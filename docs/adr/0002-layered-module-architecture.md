# ADR-0002: Layered module architecture for index.ts decomposition

## Status
Accepted

## Context
`index.ts` has grown to ~1900 lines, mixing upgrade planning, inventory/storage
management, sell routing, crafting sequencing, arena state, the tick loop, and
the decision function in one file. This makes the entry point hard to navigate
and creates merge conflicts when multiple agents work on different bot
features at once (per `CLAUDE.md`'s "tasks touching `index.ts` are sequential"
rule).

## Decision
Decompose into layered modules with a one-directional dependency flow:

```
memory (dumb store)
  ↑
character / planners (upgrade, quest) — read memory, report needs + viable paths
  ↑
pathfinding — peer module, provides travel cost + waypoints to anyone
  ↑
decisions — scores fully-resolved candidate actions, picks one
```

Planners never call each other directly, even though real need sources are
mutually circular (a quest can both need and produce an item that crafting
also needs and produces). Instead, each planner independently self-reports
`needs`/`produces` for items it knows about, based only on memory and current
world state; a generic, domain-ignorant aggregation step merges these into a
per-item total; planners that pick between options (e.g. which monster to
hunt) read that aggregate read-only. This avoids an N×N coupling graph between
planners as more get added.

`index.ts` becomes wiring only: the tick loop, event dispatch, and
`connect()` — no business logic.

## Consequences
- Extraction can happen in parallel: each module is a "create the file, don't
  touch `index.ts`" PR (per `CLAUDE.md`'s parallelism rule), since `decide()`
  and the planning functions take/return plain data, not module instances.
  Wiring `index.ts` to import from the new files happens as a single
  consolidated PR at the end, since it's a mechanical import-and-delete pass
  with no behavior change.
- Utility scoring (the decision-model rewrite, issue #7) and persistent memory
  (issue #6) are implemented *inside* their already-extracted modules as
  follow-on work, not bundled into the extraction PRs — keeps structural and
  behavioral changes reviewable separately.
- Cross-need value normalization (comparing a quest's coin reward against a
  calorie-deficit need against a stat-delta upgrade) is an open problem,
  deliberately deferred — see `CONTEXT.md` → *Need (demand aggregation)*.
- Arena and overworld share one decision engine; arena is modeled as max
  threat level rather than a separate ruleset, so no arena-specific scoring
  code exists.
- The dashboard's client bundle (`dashboard-client.ts`) is transpiled via
  TypeScript's `transpileModule` with no module resolution, so it cannot
  import from the new `src/` modules as-is. Sharing types is free (erased at
  runtime); sharing runtime values (e.g. the SDK's `Items` enum) requires
  introducing a bundler (esbuild) — tracked separately from this decomposition.
