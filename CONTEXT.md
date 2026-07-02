# Context

> For discovered facts about the game server and client SDK (timing, combat ranges, event shapes, economy), see [`docs/game-reference.md`](docs/game-reference.md).

## Architecture direction

### Decision model
Utility scoring rather than a hard priority stack. Every candidate action scores
itself each tick based on current game state; the highest scorer wins the single
action slot. Scores are continuous, not discrete tiers, so context (e.g. "target
is at 1 HP") can override a rule that would otherwise apply (e.g. "flee at 25%
HP"). Goals are non-blocking: compatible activities (healing, shopping,
equipping) compete for the action slot each tick rather than running in strict
sequence.

### Module architecture
`index.ts` has been partially decomposed (per ADR-0003 conservative extraction) into pure-function libraries. `index.ts` remains the orchestrator, owning all mutable state and decision logic. Dependency flows one direction — modules import from `utils`/`bot-types`/`plan` only, never from each other directly. `plan.ts` was added as a shared acquisition-planning layer (tier/reachability/chain-quantity primitives) once equipment, harvest, and craft planning all needed the same chaining logic — it plays the same role as `utils.ts` but is domain-specific rather than generic:

- **`src/utils.ts`** — pure-function helpers (`distanceBetween`, `isFiniteNumber`, `isFinitePosition`)
- **`src/plan.ts`** — shared acquisition-planning primitives: ingredient chaining, reachability, difficulty tiers, per-item quantity needs across a set of craft targets
- **`src/inventory.ts`** — inventory/storage queries (weight, sellables, food)
- **`src/equipment.ts`** — gear upgrade planning (target selection, merchant sourcing); chaining/tier logic delegates to `plan.ts`
- **`src/craft.ts`** — crafting target selection, sub-step selection, merchant ingredient sourcing
- **`src/harvest.ts`** — harvest target/tool planning (missing tools, their crafting-chain prerequisites, craftable ingredient shortfalls)
- **`src/trade.ts`** — merchant/banker helpers (best sell price, storage fees)
- **`src/quests.ts`** — quest helpers (completable quest detection, turn-in NPC lookup, reward evaluation with need/stocked-aware scoring, best-quest-to-accept selection, pending turn-in item tracking, stalled-quest abandonment)

The following modules remain in `index.ts` and will be extracted when the architecture supports them (tracked in the linked issues):

