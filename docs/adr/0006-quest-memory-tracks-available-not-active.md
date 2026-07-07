# ADR-0006: Quest memory only records AvailableQuest sightings, not ActiveQuest

## Status
Accepted

## Context
ADR-0005 normalized quest data into relational columns/child tables but still
had `recordQuestSighting` accept `ActiveQuest | AvailableQuest` and write the
reward/kill-requirement/turn-in-item child tables from whichever shape it was
handed, reconciling the two partial views (`end_npc`, `repeatable`) via
`COALESCE` upserts.

Reviewing this surfaced two problems:

1. **`ActiveQuest`'s steps are a live-progress view, not a fixed definition.**
   `PlayerQuestStep` (the type of `ActiveQuest.steps`) doesn't even carry a
   `'gather'` variant — only `NPCQuestStep` (`AvailableQuest.steps`) does —
   and a kill step's targets can plausibly shrink or complete over a quest's
   lifetime. Treating every `ActiveQuest` sighting as authoritative meant a
   later, narrower snapshot (e.g. a satisfied step dropping out of the
   payload) would silently delete a still-true requirement fact from memory
   the moment progress — not the requirement itself — changed.
2. **It's redundant with the heartbeat.** While a quest is active,
   `player.quests` already gives `index.ts` the current step list on every
   tick, in real time. Memory persisting a second, laggier copy of the same
   data serves no purpose `index.ts`'s own live state doesn't already serve.

## Decision
`recordQuestSighting` now only accepts `AvailableQuest` and always writes
`status = 'available'` — there is no `'active'` status anymore. Each call
fully refreshes the reward/kill-requirement/turn-in-item child tables:
current items/monsters are upserted, and rows for anything no longer present
in the current step list are deleted (not left to go stale). An empty result
set (e.g. a quest with no kill step) is treated as a real fact — all
prior rows in that table for the quest are cleared — because `AvailableQuest`
describes the quest's fixed definition, not a mutable progress view, so
"missing from this snapshot" reliably means "not part of this quest."

The one useful fact only `ActiveQuest` carries that `AvailableQuest` can't —
`end_npc`, the turn-in NPC — is captured by a new, narrow
`recordQuestEndNpc(db, npcName, quest: ActiveQuest, now)`. It touches only
`end_npc_id` and `last_seen_at` via `UPDATE ... WHERE start_npc_id = ? AND
quest_id = ?`, and is deliberately update-only: if the quest has no existing
row (never seen as an `AvailableQuest` — e.g. accepted before memory was
wired in, or in a prior session), the update affects zero rows rather than
fabricating a placeholder quest record just to hold an `end_npc_id`.

A consequence: `repeatable` is now always known once a quest row exists (it's
only ever written from `AvailableQuest`, which always carries it), so
`QuestRecord.repeatable` is a plain `boolean`, not `boolean | null`.

## Consequences
- Memory never mirrors an active quest's progress at all — by design. If a
  quest is abandoned, nothing durable is lost beyond the `available`
  definition and completion status memory already had; the heartbeat owned
  everything else about its live state anyway.
- If the bot's very first sighting of a quest is `active` (already accepted
  before memory ever saw it as an offer — e.g. across a version upgrade),
  memory has no reward/requirement data for it until it happens to be
  re-offered as available again (unlikely for a non-repeatable quest already
  accepted). This is accepted as a rare, self-correcting gap rather than
  something worth reintroducing `ActiveQuest`-sourced writes to close.
- `getQuestSighting`/`getKnownQuestsForNpc` are unaffected in shape — they
  still assemble `QuestRecord` by joining the child tables — but the data
  underneath now comes from a single, authoritative source per quest instead
  of two partial views reconciled via `COALESCE`.
