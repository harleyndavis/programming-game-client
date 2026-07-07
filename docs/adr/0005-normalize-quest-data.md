# ADR-0005: Normalize quest data into relational columns instead of a JSON blob

## Status
Accepted

## Context
`src/memory.ts`'s `quests` table originally stored the entire SDK
`ActiveQuest | AvailableQuest` object as a single `quest_json` TEXT blob,
with only `entity_id`, `quest_id`, `status`, and `last_seen_at` pulled out as
real columns — the only table in the schema built this way. Reviewing it
surfaced three concrete problems:

1. **Not queryable.** "Which known quest rewards item X, and can it actually
   be completed" requires pulling every row and `JSON.parse`-ing it in JS —
   every other table here (`safe_locations`, `heat_map`, `merchant_trades`,
   `combat_history`) answers equivalent questions in SQL.
2. **No type safety at the boundary.** `JSON.parse` returns `any`; a shape
   drift in the SDK, or a bug on the write side, fails silently instead of at
   the DB layer.
3. **Inconsistent with the rest of the schema**, for no reason tied to
   quests being special — it was simply built before the rest of the schema
   settled on a pattern.

Separately, `index.ts` keeps its own in-memory `questRewards`/
`KNOWN_QUEST_REWARDS` cache (`index.ts:71`) that resets on every restart —
every quest reward learned this way is unrecoverable history lost on
restart, exactly the failure mode ADR-0004 names as the reason write-side
memory wiring shouldn't be delayed. Normalizing rewards into memory gives
this cache a durable home (though wiring `index.ts` to actually read from it
is separate work, sequenced per ADR-0004).

## Decision
Fully normalize the nested SDK fields instead of storing them as JSON,
**except mutable per-step progress**, which is deliberately left out:

- `rewards.items` (item → quantity) → `quest_reward_items`.
- `steps[].type === 'kill'` targets → `quest_kill_requirements`, storing only
  the fixed `required` count, never the mutable `killed` counter.
- `steps[].type === 'turn_in'` (`requiredItems`) and `'gather'` (`targets`) →
  `quest_required_items`, storing only the fixed quantities, never the
  mutable `completed` flag.
- `steps[].type === 'goto'` and turn-in positions are dropped entirely —
  never read by `quests.ts`, and not a feasibility fact.

The rationale for excluding progress: it only matters while a quest is
active, when the live heartbeat already has it. Memory's job is answering
"can this quest even be completed for its reward" — a feasibility
question — not "how far along is it" — a live-state question memory has no
business mirroring. This is the same boundary the entity catalog already
draws between permanent identity and the heat map's expiring position data.

Identity fields also changed:
- `entity_id` → renamed `start_npc_id` (the NPC the quest was sighted from).
- `end_npc` (a raw string) → `end_npc_id`, resolved through
  `getOrCreateEntity(db, 'npc', endNpcName)` — consistent with every other
  NPC reference in this schema never duplicating a name string.
- `quest_kill_requirements.monster_entity_id` resolves through
  `getOrCreateEntity(db, 'monster', monsterId)` the same way. A monster or
  NPC named in a quest but never independently sighted still gets a real
  `entities` row (identity only, created on reference — the same mechanism
  `recordCombatHit`/`recordMonsterKill` already rely on) with no
  `heat_map`/`combat_history` rows yet. That split is what makes "have we
  ever seen this monster" a meaningful, separate question from "do we know
  of it at all."
- `name` and `repeatable` are stored as columns even though nothing in
  `quests.ts` reads them today — `name` for human/dev readability when
  inspecting the DB directly, `repeatable` (combined with a new `'completed'`
  status) so a caller can avoid re-attempting a non-repeatable quest already
  done.

Since `end_npc`/progress are absent from `AvailableQuest` and `repeatable` is
absent from `ActiveQuest`, the `quests` upsert preserves existing values via
`COALESCE(excluded.x, quests.x)` rather than clobbering them with whichever
partial view of the quest was just seen — the same pattern `recordMerchant`
already uses for `merchant_trades`.

`quest_json` is dropped entirely — every field on both SDK types is
accounted for by a column or a child table.

## Consequences
- `getQuestSighting`/`getKnownQuestsForNpc` can no longer return the verbatim
  `ActiveQuest | AvailableQuest` — progress isn't stored, so a faithful
  SDK-shaped object can't be reconstructed. They return a new bespoke
  `QuestRecord` type instead, assembled by joining the child tables. This is
  the one place in `memory.ts` where a read function doesn't return a
  thin wrapper around a game-native SDK type — deliberately, not an
  oversight.
- A new `recordQuestCompleted(db, npcName, questId, now)` exists because
  neither SDK quest type carries a "this is done" flag — something has to
  call it explicitly. The exact trigger point (which event or state
  transition signals completion) is left to the wiring PR that connects
  `memory.ts` to `index.ts`, per ADR-0004's phased sequencing.
- While researching this, found `CONTEXT.md` stale on a related claim: it
  said `ActiveQuest` never carries `rewards.items`, which was the reason
  `index.ts` captures rewards at quest-accept time into `questRewards`. The
  SDK now populates `rewards.items` on `ActiveQuest` too (server-side fix,
  confirmed with the user) — `CONTEXT.md` has been corrected. That accept-time
  capture workaround is likely retirable once memory's read side is wired
  into `index.ts`, but that's out of scope here.
