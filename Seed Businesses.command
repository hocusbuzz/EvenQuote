#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# EvenQuote — Seed Businesses (San Diego North County)
# Double-click this file to ingest movers + cleaners from Google
# Places into your Supabase `businesses` table.
#
# Safe to re-run: upsertBusinesses keys on (place_id, category) so
# repeats just update the existing rows.
#
# Prereqs:
#   • .env.local has GOOGLE_PLACES_API_KEY and the three Supabase keys
#     (Start Preview.command verifies all of these — run it once first).
#   • You enabled "Places API (NEW)" in Google Cloud Console for the
#     project that owns this API key. The legacy Places API will fail
#     with a 403 — the ingester uses the v1 endpoint.
#
# To stop mid-run: press Ctrl+C, then close this window.
# ─────────────────────────────────────────────────────────────────────

set -e

cd "$(dirname "$0")"

echo ""
echo "  ┌─────────────────────────────────────────────────┐"
echo "  │   EvenQuote — Seed Businesses (SD North County) │"
echo "  └─────────────────────────────────────────────────┘"
echo ""

# Sanity-check the Google Places key is in .env.local. Don't run a
# script that'll just fail on the first fetch.
if ! grep -qE "^GOOGLE_PLACES_API_KEY=AIza" .env.local 2>/dev/null; then
  echo "  ✗ GOOGLE_PLACES_API_KEY missing or doesn't look real in .env.local."
  echo "    Open .env.local and paste your key from Google Cloud → Credentials."
  echo ""
  read -n 1 -s -r -p "  Press any key to close…"
  exit 1
fi
echo "  ✓ Google Places key present"

# Make sure node_modules exists (rare — Start Preview installs them,
# but if the user only ran Stripe Listener first this would be missing).
if [ ! -d "node_modules" ]; then
  echo "  … installing dependencies first (~1 min) …"
  npm install
fi
echo "  ✓ Dependencies installed"

echo ""
echo "  ─────────────────────────────────────────────────"
echo "  1/2  Ingesting MOVERS in North County San Diego"
echo "  ─────────────────────────────────────────────────"
npx tsx scripts/ingest-businesses.ts \
  --category moving \
  --query "movers in North County San Diego"

echo ""
echo "  ─────────────────────────────────────────────────"
echo "  2/2  Ingesting CLEANERS in North County San Diego"
echo "  ─────────────────────────────────────────────────"
npx tsx scripts/ingest-businesses.ts \
  --category cleaning \
  --query "house cleaning services in North County San Diego"

echo ""
echo "  ─────────────────────────────────────────────────"
echo "  ✓ Done. Check your Supabase dashboard:"
echo "    Table Editor → businesses"
echo "    Filter by category_id to see each batch."
echo ""

read -n 1 -s -r -p "  Press any key to close this window…"
