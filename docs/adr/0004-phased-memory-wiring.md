# ADR-0004: Phased sequencing for wiring memory into index.ts

## Status
Accepted

## Context
`src/memory.ts` (issue #6) is built and unit-tested but not wired into
`index.ts` — no code currently calls its record/get functions. The natural
next question is how to wire it up, and specifically whether `decide()`
should start consulting memory as part of that wiring.

Issue #6's own "Read pattern" note already draws a boundary:

> No changes to existing decision logic required. The current heartbeat
> covers all current decisions — memory is purely additive. When
> memory-aware decisions land (e.g. "route to the best-paying merchant for
> this item"), they'll query the DB at the point of that decision. Nothing
> breaks until we add those callsites.

Separately, ADR-0003 explicitly defers extracting `decide()` into
`decisions.ts` until the utility-scoring rewrite (ADR-0001, issue #7)
lands, because `decide()` today mixes goal selection with inline execution
logic and extracting it as-is would just need to be redone once #7
reshapes it. Wiring memory lookups *into* the current `decide()` risks the
same mistake one level down: teaching soon-to-be-rewritten code to query a
database, work that's thrown away the moment #7 lands.

ADR-0002's target architecture also already answers a related question —
whether `decide()`/`decisions.ts` should query memory directly at all:

```
memory (dumb store)
  ↑
character / planners — read memory, report needs + viable paths
  ↑
pathfinding
  ↑
decisions — scores fully-resolved candidates, picks one
```

`decisions` is not supposed to read memory directly in the target design.
It scores candidates that planners already resolved using memory.
`decide()` today is a rough draft of that top layer with the resolving
logic (that's supposed to live in planners) mixed in — which is exactly
the tangle ADR-0003 names as the reason `decide()` hasn't been extracted.

### Supporting finding: the heartbeat is already an event-sourced snapshot
While discussing whether the bot should move to processing `onEvent`
exclusively (motivated by real noise in the heartbeat shape — see below),
inspection of `node_modules/programming-game/src/base-client.ts` showed
the SDK's client already reconstructs `onTick`'s heartbeat from its own
internal event-driven state each tick:

- `socketEventHandlers` is a full event→state reducer map (`hazardDamaged`,
  `used`, `dropped`, `loot`, `beganCasting`, `takingAction`, etc.), each
  mutating a locally-held unit via `updateUnit`/`updatePlayer`.
- `runOnTick` assembles the heartbeat handed to `onTick` from that same
  locally-held state (`charState.units`), not from a literal per-tick
  wire resend.
- `heartbeat.player` and `heartbeat.units[myId]` are the *same underlying
  object* — `getOnTickPlayer` does `Object.assign(getHandlers(char), char)`
  where `char` **is** `charState.units[charId]`.
- `heartbeat.items` / `heartbeat.recipes` / `heartbeat.constants` come
  from outer-scope constants in the SDK module (`localItems`,
  `localRecipes`, `localConstants`), not server-retransmitted data —
  same object reference every tick.

Implications:
- Hand-rolling our own `onEvent`-driven world-state mirror would duplicate
  logic the SDK already provides, tested and maintained by the game's
  authors — and would trade the heartbeat's self-healing property (a full,
  correct snapshot every tick, so a bug can only cause one tick's bad read)
  for a hand-rolled mirror's drift risk (a missed event or reducer bug
  corrupts state until restart, with no automatic correction). Not
  recommended.
- The specific complaints that motivated the question are real but
  narrower than "abandon the heartbeat": `heartbeat.player`/`units[myId]`
  duplication is two ways to reach identical data already filtered
  correctly wherever `index.ts` scans `units` for *other* units; `items`/
  `recipes` read off the heartbeat could instead be imported directly from
  `programming-game/items`/`programming-game/recipes` (already documented
  static modules in `CLAUDE.md`) with no behavior change. **Open caveat,
  not yet resolved:** `CLAUDE.md` currently says to *prefer*
  `heartbeat.constants` over "the deprecated `constants.ts` values" — the
  opposite direction — implying someone already hit a drift issue between
  the static constants and the live heartbeat value. Worth checking git
  history before assuming `items`/`recipes` don't have the same issue.
- Memory's write-side wiring (below) can lean on `heartbeat.units`/
  `heartbeat.gameObjects` each tick as the reliable "what's visible right
  now" snapshot, and hook `onEvent` narrowly just for the discrete facts
  memory specifically needs (`attacked`, `loot`, `acceptedQuest`, etc.) —
  it does not need its own general-purpose event-sourced mirror.

## Decision
Wire memory in three phases, sequenced by how much they risk being thrown
away when issue #7 lands:

### Phase 1 — Observation capture (now, unblocked)
Wire the *write side* only: `index.ts`'s tick loop and `onEvent` handlers
call `recordMonsterSighting` / `recordNpcSighting` / `recordResourceSighting`
/ `recordMerchant` / `recordCombatHit` / `recordMonsterKill` / `recordDrop`
/ `recordQuestSighting` / `recordExploredCell` / `recordSafeLocation` as
appropriate. `decide()` is not touched. Matches issue #6's "Read pattern"
note verbatim — purely additive, nothing breaks until read callsites are
added. Every tick this is delayed is unrecoverable lost history (kill
counts, drop rates, merchant sightings can't be reconstructed
retroactively), so there's no reason to wait on anything else.

Unlike the prior extraction PRs (equipment/craft/harvest/trade/quests),
this wiring PR adds new calls rather than removing existing inline logic
from `index.ts` — there's no memory-shaped logic in `index.ts` today to
extract. Lower risk than a typical wiring PR.

### Phase 2 — Planner-level reads (opportunistic, not blocked on #7)
Narrow read-side additions *inside already-extracted planner modules*
(`src/trade.ts`, `src/quests.ts`, etc.) — e.g. `findBestSellMerchant`
gaining a "no visible merchants, fall back to remembered ones via
`getMerchantTrades`" path. These modules sit below `decide()` in the call
graph today and are meant to survive into the `decisions.ts` world per
ADR-0002 (planners read memory; decisions doesn't), so this isn't
throwaway work — it's what a planner is for. Land these as normal,
individually-scoped changes whenever a specific memory-aware capability is
wanted, without waiting for Phase 3.

### Phase 3 — Decision-layer integration (blocked on issue #7)
Anything that means `decide()` itself starts consulting memory directly,
or the needs/produces aggregation layer described in ADR-0002 — deferred
until the utility-scoring rewrite (issue #7) gives `decisions.ts` the
right shape to receive it. Do not add memory lookups to the current
priority-stack `decide()`.

## Consequences
- Memory can start accumulating real history immediately (Phase 1) without
  betting on when #7 lands.
- Planner modules (`trade.ts`, `quests.ts`, `harvest.ts`, ...) become the
  natural home for "prefer remembered data when live data is
  insufficient" logic, reinforcing their role as the layer between memory
  and decisions per ADR-0002 — this is consistent with, not a deviation
  from, the existing architecture direction.
- `decide()` stays exactly as risky/stable as it already is until #7 — no
  new coupling is added to code already known to be rewritten.
- The heartbeat-vs-events finding means memory's write-side wiring (Phase
  1) should be implemented against `heartbeat.units`/`heartbeat.gameObjects`
  snapshots plus targeted `onEvent` hooks, not a bespoke world-state
  mirror.
- Follow-up, not yet done: verify whether `items`/`recipes` are safe to
  import statically instead of reading off the heartbeat, given the
  existing (unexplained, as of this ADR) preference for
  `heartbeat.constants` over `constants.ts`.
