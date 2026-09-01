#!/usr/bin/env node

import duckdb from 'duckdb';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const { Database } = duckdb;

const APP_ROOT = process.cwd();
const KEY_ROOT = existsSync('/app/keys') ? '/app/keys' : join(APP_ROOT, 'keys');
const DB_PATH = join(APP_ROOT, 'releases.duckdb');
const MANIFEST_PATH = join(APP_ROOT, 'fixtures', 'build_manifest.csv');
const GATEWAY_BASE = 'http://127.0.0.1:7070';
const OPENSSL_CANDIDATES = [
  process.env.OPENSSL_BIN,
  process.env.OPENSSL,
  process.env.OPENSSL_PATH,
  'openssl',
  'C:/Program Files/Git/usr/bin/openssl.exe',
  'C:/Program Files/Git/mingw64/bin/openssl.exe',
  'C:/Program Files/edb/pem/httpd/apache/bin/openssl.exe',
];

function normalizePath(filePath) {
  return resolve(filePath).replace(/\\/g, '/');
}

function locateOpenSSL() {
  for (const candidate of OPENSSL_CANDIDATES) {
    if (!candidate) continue;
    try {
      if (existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // ignore candidate format issues and continue scanning.
    }
  }

  return 'openssl';
}

function ensureSigningKeys() {
  const currentDir = join(KEY_ROOT, 'current');
  const revokedDir = join(KEY_ROOT, 'revoked');
  const currentKey = join(currentDir, 'current.key.pem');
  const currentCert = join(currentDir, 'current.cert.pem');
  const revokedKey = join(revokedDir, 'revoked.key.pem');
  const revokedCert = join(revokedDir, 'revoked.cert.pem');
  const opensslBin = locateOpenSSL();

  mkdirSync(currentDir, { recursive: true });
  mkdirSync(revokedDir, { recursive: true });

  if (!existsSync(currentKey) || !existsSync(currentCert)) {
    execFileSync(
      opensslBin,
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-keyout',
        currentKey,
        '-out',
        currentCert,
        '-days',
        '3650',
        '-nodes',
        '-sha256',
        '-subj',
        '/CN=fw-signing-2026-current/O=ReleaseEng/C=US',
      ],
      { stdio: 'inherit' }
    );
  }

  if (!existsSync(revokedKey) || !existsSync(revokedCert)) {
    execFileSync(
      opensslBin,
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-keyout',
        revokedKey,
        '-out',
        revokedCert,
        '-days',
        '3650',
        '-nodes',
        '-sha256',
        '-subj',
        '/CN=fw-signing-2025-revoked/O=ReleaseEng/C=US',
      ],
      { stdio: 'inherit' }
    );
  }

  process.env.CURRENT_CERT_PATH = currentCert;
  return { currentKey, currentCert, revokedKey, revokedCert };
}

