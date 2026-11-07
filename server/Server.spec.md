# Server

The backend runtime: the HTTP server and both WebSockets on loopback, the lanes, git workspace management and the shell around every pure core

## entrances
- pair route: a device on the network redeems a pairing token to join remote mode
  handler: remote-auth.ts
  trust: remote

## invariants
- child process chokepoint: Only server/child-process-safe.ts imports node:child_process, so every spawn outside a PTY goes through its scrubbed, shell-free wrapper.
  over: every source file under server, session, detection, notifications, shared, bin and scripts that is not child-process-safe.ts
  via: only child-process-safe.ts imports child_process directly (all spawns go through it)
  because: a direct child_process call can pass shell: true or the unscrubbed environment, leaking the operator's secrets into a subprocess or running a shell string
  kinds: credential
  checklist: capability-authorization dismissed: the wrapper grants no credential; it withholds the environment's
  checklist: revalidated-permission dismissed: a spawn runs at once, nothing is queued under an older permission
  checklist: message-authenticity dismissed: no message is accepted here
  checklist: encrypted-storage dismissed: nothing is persisted by the spawn wrapper
  checklist: key-rotation-compatibility dismissed: no key is held or rotated
  checklist: separation-of-duties dismissed: one actor, the glimmervoid process, spawns every child
- pairing token single use: A pairing token joins at most one device, and a replayed, expired or unknown token joins none.
  over: every redemption of a minted pairing token through the pairings store
  via: redeem mints a device, marks the token used, and is single use
  because: a pairing link can leak through chat or shell history; a reusable token would let anyone holding it pair a device into remote mode
  crossing: remote -> host
  entrances: pair route
  kinds: credential
  checklist: capability-authorization declared as pairing token single use
  checklist: revalidated-permission dismissed: a redemption is decided when the request arrives, nothing is queued
  checklist: message-authenticity dismissed: the token is a bearer secret; no message signature is part of pairing
  checklist: encrypted-storage dismissed: only the token's hash and the device secret's hash are persisted, never the secrets
  checklist: key-rotation-compatibility dismissed: no key is held or rotated; each device holds its own minted secret
  checklist: separation-of-duties dismissed: one operator mints and redeems on their own devices
- agent-made worktree cleanup floor: Branch cleanup removes a worktree it picked only for sitting in the worktree root once it is clean, merged, untouched for a day, outside every live session folder and not a configured project.
  over: every worktree under the worktree root whose branch matches no cleanup prefix
  via: branch-gc removes a clean merged worktree an agent made under the worktree root only once it sits untouched a day, never one inside a live session or a configured project
  because: an agent still working in a worktree it made by hand would have it force-removed under it
  kinds: none
- paused cards get no live bytes: A dashboard data socket that asks to pause output gets no terminal bytes until it resumes, whether it attached paused or paused mid-stream, and resuming lands it on the live screen.
  over: every pause-output and resume-output a data socket sends, at attach or mid-stream
  via: a hidden card attaching paused gets no screen until it resumes, then lands on the live screen without reconnecting, and pausing again stops live bytes
  because: hidden cards that keep streaming spend the browser's render budget on terminals nobody sees, and nothing on screen shows it
  kinds: none
