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
- the watcher stands alone: The watcher's code, and everything it imports, reaches only the link contract, the signing core and its own files.
  over: every code file under cloud/watcher and every file it is allowed to import
  via: the watcher imports only the link contract, the link signing core and its own code, so it can run on a box with no server
  because: the watcher must run on a separate always-on box with no server code, and a server import would drag lane logic and secrets into it
  kinds: none
