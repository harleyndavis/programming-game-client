# ADR-0003: Conservative module extraction from index.ts

## Status
Accepted

## Context

ADR-0002 describes the full layered module architecture vision: memory → character/planners → pathfinding → decisions, with `index.ts` reduced to wiring only. Issue #14 was opened to execute that vision as a parallel extraction — one PR per module, no `index.ts` changes, then a single wiring PR.

A first extraction attempt (PRs #16–#21) exposed three problems with executing the full ADR-0002 plan immediately:

**1. Circular planner dependencies**

The planner layer has genuine mutual cycles. Crafting needs ingredients → ingredients come from harvesting → harvesting needs tools → tools are craftable items → crafting. Quest rewards can both supply and consume items that other planners need. Planners cannot import each other cleanly, and they cannot all receive the needed data through parameters without index.ts threading data from one module's output into another's input — which is just the same coupling, renamed.

The needs/produces aggregation described in `CONTEXT.md` is the intended solution, but it does not exist yet. Extracting planners before the aggregation layer forces a choice between circular imports and parameter bloat.

**2. Shared type ownership**

Types like `UpgradeTarget`, `RecipeList`, `ItemMap`, and `QuestMap` are used across multiple would-be modules. Without a canonical home established first, each agent independently defined them — producing duplicates that the wiring PR would have to resolve.

**3. `decide()` mixes layers**

The `decide()` function contains both goal selection (which task scores highest) and execution logic that belongs in domain modules (which recipe to craft next, which merchant to sell to). Extracting it as-is into `decisions.ts` would create a module that needs to be restructured again when the utility scoring rewrite (ADR-0001, issue #7) lands.

## Decision

Extract only the modules that are provably self-contained pure function libraries — no inter-module dependencies, no mutable state, no circular risk. `index.ts` remains the orchestrator and owns all mutable state and decision logic until the needs aggregation and memory layers exist to replace them.

### What gets extracted

| Module | Exports | Imports |
|---|---|---|
| `src/utils.ts` | `distanceBetween`, `isFiniteNumber`, `isFinitePosition` | nothing |
| `bot-types.ts` (expanded) | `RecipeList`, `ItemMap`, `QuestMap`, `UpgradeTarget`, existing dashboard types | nothing domain-specific |
| `src/inventory.ts` | `getInventoryWeight`, `isEncumbered`, `findHeaviestInventoryItem`, `computeDeposit`, `computeWithdrawForCraft`, `computeWithdrawForPurchase`, `computeWithdrawToSell`, `computeStorageFee` | utils, bot-types |
| `src/gear.ts` | `computeUpgradeTargets`, `computeDifficultyTier`, `canObtainChain`, `getChainedIngredients`, `getTargetItemsToKeep`, `getEquippedRecipeInputs`, `computeTargetsToBuyFromMerchant`, `findGearToEquip` | utils, bot-types |
| `src/craft.ts` | `findCraftableTarget`, `findNextCraftTarget`, `findCraftableSubStep` | utils, bot-types |
| `src/trade.ts` | `findBestSellMerchant` | bot-types, `programming-game/types` |

**Dependency rule:** `utils` and `bot-types` at the bottom. Domain modules (`inventory`, `gear`, `craft`, `trade`) import from `utils`/`bot-types` only — never from each other. `index.ts` imports from all of them.

### What stays in index.ts

- All mutable state: `recoveringAtHome`, `huntTier`, `stickyTargetId`, `depositInProgress`, `lastEquipment`, arena bookkeeping, etc.
- `decide()` and the full priority-stack decision logic
- The tick loop, event handlers, and `connect()` wiring
- `keepItems` aggregation (union of `gear.ts` + `craft.ts` outputs)
- Override priority chain: `withdrawOverride ?? depositOverride ?? decide()`
- Arena logic

### Why not extract `decide()`

`decide()` currently serves as both a goal selector and an inline executor of domain sub-steps (which recipe to craft, which merchant to use). Extracting it as-is produces a `decisions.ts` that would need to be restructured when:

1. The utility scoring rewrite (ADR-0001, issue #7) replaces the priority stack with scored candidates
2. Domain sub-steps migrate to their owning modules as part of that rewrite

Extracting and then immediately restructuring is net-negative. `decide()` stays in `index.ts` until the rewrite shapes what `decisions.ts` actually needs to be.

## Options Considered

### Option A: Full ADR-0002 extraction (original plan, issues #14, PRs #16–#21)

Extract all modules including `decisions.ts`, `character.ts`, `inventory.ts` simultaneously.

| Dimension | Assessment |
|---|---|
| Completeness | High — matches the full vision |
| Immediate complexity | High — circular planner deps, shared type ownership, parameter threading |
| Risk | High — wiring PR becomes a large untangle |
| Agent navigability gain | High |

**Rejected because:** The circular planner dependency problem has no clean resolution without the needs aggregation layer. Forcing a solution produces coupling that has to be undone.

### Option B: Conservative extraction (this ADR)

Extract only provably self-contained pure function modules now. Defer planners-calling-planners and `decide()` until the architecture supports them.

| Dimension | Assessment |
|---|---|
| Completeness | Medium — leaves decide() and state in index.ts |
| Immediate complexity | Low — no inter-module dependencies possible |
| Risk | Low — each module is independently verifiable |
| Agent navigability gain | Medium-High — gear logic, craft logic, inventory ops, sell routing all have clear homes |

**Accepted.**

### Option C: Don't extract, improve index.ts navigation

Add section comments and reorganize inline. No new files.

| Dimension | Assessment |
|---|---|
| Completeness | Low |
| Immediate complexity | Low |
| Risk | None |
| Agent navigability gain | Low — 1857 lines with comments is still 1857 lines |

**Rejected because:** The file is already past the point where comments help. Agents consistently struggle to locate entry points for new decisions and bug traces.

## Consequences

- Agents working on gear progression go to `src/gear.ts`; agents working on recipe logic go to `src/craft.ts`; agents working on storage go to `src/inventory.ts` — without reading the full tick loop
- `index.ts` shrinks meaningfully but remains the largest file; this is acceptable until the needs aggregation and utility scoring rewrite create the right home for the orchestration logic
- The `decide()` rewrite (issue #7) will likely extract `decisions.ts` at that time, shaped correctly for scored candidates rather than as a copy of the current priority stack
- The needs/produces aggregation (part of issue #6/#7) will eventually replace index.ts's manual `keepItems` union and enable the planner modules to be independent — that is the trigger for the next extraction phase
- `bot-types.ts` becomes the canonical source for shared structural types; type duplication across modules is no longer possible

## Action Items

1. [ ] Expand `bot-types.ts` with shared structural types (`RecipeList`, `ItemMap`, `QuestMap`, `UpgradeTarget`)
2. [ ] Create `src/utils.ts`
3. [ ] Create `src/inventory.ts`
4. [ ] Create `src/gear.ts`
5. [ ] Create `src/craft.ts`
6. [ ] Create `src/trade.ts`
7. [ ] Single wiring PR: update `index.ts` imports, delete extracted inline code
8. [ ] Update issue #14 to reflect revised scope and link this ADR
