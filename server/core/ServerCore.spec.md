# Server core

The pure decision modules behind every server shell: no IO, no clock, no Session

## invariants
- environment secrets never persisted: A secret the environment provides is never written to config.json by any save.
  over: a config save while GLIMMERVOID_POSTHOG_API_KEY and GLIMMERVOID_TELEGRAM_BOT_TOKEN come from the environment
  via: a save leaves out every secret the environment provides
  because: a dashboard save would otherwise copy an environment secret into a plaintext file the operator meant to keep it out of
  kinds: credential, storage
  checklist: scoped-reads dismissed: the config is one operator's file, there is no scope to read across
  checklist: capability-authorization dismissed: the secrets are passed to their services, not checked here
  checklist: revalidated-permission dismissed: saves run at once, nothing is queued
  checklist: message-authenticity dismissed: no message is accepted here
  checklist: encrypted-storage dismissed: config.json is the operator's local file; a secret entered in the dashboard is stored as entered by design, and an environment one is not stored at all
  checklist: key-rotation-compatibility dismissed: no encryption key exists
  checklist: input-validation dismissed: the config schema in shared/contracts validates every save
  checklist: revision-preservation dismissed: config.json keeps no revisions
  checklist: separation-of-duties dismissed: one operator owns the config
  checklist: commit-ordered-effects dismissed: a save has no external effect
  checklist: durable-dispatch-intent dismissed: nothing is dispatched by a save
  checklist: declared-target-coverage dismissed: a save writes one file
  checklist: completion-evidence dismissed: a save completes with the file write
