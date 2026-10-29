<!-- Generated: 2026-07-03 -->

# notifications

## Purpose
The notification domain: the lifecycle state machine deciding when the operator is notified, and the delivery channel adapters.

## Key Files

| File | Description |
|------|-------------|
| `notification-manager.ts` | Notification lifecycle state machine (states in `../shared/notification-states.ts`); focus suppression defers, never drops |
| `channels/` | Delivery adapters: web-notification (primary, via control WS) and Telegram; see `channels/AGENTS.md` |

## For AI Agents
- The per-state notify decision lives in `../session/core/notify-gate.ts`; the manager only owns entry lifecycle and timers.
- See root `AGENTS.md` ("Notifications (lifecycle + delivery)") for the delivery contract.

## Invariants

Each entry is a rule, its why, and where it is pinned. Mechanism lives in the code.

### Notifications

- Acknowledge the old entry BEFORE deciding the new one, or a WAITING to COMPLETE hop lands on a live DELIVERED entry and delivers nothing.
- Terminal categories fire once per WORK CYCLE, started only by a USER-driven RUNNING entry, so a lead waking N times per prompt fires once. `user_kill` is always silent.
- Focus suppression DEFERS, never drops, and is PER-CONNECTION: a global rule was right with one device and wrong once a paired phone existed. Zero connections never suppresses.
- Telegram pings are durable, browser notifications are not (operator ruling): a lost phone ping is unacceptable, a duplicate is a shrug. Session alerts reach Telegram ONLY through phone escalation, never with the first delivery, even with no dashboard open (operator ruling 2026-10-28: the phone hears only about input left sitting).
- One alert group clock spans every session: dashboard deliveries within `notifyDebounceMs` of a group's start fold into it, so the browser sounds once per burst; the browser decides sound only from the `notify` message's group, never from raw state.
- The phone rung measures operator idleness, not entry age: keystrokes in ANY session defer it, and typing on for a full delay after the entry counts as seen (operator ruling, one ping per idle burst, not one per session). Only real keystrokes count, never terminal replies (`isOperatorKeystroke`).
