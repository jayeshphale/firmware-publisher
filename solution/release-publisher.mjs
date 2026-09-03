#!/usr/bin/env node

import duckdb from 'duckdb';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const { Database } = duckdb;
const APP_ROOT = process.cwd();
const KEY_ROOT = process.env.KEY_ROOT || (existsSync('/app/keys') ? '/app/keys' : join(APP_ROOT, 'keys'));
const DB_PATH = join(APP_ROOT, 'releases.duckdb');
const MANIFEST_PATH = join(APP_ROOT, 'fixtures', 'build_manifest.csv');
const GATEWAY_BASE = process.env.GATEWAY_BASE || 'http://127.0.0.1:7070';
const OPENSSL_CANDIDATES = [
  process.env.OPENSSL_BIN,
  process.env.OPENSSL,
  process.env.OPENSSL_PATH,
  'openssl',
  'C:/Program Files/Git/usr/bin/openssl.exe',
  'C:/Program Files/Git/mingw64/bin/openssl.exe',
  'C:/Program Files/edb/pem/httpd/apache/bin/openssl.exe',
  '/usr/bin/openssl',
  '/usr/local/bin/openssl',
];

function locateOpenSSL() {
  for (const candidate of OPENSSL_CANDIDATES) {
    if (!candidate) continue;
    try {
      if (candidate === 'openssl' || existsSync(candidate)) return candidate;
    } catch {
      // Continue when a platform-specific candidate does not exist.
    }
  }
  return 'openssl';
}

function runSql(db, sql) {
  return new Promise((resolvePromise, reject) => {
    db.run(sql, (error) => (error ? reject(error) : resolvePromise()));
  });
}

function queryAll(db, sql) {
  return new Promise((resolvePromise, reject) => {
    db.all(sql, (error, rows) => (error ? reject(error) : resolvePromise(rows)));
  });
}

function sqlQuote(value) {
  return String(value).replace(/'/g, "''");
}

async function initializeDatabase(db) {
  const manifestPath = resolve(MANIFEST_PATH).replace(/\\/g, '/');
  await runSql(db, `CREATE OR REPLACE TABLE manifest AS
    SELECT DISTINCT * FROM read_csv_auto('${sqlQuote(manifestPath)}', header = true);`);
  await runSql(db, `CREATE TABLE IF NOT EXISTS publications (
    bundle_id VARCHAR PRIMARY KEY,
    request_token VARCHAR UNIQUE,
    publication_id VARCHAR,
    status VARCHAR,
    descriptor VARCHAR
  );`);
}

async function reconcileBundles(db) {
  const rows = await queryAll(db, `WITH deduped AS (
      SELECT DISTINCT * FROM manifest
    ), withdrawn AS (
      SELECT DISTINCT supersedes_id AS entry_id
      FROM deduped
      WHERE record_type = 'WITHDRAWAL' AND supersedes_id IS NOT NULL
    ), surviving_builds AS (
      SELECT build.* FROM deduped build
      WHERE build.record_type = 'BUILD'
        AND NOT EXISTS (
          SELECT 1 FROM withdrawn WHERE withdrawn.entry_id = build.entry_id
        )
    )
    SELECT bundle_id, COUNT(*) AS artifact_count, SUM(size_bytes) AS total_bytes
    FROM surviving_builds
    GROUP BY bundle_id
    ORDER BY bundle_id;`);
  return rows.map((row) => ({
    bundle_id: row.bundle_id,
    artifact_count: Number(row.artifact_count),
    total_bytes: Number(row.total_bytes),
  }));
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}: ${JSON.stringify(body)}`);
  return body;
}

function canonicalEncode(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalEncode).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalEncode(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function signDescriptor(descriptor, certificatePath, keyPath) {
  const scratch = mkdtempSync(join(tmpdir(), 'fw-publisher-'));
  const descriptorPath = join(scratch, 'descriptor.bin');
  try {
    writeFileSync(descriptorPath, descriptor, 'utf8');
    return execFileSync(locateOpenSSL(), [
      'cms', '-sign', '-in', descriptorPath, '-signer', certificatePath,
      '-inkey', keyPath, '-outform', 'PEM', '-binary', '-md', 'sha256',
    ], { encoding: 'utf8' });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function storedReceipt(db, bundleId) {
  const rows = await queryAll(db, `SELECT request_token, publication_id, status
    FROM publications WHERE bundle_id = '${sqlQuote(bundleId)}' LIMIT 1;`);
  return rows[0] || null;
}

async function persistReceipt(db, bundleId, receipt, descriptor) {
  await runSql(db, `INSERT INTO publications
    (bundle_id, request_token, publication_id, status, descriptor)
    VALUES ('${sqlQuote(bundleId)}', '${sqlQuote(receipt.request_token)}',
      '${sqlQuote(receipt.publication_id)}', '${sqlQuote(receipt.status)}', '${sqlQuote(descriptor)}')
    ON CONFLICT (bundle_id) DO UPDATE SET
      request_token = excluded.request_token,
      publication_id = excluded.publication_id,
      status = excluded.status,
      descriptor = excluded.descriptor;`);
}

async function publishBundle(db, bundle, certificatePath, keyPath) {
  const requestToken = `token-${bundle.bundle_id}`;
  const existing = await storedReceipt(db, bundle.bundle_id);
  if (existing) return { ...existing, request_token: existing.request_token };

  const descriptor = canonicalEncode({
    artifact_count: bundle.artifact_count,
    bundle_id: bundle.bundle_id,
    total_bytes: bundle.total_bytes,
  });
  const signature = signDescriptor(descriptor, certificatePath, keyPath);
  const receipt = await fetchJson(`${GATEWAY_BASE}/v1/publications`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ descriptor, signature, request_token: requestToken }),
  });
  if (receipt.status !== 'PUBLISHED') throw new Error(`Publication failed for ${bundle.bundle_id}`);
  await persistReceipt(db, bundle.bundle_id, receipt, descriptor);
  return receipt;
}

async function main() {
  const currentKey = join(KEY_ROOT, 'current', 'current.key.pem');
  const currentCertificate = join(KEY_ROOT, 'current', 'current.cert.pem');
  if (!existsSync(currentKey) || !existsSync(currentCertificate)) {
    throw new Error(`Current signing keypair is missing under ${join(KEY_ROOT, 'current')}`);
  }
  const db = new Database(DB_PATH);
  try {
    await initializeDatabase(db);
    const bundles = await reconcileBundles(db);
    const keyInfo = await fetchJson(`${GATEWAY_BASE}/v1/signing-key/current`);
    for (const bundle of bundles) {
      console.log(`BUNDLE ${bundle.bundle_id} SIGNED KEY=${keyInfo.key_id}`);
      const receipt = await publishBundle(db, bundle, currentCertificate, currentKey);
      console.log(`BUNDLE ${bundle.bundle_id} PUBLISHED RECEIPT=${receipt.publication_id} TOKEN=${receipt.request_token} STATUS=${receipt.status}`);
    }
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
});
