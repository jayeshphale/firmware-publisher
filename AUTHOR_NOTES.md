# Author Notes

## Task design

This task tests a single release-publisher workflow across SQL reconciliation,
detached OpenSSL CMS signing, HTTP integration, and durable idempotency. The
manifest intentionally contains exact duplicate rows, withdrawn builds, a fully
withdrawn bundle, and multiple surviving bundles. The gateway uses a self-signed
current certificate so trust verification is real and deterministic apart from
random publication ids.

## Package structure

- `instruction.md`: binding candidate specification.
- `environment/`: candidate inputs, generated key material in the image, and
  the unmodified Express gateway. It deliberately contains no publisher.
- `solution/`: the reference publisher and its executable `publish.sh` entry point.
- `tests/`: binary verifier and gateway contract checks.
- `task.toml`: Linux/shared-environment limits and task metadata.

## Reference behavior

The reference imports the CSV into DuckDB, uses SQL `DISTINCT` plus
`supersedes_id` withdrawal matching, signs canonical descriptors with the
current key, posts only through the documented HTTP endpoints, and persists
receipts keyed by bundle and request token. Repeated runs reuse DuckDB receipts.
OpenSSL discovery accepts the normal Linux executable, configured overrides,
and the common Git-for-Windows locations without weakening verification.

## Verification

Proof A is a fresh environment with no `publisher/release-publisher.mjs`; the
candidate command fails and the verifier writes reward `0`. Proof B is a fresh
environment with the contents of `solution/` available; `solution/publish.sh`
must complete, `npm run report` must match the golden output with receipts
masked, and the verifier must write reward `1`. The gateway's node tests cover
current-key acceptance, revoked-key rejection, required request tokens, and
idempotent replay. No private key or credential belongs in this package.

The supplied Dockerfile is the clean Linux execution path. Docker daemon
availability is an operator prerequisite; native Windows runs are useful for
development but do not replace the clean-container proofs.