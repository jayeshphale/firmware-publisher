from __future__ import annotations

import csv
import re
import subprocess
from pathlib import Path

import duckdb
import requests

ROOT = Path.cwd()
EXPECTED = ROOT / "reports" / "publications.expected.txt"
MANIFEST = ROOT / "fixtures" / "build_manifest.csv"


def run_report() -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["npm", "run", "--silent", "report"], cwd=ROOT, text=True, capture_output=True, timeout=120
    )


def mask_receipts(text: str) -> str:
    return re.sub(r"RECEIPT=[^ ]+", "RECEIPT=<id>", text)


def expected_bundles() -> dict[str, tuple[int, int]]:
    rows = list(csv.DictReader(MANIFEST.open(newline="", encoding="utf-8")))
    unique = {tuple(row.items()): row for row in rows}.values()
    withdrawn = {row["supersedes_id"] for row in unique if row["record_type"] == "WITHDRAWAL"}
    totals: dict[str, list[int]] = {}
    for row in unique:
        if row["record_type"] == "BUILD" and row["entry_id"] not in withdrawn:
            totals.setdefault(row["bundle_id"], [0, 0])
            totals[row["bundle_id"]][0] += 1
            totals[row["bundle_id"]][1] += int(row["size_bytes"])
    return {bundle: tuple(values) for bundle, values in totals.items()}


def test_report_and_reconciliation():
    result = run_report()
    assert result.returncode == 0, result.stderr
    assert mask_receipts(result.stdout) == mask_receipts(EXPECTED.read_text(encoding="utf-8"))
    assert [line.split()[1] for line in result.stdout.splitlines()[::2]] == [
        "BND-101", "BND-102", "BND-103"
    ]
    with duckdb.connect(str(ROOT / "releases.duckdb"), read_only=True) as db:
        receipts = db.execute(
            "SELECT bundle_id, request_token, status FROM publications ORDER BY bundle_id"
        ).fetchall()
    assert len(receipts) == 3
    assert all(token == f"token-{bundle}" and status == "PUBLISHED" for bundle, token, status in receipts)


def test_rerun_is_idempotent():
    first = run_report()
    second = run_report()
    assert first.returncode == second.returncode == 0
    assert first.stdout == second.stdout


def test_gateway_contract_and_current_metadata():
    response = requests.get("http://127.0.0.1:7070/v1/signing-key/current", timeout=5)
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "current"
    assert body["key_id"] == "fw-signing-2026-current"


def test_gateway_rejects_missing_token():
    response = requests.post(
        "http://127.0.0.1:7070/v1/publications",
        json={"descriptor": "{}", "signature": "invalid"},
        timeout=5,
    )
    assert response.status_code == 400
    assert response.json()["error"] == "MISSING_REQUEST_TOKEN"
