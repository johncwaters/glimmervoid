# Cloud

The watcher, which runs the probes the server compiles and nudges the server on change, and the server's half of that link

## invariants
- changes reach the owning lane: A probe answer that changes reaches the lane that owns the probe as a nudge, and a probe's first answer never does.
  over: every probe the server delivers, from its first answer through each changed answer
  via: a probe whose GitHub answer changes nudges its lane, and the lane hears the watcher covers that probe
  because: a lost nudge leaves a lane showing stale data while its timers are off, and a nudge on a first answer would poll every lane each time the probe set changes
  kinds: none
- nudges carry the watcher key: The server acts only on a nudge signed with the watcher-to-server key, inside the clock skew window, seen once.
  over: forged signatures, stale timestamps, replays of an accepted nudge, and nudges signed with the server-to-watcher key
  via: the server refuses a nudge that is forged, stale, replayed or signed with the other direction key, and the watcher health check needs no signature
  because: a nudge makes the server spend GitHub calls, so an unsigned or replayed one would let anything that reaches the port drive the server's rate limit
  crossing: remote -> host
  kinds: none
- a silent remote watcher hands lanes back: A remote watcher that stops answering its status check, or whose nudges cannot reach the server, unlinks, so every lane returns to its own timers until it recovers.
  over: a remote watcher reached by URL, across answering, silent, nudges refused on the way back, and recovered
  via: a remote watcher links by URL and nudges its lane, and a watcher that stops answering or cannot nudge the server hands lanes back to their timers until it recovers
  because: every watcher lives in a doorman the server does not own, so there is no child exit event, so without the check a dead watcher or a broken doorman would leave lanes covered and their timers off
  crossing: remote -> host
  kinds: none
- one local doorman per server: With no watcher URL, a server starts at most one local doorman, finds it again by its port file, replaces it when Glimmervoid changes version, and the doorman stops once its tenant table is deleted.
  over: a first start, a second start at the same version, a start at a new version, and a deleted tenant table
  via: a server starts one local doorman found by its port file, replaces it when Glimmervoid changes version, and the doorman stops once its tenant table is deleted
  because: the local doorman outlives the server, so without the lock, version check and table exit a restart would stack doormen, an update would keep running old code, and a removed home would leave a daemon behind
  kinds: none
- the watcher stands alone: The watcher's code, and everything it imports, reaches only the link contract, the signing core and its own files.
  over: every code file under cloud/watcher and every file it is allowed to import
  via: the watcher imports only the link contract, the link signing core and its own code, so it can run on a box with no server
  because: the watcher must run on a separate always-on box with no server code, and a server import would drag lane logic and secrets into it
  kinds: none
- app tokens stay read-only and fill in: A doorman with a GitHub App gives its tenant watcher a read-only installation token scoped to the tenant's repositories, re-minted before the hour ends, and only where the server sent no read token.
  over: a tenant with an installation and no read token, the token's last ten minutes, and a server that sends an operator read token
  via: a doorman with a GitHub App mints a read-only installation token for its tenant watcher, probes with it while the server sends no read token, re-mints before the hour ends, and leaves an operator read token in charge
  because: the tenant server sleeps through most hours, so only the doorman can keep a one-hour token fresh, and an installation token cannot read notifications, so it must never displace a personal read token
  kinds: none
