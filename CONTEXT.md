# Context

## Architecture direction

### Decision model
Utility scoring rather than a hard priority stack. Every candidate action scores
itself each tick based on current game state; the highest scorer wins the single
action slot. Scores are continuous, not discrete tiers, so context (e.g. "target
is at 1 HP") can override a rule that would otherwise apply (e.g. "flee at 25%
HP"). Goals are non-blocking: compatible activities (healing, shopping,
equipping) compete for the action slot each tick rather than running in strict
sequence.

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

### World geometry
The game world is an open plane with no hard impassable obstacles — characters
walk through trees, ore deposits, and other objects. Pathfinding requires only
cost-weighted routing (avoid high-threat areas), not obstacle avoidance or
connectivity graphs.

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
vulnerability whose length depends on equip action duration (not yet measured).

### Combat ranges
- Melee: 0.7 units
- Bow: 2.5–10 units (min ranged attack range 2.5, max 10)
- Bow requires arrows (consumable); no arrows = cannot use bow.
- Grimoire (offhand): assumes caster must be holding it to cast spells, same as
  bow assumption — unverified.

### Global cooldown
0.5 seconds between actions (from `heartbeat.constants.globalCooldown` — the
deprecated `constants.ts` value matches but live value should be preferred).
Applies after gear equips, attacks, and other actions. **Move is exempt** — the
bot can issue move intents freely during cooldown, but all other actions are
blocked. Intents can be changed during cooldown; they are queued and executed
when the cooldown expires.

### Intent throttle
The server applies a 100 ms leading-and-trailing throttle to incoming intents.
Multiple intent changes within a 100 ms window collapse to the last one received
— the intermediate intents are silently dropped. The client will not resend an
intent if it has not changed since the last send. Combined with the global
cooldown and status effects, this means an intent sent by the bot may not be
acted on for several ticks; the server queues it and executes it as soon as
conditions allow. This is the primary explanation for observed intent lag of
6–30 ticks.

Intent persistence varies by type. **Attack does not clear when combat ends** —
the attack intent remains in the heartbeat after the target is dead. A stale
attack intent does not mean combat is ongoing; confirm against active target
presence.

### Arena match boundaries
There is no explicit match-start or match-end event. Detection strategy:

- **Match start**: when an arena heartbeat arrives and the arena timer has
  advanced, a new match has begun. Log this tick as the match-start boundary and
  close out the previous match (win/loss/tie) at the same time.
- **Closing previous match on start**: if no arena combat log exists yet (e.g.
  fresh bot startup), there is no previous match to close — skip the close-out.
  This handles the cold-start edge case.
- **Match end**: if 60 seconds have elapsed since the last arena tick, assume
  the match has ended. The arena match duration is fixed at 60 seconds.

Extra heartbeat ticks arrive between server events — the client fires one on
every server event *and* on a 300 ms poll. These extra ticks carry no new server
state; they are time-passing acknowledgements and should not be treated as match
activity.

### Action durations
- **Gear equip**: instant — fires `equipped` immediately, then global cooldown.
  Bow ↔ melee switching is viable mid-combat.
- **Spell equip**: 5,000 ms — fires `beganEquippingSpell`, then `equippedSpell`
  after 5 seconds. Too slow for mid-combat use; spellbook must be configured
  before engaging.
- **Crafting, harvesting, casting**: have individual durations tracked via
  `actionStart` + `actionDuration` in the heartbeat.

### Raw server events
`connect()` accepts an `onEvent` callback that receives every raw server event
before it is processed into a heartbeat. Useful for debugging intent lag,
observing `unitDisappeared` events, and timing analysis. The server can emit up
to 60 events per second during movement (~16–17 ms between events).

Storage events (`storageCharged`, `storageEmptied`, `deposited`, `withdrew`) are
logged via `logger.addExtra` in the `onEvent` handler at `index.ts:721`. This
makes the fee (`charged`) and remaining coins visible per-tick for monitoring.

### Storage / Banking
Each player has a personal bank vault (`player.storage`) accessible through
banker NPCs (`NPC_TYPE.banker`). Items in storage survive death.

**Deposit trigger:** the bot deposits items when at home (`recoveringAtHome`,
`idlingAtHome`, or `finishingHomeChores`) and a banker is visible.

**What is deposited:**
- `copperCoin` — all coins above `COINS_TO_KEEP` (200) are deposited. Pocket
  change stays in inventory for small merchant purchases.
- `keepItems` — upgrade ingredients and tools that the bot is reserving for
  crafting are deposited in full (already excluded from sale).

**Priority within home chores:** deposit runs last (after equip, craft, buy, and
sell). This ensures sale proceeds are captured in the same deposit, and the coin
count used for buy decisions isn't reduced by the deposit.

**Withdraw:** not yet implemented. The bot only deposits. Items must be
withdrawn manually or via future agent work.

**Event monitoring:** `storageCharged` (contains `coinsLeft` and `charged`) and
`storageEmptied` are logged via `onEvent` at `index.ts:721` so the storage fee
can be observed at runtime.

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
rates, combat averages, and heat map proximity lookups. Five categories:

- **Safe locations** — discovered towns, healers, and player-built structures
  where the bot can recover. Not limited to (0, 0).
- **Merchant knowledge** — location, inventory, and prices for every merchant
  ever encountered, including ones discovered far from home.
- **World heat map** — spatial record of where monsters, resources, and NPCs
  were observed, with timestamps. Observations expire if not re-confirmed after
  a set duration. Used to guide exploration and target-farming routes.
- **Combat history** — per monster type: HP (available directly from heartbeat
  units), average damage dealt per hit to the player (not in client data —
  inferred from player HP-delta during combat; may vary), and kill count. Used
  to decide whether to engage a monster or flee, and to estimate fight
  survivability.
- **Drop tables** — per monster type: total kills and per-item drop counts,
  from which drop rates are derived. Enables target-farming for crafting
  ingredients and helps prioritise gear upgrade paths based on realistic
  ingredient acquisition cost.

Currently absent — the bot only knows what is in the current heartbeat tick.

### Quest
A task accepted from an NPC that yields a reward (coins, items) on completion.
Quests are not a separate track — they compete in the same utility scoring
system as selling or crafting. A turn-in quest that pays better per item than
selling should be preferred. A quest that provides a crafting ingredient cheaper
than any other route should be pursued when that ingredient is on the upgrade
path.

### Merchant trade model
Each merchant NPC exposes two price lists:
- `trades.selling` — items the merchant sells *to* the player (player buys)
- `trades.buying` — items the merchant buys *from* the player (player sells)

When deciding where to sell an item, compare prices across all visible
merchants' `buying` lists. The current bot only reads `selling` and misses this
entirely. The deprecated `wants/offers` barter fields should be ignored.

### Player trade
Players can publish their own `buying` and `selling` price lists via `setTrade`,
enabling player-to-player commerce. Not currently used; relevant once the bot
encounters other players with desirable trade offers.

### Progression loop
The primary game cycle: hunt monsters → loot → sell or turn in quests (whichever
pays better) → buy or craft better gear → hunt slightly harder monsters →
repeat. Quests and crafting compete in the same utility scoring system as
direct selling; the best-value path wins.
