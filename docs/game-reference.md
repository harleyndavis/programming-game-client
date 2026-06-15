# Game Reference

Discovered facts about the programming-game server and client SDK. Updated as we observe new behaviour in the running bot. This is not a guide to the bot's decisions — for bot architecture, see `CONTEXT.md`.

---

## World

The game world is an open plane with no hard impassable obstacles. Characters walk through trees, ore deposits, and other objects. Pathfinding only needs cost-weighted routing (e.g. avoid dangerous areas); there are no connectivity graphs or obstacle meshes.

---

## Timing

### Global cooldown

0.5 seconds between actions. Source: `heartbeat.constants.globalCooldown` — prefer this live value over the deprecated `constants.ts` export, which currently matches but may diverge.

Applies after gear equips, attacks, and most other actions. **Move is exempt** — move intents can be issued freely during cooldown. All other actions are blocked. Intents can be changed during cooldown; they are queued and executed when the cooldown expires.

### Intent throttle

The server applies a 100 ms leading-and-trailing throttle to incoming intents. Multiple intent changes within a 100 ms window collapse to the last one received — intermediates are silently dropped. The client will not resend an intent if it has not changed since the last send.

Combined with the global cooldown and status effects, an intent sent by the bot may not be acted on for several ticks. The server queues it and executes it when conditions allow. This is the primary explanation for observed intent lag of 6–30 ticks.

### Server event rate

The server can emit up to 60 events per second during movement (~16–17 ms between events). Extra heartbeat ticks arrive between server events — the client fires one on every server event *and* on a 300 ms poll. Extra ticks carry no new server state; they are time-passing acknowledgements and should not be treated as match activity.

---

## Combat

### Ranges

| Attack type | Range |
|---|---|
| Melee | 0.7 units |
| Bow (min) | 2.5 units |
| Bow (max) | 10 units |

Bow requires arrows (consumable). No arrows = cannot use bow. Grimoire (offhand) is assumed to be required for spellcasting, same as bow — unverified.

### Action durations

| Action | Duration |
|---|---|
| Gear equip | Instant — fires `equipped` immediately, then global cooldown applies |
| Spell equip | 5,000 ms — fires `beganEquippingSpell`, then `equippedSpell` after 5 s |
| Crafting / harvesting / casting | Individual — tracked via `actionStart` + `actionDuration` in the heartbeat |

Spell equip is too slow for mid-combat use; spellbook must be configured before engaging.

### Intent persistence

Attack intent does not clear when combat ends — `player.intent === 'attack'` remains in the heartbeat after the target dies. A stale attack intent does not mean combat is ongoing; confirm against active target presence.

---

## Economy

### Merchants

Each merchant NPC exposes two price lists via `unit.trades` (use `NewTrades` fields; the old `wants`/`offers` fields are deprecated):

| Field | Meaning |
|---|---|
| `trades.selling` | Items the merchant sells **to** the player (player pays) |
| `trades.buying` | Items the merchant buys **from** the player (player earns) |

Each entry is `{ price: number, quantity: number }`. When deciding where to sell an item, compare `buying.price` across all visible merchants. The deprecated `wants`/`offers` barter fields should be ignored.

### Storage fees

Each player has a personal bank vault (`player.storage`) accessible through banker NPCs (`NPC_TYPE.banker`). Items in storage survive death.

**Fee formula:** `ceil(total_storage_weight_g × 0.0025) × 100` coins. This is the minimum coin balance that should remain in storage as a fee buffer — only coins above this amount are safely withdrawable.

**Events emitted:**
- `storageCharged` — contains `charged` (fee taken) and `coinsLeft` (remaining balance)
- `storageEmptied` — fired when storage coin balance hits zero
- `deposited` — confirms a deposit completed
- `withdrew` — confirms a withdrawal completed

---

## Arena

There is no explicit match-start or match-end event.

**Detecting match start:** when an arena heartbeat arrives and the arena timer has advanced, a new match has begun. Log this tick as the match-start boundary and close out the previous match (win/loss/tie) at the same time. If no arena combat log exists yet (cold start), skip the close-out.

**Detecting match end:** if 60 seconds have elapsed since the last arena tick, assume the match has ended. Arena match duration is fixed at 60 seconds.

---

## Client SDK

### `connect()` and `onEvent`

`connect()` accepts an `onEvent` callback that receives every raw server event before it is processed into a heartbeat. Useful for observing events that are not surfaced in the heartbeat (e.g. `storageCharged`, `storageEmptied`, `unitDisappeared`) and for timing analysis.

### `heartbeat.constants` vs `constants.ts`

Prefer `heartbeat.constants` at runtime. The top-level `constants.ts` export is deprecated and currently matches, but the live heartbeat value is authoritative.

### Key event shapes

| Event | Key fields |
|---|---|
| `attacked` | `attacker`, `attacked`, `damage`, `hp` (attacked unit's resulting HP), `attackerTp` |
| `loot` | `unitId` (the looted unit), `items: Partial<Record<Items, number>>` |
| `dropped` | `unitId`, `item: Items`, `amount` |
| `storageCharged` | `charged`, `coinsLeft` |
| `updatedTrade` | `unitId`, `trades` (full `Trades & NewTrades`) |

### NPC types

```ts
enum NPC_TYPE {
  guard    = 'guard',
  banker   = 'banker',
  merchant = 'merchant',
  healer   = 'healer',
}
```

### Monster IDs

```ts
enum Monsters {
  chicken, rat, goblin, goblinScout, goblinMedicant,
  snake, imp, slime, orc, orcBerserker, orcShaman, orcScout,
  wolf, troll, slimeKing, plainsTrainingDummy, satyr
}
```

Monster identity in the heartbeat comes from `unit.monsterId` (the `Monsters` enum value), not `unit.name` or `unit.id`.