function runSql(db, sql) {
  return new Promise((resolve, reject) => {
    db.run(sql, (err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

function queryAll(db, sql) {
  return new Promise((resolve, reject) => {
    db.all(sql, (err, rows) => {
      if (err) {
        reject(err);
      } else {
        resolve(rows);
      }
    });
  });
}

async function initializeDatabase(db) {
  const manifestCsv = normalizePath(MANIFEST_PATH);
  const escapedCsv = manifestCsv.replace(/'/g, "''");

  await runSql(
    db,
    `CREATE TABLE IF NOT EXISTS manifest (
      entry_id VARCHAR,
      bundle_id VARCHAR,
      component_id VARCHAR,
      version VARCHAR,
      size_bytes BIGINT,
      record_type VARCHAR,
      supersedes_id VARCHAR,
      recorded_at VARCHAR
    );`
  );

  await runSql(
    db,
    `CREATE OR REPLACE TABLE manifest AS
      SELECT DISTINCT *
      FROM read_csv_auto('${escapedCsv}', header = true);`
  );

  await runSql(
    db,
    `CREATE TABLE IF NOT EXISTS publications (
      bundle_id VARCHAR PRIMARY KEY,
      request_token VARCHAR UNIQUE,
      publication_id VARCHAR,
      status VARCHAR,
      descriptor VARCHAR
    );`
  );
}

async function reconcileBundles(db) {
  const rows = await queryAll(
    db,
    `WITH deduped AS (
      SELECT DISTINCT *
      FROM manifest
    ),
    withdrawn AS (
      SELECT DISTINCT supersedes_id AS entry_id
      FROM deduped
      WHERE record_type = 'WITHDRAWAL'
        AND supersedes_id IS NOT NULL
    ),
    surviving_builds AS (
      SELECT b.*
      FROM deduped b
      WHERE b.record_type = 'BUILD'
        AND NOT EXISTS (
          SELECT 1
          FROM withdrawn w
          WHERE w.entry_id = b.entry_id
        )
    )
    SELECT bundle_id, COUNT(*) AS artifact_count, SUM(size_bytes) AS total_bytes
    FROM surviving_builds
    GROUP BY bundle_id
    ORDER BY bundle_id;`
  );

  return rows.map((row) => ({
    bundle_id: row.bundle_id,
    artifact_count: Number(row.artifact_count),
    total_bytes: Number(row.total_bytes),
  }));
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  const raw = await response.text();
  let payload = null;

  if (raw) {
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = raw;
    }
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}: ${JSON.stringify(payload)}`);
  }

  return payload;
}

async function getCurrentSigningKey() {
  return fetchJson(`${GATEWAY_BASE}/v1/signing-key/current`);
}

function canonicalEncode(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalEncode).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalEncode(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

function signDescriptor(descriptor, certPath, keyPath) {
  const scratchDir = mkdtempSync(join(tmpdir(), 'fw-publisher-'));
  const descriptorFile = join(scratchDir, 'descriptor.bin');
  try {
    writeFileSync(descriptorFile, descriptor, 'utf8');
    return execFileSync(
      locateOpenSSL(),
      [
        'cms',
        '-sign',
        '-in',
        descriptorFile,
        '-signer',
        certPath,
        '-inkey',
        keyPath,
        '-outform',
        'PEM',
        '-binary',
      ],
      { encoding: 'utf8' }
    );
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
}

async function loadStoredReceipt(db, bundleId) {
  const escaped = String(bundleId).replace(/'/g, "''");
  const rows = await queryAll(
    db,
    `SELECT bundle_id, request_token, publication_id, status, descriptor
     FROM publications
     WHERE bundle_id = '${escaped}'
     LIMIT 1;`
  );

  return rows[0] || null;
}

async function saveReceipt(db, bundleId, requestToken, publicationId, status, descriptor) {
  const escapedBundle = String(bundleId).replace(/'/g, "''");
  const escapedToken = String(requestToken).replace(/'/g, "''");
  const escapedPublicationId = String(publicationId).replace(/'/g, "''");
  const escapedStatus = String(status).replace(/'/g, "''");
  const escapedDescriptor = String(descriptor).replace(/'/g, "''");

  await runSql(
    db,
    `INSERT INTO publications (bundle_id, request_token, publication_id, status, descriptor)
     VALUES ('${escapedBundle}', '${escapedToken}', '${escapedPublicationId}', '${escapedStatus}', '${escapedDescriptor}')
     ON CONFLICT (bundle_id) DO UPDATE SET
       request_token = excluded.request_token,
       publication_id = excluded.publication_id,
       status = excluded.status,
       descriptor = excluded.descriptor;`
  );
}

async function publishBundle(db, bundle, currentCert, currentKey) {
  const requestToken = `token-${bundle.bundle_id}`;
  const stored = await loadStoredReceipt(db, bundle.bundle_id);

  if (stored) {
    return {
      publication_id: stored.publication_id,
      request_token: stored.request_token,
      status: stored.status,
    };
  }

  const descriptor = canonicalEncode({
    artifact_count: bundle.artifact_count,
    bundle_id: bundle.bundle_id,
    total_bytes: bundle.total_bytes,
  });
  const signature = signDescriptor(descriptor, currentCert, currentKey);

  const response = await fetchJson(`${GATEWAY_BASE}/v1/publications`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ descriptor, signature, request_token: requestToken }),
  });

  await saveReceipt(
    db,
    bundle.bundle_id,
    response.request_token,
    response.publication_id,
    response.status,
    descriptor
  );

  return response;
}

async function main() {
  ensureSigningKeys();

  const database = new Database(DB_PATH);
  try {
    await initializeDatabase(database);
    const bundles = await reconcileBundles(database);
    const keyInfo = await getCurrentSigningKey();
    const { currentCert, currentKey } = ensureSigningKeys();

    for (const bundle of bundles) {
      console.log(`BUNDLE ${bundle.bundle_id} SIGNED KEY=${keyInfo.key_id}`);
      const receipt = await publishBundle(database, bundle, currentCert, currentKey);
      console.log(
        `BUNDLE ${bundle.bundle_id} PUBLISHED RECEIPT=${receipt.publication_id} TOKEN=${receipt.request_token} STATUS=${receipt.status}`
      );
    }
  } finally {
    database.close();
  }
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
});
