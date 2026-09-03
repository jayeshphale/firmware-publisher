# Firmware Release Publisher

Implement the JavaScript publisher at `/app/publisher/release-publisher.mjs` in
the provided Linux environment. The entry point must support `npm run report`,
which runs `node publisher/release-publisher.mjs --report` from `/app`.

## Inputs and boundaries

- Read `/app/fixtures/build_manifest.csv` and create `/app/releases.duckdb` at
	runtime. Do not edit the fixture, golden report, gateway source, or gateway
	private ledger (`/app/distribution-gateway/data/gateway.json`).
- The gateway is already available at `http://127.0.0.1:7070`.
- `GET /v1/signing-key/current` returns the active `key_id`, `algorithm`,
	`certificate_ref`, and `status`.
- The current keypair is `/app/keys/current/current.key.pem` and
	`/app/keys/current/current.cert.pem`. The keypair under `/app/keys/revoked/`
	is intentionally invalid for publication and must not be used.

## Reconciliation

Import the CSV into DuckDB and perform reconciliation with SQL. The columns are
`entry_id,bundle_id,component_id,version,size_bytes,record_type,supersedes_id,recorded_at`.
Collapse only rows identical across every column (`SELECT DISTINCT`). A
`WITHDRAWAL` cancels the `BUILD` whose `entry_id` equals its `supersedes_id`.
Exclude cancelled builds, group surviving builds by `bundle_id`, and skip a
bundle with no surviving builds. For each remaining bundle derive
`artifact_count` and `total_bytes` as `COUNT(*)` and `SUM(size_bytes)`. Process
bundles in ascending `bundle_id` order.

## Signing and publication

For each publishable bundle, construct exactly this descriptor object:
`{"artifact_count":<number>,"bundle_id":"<id>","total_bytes":<number>}`.
Encode it as UTF-8 JSON with lexicographically sorted object keys and no
insignificant whitespace. Sign those exact bytes with a detached, binary CMS
signature using OpenSSL, the current certificate and private key, SHA-256,
and PEM output. Send the descriptor string and PEM signature without changing
their bytes.

POST JSON to `/v1/publications`:

```json
{"descriptor":"<canonical JSON>","signature":"<PEM CMS>","request_token":"token-<bundle_id>"}
```

Require the success response to contain `status: "PUBLISHED"`, a
`publication_id`, and the echoed request token. HTTP failures, malformed
responses, signature failures, and missing key material are genuine errors and
must produce a non-zero exit code. Do not bypass CMS verification, trust
validation, or the gateway.

## Persistence and output

Persist each bundle's descriptor, request token, publication id, and status in
`/app/releases.duckdb`. On a rerun, reuse the persisted receipt for that bundle
and do not submit a second publication. The gateway itself also replays a
request token idempotently.

When `--report` is used, print exactly two lines per publishable bundle:

```
BUNDLE <bundle_id> SIGNED KEY=<key_id>
BUNDLE <bundle_id> PUBLISHED RECEIPT=<publication_id> TOKEN=token-<bundle_id> STATUS=PUBLISHED
```

There must be no extra stdout. The expected ordering and text are in
`/app/reports/publications.expected.txt`; the verifier masks only the random
receipt value. The expected publishable bundles are BND-101, BND-102, and
BND-103 after reconciliation. A correct run exits zero, matches the golden
report, records three receipts, and is byte-identical on a second run. Any
other outcome is failure.

Before finishing, run the gateway tests with
`cd /app/distribution-gateway && node --test tests/`, then run the publisher
twice with `npm run report` and compare the masked output with the golden file.
