#!/usr/bin/env bash
# Spin up the REAL Darkmoon Dashboard API locally (no Docker needed — it is a
# pure FastAPI-over-JSON service), with the pentest engine replaced by
# test/stub_opencode, then run the n8n node's e2e integration test against it.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG="$(cd "$HERE/.." && pwd)"
FRONT_API="${FRONT_API:-/home/mehdi/Dark-Moon-Front-API}"
MCP_SRC="$FRONT_API/mcp"
PORT="${PORT:-8000}"
BASE_URL="http://127.0.0.1:${PORT}"

WORK="$(mktemp -d)"
VENV="$WORK/venv"
STUB_DIR="$WORK/bin"
USERS_FILE="$WORK/users.json"
# Isolated copy of the API + JSON store so the test never mutates the real repo.
MCP_DIR="$WORK/mcp"
mkdir -p "$STUB_DIR"
cp -r "$MCP_SRC" "$MCP_DIR"
rm -rf "$MCP_DIR"/**/__pycache__ "$MCP_DIR"/.pytest_cache 2>/dev/null || true

# routes_auth.py hard-codes a writable users cache at this tmpfs path, which
# shadows USERS_FILE when present. Move any existing one aside for the duration
# of the test and restore it afterwards (fully reversible).
RW_USERS="/tmp/darkmoon-users.json"
RW_BAK="$WORK/darkmoon-users.json.bak"

cleanup() {
	[[ -n "${API_PID:-}" ]] && kill "$API_PID" 2>/dev/null || true
	rm -f "$RW_USERS" 2>/dev/null || true
	[[ -f "$RW_BAK" ]] && mv "$RW_BAK" "$RW_USERS" 2>/dev/null || true
	rm -rf "$WORK"
}
trap cleanup EXIT

[[ -f "$RW_USERS" ]] && mv "$RW_USERS" "$RW_BAK"

echo "== venv + deps =="
python3 -m venv "$VENV"
"$VENV/bin/pip" -q install --upgrade pip >/dev/null
"$VENV/bin/pip" -q install "fastapi>=0.104" "uvicorn[standard]>=0.24" >/dev/null

echo "== stub opencode on PATH =="
cp "$HERE/stub_opencode" "$STUB_DIR/opencode"
chmod +x "$STUB_DIR/opencode"

# admin/admin, no forced password change, so login is frictionless in the test.
python3 - "$USERS_FILE" <<'PY'
import hashlib, json, sys
open(sys.argv[1], "w").write(json.dumps([{
    "username": "admin",
    "password_hash": hashlib.sha256(b"admin").hexdigest(),
    "role": "admin",
    "display_name": "Administrator",
    "must_change_password": False,
}]))
PY

echo "== start API (real FastAPI, real JSON store at $MCP_DIR/data) =="
(
	cd "$MCP_DIR"
	PATH="$STUB_DIR:$PATH" \
	DM_MCP_DIR="$MCP_DIR" \
	USERS_FILE="$USERS_FILE" \
	DARKMOON_STALE_GRACE_SECONDS=86400 \
	"$VENV/bin/python" -m uvicorn api.api_server:app --host 127.0.0.1 --port "$PORT" --log-level warning
) &
API_PID=$!

echo "== wait for health =="
for _ in $(seq 1 40); do
	if curl -fsS "$BASE_URL/health" >/dev/null 2>&1; then ok=1; break; fi
	sleep 0.5
done
[[ "${ok:-}" == 1 ]] || { echo "API did not come up"; exit 1; }
curl -fsS "$BASE_URL/health"; echo

echo "== run e2e =="
BASE_URL="$BASE_URL" DM_USER=admin DM_PASS=admin node "$HERE/e2e.mjs"
