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
| `src/craft.ts` | Crafting target selection and merchant sourcing: `findCraftableTarget`, `findNextCraftTarget`, `findCraftableFromList`, `findCraftableSubStep`, `isFullyAchievableFromInventory`, `computeCraftIngredientsToBuyFromMerchant` (takes an optional `knownHarvestItems` set — a shortfall in it is left unaddressed here rather than bought, since harvesting is free besides tool wear and is promoted over spending coins for now; `src/harvest.ts`'s need-aware `getHarvestableTarget` is what actually goes and acquires it). |
| `src/harvest.ts` | Harvest tool/target planning: `getHarvestableTarget`, `getMissingHarvestToolIds`, `collectHarvestToolItemIds`, `collectHarvestCraftingChainToolIds` (prerequisite tools needed to craft missing harvest tools), `collectCraftableInputIngredients` (craftable ingredient shortfalls in dependency order), `isHarvestWeaponType`, `HARVEST_WEAPON_TYPES`, `HARVEST_WEAPON_TYPE`, `HARVEST_TOOL_TIER_ORDER`. `TREE_TYPE_LOG_ITEM`/`ORE_TYPE_ITEM` are the a-priori "what does this treeType/oreType yield" guess table (e.g. oreType `'copper'` → `copperOre`) — the cold-start kickstart so ore/logs are treated as obtainable (fed into `knownLootItems` in `index.ts`) and targetable before the bot has ever actually harvested one; `getKnownLootItems`/`getLootRates` (`src/memory.ts`) confirm/extend this empirically afterward the same way as monster drops, since harvest yields go through the same `loot` event. `KNOWN_HARVESTABLE_ITEMS` is the flattened set of every guessed yield. `getHarvestableTarget` takes an optional `neededItems` set (raw materials the active chain is short on, from `chainKeepNeeds` in `index.ts` — nets off combinedInventory, so it's a live shortfall, not "we needed one an hour ago") and prefers the nearest node whose guessed yield is in it over a nearer node yielding nothing needed. When `neededItems` is non-empty but nothing visible matches it, returns null rather than falling back to the nearest node of *any* type — otherwise the bot would happily harvest something it doesn't need just because it's closer, running itself encumbered on the wrong item and dropping it. The nearest-of-any-type fallback only applies when `neededItems` is empty (no active need at all), preserving opportunistic/idle gathering. Unlike the opportunistic "nearest of any type" pass, `getHarvestableTarget`'s needed-item search does *not* filter by the currently-equipped tool — it reports the nearest needed node regardless of what's in the weapon slot right now, which means `harvestTarget` can legitimately be a node the bot has no matching tool for at all. `resolveHarvestToolForTarget` resolves that, scoped to the *specific* chosen `harvestTarget` (keyed off its own `type` — tree → fellingAxe, miningNode → pickaxe — via `HARVEST_WEAPON_TYPE`, not a `neededItems`-wide tie-break that could name a different tool type than the one node actually chosen when both a log and an ore are needed at once): `ready: true` means the equipped weapon already matches and it's safe to harvest; `toEquip` is the best owned-in-pocket tool to swap in when it doesn't; both false/null means the tool isn't equipped and isn't owned at all, so `index.ts`'s `harvestTarget` branch must fall through rather than issue a harvest intent with the wrong tool equipped. `index.ts` only consults `resolveHarvestToolForTarget` inside the `harvestTarget` branch itself (equip-or-harvest, never explore-then-harvest — see below), never as an earlier standalone check — otherwise it fired purely off the abstract chain need with nothing harvestable in sight (e.g. while sitting at home), which fought every tick with `gearToEquip` wanting the best combat weapon equipped there instead. `findHarvestToolToWithdraw` covers the case `resolveHarvestToolForTarget` can't: the needed tool owned only in storage (e.g. previously crafted/bought then auto-deposited home) rather than pocket — `index.ts`'s `homeChores` withdraws it so it becomes visible to `resolveHarvestToolForTarget` the next tick; the pocket-inventory deposit loop in `index.ts` also excludes harvest-weapon-type items outright so a carried tool never gets banked away in the first place. Once the tool is ready, `index.ts` issues `player.harvest(target)` with no client-side range gate — like `attack`, it's a move-to-and-act intent the server handles, so there's no separate "explore until within range, then harvest" step. |
| `src/trade.ts` | Merchant/banker helpers: `findBestSellMerchant`, `collectVisibleMerchants`, `collectAllMerchantSelling`, `getStorageFeeInfo` (fee buffer scales with total storage weight, uncapped — hoarding is bounded elsewhere via chain-need surplus selling, not by capping this buffer). |
| `src/quests.ts` | Quest helpers: `findCompletableQuest`, `findTurnInNpc`, `evaluateQuest`/`questRewardsNeededItem` (take `QuestScoringOpts` — `neededItems` boosts, `stockedItems` zeroes reward items already stocked, `rewardPatches` supplies reward data — `index.ts` builds this from a hand-curated list plus a self-learned cache; this predates SDK `0.10.3`, which now puts `rewards` directly on `ActiveQuest` — the workaround still works but is no longer strictly necessary, see `CONTEXT.md` → *Reward visibility*), `findBestQuestToAccept`, `findBestAvailableQuest` (same scan, ignores capacity), `findQuestGivers`, `findQuestTurnInRequiredItemIds`, `findPendingQuestTurnInItems`, `findStalledQuests`, `findQuestToAbandon` (frees a quest slot for a needed quest blocked by a full log). |
| `src/memory.ts` | Persistent SQLite-backed (`better-sqlite3`) world knowledge store (tracked in #6) — `openMemoryDb`, plus record/get functions for safe locations, an `entities` catalog, explored cells, world heat map, merchant trades, combat history, loot tables, and quests. The `entities` table is the canonical registry of every distinct entity ever seen (pure identity — `id`, `entity_type`, `entity_name`, no timestamp, no position; `getEntity`, `getKnownEntities`) — heat map, combat history, loot tables, merchant trades, and quests all reference an entity by surrogate `id` (never duplicate `npc_name`/`merchant_name` columns) rather than duplicating the type/name pair. What `entity_name` holds depends on whether individuals of that type are unique or interchangeable: monsters and resources are interchangeable instances of a species/type (`monster.monsterId`, `treeType`/`oreType` — many rats or pine trees collapse into one `entities` row each), stations are the same pattern keyed by `stationType` (`'smithing'`, `'smelting'`, ... — what recipes require, not `stationSubtype`, the visual fixture), but NPCs are individually named, persistent characters (`npc.name`, e.g. "Aigor the Merchant" — never `npcType`, which is a shared role, not an identity: every merchant would otherwise collapse into one indistinguishable entity). `getKnownStationTypes` lists every distinct station type ever seen. `heat_map` is keyed by cell (`cell_x`/`cell_y`/`sight_range`), not exact tile — linked to the same sight-range-sized grid `explored_cells` uses (same `cellCoordsFor` helper), for every entity type including NPCs, so a wandering monster or a merchant seen a few tiles apart collapses into one row instead of exploding per-tile; `position` on read is reconstructed as the cell's center. There is no standalone `merchants` table — position is `heat_map`'s job, recorded via the same `recordNpcSighting` every NPC gets regardless of role (a merchant is an NPC that additionally has trade data, not a different kind of thing — there's no merchant-specific sighting call; `getLastKnownPosition` recovers position from that shared sighting), and `merchant_trades` (keyed `entity_id, item` — named for the SDK's own `trades.buying`/`trades.selling` vocabulary, not "prices") holds only what's merchant-specific: per-item `buying_price`/`buying_qty` (what the merchant pays the player — earned selling to them) and `selling_price`/`selling_qty` (what the merchant charges the player — paid buying from them). Deliberately not named `buy_price`/`sell_price` — that reads as the player's verb and is backwards from that reading; see `docs/game-reference.md` → *Merchants*. `getAllKnownSellingOffers` returns the cheapest known selling price per item across every merchant ever seen, independent of current visibility. `combat_history` tracks `min_damage_per_hit`/`max_damage_per_hit` alongside the average — a rare big hit must not be hidden by the mean. `monster_max_hp` is the monster's actual maximum HP (`UnitStats.maxHp`), not its current/remaining HP at some past moment — `recordMonsterMaxHp` writes it from either side's attacks (`recordCombatHit` from hits the player took, `recordMonsterMaxHp` from hits the player landed), independent of the hit-received counters, so a monster killed before it ever lands a hit still gets its maxHp recorded. Column was renamed from `monster_hp` in schema v2->v3 after exactly that bug (was reading `attackerUnit.hp` — current HP at the moment of a hit — instead of `attackerUnit.stats.maxHp`); old values are meaningless under the new semantics and reset to 0 by the migration rather than carried forward. Kill/harvest counting is a single shared `action_counts` table (`entity_id` PK, `total_count`) rather than a monster-specific one, since `entities.entity_type` already disambiguates kill-vs-harvest without a redundant column; `recordMonsterKill`/`recordHarvest` both write to it. `loot_counts` (renamed from a monster-only `drop_counts`, since the SDK's own `loot` event is the source for both monster drops and harvest yields) is keyed `entity_id, item` and tracks `total_quantity`, `loot_events` (distinct from total_quantity, so a per-event average/min/max survives instead of collapsing into one running sum), and `min_quantity`/`max_quantity` — `recordLoot`/`getLootRates` are entity-generic (take `entityType`/`entityName`), used for both monster kills and resource harvests. `quests` (keyed `start_npc_id, quest_id`, with `end_npc_id` resolved the same entity-reference way once known) is the same NPC-detail pattern, but fully normalized rather than a JSON blob — reward items, kill requirements, and turn-in requirements each live in their own child table (`quest_reward_items`, `quest_kill_requirements`, `quest_required_items`), the last two named for what quest data actually needs (queryability, type safety at the DB boundary, consistency with every other table), not because it mirrors merchant pricing. Kill requirements reference the monster via the entity catalog too (`monster_entity_id`), so "have we ever seen/can we fight this monster" is answerable by joining to `heat_map`/`combat_history` — see ADR-0005. Deliberately excludes mutable per-step progress (`killed`/`completed`): that's live-heartbeat-only data, not a durable fact. A dumb store: records what it's told, no domain judgement. Write functions take game-native SDK types (`Position`, `Items`, `Monsters`, `ClientSideNPC`, `ClientSideMonster`, `GameObject`, `ActiveQuest`) directly; read functions mostly return thin wrappers around them, except quests — `getQuestSighting`/`getKnownQuestsForNpc` return a bespoke `QuestRecord` (not `ActiveQuest`/`AvailableQuest`), since progress isn't persisted and a faithful SDK-shaped object can't be reconstructed. Wired into `index.ts` per ADR-0004's phasing: write-side (station/merchant sightings, kill/harvest detection, timing-based loot attribution — the SDK's `loot` event carries no source reference at all) and the station/merchant slice of the read-side (`knownStationTypes`/`availableStationTypes` in `src/plan.ts`/`src/equipment.ts`/`src/craft.ts`/`src/harvest.ts`, stabilizing upgrade-plan reachability across the bot's location). Combat/loot variance data is captured but not yet consumed by any decision logic. |

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
