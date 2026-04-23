#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# Synthetic Vapi end-of-call-report → local webhook.
#
# Simulates what Vapi POSTs when a real outbound call finishes. Lets
# you drive the full post-call pipeline (calls update → quote extraction
# → apply_call_end → success-rate recompute) without running the dialer.
#
# Prereqs:
#   1. `npm run dev` running on :3000
#   2. A calls row exists in Supabase whose vapi_call_id matches
#      $VAPI_CALL_ID below. The easiest way to get one is:
#        - complete a paid checkout in the browser so a quote_request
#          + 5 calls rows get inserted,
#        - `select id, vapi_call_id from calls order by created_at desc limit 5;`
#        - pick any row whose status is still 'queued' or 'dialing'.
#   3. VAPI_WEBHOOK_SECRET set in .env.local so auth passes. In dev
#      the verifier accepts-with-warning if blank, but match prod.
#
# Usage:
#   VAPI_CALL_ID=abc-123 VAPI_WEBHOOK_SECRET=whsec_local_dev \
#     bash scripts/test-vapi-webhook.sh [completed|no_answer|refused|failed]
#
# Default outcome is "completed" with a believable moving-quote transcript.
# ─────────────────────────────────────────────────────────────────────

set -euo pipefail

OUTCOME="${1:-completed}"
VAPI_CALL_ID="${VAPI_CALL_ID:-test-call-$(date +%s)}"
SECRET="${VAPI_WEBHOOK_SECRET:-whsec_local_dev}"
URL="${WEBHOOK_URL:-http://localhost:3000/api/vapi/webhook}"

case "$OUTCOME" in
  completed)
    ENDED_REASON="assistant-ended-call"
    DURATION=142
    TRANSCRIPT="AI: Hi, I'm calling on behalf of a customer looking for a moving quote from a 2-bedroom apartment in Oakland to San Francisco on May 10th. Are you available?\nBusiness: Yeah, we've got availability that weekend. Two-bed to SF is usually a three-hour job, two movers and a truck. We'd quote eight hundred to nine fifty all in, depending on stairs and parking. No onsite estimate needed for a 2BR.\nAI: Great. Does that include packing materials?\nBusiness: Blankets and wrap yes, boxes no — those are extra at two dollars per box if you need them. Contact me directly at mike@oaklandmovers.example, I'm Mike.\nAI: Perfect, I'll pass that along. Thank you!"
    SUMMARY="Mike from Oakland Movers quoted \$800-\$950 for a 2BR move Oakland→SF on May 10. Wrap/blankets included, boxes \$2 each extra. No onsite estimate."
    STRUCTURED_DATA='{"priceMin":800,"priceMax":950,"priceDescription":"all-in, 2 movers + truck, 3 hours","availability":"May 10 weekend","includes":["blankets","wrap"],"excludes":["boxes ($2 ea)"],"notes":"Confirmed no onsite estimate needed for a 2BR.","contactName":"Mike","contactPhone":null,"contactEmail":"mike@oaklandmovers.example","requiresOnsiteEstimate":false,"confidenceScore":0.9}'
    ;;
  no_answer)
    ENDED_REASON="voicemail-detected"
    DURATION=18
    TRANSCRIPT=""
    SUMMARY=""
    STRUCTURED_DATA="null"
    ;;
  refused)
    ENDED_REASON="customer-hungup"
    DURATION=4
    TRANSCRIPT=""
    SUMMARY=""
    STRUCTURED_DATA="null"
    ;;
  failed)
    ENDED_REASON="twilio-error-no-route"
    DURATION=0
    TRANSCRIPT=""
    SUMMARY=""
    STRUCTURED_DATA="null"
    ;;
  *)
    echo "Unknown outcome: $OUTCOME (expected: completed|no_answer|refused|failed)" >&2
    exit 1
    ;;
esac

# Build JSON with jq so newlines/quotes in the transcript escape safely.
PAYLOAD=$(jq -n \
  --arg call_id "$VAPI_CALL_ID" \
  --arg reason "$ENDED_REASON" \
  --arg transcript "$TRANSCRIPT" \
  --arg summary "$SUMMARY" \
  --argjson duration "$DURATION" \
  --argjson structured "$STRUCTURED_DATA" \
  '{
    message: {
      type: "end-of-call-report",
      call: { id: $call_id },
      transcript: $transcript,
      summary: $summary,
      recordingUrl: "https://example.com/recordings/test.mp3",
      cost: 0.12,
      durationSeconds: $duration,
      endedReason: $reason,
      analysis: {
        structuredData: $structured,
        successEvaluation: (if $structured == null then null else "pass" end)
      }
    }
  }')

echo "→ POST $URL"
echo "  outcome=$OUTCOME  vapi_call_id=$VAPI_CALL_ID"
echo

curl -sS -X POST "$URL" \
  -H "Content-Type: application/json" \
  -H "x-vapi-secret: $SECRET" \
  --data-raw "$PAYLOAD" \
  -w "\n← HTTP %{http_code}\n"
