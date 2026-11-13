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
- boards outlive sessions: A whiteboard is removed only by an explicit delete; a session closing or being removed disconnects it from its boards and leaves every board in place.
  over: every board a closing or removed session was connected to, whether it was the board's last connection or not
  via: the operator connects and disconnects a session from the dashboard, and a removed session leaves every board and keeps the boards only it was on
  because: boards now carry plans and designs across sessions and restarts; deleting a board with its last session threw away the operator's work the moment the agent exited
  kinds: none
- agent board list is the project's: An agent's board list holds only boards of its own project or unfiled, leaves out archived boards unless it asks for all, and a title names only a board of its project or an unfiled one.
  over: every board list and title lookup an agent makes, through the MCP tool or the agent CLI
  via: an agent lists its own project boards in use, all lists every board, a title resolves only in its project, and a board idle 30 days unconnected is archived until a connect or an edit
  because: boards outlive their sessions, so without the project scope every agent would wade through every other repository's boards and a common title would open another project's board
  kinds: none
- code session claimed only within the project: A board's code session passes to a connecting session only once the old one is gone and only to a session of the board's project or an unfiled board's first session.
  over: every connect of a board whose code session is gone or whose project differs from the connecting session's
  via: once its code session is gone a board checks refs against its project, the next session of its project to connect takes over the refs and keeps them while live, and no agent deletes an unfiled board
  because: a session of another repository taking a board's code session would check its refs against the wrong tree and show another tree's changes on the board
  kinds: none
- boards deleted only within the project: An agent deletes a board only when the board is filed under the agent's own project; another project's board is refused and stays.
  over: every delete an agent sends, through the MCP tool or the agent CLI
  via: a session deletes a board of its project and is refused a board of another project
  because: boards outlive their sessions, so an agent of one repository deleting another repository's board destroys work it never owned
  kinds: none
- unfiled boards deleted only by the operator: An agent's delete of an unfiled board is refused and leaves the board unfiled, so only the operator deletes a board no project owns.
  over: every delete an agent sends for a board whose project is null
  via: once its code session is gone a board checks refs against its project, the next session of its project to connect takes over the refs and keeps them while live, and no agent deletes an unfiled board
  because: a board made on the dashboard belongs to the operator until a session files it; an agent's delete would otherwise first file it under its own project and then destroy it
  kinds: none
- first prompt names other sessions' project boards: A new session's first prompt names at most the five newest unarchived boards of its own project that it neither made nor is connected to, and later prompts in the same server run name none; after a restart, a session never names its own boards.
  over: every session's first prompt, and every prompt of a session after a server restart
  via: a new session first prompt names the five newest boards of its project in use, once
  because: boards outlive their sessions, so a new session would otherwise not know a plan for its repository already exists; naming its own board or another repository's sends it to the wrong place
  kinds: none
- agents never approve packs: No agent verb, MCP action or pack source change approves a pack; a pack an agent installs, or one enabled or updated from a pack source, waits in Pending until the operator approves it in the Packs tab.
  over: every packs command an agent sends and every pack source add, enable and update
  via: an agent adds a git pack source whose packs stay off until the operator enables one, update reinstalls it so a changed pack waits for approval again, and removing the source deletes its clone and installs
  because: an approved pack can start agents and run commands on this machine; an approval the operator never saw would run code they never read
  kinds: none
