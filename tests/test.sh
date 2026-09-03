#!/bin/bash

if [ "$PWD" = "/" ]; then
    echo "Error: No working directory set. Please set a WORKDIR in your Dockerfile before running this script."
    exit 1
fi

mkdir -p /logs/verifier

node /app/distribution-gateway/server.js >/tmp/gateway.log 2>&1 &
gateway_pid=$!
trap 'kill "$gateway_pid" 2>/dev/null || true' EXIT

for attempt in $(seq 1 30); do
  if node -e "fetch('http://127.0.0.1:7070/healthz').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"; then break; fi
  sleep 1
done

# pytest + pytest-json-ctrf are pre-installed in the verifier image.
python3 -m pytest --ctrf /logs/verifier/ctrf.json /tests/test_outputs.py -rA
code=$?

# Surface pytest's raw exit code so the negative-control check can tell "tests ran
# and failed" (code 1, expected with no solution) from "tests could not run" (>=2).
echo "pytest exit code: ${code}"

if [ "$code" -eq 0 ]; then
  echo 1 > /logs/verifier/reward.txt
else
  echo 0 > /logs/verifier/reward.txt
fi
