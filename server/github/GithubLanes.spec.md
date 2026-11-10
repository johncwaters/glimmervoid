# GitHub lanes

GitHub lanes: issue and pull request polling, the canonical PR store (`core/github-store-core.ts`, `github-store-poller.ts`, `github-store-wiring.ts`), and the opt-in team PR review that acts under the operator's name

## invariants
- drafts follow the reviewed head: A team review draft is never left ready for posting at a pull request head it was not reviewed at: a moved head makes it stale, a returned head makes it ready again, and restoring or requeueing a discarded draft while the head has moved leaves it stale.
  over: the moves that can leave a draft ready at an unreviewed head: a head moving off and back onto the reviewed head, a restore while the head has moved, and a requeue of a discarded draft
  via: a saved draft goes stale when the pull request head moves, is ready again when it returns, shows a teammate comment review with its earlier reviews, and a discarded draft restores or requeues as stale at a moved head
  because: a draft left ready at a moved head posts an approval for code the reviewer never read, and nothing on the card shows it
  kinds: none
- the store reads what the watcher does not cover: A timed store read is skipped only while the watcher runs that exact request healthily and the store already holds its first answer.
  over: watches, pull request keys, behind counts and notifications, each covered or not
  via: a timer tick still searches a watch the watcher does not cover yet, and leaves a covered, loaded watch to nudges
  because: the watcher never nudges on a first answer, so skipping an uncovered or unloaded read leaves that list empty until GitHub happens to change
  kinds: none
- a failed nudged read runs again: A store read that a nudge started and that failed runs again until it succeeds, a bounded number of times.
  over: every nudged read, through each failure before it succeeds
  via: a nudged store poll that fails runs again until it succeeds, then stops
  because: the watcher has already stored the new answer and never nudges for it again, so a dropped retry loses that change
  kinds: none
- newly covered reads catch up once: A read the watcher newly covers gets one catch-up read, and coverage that did not change gets none.
  over: every change in the set of probes the watcher covers
  via: a probe the watcher newly covers gets one catch-up read, and the same coverage again gets none
  because: a change between the store's last timed read and the watcher's first answer is otherwise lost, and catching up on every unchanged report would spend calls for nothing
  kinds: none
