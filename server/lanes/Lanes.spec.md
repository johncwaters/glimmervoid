# Lanes

Lane spawning: the ephemeral judge lanes and the interactive work lane, with their logging and status

## invariants
- watcher feed silence: A watchee lane says it has no list once two awake poll intervals pass without one from the watcher, and any delivered list, even one older than the last, clears it.
  over: every watchee lane fed through server/lanes/watchee-feed.ts
  via: team review says it has no pull request list once two awake poll intervals pass without one, and clears it when one arrives
  because: a stopped or unreachable watcher otherwise leaves every GitHub lane showing stale rows with no error
  kinds: none
- watcher feed counts older lists: A list stamped earlier than the last one still proves the watcher is alive.
  over: every list a watchee lane accepts
  via: a pull request list stamped earlier than the last one still counts as the watcher feed arriving
  because: a watcher clock stepped backward made the lane report a dead watcher while lists kept arriving
  kinds: none
