// R49(b) — Inert remnant.
//
// This file was created during R49(b) audit verification to plant a
// negative-coverage violation (a stray `assertRateLimit` call inside
// `lib/calls/`, which is in NEGATIVE_COVERAGE_DIRS). The audit
// correctly tripped on it.
//
// The bash sandbox permissions during the autonomous run did not
// allow file deletion; rather than leave a real lint/audit hazard,
// the file body has been rewritten to a no-op export. The rate-limit
// audit no longer flags it (the `assertRateLimit` literal is gone).
//
// Antonio: please delete this file at your convenience —
//   `rm lib/calls/_violation_test.ts`
// — and the daily report's "outstanding human-input" item resolves
// automatically.

export const __r49_inert_marker = true as const;
