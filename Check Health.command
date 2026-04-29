#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# EvenQuote — Check Health
# Double-click to print the liveness + readiness status (DB probe,
# feature-integration flags, uptime) from each target.
#
# When to use this:
#   • You want a 5-second read on "is prod alive and can it reach
#     its DB right now?" before starting your day.
#   • A Stripe or Vapi alert fires and you want to see whether the
#     web tier + DB are still fine (feature flags here tell you
#     which integrations are live vs simulation).
#   • Your dev server is acting weird and you want to confirm your
#     local DB connection is actually working.
#
# What it checks, in order:
#   1. Production  — https://evenquote.com/api/health
#   2. Local dev   — http://localhost:3000/api/health  (only if it responds)
#
# /api/health is a public endpoint (no secrets returned), so no auth
# needed. HTTP 200 means "ok", 503 means "degraded — DB unreachable".
# Either is still useful intel; both cases print the full body so you
# can see the feature flags and uptime even under degraded state.
# ─────────────────────────────────────────────────────────────────────

set -e

cd "$(dirname "$0")"

PROD_URL="https://evenquote.com/api/health"
LOCAL_URL="http://localhost:3000/api/health"

echo ""
echo "  ┌─────────────────────────────────────────────────┐"
echo "  │   EvenQuote — Check Health                      │"
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

  # Split body and status so we can tell "not running" from "503 with
  # a body we still want to read". /api/health returns JSON on both
  # 200 and 503 — print either.
  local tmp
  tmp=$(mktemp /tmp/eq-health-XXXXXX)
  local http
  http=$(curl -s -S --max-time "$timeout" -o "$tmp" -w "%{http_code}" "$url" 2>/dev/null || echo "000")

  if [ "$http" = "000" ]; then
    echo "  (no response — host unreachable or not running)"
    rm -f "$tmp"
    return 1
  fi

  echo "  HTTP $http"
  format_json < "$tmp"
  rm -f "$tmp"
  echo ""

  # Return non-zero on degraded so the caller knows — but we still
  # printed the body above.
  if [ "$http" != "200" ]; then
    return 1
  fi
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
