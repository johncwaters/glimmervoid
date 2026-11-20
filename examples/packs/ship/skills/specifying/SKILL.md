---
name: specifying
description: Turns a feature request into a design spec, a typed and validated JSON graph of decisions and units of work. Sketches it from the repo and outside research, settles each decision on research, leaving the operator only contested or irreversible ones, cuts it into ticket-sized units with verifiable contracts, and runs challenging-plans on them. Use for /specifying, "spec this", "sharpen this", "grill me on this", and before the first edit of any change that involves a choice, which the ship pack's spec gate enforces.
---

# Spec

Settle a feature's hidden decisions on research, leaving the operator only the contested, irreversible, or critical ones.

Terms: design spec, sketch, branch, question round, decision, design node, open question, unit of work, contract, ticket, intent, challenge stamp. Defined in `<skill-dir>/GLOSSARY.md`; read it first.

**Input.** The feature in the operator's words and the repo in the working directory.

**Output.** A design spec at `~/.local/state/ship/specs/<repo>/<slug>.json` with status `challenged`, its intent file beside it, and the intent built.

**Paths.** `<skill-dir>` is the directory you loaded this SKILL.md from; the scripts and `subskills/` live there, whichever agent runs the skill.

## Subskills

Read each file under `subskills/` as you reach it.

| Order | Subskill | Status it sets | The graph then holds |
|-------|----------|----------------|----------------------|
| 1 | `sketch.md` | `sketch` | one goal with its problem, and a branch per guess |
| 2 | `grill.md` | `grilled` at risk `low`, else none (stays `sketch`) | zero branches |
| 3 | `design.md` | `grilled` | design nodes with every branch closed |
| 4 | `slice.md` | `sliced` | vertical units with full contracts, every decision and design node implemented or a constraint |
| 5 | `challenge.md` | `challenged` | the challenge stamp |

Every question round runs through `subskills/ask.md`.

An existing design spec resumes at the subskill after its status. A `challenged` one resumes in `grill.md` when the operator brings the answer to an open question.

## Design spec graph

```json
{
  "status": "sliced",
  "request": "let me export my deck as csv",
  "repoRoot": "/home/me/Projects/decks",
  "nodes": [
    { "id": "G1", "kind": "goal", "text": "A deck exports to a CSV file from the deck page.", "risk": "low", "criteria": ["The exported CSV contains the deck names, sets, and quantities.", "The exported CSV carries a price per row when pricing is licensed."] },
    { "id": "N1", "kind": "nonGoal", "text": "Importing a CSV." },
    { "id": "D1", "kind": "decision", "question": "Which columns?", "answer": "Name, set, quantity.", "why": "Matches what trading sites import.", "source": "decided" },
    { "id": "D2", "kind": "decision", "question": "Where is the CSV built?", "answer": "In the export module.", "why": "It already streams the JSON export.", "source": "read", "evidence": "src/export/index.ts:14" },
    { "id": "Q1", "kind": "openQuestion", "question": "Is price a column?", "settledBy": "The pricing provider's license terms." },
    { "id": "I1", "kind": "design", "layer": "program", "title": "CSV writer", "at": "src/export/csv.ts", "code": "type CsvRow = { name: string; set: string; quantity: number };\nexport function writeDeckCsv(deck: Deck, out: Writable): Promise<void>;" },
    { "id": "U1", "kind": "unit", "title": "Add the CSV writer", "reads": ["src/export/"], "changes": ["src/export/csv.ts"], "checks": [{ "run": "npm test -- export" }], "serves": [1] },
    { "id": "U2", "kind": "unit", "title": "Add the price column", "reads": ["src/export/csv.ts"], "changes": ["src/export/csv.ts"], "checks": [{ "run": "npm test -- export" }], "serves": [2] }
  ],
  "edges": [
    { "from": "U1", "kind": "implements", "to": "D1" },
    { "from": "U1", "kind": "implements", "to": "D2" },
    { "from": "U1", "kind": "implements", "to": "I1" },
    { "from": "U2", "kind": "implements", "to": "D1" },
    { "from": "U2", "kind": "dependsOn", "to": "U1" },
    { "from": "U2", "kind": "deferredBy", "to": "Q1" }
  ]
}
```

Every other field, and which status requires it, lives in `lib/graph.ts`.

The `validate-spec.mjs` write hook accepts a graph that passes `lib/graph.ts` for its status. Its denial names each rule and the fix; apply them and write again. Run the same checks, or view the graph, at any time with the scripts below.

## Cut and build

A `challenged` design spec with every open question answered cuts into one intent, a ticket per unit:

```
node <skill-dir>/cut.ts <spec.json>
```

It writes `<slug>.intent.json` beside the design spec, or names what to settle first. The session that wrote the design spec becomes the intent's one dedicated session and builds all of it: read `subskills/build.md`.

## Hand off

1. Show the `tree` rendering, then reply with the path, the goal's problem, criteria, and risk with the signal that set it, every open question with the units it defers, every `assumed` decision, and every budget waiver.
2. With an open question left or a `critical` goal, stop there; a critical goal's approval is the operator's reply.
3. Keep without asking every `assumed` decision the challenge did not overturn and every changed design node whose code you wrote.
4. Settle each decision `challenge.md` step 2 overturned and each changed design node whose code the operator chose in a round, keep or restore, with a question round through `ask.md`, since the challenge undid their own answer. A restore follows `challenge.md` step 5, and a changed answer resumes in `grill.md`. A kept overturn sets that decision's source to `decided`, keeping its `why`.
5. Once none is left, unless the operator asked for the design spec alone, cut and build without asking.

## Scripts

- `validate.ts`: `node <skill-dir>/validate.ts <spec.json>` runs the same graph checks the write hook runs, at any status.
- `render.ts`: `node <skill-dir>/render.ts <spec.json> tree|design` draws the graph; `tree` also reads an archive's structure.
- `cut.ts`: `node <skill-dir>/cut.ts <spec.json>` cuts a `challenged` design spec into its intent file, or names what to settle first.
- `archive.ts`: `node <skill-dir>/archive.ts <spec.json> built|abandoned` archives a design spec and its intent file.
- `report.ts`: `node <skill-dir>/report.ts` lists archived specs with landed tickets and sweeps specs idle 14 days as abandoned.
