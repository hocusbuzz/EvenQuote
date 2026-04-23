#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# EvenQuote — Restart Preview
# Double-click to kill whatever's running on :3000 (the Next.js dev
# server) and start it fresh in this Terminal window.
#
# When to use this:
#   • You edited .env.local and need Next.js to reload it.
#   • The dev server is hung or behaving weirdly.
#
# What it does NOT touch:
#   • The Cloudflare tunnel — cloudflared keeps proxying to :3000 and
#     just sees a brief 502 while Next.js boots back up. No need to
#     restart Start Tunnel.command.
#   • The Stripe listener — separate window, separate process.
# ─────────────────────────────────────────────────────────────────────

set -e

cd "$(dirname "$0")"

echo ""
echo "  ┌─────────────────────────────────────────────────┐"
echo "  │   EvenQuote — Restart Preview                   │"
echo "  └─────────────────────────────────────────────────┘"
echo ""

# ── 1. Find and kill anything listening on :3000 ──
# lsof -ti returns just the PIDs (one per line). Quietly continue if
# nothing's bound — first-time use case.
PIDS=$(lsof -ti tcp:3000 2>/dev/null || true)
if [ -n "$PIDS" ]; then
  echo "  Killing process(es) on :3000 → $PIDS"
  # Be polite first (SIGTERM), wait a beat, then force if still alive.
  kill $PIDS 2>/dev/null || true
  sleep 1
  STILL=$(lsof -ti tcp:3000 2>/dev/null || true)
  if [ -n "$STILL" ]; then
    echo "  → Still alive, sending SIGKILL: $STILL"
    kill -9 $STILL 2>/dev/null || true
    sleep 1
  fi
  echo "  ✓ Port :3000 is free"
else
  echo "  ✓ Nothing on :3000 to kill (clean start)"
fi

echo ""
echo "  Handing off to Start Preview.command…"
echo ""

# ── 2. Hand off to Start Preview.command ──
# `exec` replaces this script with Start Preview.command in the same
# Terminal window — so you see the dev-server output and can Ctrl+C it
# the same way as a normal preview session.
exec ./"Start Preview.command"
