# CLAUDE.md

## Codebase map

### Root source files

These are the files we own and actively change. Bot logic lives at the root; cross-cutting infrastructure lives in `src/`. As the codebase grows, expect further modules to be extracted into `src/` (e.g. `src/memory/`, `src/decisions/`). Update this map when that happens.

| File | Role |
|---|---|
| `index.ts` | Bot entry point. Connects to the game server, drives the tick loop, and makes all decisions. Start here for any bot logic work. |
| `bot-types.ts` | TypeScript types used only by the bot (e.g. `UpgradePlanItem`, `UpgradeRequirement`). No runtime logic. |
| `snapshot.ts` | Builds the `DashboardSnapshot` sent to the dashboard: bot-internal state (`bot.*`) plus the raw heartbeat minus `recipes`/`items` (`raw`), plus `weight`/`maxCarryWeight` (the one thing computed server-side since it needs the stripped `items` weights). Does **not** reconstruct player/unit/world data — that duplicated the heartbeat and was removed; `dashboard-client.ts` derives it from `raw` instead. |
| `dashboard.ts` | HTTP server for the dashboard UI. Keeps the latest snapshot in memory and serves it via a plain `GET /state` — no push/SSE; the client polls (see below). |
| `dashboard-client.ts` | Browser-side script, transpiled fresh from this `.ts` file on every request to `/dashboard-client.js` (no build step). Polls `GET /state` on a 1s interval (guarded against overlapping/hung requests) instead of holding an SSE connection open — SSE's unthrottled `res.write()` per tick was the root cause of the dashboard becoming unresponsive under high event volume (see `CONTEXT.md` → *Decision throttle*). Derives `player`/`unitCount`/`world` display data from the raw heartbeat (`payload.raw`) itself rather than receiving them pre-built. |
| `dashboard.html` | Dashboard page markup. |
| `dashboard.css` | Dashboard styles. |

### src/ — cross-cutting infrastructure

Modules here are shared across the bot, future `src/memory/`, `src/decisions/`, and any other modules. Promote a file to its own folder (e.g. `src/logger/`) if it grows beyond a single file.

