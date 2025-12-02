#!/usr/bin/env bash
set -euo pipefail

endpoint="${1:-}"
if [[ -z "$endpoint" ]]; then
  echo "Usage: $0 <endpoint-url>" >&2
  exit 1
fi

for i in $(seq 1 101); do
  method=$((RANDOM % 5))
  case "$method" in
    0) http_method="GET" ;;
    1) http_method="POST" ;;
    2) http_method="PUT" ;;
    3) http_method="PATCH" ;;
    *) http_method="DELETE" ;;
  esac

  body=$(head -c 64 /dev/urandom | base64)
  curl -sS -X "$http_method" \
    -H "X-Test-Id: $i" \
    -H "Content-Type: application/json" \
    -d "{\"seq\":$i,\"payload\":\"$body\"}" \
    "$endpoint?req=$i&rand=$RANDOM" >/dev/null || true
  # sleep 0.1
  printf '.'
done
printf '\nDone sending 101 requests to %s\n' "$endpoint"
