<!-- Parent: ../AGENTS.md -->

# tests

The automated suite `npm test` runs (node:test, no framework). It holds rules, not a mirror of the code: a test earns its file only by failing on a defect nobody meant to write.

| Path | Role |
|------|------|
| `gates/` | Repo-wide rules: each walks the tracked tree or a whole catalog and fails on any entry that breaks the rule |
| `*.test.ts` | Wire and persisted contracts, end-to-end runs through real components, hostile-input edges |
| `fixtures/` | Recorded session JSONL replayed through the real adapters |
| `helpers/` | Shared setup that is not itself a test (the `*.test.ts` glob skips it) |

## For AI Agents

- A new rule is a gate in `gates/`, never a test that pins one module's source text.
- Outside `gates/`, drive real components: a booted backend, a temp git repo, real files, a PTY, a child process, or a replay fixture. A test that restates the code or wires fakes together is not added.
- No real network and no live agent binary; a fake agent binary on PATH is fine.
- `node --import ./tests/helpers/isolate-home.ts --test <file>` runs one file.
