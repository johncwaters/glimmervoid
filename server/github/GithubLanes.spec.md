# GitHub lanes

GitHub lanes: issue and pull request polling, the canonical PR store (`core/github-store-core.ts`, `github-store-poller.ts`, `github-store-wiring.ts`), and the opt-in team PR review that acts under the operator's name

## invariants
- drafts follow the reviewed head: A team review draft is never left ready for posting at a pull request head it was not reviewed at: a moved head makes it stale, a returned head makes it ready again, and restoring or requeueing a discarded draft while the head has moved leaves it stale.
  over: the moves that can leave a draft ready at an unreviewed head: a head moving off and back onto the reviewed head, a restore while the head has moved, and a requeue of a discarded draft
  via: a saved draft goes stale when the pull request head moves, is ready again when it returns, and a discarded draft restores or requeues as stale at a moved head
  because: a draft left ready at a moved head posts an approval for code the reviewer never read, and nothing on the card shows it
  kinds: none