- **Memory** (`src/memory.ts`, tracked in #6) — dumb store for world facts (merchant inventory, drop tables, heat map, combat history). No opinions.
- **Decisions** (`src/decisions.ts`, tracked in #7) — utility scoring engine replacing the current priority-stack `decide()`
- **Pathfinding** (`src/pathfinding.ts`, tracked in #8) — threat-aware routing. Threat zones are circular regions, not a grid, so routing is tangent-point geometry, not search.
- **Planners** (`src/upgrade-planner.ts`, `src/quest-planner.ts`) — decompose long-term goals into needs and acquisition paths. Planners never call each other directly — see **Need** below.

### Need (demand aggregation)
A want for a quantity of an item, reported independently by a producer (an upgrade plan, a quest, a survival want from Character) without that producer knowing who else wants the same item. Needs from every source are merged by a generic, domain-ignorant aggregation step into a per-item total value. A resolver then matches reachable sources (a monster that drops the item, a resource node) to the aggregate, so a single hunt or harvest that satisfies multiple unrelated goals at once (e.g. a quest needs pinewood logs and crafting also needs pinewood logs) is valued correctly instead of being chased twice. Planners and the resolver only ever read the aggregate, never each other — this keeps the dependency graph flat even though real need sources are mutually circular (a quest can both need and produce items that crafting also needs and produces).

**Open question:** needs from different sources don't share a value unit yet — market value (sellable items, has a coin price), stat-delta value (gear upgrades), and survival urgency (calorie deficit, which should spike sharply near zero rather than scale linearly) aren't directly comparable. Treat this as an empirical tuning problem once the bot is running, not something to resolve on paper — per ADR-0001, scoring weights are observable parameters, not constants to get right in advance.

### Action net value
Actions are not scored on immediate reward alone. Net value accounts for:

- **Immediate reward** — coins, items, XP, or progression gained from the action.
- **Travel cost** — distance to reach the action's target, adjusted for current
  movement speed. A higher-reward option far away may score below a lower-reward
  option nearby.
- **Route danger cost** — threat level along the path (from the heat map). A
  shorter but dangerous route may cost more than a longer safe one.
- **Opportunity cost** — positional penalty if completing this action moves the
  bot away from its next highest-priority destination. Turning in a quest to the
  west scores lower if the bot's next goal is clearly to the east.

Net value is computed at decision time using current knowledge; it is not a
global plan. The bot does not do multi-step lookahead — it weights the immediate
next move by how well it positions for the one after.

### Hysteresis
Soft anti-thrashing: the currently executing action receives a score bonus so
that a new action must clearly outscore it before a switch occurs. Absorbs
score noise near tie points. Does not prevent thrashing if scores oscillate
above and below the bonus threshold — that case requires commitment.

### Action commitment
Hard anti-thrashing: once an action is chosen, the bot runs it for a minimum
number of ticks before re-evaluating. Commitment duration is action-specific
(movement: longer; single-step actions like eating: 1 tick). **Hard interrupts**
— HP at zero, target died, encumbrance critical — bypass commitment immediately.

Hysteresis and commitment are complementary: hysteresis handles nearly-equal
scores; commitment handles oscillating scores. Persistent thrashing despite both
is a signal that the scoring function is missing context, not that the mechanism
needs more tuning.

### Threat level
A score assigned to a monster type or map area based on accumulated combat
history and heat map data. Drives two decisions:

1. **Resource usage** — low-threat situations (familiar enemies, known safe
   routes) warrant no consumable or active-skill expenditure. High or unknown
   threat justifies burning TP, MP, and healing items to gather data and survive.
2. **Exploration readiness** — the bot only ventures into higher-threat areas
   when resources (HP, consumables, TP/MP) are fully stocked.

Unknown entities default to high threat until data is collected.

**Arena threat level:** Arena matches always present maximum threat. There is no home to retreat to, no healer, and no option to avoid the fight. The decision engine does not need separate arena scoring rules — it receives max threat as context, and the existing threat-driven logic (spend TP, MP, and consumables freely; do not hold back) follows naturally.

### Exploration trigger
The bot expands its search radius when progression is blocked — specifically
when a required crafting ingredient or resource cannot be obtained from any
known merchant or reachable enemy's drop table. Exploration is not pursued for
its own sake; it is a response to a concrete progression gap. Crafting skill
unlocks (which would gate recipes) do not exist in the current game version.

### Fight evaluation
Before engaging a new target, estimate fight survivability using combat history
(monster HP + average damage per hit) and current player HP. During a fight,
re-evaluate each tick.

When HP drops below the danger threshold, the following factors are weighted
together to score each candidate action (fight on, kite, flee to safety):

- **Win probability** — remaining monster HP and expected hit rate vs. remaining
  player HP. A near-dead target raises the score for finishing the fight.
- **In-place recovery potential** — natural regen rate, available consumables,
  kiting room. Raises the score for kiting over fleeing.
- **Escape viability** — player movement speed (reduced by encumbrance) vs.
  monster chase speed. Low encumbrance raises the flee score; high encumbrance
  lowers it.
- **Route safety** — heat map danger assessment of the path to the nearest safe
  location. A dangerous path raises the score for fighting on.

### Kiting
Maintaining distance from a pursuer while dealing ranged damage or recovering
HP, with intent to re-engage or finish the fight at range. Bow kiting (staying
between 2.5 and 10 units from the target) is theoretically viable but untested.

### Weapon switching
Manually equipping a different weapon via an equip action. Required to change
combat style mid-fight. Triggers:

- **Bow → melee**: target closes within min ranged attack range (2.5 units), or
  arrows are depleted.
- **Melee → bow**: target is far enough away and arrows are available.
- **Offhand swap (grimoire ↔ shield)**: switching between magic and melee/tank
  style.

During a weapon swap the character cannot attack. The swap exposes a window of
vulnerability whose length depends on equip action duration (see `docs/game-reference.md` → *Action durations*).

### Storage / Banking
Each player has a personal bank vault (`player.storage`) accessible through
banker NPCs (`NPC_TYPE.banker`). Items in storage survive death.

**Home state (`atHome`):** True when any of `recoveringAtHome`, `idlingAtHome`,
or `finishingHomeChores` is true. All banking decisions use this flag.

**Deposit trigger:** auto-deposit runs when at home, a banker is nearby, and the
`toDeposit` dict is non-empty. Deposit is set as an override (`depositOverride`)
before the main `decide()` function runs, but withdraw overrides take priority.

**What is deposited:**
- `copperCoin` — `COINS_TO_KEEP` is **0**: all coins above the immediate
  purchase need are deposited. The `toDeposit.copperCoin` is adjusted by
  subtracting `buyCost`; coins needed for the next purchase stay in inventory.
- `keepItems` — upgrade ingredients and tools that the bot is reserving for
  crafting are deposited, minus whatever quantity `toSell` is about to sell
  this tick (otherwise a sellable surplus of a protected item would get
  deposited and immediately re-withdrawn next tick instead of sold).

**Buy-cost adjustment:** Before the deposit check, `toDeposit.copperCoin` is
reduced by `buyCost` (the total price of the first merchant's planned
purchases). This prevents depositing coins that are immediately needed. If the
bot can't afford the purchase at all (coins + max safe storage withdrawal <
buyCost), ALL coins are deposited (death-loss avoidance).

**Withdraw (coins):** If at home with a banker, a purchase is planned
(`buyCost > 0`), the bot lacks enough pocket coins (`playerCoins < buyCost`),
and storage has enough withdrawable coins (above the fee buffer), the bot
issues a withdraw override for the exact deficit. This override takes priority
over deposit.

**Withdraw (non-protected + surplus-protected items):** Items in storage that
are NOT in `keepItems` are withdrawn to inventory for selling, up to the full
carry limit (`maxCarryWeight`) — not the soft `ENCUMBRANCE_THRESHOLD` used
elsewhere. This is deliberately more aggressive than other withdraw paths:
this one only runs at home next to a banker, about to sell everything pulled
here, and never travels while carrying it — so briefly exceeding the soft
"encumbered" threshold is harmless (`decide()`'s `isEncumbered` branch routes
straight to the same sell action anyway). Capping at the soft threshold here
would just stretch a large stash sell-off over needlessly many withdraw/sell
cycles. Whatever still doesn't fit (rare — only when a single haul exceeds
full carry capacity) is picked up on a later pass. Items that ARE
`keepItems`-protected but chain-quantity bounded (`computeChainNeeds` — see
`src/plan.ts`) are also withdrawn for their surplus beyond what the craft
chains need, but only when a currently visible merchant actually buys that
item; otherwise the item would bounce between pocket and storage every tick
with nowhere to sell it. Runs only when no other banking override is active.

**Fee buffer:** `minStorageCoins = min(ceil(total_storage_weight_g × 0.0025) ×
100, floor(storageCoins / 2))`. Only coins above this buffer are available for
withdrawal. The `/ 2` cap exists because the raw 100× buffer scales with
hoarded storage weight — with enough low-value bulk items (e.g. thousands of
rat pelts) it can exceed total wealth and permanently lock every coin
(`availableWithdrawal` stays 0 forever, so no purchase can ever be afforded).
Capping at half of on-hand coins guarantees some coins are always spendable.
(Uncapped formula source: `docs/game-reference.md` → *Storage fees*.)

**Upgrade-aware inventory (cycle prevention):** `computeUpgradeTargets` receives
a merged view of `player.inventory + player.storage` so that craftable
ingredients already in storage are still visible. Without this merge, depositing
ingredients (e.g. rat pelts for leather armor) would make them disappear from
the upgrade targets → they'd drop from `keepItems` → the non-protected withdraw
would pull them back → deposit → infinite cycle.

**Decision priority chain** (see `index.ts`, the block right before `decide()`
is called):
1. Coin withdraw (for purchase deficit)
2. Ingredient/tool withdraw for the active craft or tool craft
3. Quest turn-in item withdraw
4. Non-protected + surplus-protected item withdraw (for selling)
5. Deposit (coins + keepItems, minus items being sold this tick)
6. `decide()` — equip, craft, buy, turn-in quest, sell, accept quest, or return-home

**Sell during recovery:** The `recoveringAtHome` branch in `decide()` includes
a sell check ahead of returning home, so withdrawn non-protected items are sold
during recovery instead of sitting in inventory until the next idle-at-home
pass.

**Event monitoring:** `storageCharged` (contains `coinsLeft` and `charged`) and
`storageEmptied` are logged via `onEvent` in `index.ts` so the storage fee can
be observed at runtime.

### Safe location
Any location where the bot can recover HP without danger. Includes the starting
area around (0, 0) (home), other discovered towns, and future player-built
structures. Safe locations are stored in bot memory and discovered through
exploration — the bot is not limited to returning to (0, 0).

## Bot goal

Single-character autonomous linear progression bot. Advances the character
incrementally through gear, skills, and quests without manual intervention.
Does not attempt to jump to end-game gear; prioritises steady forward movement.

## Glossary

### Combat skill
Passive proficiency level tied to a weapon type (e.g. one-handed sword).
Increments automatically through use. Likely affects damage or hit chance
invisibly; the exact effect is not yet confirmed by observation.

### Weapon skill
Active ability triggered mid-combat. Costs **TP**. Has a visible in-combat
effect (e.g. a special attack). Distinct from combat skill — active vs. passive.

### TP (Tactical Points)
Physical-energy resource consumed by weapon skills. Regenerates over time
(mechanism not yet confirmed).

### MP (Mana Points)
Resource consumed by spells cast from the spellbook.

### HP (Hit Points)
Character health. Bot retreats home when HP falls below a configurable threshold.

### Calories
Hunger resource. Depletes over time; replenished by eating food from inventory.

### Action
A timed server-side operation the character is currently performing (e.g.
`move`, `craft`, `cast`). Tracked via `player.action`, `player.actionStart`,
and `player.actionDuration` in the heartbeat. An action is in progress while
`Date.now() < actionStart + actionDuration`.

### Intent
The server-confirmed goal of the character (e.g. `attack`, `move`, `craft`).
Updated only when the server echoes back a `setIntent` event — lags behind the
locally-sent intent by several ticks under normal latency. See **Intent
throttle** for the full lag model. Some intents persist after the action
completes (e.g. `attack` remains after the target dies); presence of an intent
does not imply the action is still executing.

### Bot memory
Persistent knowledge about the game world accumulated across ticks and across
restarts. Stored in SQLite (`better-sqlite3`) — ACID transactions prevent
corruption on crash, WAL mode allows concurrent reads during writes, and SQL
aggregates (AVG, SUM/COUNT, bounding-box queries) are a natural fit for drop
rates, combat averages, and heat map proximity lookups. Categories:

- **Safe locations** — discovered towns, healers, and player-built structures
  where the bot can recover. Not limited to (0, 0).
- **Merchant knowledge** — location, inventory, and prices for every merchant
  ever encountered, including ones discovered far from home.
- **Explored cells** — a sparse grid (cell size derived from
  `player.stats.sightRange`, observed as 10 at baseline but status-dependent,
  so record the sight range used at the time of each observation rather than
  hardcoding it) marking which areas have been visually covered. World extent
  is unconfirmed — exploration has reached at least (1000, 1000) without
  finding a boundary — so this stores visited cells sparsely, not a bounded
  dense array.
- **World heat map** — spatial sightings of monsters, resources (trees, ore),
  crafting stations, and NPCs, linked to explored-cell coordinates, with a
  confirmation count and last-seen timestamp. There is no separate "permanent
  fixture" table: whether trees/ore relocate on respawn and where the smelter
  is are both unconfirmed, so everything starts as an expiring sighting and
  earns confidence through repeated re-confirmation rather than being assumed
  permanent on first sight. Used to guide exploration, assess route danger,
  and identify target-farming zones.
- **Combat history** — per monster type: HP (available directly from heartbeat
  units), average damage dealt per hit to the player (not in client data —
  inferred from player HP-delta during combat; may vary), and kill count. Used
  to decide whether to engage a monster or flee, and to estimate fight
  survivability. Not spatial — kept separate from heat map sightings.
- **Drop tables** — per monster type: total kills and per-item drop counts,
  from which drop rates are derived. Enables target-farming for crafting
  ingredients and helps prioritise gear upgrade paths based on realistic
  ingredient acquisition cost.
- **Quests** — accepted/available quests, keyed to the giving NPC rather than
  a position: requirements, reward, and status. Not part of the heat map —
  quests aren't a geographic fact.

Currently absent — the bot only knows what is in the current heartbeat tick.

### Quest
A task accepted from an NPC that yields a reward (coins, items) on completion.
The bot tracks active quests via `player.quests` (`ActiveQuests`) and accepts
opportunistically from nearby quest-giver NPCs when there is capacity (max 5).
Turn-in happens when all required items are in inventory and the turn-in NPC
is visible. No pathfinding — the bot's own movement toward a remembered NPC
position is a straight line (`player.move`), not a route (tracked in #8).

**Bounded chase-to-NPC:** `lastQuestNpcPosition` remembers the last position a
quest NPC we have business with was actually seen at (`questNpcInRange` —
either the completable-quest turn-in NPC or the accept-target NPC). When that
NPC isn't currently visible but we either have turn-in items ready or need to
re-accept a quest, the bot moves toward the remembered spot
(`questNpcTarget`) instead of just standing still and hoping the NPC wanders
into `heartbeat.units` on its own — useful when the NPC (or the bot's idle
position) is right at the edge of sight range.

This used to have no exit condition: if the remembered position was stale
(NPC moved a little, or the bot can't occupy the exact same tile as the NPC
due to collision) the bot would walk toward that fixed point and sit there
indefinitely, even while effectively standing on top of the NPC — a real
observed failure. Two fixes, both required together:

1. **Arrival give-up (`QUEST_NPC_ARRIVAL_RADIUS`):** once the bot has closed
   to within this distance of the remembered spot and the NPC still isn't in
   `heartbeat.units`, `lastQuestNpcPosition` is cleared immediately — no
   waiting for a timeout, no exact-position match required. This directly
   fixes "walked right up to where the NPC was and nothing happened."
2. **Capacity check on re-accept:** `needQuestForHarvestTools` now also
   requires spare quest capacity (`activeQuests count < maxActiveQuests`)
   before triggering the chase. Without this, the bot could walk all the way
   to the guard to re-accept `wood_for_stone` while all 5 quest slots were
   already full of other quests — `findBestQuestToAccept` returns null at
   capacity regardless of proximity, so the trip was guaranteed to accomplish
   nothing. See **Abandoning stalled quests** below — this check only
   prevents a wasted trip, it does not free a slot on its own.

The old design's deadlock wasn't really about position precision — chasing
moved the bot away from home, and the `finishingHomeChores` chore-clear check
only re-evaluates while `nearHome` is true, so the give-up path could never
run *while the chase was in progress*, regardless of how close the bot got.
The arrival-based clear above sidesteps that entirely: it fires independently
of `nearHome`, and once it fires, `questNpcTarget` goes null and `decide()`
naturally falls through to `return-home-idle` on the next tick.

**Decision order:** the home-chores branch of `decide()` checks
`equip → craft → turnIn → acceptQuest → buy → sell → toolCraft → chase quest
NPC`, so quest items are consumed by the turn-in instead of being sold for
coin, and turn-in/accept both run ahead of buying (the quest NPC may only be
visible for a short window right after arriving at their location). Chasing
is last — every other home task takes priority over closing distance on a
quest NPC that isn't even visible yet.

**Reward visibility — a structural gap, not a bug:** `ActiveQuest` (the shape
of `player.quests`) has no `rewards` field at all, for every quest, always —
see `node_modules/programming-game/src/types.ts`. The reward is only ever
visible in `npc.availableQuests[id].rewards.items`, i.e. *before* accepting.
Once a quest is active, that data is gone from the heartbeat entirely. This is
why `questRewards` (in `index.ts`) exists: `execute()`'s `acceptQuest` case
captures `availableQuest.rewards.items` at the exact moment of accepting,
before it disappears, keyed by quest id.

**Reward evaluation (`evaluateQuest`):** base score is the sum of reward item
quantities, but a quest whose reward includes an item the bot's craft chains
are currently short on (`questNeededItems`, derived from `computeChainNeeds`)
gets a large fixed bonus on top — so a progression quest (e.g. `wood_for_stone`
rewarding `stone`) reliably outranks a higher-raw-reward filler quest instead
of losing its quest slot to it after every turn-in. Scoring runs against
`npc.availableQuests[id].rewards.items` (see above — the pre-accept listing,
which normally *does* have rewards), via `QuestScoringOpts.rewardPatches`.

`rewardPatches` is built in `index.ts` as `questRewardPatches` — a merge of
two sources, in priority order:
1. **`KNOWN_QUEST_REWARDS`** — hand-curated, for the rare case where even the
   pre-accept listing has no reward (a genuine server-side omission, confirmed
   for `wood_for_stone`). Can't be discovered automatically; someone has to
   observe the true reward some other way and hardcode it. Remove an entry
   once the server reports that quest's rewards correctly.
2. **`questRewards` itself** — since it already captures the true reward the
   *first* time any quest is accepted (from the source above), it doubles as
   a self-updating patch for every quest scoring might otherwise be blind to
   after that quest goes active. This covers ordinary quests automatically —
   `KNOWN_QUEST_REWARDS` is only needed for the harder case (1).

**Stocked items (`questStockedItems`):** symmetric to needed items — zeroes
out reward items the bot already has plenty of, currently applied to tools:
`toolItemIds` at or above `max(chainKeepNeeds[item] ?? 0, TOOL_KEEP_CAP)` (the
flat cap is "one, maybe a spare"; a genuinely higher active chain need always
wins). This isn't just "not bonused" — it's actively zeroed, pushing the score
*below* the unknown-reward fallback of 1, so the quest stops winning
acceptance purely by being the only or repeatable option at an NPC. Without
this, a repeatable quest whose reward is a tool (e.g. `stoneCutterTools`)
keeps cycling accept → turn-in → accept forever once the reward has stopped
being useful. `TOOL_KEEP_CAP` is also merged into `chainKeepNeeds` itself (see
quantity-bounded selling above) as a fallback for tools outside any currently
active chain, so surplus tools actually get sold, not just capped from
growing further — `stockedItems` alone only stops *acquiring* more via
quests, it doesn't sell what's already stockpiled.

**Stall avoidance (actionable turn-in items):** a quest's turn-in items only
count toward `finishingHomeChores` staying active when they're actually
obtainable this tick — already in storage, or sold by a remembered merchant
at an affordable price (merchant offers are remembered persistently across
ticks, not just while that merchant is currently visible). Without this, an
active quest needing an item nobody sells (e.g. a rare kill drop) would pin
the bot at home indefinitely doing nothing, since that quest can never
complete on its own.

**Abandoning stalled quests (`findQuestToAbandon`):** with quest capacity
fixed at 5 and no way to complete a quest whose turn-in items are unobtainable
(see stall avoidance above), a full quest log can permanently block a
progression quest even when that quest's NPC is standing right there —
`findBestQuestToAccept` returns null at capacity regardless of reward score,
and the need-aware scoring in `evaluateQuest` only prevents *new* junk quests
from displacing a needed one; it does nothing for slots already occupied.

`player.abandonQuest(questId)` is a capacity-free action — no NPC or position
required — so the bot can drop a quest from anywhere. But abandoning has a
real cost (the quest's partial progress and reward are gone), so it only
fires when it's clearly worth it, gated on all three:
1. **Stalled** (`findStalledQuests`): the quest's current turn_in step needs
   an item that's short and not obtainable (same signal as stall avoidance).
2. **At capacity** (`activeQuests count >= maxActiveQuests`): if there's a
   free slot, just accept the better quest directly — no need to abandon
   anything.
3. **Something needed is actually waiting** (`findBestAvailableQuest` +
   `questRewardsNeededItem`): a quest a visible NPC is offering right now
   must reward a currently-needed item. Abandoning a stalled quest just to
   make room for more filler would throw away its partial value for nothing.

With multiple stalled quests, the first one found is dropped — no
reward-based ranking. `questRewards`/`questRewardPatches` *could* now rank
them (every stalled quest was necessarily accepted at some point, so its true
reward is very likely already learned — see reward visibility above), but
`findQuestToAbandon` doesn't take that as a parameter; picking the lowest-
value stalled quest to drop is a rare enough tie-break that the added
plumbing didn't seem worth it. Revisit if abandoning ever visibly drops the
"wrong" (more valuable) stalled quest in practice.

**Available quests** from nearby NPCs are rendered in the dashboard Quests
tab alongside active quest progress (kill step counts, turn-in requirements).

### Merchant trade model
See `docs/game-reference.md` → *Merchants* for the full price-list structure (`trades.selling` / `trades.buying`). When deciding where to sell an item, compare `buying.price` across all visible merchants. The deprecated `wants`/`offers` fields should be ignored.

### Player trade
Players can publish their own `buying` and `selling` price lists via `setTrade`,
enabling player-to-player commerce. Not currently used; relevant once the bot
encounters other players with desirable trade offers.

### Progression loop
The primary game cycle: hunt monsters → loot → sell or turn in quests (whichever
pays better) → buy or craft better gear → hunt slightly harder monsters →
repeat. Quests and crafting compete in the same utility scoring system as
direct selling; the best-value path wins.
