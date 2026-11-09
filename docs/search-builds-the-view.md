# Search that builds the view: product outline

Product outline for pickup in another session; nothing is built. Run `/specifying` on it before building; the open decisions at the end are not settled.

## The idea

One search bar. The carbon unit types what they want ("signups last week", "my positions and health factor"), and a fitting UI appears right away: assembled from premade components, filled with real data, and refined by editing the text. A decision model picks and arranges components; it never writes markup, prose, or numbers.

Reference: a 66 s demo by @GabiDev98 (x.com/GabiDev98/status/2119060310384365669). The tweet credits OpenAI's Decisions API; this build uses Jev instead.

## Interaction patterns to keep (from the demo)

1. **One bar, no navigation.** No tabs, menus, or filters. The query text becomes the result card's title.
2. **Layout first, data second.** The card shows a skeleton already shaped like the answer (table rows, stat tiles plus a chart), then the data fills in.
3. **One card built from a closed set of blocks:** entity header, stat tiles, headline number with a delta pill, chart with metric tabs and a period toggle, ranked table, threshold gauge, area chart with a range toggle, live ticking counter, scrub chart (hovering a bucket rewrites the headline), activity list.
4. **Refine by retyping.** Editing the query edits the current view in place rather than rebuilding it, with a blur transition between versions.
5. **"my" means the signed-in identity**, shown as a persistent pill in a corner with its key number.
6. **Pasting an identifier opens that entity** (an address, email, key, or id).

## Built on json-render and Jev

[json-render](https://json-render.dev) supplies the component catalog (Zod props, slots, events, actions), the spec format and the React renderer. Jev (`typesafe-ai/jev`, through Vercel AI Gateway) is a decision model: given **candidates** (catalog components with concrete props already filled in), it picks which to include, their order, and their parent and slot. It writes no data or prose and never runs actions. API: `experimental_createEvaluator` plus `experimental_composeSpec` in `@json-render/core` >= 0.21.0, experimental, so pin exact versions.

Implication: the creative work moves out of the model and into **candidate generation**. The pipeline:

1. **Resolve.** Parse the query against the domain's known entities (fuzzy match on names, keys, ids, "my"). Cheap, deterministic, no LLM.
2. **Generate candidates.** Each domain adapter turns resolved entities into a candidate pool: every block that could plausibly apply, with props pre-bound. Data props bind to state paths (`{ $state: "/signups/daily" }`), not literals, so candidates exist before any data loads. Each candidate gets a sharp `description`, because Jev sees descriptions and topology, not state or prop values. Mutually exclusive variants share a `resource`.
3. **Compose.** `experimental_composeSpec({ catalog, candidates, prompt, evaluate })` streams `step` snapshots (full specs). The first snapshot renders as the skeleton.
4. **Fetch.** For each candidate in the final spec, run its adapter query and write the result into renderer state at its bound path. Blocks fill in as their data lands. Only selected blocks fetch.
5. **Refine.** On re-submit, pass the current spec as `initialSpec` with the new text as `prompt`, so Jev edits rather than rebuilds. Unchanged blocks keep their state and do not refetch.

## Pieces to build

- **Block library:** the closed set from pattern 3, as json-render catalog entries and React components. Tables and lists take rows through one bound prop, because Jev's spec has no repeats.
- **Domain adapter interface:** `resolve(query) -> entities`, `candidates(entities, identity) -> Candidate[]`, `fetch(candidateId) -> data`. The engine knows nothing about any domain.
- **First adapter: PostHog**, read-only through the Query API (`POST /api/projects/:id/query`). It proves the adapter interface; it is not the product.
- **Shell:** the bar, the card, the identity pill, skeleton states and the blur transition between versions.

## Constraints from Jev's documented limits

- Default budget 32 evaluations, 32 elements, depth 8; 10 s per evaluation. Set an overall `signal` deadline.
- Supported expressions: literals, `$state`, `$bindState`, and state-based visibility only. No repeats, computed expressions, or conditional props.
- `stopReason` is `finish`, `unavailable`, or `limit`; errors throw. Keep the last snapshot and mark it incomplete.
- Disable interaction while a composition is running.
- Validate and authorize every action in its handler.
- Gateway team must allow the `typesafe-ai` provider (`AI_GATEWAY_API_KEY`). Free use reportedly ran until 2026-09-25; check current pricing.

## MVP acceptance

- 8 queries against the first adapter produce fitting views, with every number matching the source system.
- Skeleton in under 1 s; first block filled in under 3 s on warm data.
- A refinement keeps the blocks that did not change, without refetching them.
- A second adapter can be added without touching the engine or the shell (prove it with a stub domain).

## Non-goals (v1)

Writes or actions with side effects, saved views, sharing, multi-tenant auth, mobile layout.

## Still open for /specifying

1. **Where it lives:** a standalone app, a Glimmervoid view, or a library plus a demo app.
2. **Candidate pool size:** generate all plausible blocks per entity, or prefilter with a cheap classifier. Pool size drives Jev latency and cost.
3. **Ambiguity:** pick one reading and show it as a chip ("event `signup`"), or ask before composing.
4. **Spec caching** per normalized query and identity, for instant repeats.
5. **Fallback** when Jev is unavailable: a deterministic default layout per entity type, or an error.
6. **Visual direction:** `applying-house-style` for a personal project.
