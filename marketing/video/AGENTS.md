# marketing/video

`boards-riff/` is the standard every new video follows: start by copying its folder (`template.html`, `build.mjs`, `cues.json`, `render.sh`, the posted cut) and keep its look. `boards-intro/` is the older cut, kept as the posted record only.

## Rules the standard set, with why

- The agent never touches a mouse or cursor on screen, because agents drive a board through tool calls and viewers must not think otherwise. Wherever the terminal is on screen, its board work shows as `whiteboard get` / `whiteboard put` lines landing alongside the board change.
- Only the operator moves a cursor or draws ink.
- Board content is drawn in the real board look: the fill, stroke, wire, arrowhead, step and status tokens of `shared/whiteboard-svg-core.ts`, with Lucide icons. A made-up style misrepresents the product.
- Music only, no sound effects: the operator judged the effects added nothing.
- Motion and color follow `brand-bible/` and `DESIGN.md`.
