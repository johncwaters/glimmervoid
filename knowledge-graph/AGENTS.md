<!-- Parent: ../AGENTS.md -->

# knowledge-graph

Experimental typed knowledge and task graph behind `knowledgeGraph.enabled`. Intent and the Coherence boundary: `../docs/knowledge-graph.md`.

| File | Role |
|------|------|
| `graph-schema.ts` | Schema-as-data types and the pure edge, property and integrity checks |
| `personal-schema.ts` | The personal graph's kinds, edges and next-action ranking |
| `graph-store.ts` | SQLite store; a database file claims one schema name and refuses any other |
| `graph-views.ts` | Next actions and markdown export |
| `coherence-delta.ts` | Pure divergence report between graph tasks and ledger records |
| `coherence-source.ts` | Reads a repo's ledger through an injected Coherence runner |
| `cli.ts` | `glimmervoid kg` commands, all IO injected |

## Rules

- Import only siblings, `zod` and `node:` builtins other than `node:child_process`; Glimmervoid reaches this folder only via `server/knowledge-graph-cli.ts`. Why: it must stay deletable whole (`tests/knowledge-graph-boundary.test.ts`).
- Never write into a repo or a Coherence ledger, and never sync status either way; report divergence only. Why: the ledger is the agents' record, the graph is the operator's.
- A new edge or kind is a schema change: add it to the schema table and pin it with a test in `tests/knowledge-graph-store.test.ts`, never as free-text properties.
