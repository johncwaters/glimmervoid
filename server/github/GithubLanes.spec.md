# GitHub lanes

GitHub lanes: issue and pull request polling, the canonical PR store (`core/github-store-core.ts`, `github-store-poller.ts`, `github-store-wiring.ts`), and the opt-in team PR review that acts under the operator's name

## invariants
- issue lists from the watcher: The Issues tab shows the watcher's issue lists for every project, assigned and team source; an unchanged page costs a 304, a failed source names itself and keeps its rows, a list older than the last one for its source changes nothing, and an issue closed from the tab stays out until a list after the hold or a reopen.
  over: every issue list the watcher delivers to the server's job inbox, and every close or reopen made from the Issues tab
  via: issue lists from the watcher fill the Issues tab with project, assigned and team issues, an unchanged page costs a 304 and no linked pull request read, a restarted watcher that could not read linked pull requests keeps the held ones, a failed source shows its error, a list older than the last one for its source changes nothing, a closed issue stays gone after Refresh even when a list taken before the close is planned after it or after a settings restart, and comes back with the next list once reopened
  because: the server no longer reads issues itself, so a dropped etag, a silently failed source, an out-of-order list or a list planned after a close would show the operator wrong rows with nothing to correct them for a poll interval or more
  kinds: none
- crowded issue listing falls back to search: A repository whose first listing pages hold fewer than 300 issues because pull requests fill them is listed newest-updated first, then through issue search from that list on.
  over: every project repository and assigned-issue source the issues watchee lists
  via: a repository whose first listing pages are crowded with pull requests is listed newest-updated first and then through issue search from that list on
  because: on a busy repository the REST open-issue listing returned 2 issues in 100 rows, so the tab lost recently active issues until the listing sorted by update and fell back to search
  kinds: none
- workflows list from the watcher: A workflows rule fires once per pull request transition from the watcher's lists, its snapshot is stamped with the server clock, and a list older than the last one for its repository changes nothing.
  over: every workflows candidate list the watcher delivers
  via: a pull request list from the watcher drives a workflow rule: approving the operator pull request labels it once, using the viewer the watcher looked up, stamps its snapshot with the server clock, and ignores a list older than the last one
  because: a snapshot stamped by a watcher clock running ahead silenced the lane across restarts, and an out-of-order list would replay or drop rule events
  kinds: none
- my pull requests list order: A my pull requests candidate list older than the last one accepted changes nothing.
  over: every my pull requests candidate list the watcher delivers
  via: a stage the store shows while a rebase is in flight keeps its clock when the tick finishes on its older snapshot, and a pull request list older than the last one changes nothing
  because: an out-of-order list would drop held pull requests from the watched set and the tab
  kinds: none
