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
  via: a server starts one local doorman found by its port file, replaces it when Glimmervoid changes version, and the doorman stops once its whole home is deleted
  because: the local doorman outlives the server, so without the lock, version check and table exit a restart would stack doormen, an update would keep running old code, and a removed home would leave a daemon behind
  kinds: none
- the watcher stands alone: The watcher's code, and everything it imports, reaches only the link contract, the signing core and its own files.
  over: every code file under cloud/watcher and every file it is allowed to import
  via: the watcher imports only the link contract, the link signing core and its own code, so it can run on a box with no server
  because: the watcher must run on a separate always-on box with no server code, and a server import would drag lane logic and secrets into it
  kinds: none
- app tokens stay read-only and fill in: A doorman with a GitHub App binds only the installations its tenant's own user token lists, gives the tenant watcher a read-only installation token scoped to the repositories that user reaches, re-mints before the hour ends, hands the awake server the same token over the signed link for its lanes, and fills in only where no read token is set.
  over: a tenant that connected through the device flow, an installation where the user reaches no repository, the token's last ten minutes, and a server that sends an operator read token
  via: a doorman with a GitHub App binds the installation its tenant connected through the device flow, mints a read-only installation token scoped to the repositories the user reaches, probes with it while the server sends no read token, re-mints before the hour ends, hands the awake server that token over the signed link, and leaves an operator read token in charge
  because: an installation id from a redirect can be forged and an empty repository list mints for the whole installation, the tenant server sleeps through most hours so only the doorman can keep a one-hour token fresh, and an installation token cannot read notifications, so it must never displace a personal read token
  kinds: none
- user tokens have one writer: Only the doorman refreshes a tenant's GitHub user token, one refresh at a time, always from the newest sealed refresh token, and a refused refresh asks the carbon unit to reconnect.
  over: concurrent callers, a doorman restart mid-refresh, a revoked refresh token, a disconnect during sign-in, and an App whose device flow is off
  via: only one refresh of a tenant GitHub user token runs at a time, a doorman restart refreshes from the newest stored refresh token, a refused refresh asks for a reconnect, a disconnect outlasts a sign-in still finishing, and a disabled device flow reads as unavailable
  because: GitHub refresh tokens are single use and a refresh kills the old access and refresh tokens, so a second writer or a reused token loses the connection
  kinds: none
- hosts wake from their status: A doorman's GCE host adapter resumes a suspended instance, starts a terminated one, waits out a state change and a passing Compute API error, suspends only a running instance, and fails a stop that leaves the instance anywhere but stopped.
  over: every instance status, a 429 or 5xx while reading the status, and a stop that finds the instance in repair
  via: the GCE host adapter resumes a suspended instance, starts a terminated one, waits out a suspend in progress and a passing 503, suspends only a running one, refuses to call an instance in repair stopped, and fails on a refused call
  because: a suspended instance cannot be suspended again and one suspended past 60 days comes back terminated, so acting on a stale guess fails the wake, and a stop that silently did nothing would book a running host as asleep and let it run past its awake hours
  kinds: none
- edge wakes are limited: A doorman wakes a hosted tenant from its public hostname at most the configured number of times an hour, answers a browser opening a sleeping tenant at once with a page that reloads itself, and past the limit leaves the host asleep with a Retry-After, counting the hour's edge wakes from the awake ledger after a restart.
  over: a browser and a script hitting a sleeping tenant, repeated wakes inside one hour, the wake the limit refuses, and a doorman restarted inside that hour
  via: a hosted doorman answers a browser opening a sleeping tenant with a waking page at once, counts only wakes that started the host, and past the edge wake limit leaves the host asleep with a Retry-After an hour out, even after a doorman restart
  because: anyone who knows a tenant's hostname can send a request, and every wake spends at least the server's idle minutes of the tenant's awake hours, while the tenant's own watcher wakes carry real work; a recreated doorman VM would otherwise start each hour's count over
  kinds: none
- bucket state survives the doorman: A doorman serving a state bucket reads its tenant table and Secret Manager link secrets from it, keeps watcher files per tenant, appends awake events to month objects under a generation match, and a restarted meter rebuilds usage and the edge wake count from the newest months.
  over: a racing ledger writer, events on both sides of a month boundary, a missing watcher file, and a restart
  via: the Cloud Storage doorman state reads its table and Secret Manager link secrets, keeps watcher files per tenant, appends awake events into month objects under a generation match that survives a racing writer, and a restarted meter rebuilds usage and the edge wake cap from the newest months
  because: the doorman VM and its disk are replaceable, so state kept only on that disk is lost with it, and a blind ledger write would drop the events of a writer it raced
  kinds: none
- a wake rechecks the watcher: A server whose idle-stop tick sees the wall clock jump more than 30 s past the tick runs its remote watcher status check at once, and a steady tick never does.
  over: a steady tick, a jump just under 30 s, and a three hour sleep
  via: a server that wakes from a sleep longer than 30 s rechecks its remote watcher at once instead of waiting out the status timer, and a steady tick never does
  because: node timers stop while the machine sleeps, so after a long suspend the status check and the GitHub App token, whose expiry is on the wall clock, would wait out a minute or more of paused countdown
  kinds: none
