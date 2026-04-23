#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# EvenQuote — Check Version
# Double-click to print the deployed version info (commit, branch,
# build time, environment, region) from each target.
#
# When to use this:
#   • You just pushed to main and want to confirm Vercel has picked it
#     up before you bless a change.
#   • You're investigating whether prod and your local build are on
#     the same code.
#   • After a rollback, confirm the commit SHA matches what the Vercel
#     dashboard claims is deployed.
#
# What it checks, in order:
#   1. Production  — https://evenquote.com/api/version
#   2. Local dev   — http://localhost:3000/api/version  (only if it responds)
#
# No secrets needed. /api/version is a public read-only endpoint (commit
# SHAs are already visible in the public build log and git history).
# ─────────────────────────────────────────────────────────────────────

set -e

cd "$(dirname "$0")"

PROD_URL="https://evenquote.com/api/version"
LOCAL_URL="http://localhost:3000/api/version"

echo ""
echo "  ┌─────────────────────────────────────────────────┐"
echo "  │   EvenQuote — Check Version                     │"
echo "  └─────────────────────────────────────────────────┘"
echo ""

# Prefer `jq` for pretty output; fall back to python; fall back to raw.
format_json() {
  if command -v jq >/dev/null 2>&1; then
    jq .
  elif command -v python3 >/dev/null 2>&1; then
    python3 -m json.tool
  else
    cat
  fi
}

probe() {
  local label="$1"
  local url="$2"
  local timeout="$3"

  echo "  ── $label ──"
  echo "  URL: $url"
  echo ""

  # -s silent, -S show errors, --max-time budget, -w for HTTP status.
  # We split the body and status so we can tell "not running" from
  # "returning garbage". 000 = connection failed.
  local tmp
  tmp=$(mktemp /tmp/eq-version-XXXXXX)
  local http
  http=$(curl -s -S --max-time "$timeout" -o "$tmp" -w "%{http_code}" "$url" 2>/dev/null || echo "000")

  if [ "$http" = "000" ]; then
    echo "  (no response — host unreachable or not running)"
    rm -f "$tmp"
    return 1
  fi

  if [ "$http" != "200" ]; then
    echo "  HTTP $http"
    cat "$tmp"
    echo ""
    rm -f "$tmp"
    return 1
  fi

  format_json < "$tmp"
  rm -f "$tmp"
  echo ""
}

# Production — always probe.
probe "Production" "$PROD_URL" 10 || true
echo ""

# Local — only if something's actually listening on :3000.
if lsof -ti tcp:3000 >/dev/null 2>&1; then
  probe "Local (localhost:3000)" "$LOCAL_URL" 3 || true
else
  echo "  ── Local (localhost:3000) ──"
  echo "  (skipped — nothing listening on :3000)"
  echo ""
fi

echo ""
echo "  Done. Close this window when you're finished reading."
echo ""

# Keep the Terminal window open on double-click so the output is
# readable. `read -n 1` waits for a keypress instead of forcing a
# manual Cmd+W.
read -n 1 -s -r -p "  Press any key to close…"
echo ""
