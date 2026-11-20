# Design

Settle the design as code before any is written.

1. Draft design nodes from the decisions and the code they touch, one per piece a reviewer judges on its own:
   - `behavior`: the desired flow as a walkthrough.
   - UI mockups, whenever a unit changes a UI file, at any risk: build each screen state and each alternative as an HTML page in the project's taste (the `designing-ui` taste step), the same markup the build later starts from, so no detail is lost translating a picture into HTML. Save them under `~/.agents/specs/<repo>/<slug>.mockups/`, put each on the Glimmervoid whiteboard with `show`, and record `board: { id, boxes, pages }` on a `behavior` design, `pages` as absolute paths. With rounds on, the round asks against the board; with rounds off, still build and show them, take the recommended alternative as `assumed`, and continue without waiting. Only with no board in the session, or a UI file change nobody can see, write a decision with `mockup: "none"` saying which.
   - `architecture`: the components, the contracts between them, and the data model.
   - `program`: types, function signatures, the call graph, and pseudocode for logic a signature leaves open, each with `at` naming its file.
   - `machine`: each lifecycle the feature adds or changes (a status, mode, or phase, or booleans that together encode one): `states` with the initial state first, `transitions` as `[from, event, to]`, and `at`, the one module that writes it. A spec above low risk with no lifecycle carries a decision with `"lifecycle": "none"` saying why.
   Write code in the repo's language, and pseudocode where that language adds only noise.
2. Each place the design could go more than one way is a branch; ask it through `ask.md`.
3. Once those branches close, set status `grilled` and continue to `slice.md`.