| File | Role |
|---|---|
| `src/logger.ts` | Structured per-tick JSON logging to `overworld.log` / `arena.log`, death snapshots to `deaths/`, and a 60-tick circular buffer copied (not cleared) into each death file. All bot modules should import this for observability. |
| `src/utils.ts` | Pure-function helpers: `distanceBetween`, `isFiniteNumber`, `isFinitePosition`. |
| `src/plan.ts` | Shared acquisition-planning primitives used by equipment, harvest, and craft planning alike: `getChainedIngredients`, `computeChainNeeds` (gross per-item quantities needed to craft a set of targets — used as a sell/keep quantity bound), `canObtainChain`, `findBlockingItems`, `computeDifficultyTier`. Defines the tier vocabulary (1 buyable now … 5 blocked) shared across `UpgradeTarget`/`ToolPlanItem`. |
| `src/inventory.ts` | Inventory/storage queries: `ENCUMBRANCE_THRESHOLD`, `getInventoryWeight`, `findHeaviestInventoryItem`, `findCheapestFood`, `computeFoodToKeep`, `computeItemsToSell` (accepts an optional `keepQuantities` bound so chain-protected ingredients are sold once a quantity ceiling is exceeded, instead of hoarded indefinitely). |
| `src/equipment.ts` | Gear upgrade planning: `computeUpgradeTargets`, `getTargetItemsToKeep`, `getEquippedRecipeInputs`, `computeTargetsToBuyFromMerchant`, `findGearToEquip`. Chain/tier primitives live in `src/plan.ts`. |
| `src/craft.ts` | Crafting target selection and merchant sourcing: `findCraftableTarget`, `findNextCraftTarget`, `findCraftableFromList`, `findCraftableSubStep`, `isFullyAchievableFromInventory`, `computeCraftIngredientsToBuyFromMerchant`. |
| `src/harvest.ts` | Harvest tool/target planning: `getHarvestableTarget`, `getMissingHarvestToolIds`, `collectHarvestToolItemIds`, `collectHarvestCraftingChainToolIds` (prerequisite tools needed to craft missing harvest tools), `collectCraftableInputIngredients` (craftable ingredient shortfalls in dependency order), `isHarvestWeaponType`, `HARVEST_WEAPON_TYPES`, `HARVEST_WEAPON_TYPE`, `HARVEST_TOOL_TIER_ORDER`. |
| `src/trade.ts` | Merchant/banker helpers: `findBestSellMerchant`, `collectVisibleMerchants`, `collectAllMerchantSelling`, `getStorageFeeInfo` (fee buffer is capped at half of on-hand storage coins so a heavy hoard can't lock every coin). |
| `src/quests.ts` | Quest helpers: `findCompletableQuest`, `findTurnInNpc`, `evaluateQuest`/`questRewardsNeededItem` (take `QuestScoringOpts` — `neededItems` boosts, `stockedItems` zeroes reward items already stocked, `rewardPatches` supplies reward data — `index.ts` builds this from a hand-curated list plus a self-learned cache; this predates SDK `0.10.3`, which now puts `rewards` directly on `ActiveQuest` — the workaround still works but is no longer strictly necessary, see `CONTEXT.md` → *Reward visibility*), `findBestQuestToAccept`, `findBestAvailableQuest` (same scan, ignores capacity), `findQuestGivers`, `findQuestTurnInRequiredItemIds`, `findPendingQuestTurnInItems`, `findStalledQuests`, `findQuestToAbandon` (frees a quest slot for a needed quest blocked by a full log). |
| `src/memory.ts` | Persistent SQLite-backed (`better-sqlite3`) world knowledge store (tracked in #6) — `openMemoryDb`, plus record/get functions for safe locations, an `entities` catalog, explored cells, world heat map, merchant trades, combat history, drop tables, and quests. The `entities` table is the canonical registry of every distinct entity ever seen (pure identity — `id`, `entity_type`, `entity_name`, no timestamp, no position; `getEntity`, `getKnownEntities`) — heat map, combat history, drop tables, merchant trades, and quests all reference an entity by surrogate `id` (never duplicate `npc_name`/`merchant_name` columns) rather than duplicating the type/name pair. What `entity_name` holds depends on whether individuals of that type are unique or interchangeable: monsters and resources are interchangeable instances of a species/type (`monster.monsterId`, `treeType`/`oreType` — many rats or pine trees collapse into one `entities` row each), but NPCs are individually named, persistent characters (`npc.name`, e.g. "Aigor the Merchant" — never `npcType`, which is a shared role, not an identity: every merchant would otherwise collapse into one indistinguishable entity). There is no standalone `merchants` table — position is `heat_map`'s job (`recordMerchant` records a sighting too, via `recordNpcSighting`, so a merchant's trades are never captured without also capturing where it was seen; `getLastKnownPosition` recovers it), and `merchant_trades` (keyed `entity_id, item` — named for the SDK's own `trades.buying`/`trades.selling` vocabulary, not "prices") holds only what's merchant-specific: per-item `buying_price`/`buying_qty` (what the merchant pays the player — earned selling to them) and `selling_price`/`selling_qty` (what the merchant charges the player — paid buying from them). Deliberately not named `buy_price`/`sell_price` — that reads as the player's verb and is backwards from that reading; see `docs/game-reference.md` → *Merchants*. `quests` (keyed `entity_id, quest_id`) is the same pattern for quest-giving NPCs. A dumb store: records what it's told, no domain judgement. Write/read functions take and return game-native SDK types (`Position`, `Items`, `Monsters`, `ClientSideNPC`, `ClientSideMonster`, `GameObject`, `ActiveQuest`) or thin wrappers around them — never bespoke re-derived shapes. Not yet wired into `index.ts` — see ADR-0003's "create the file, don't touch `index.ts`" sequencing. |

### Game client SDK (`node_modules/programming-game`)

This is a **read-only** package — the official client library shipped with the game. Do **not** search or read other `node_modules/` packages; they are standard dependencies with no project-specific logic.

Key files inside `node_modules/programming-game/src/`:

| File | Contents |
|---|---|
| `types.ts` | All server-side types: `ClientSideUnit`, `ClientSideNPC`, `ClientSideMonster`, `GameObject`, `PlayerEquipment`, heartbeat shape, etc. |
| `base-client.ts` | WebSocket client class and `connect()` function. |
| `constants.ts` | Game constants (e.g. `globalCooldown`). Prefer `heartbeat.constants` at runtime over the deprecated `constants.ts` values. |
| `items.ts` | `Items` enum — every item name in the game. |
| `recipes.ts` | `RECIPE` map — crafting recipes. |
| `monsters.ts` | Monster definitions. |
| `unit-stats.ts` | Base stat tables per unit type. |
| `weapon-skills.ts` | Weapon skill definitions. |
| `spells.ts` | Spell definitions. |
| `utils.ts` | Shared utility helpers. |

When searching src files, only search the root src files and node_modules/programming-game/src/. 
 -Never search other node_modules/ directories.
 -Never pass a search path or glob that would match files outside the root or node_modules/programming-game/src.

## Git workflow

Main branch is protected — no direct pushes. All changes land via PR.

### Agent tasks

Every agent working on a code change **must** use `isolation: "worktree"` when spawned. This puts the agent on its own branch and leaves main untouched until a PR is reviewed and merged.

### Parallelism rules

Tasks that touch `index.ts` (extractions, wiring) are **sequential** — merge one PR before starting the next. Merge conflicts on `index.ts` are painful and avoidable.

Tasks that only create new files in `src/` with no `index.ts` edits can run in parallel safely.

### Recommended refactor sequence

When extracting a module from `index.ts`:
1. Agent creates the new `src/<module>.ts` file (no `index.ts` changes) → PR → merge
2. Agent wires the module into `index.ts`, removing the extracted logic → PR → merge

This keeps each PR small and conflict-free.

## Agent skills

### Issue tracker

GitHub Issues on `harleyndavis/programming-game-client`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default label vocabulary (needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context repo — one `CONTEXT.md` + `docs/adr/` at the root. See `docs/agents/domain.md`.
