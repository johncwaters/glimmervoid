# server/usage

Usage tracking: local transcript scans priced against list price, with lane attribution and budgets.

## Invariants

Each entry is a rule, its why, and where it is pinned. Mechanism lives in the code.

### Usage Tracking

- Costs are estimates against list price, not bills, over local transcripts only. Budgets evaluate on a COMPLETE scan pass, or after three consecutive io-failed passes since an undercount can only delay an alert, and only a complete or an incremental io-failed pass writes the warehouse: a byte-limited pass, or an io-failed pass that already reset the store, would store an undercount as durable truth and burn a once-per-period alert. State files are quarantined beside the original when corrupt and never rewritten while unreadable, and a budget alert is stamped fired only after it delivered (`server/json-file.ts`).
- The warehouse exists because Claude Code deletes transcripts after about 30 days; it extends the DAILY series only. Live wins inside live coverage, history fills in only behind it and is labelled: a day Glimmervoid remembers is a different claim from one it can still see.
- Lane attribution is EXACT, never inferred: a session counts only because Glimmervoid recorded spawning it, everything else is `other`. Guessing from a cwd would mis-bill a lane.
- The ledger (`usage-lanes.json`) is keyed by a VENDOR-NAMESPACED composite `<vendor>:<sessionId>`, the same shape the scanner's dedup uses, so a codex id cannot collide with a claude one now that Glimmervoid supervises both; a pre-M5 file keyed `claudeSessionId` round-trips as vendor `claude`. It is written from the `claude-session-id` event (name kept for wire/back-compat; payload now carries `{ vendor, sessionId }`, `vendor` from the session's adapter `usageVendor`).
- Wire-unit traps, normalized once in `public/usage/usage-view-core.ts`: `tokenLimit.pct` is a RATIO, not a percentage, and `scan.dirs` an ARRAY, not a count; face-value reads fail silently. Today is the SERVER's day, or a viewer in another zone reads the wrong bucket.
- The statusLine relay MUST chain the operator's own, since a per-session settings file REPLACES the global one and would delete their HUD; its POST is abandoned quickly to add no latency. The reply stays plain `{ ok, reason }`: telemetry must never become an injection point.
