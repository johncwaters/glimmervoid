# Knowledge graph: intent

Experimental. Behind `knowledgeGraph.enabled`, off by default. Code lives in `knowledge-graph/`, reached only through `server/knowledge-graph-cli.ts`.

## Why it exists

The operator keeps work knowledge, references, research and project tasks as markdown in a Claude artifact. Free text links rot and cannot be queried: nothing stops a task pointing at a note as its project, and "what is unblocked" is a manual read. The knowledge graph replaces that with a strongly typed graph: node kinds with strict fields, and a closed table of edge types that says which kinds each edge may join, how many it may have, and whether it must stay acyclic. A bad write is refused at the boundary instead of discovered later.

Offline and local first: one SQLite file under the Glimmervoid home (`node:sqlite`, no dependency). Notion, Postgres, TypeDB and Graphiti were weighed and rejected for now, because each needs a service, an account or a schema language heavier than the problem.

## Relationship to Coherence

The two have different goals and must never conflict.

| | Knowledge graph | Coherence ledger |
|---|---|---|
| Scope | One operator, across repos and outside code | One repo, code intent |
| Owns | Personal task status, notes, references, questions | Work orders, decisions, verification |
| Writes | Only its own SQLite file | Only `.coherence/` in its repo |

- The knowledge graph holds read-only pointers (`coherence_record` nodes joined by `tracked_by`) to work orders and decision journal records (decisions, blocked reports, conjectures). It never copies a record and never writes into a repo.
- Task status in the graph and work state in the ledger stay separately owned. `glimmervoid kg delta` only reports where they disagree, a completion without verification, or a retracted decision; it never syncs either side.
- A repo whose ledger or CLI cannot be read degrades to unavailable for that repo; the rest of the graph keeps working.
- The factory does not get a graph of its own here. Each repo's Coherence ledger already is the factory graph.

## Why it is kept apart

It is an experiment and may be deleted whole. So it imports nothing from Glimmervoid, spawns no process itself (the Coherence runner is injected), and Glimmervoid reaches it only through its CLI wiring. `tests/knowledge-graph-boundary.test.ts` fails on any import that crosses that line. Removing it means deleting `knowledge-graph/`, the wiring file, its tests, the `kg` command and the `knowledgeGraph` setting.

## Known couplings

- Coherence has no JSON output for decisions, so the graph reads `.coherence/decisions/*.jsonl` directly. A change to that row format breaks the reader, which then reports the repo unavailable rather than guessing.
- Pointers store the repo's absolute path; moving a repo leaves them reported as unavailable.
