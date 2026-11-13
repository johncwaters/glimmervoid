# marketing/video

`boards-riff/` is the standard every new video follows: start by copying its folder (`template.html`, `build.mjs`, `cues.json`, `render.sh`, the posted cut) and keep its look. `boards-intro/` is the older cut, kept as the posted record only.

## Rules the standard set, with why

- The agent never touches a mouse or cursor on screen, because agents drive a board through tool calls and viewers must not think otherwise. Wherever the terminal is on screen, its board work shows as real Claude Code MCP tool calls (`glimmervoid - whiteboard (MCP)(action: "put")` with a result line) landing alongside the board change; a custom-looking terminal was rejected.
- Only the operator moves a cursor or draws ink.
- Board content is drawn in the real board look: the fill, stroke, wire, arrowhead, step and status tokens of `shared/whiteboard-svg-core.ts`, with Lucide icons. A made-up style misrepresents the product.
- Music only, no sound effects: the operator judged the effects added nothing.
- Motion and color follow `brand-bible/` and `DESIGN.md`.
- Dashboard chrome copies the real dashboard (the bracket mark from `shared/brand-mark.ts`, the Alt+J attention banner, the sidebar); a stale or invented logo was caught by the operator.
- The camera shows the input line whenever a prompt is typed, with a short pause before typing: typing out of frame reads as nothing happening.
- The music drop lands on a visual beat (`TIMELINE.flyStart`, the letters flying) and on a beat of the track (`clipAt`); off-beat or late drops were rejected.
