import type { ActiveQuests, ActiveQuest, ClientSideNPC } from 'programming-game/types';

/**
 * Returns the first active quest whose turn_in step requiredItems are all
 * present in inventory. A quest with no turn_in step or no requiredItems
 * is not considered completable (we can't determine what to hand in).
 */
export const findCompletableQuest = (
  activeQuests: ActiveQuests,
  inventory: Partial<Record<string, number>>,
): ActiveQuest | null => {
  for (const quest of Object.values(activeQuests)) {
    for (const step of quest.steps) {
      if (step.type !== 'turn_in' || !step.requiredItems) continue;
      let satisfied = true;
      for (const [itemId, qty] of Object.entries(step.requiredItems)) {
        if (typeof qty !== 'number') continue;
        if ((inventory[itemId] ?? 0) < qty) {
          satisfied = false;
          break;
        }
      }
      if (satisfied) return quest;
    }
  }
  return null;
};

/**
 * Finds the NPC whose id matches quest.end_npc among visible units.
 */
export const findTurnInNpc = (
  quest: ActiveQuest,
  units: readonly ClientSideNPC[],
): ClientSideNPC | null => {
  return units.find((u) => u.id === quest.end_npc) ?? null;
};

/**
 * Scores an NPC-offered quest by total reward item count.
 * Higher is better. Falls back to 1 if no reward items defined.
 */
export const evaluateQuest = (
  quest: ClientSideNPC['availableQuests'][string],
): number => {
  const items = quest.rewards?.items;
  if (!items) return 1;
  return Object.values(items).reduce((sum, qty) => sum + (typeof qty === 'number' ? qty : 0), 0);
};

/**
 * Picks the best available quest to accept from all nearby NPCs.
 * Skips quests already active. Returns null if at capacity or nothing available.
 */
export const findBestQuestToAccept = (
  questGivers: readonly ClientSideNPC[],
  activeQuests: ActiveQuests,
  maxActiveQuests: number,
): { npc: ClientSideNPC; quest: ClientSideNPC['availableQuests'][string] } | null => {
  if (Object.keys(activeQuests).length >= maxActiveQuests) return null;

  let best: { npc: ClientSideNPC; quest: ClientSideNPC['availableQuests'][string] } | null = null;
  let bestScore = -1;

  for (const npc of questGivers) {
    if (!npc.availableQuests) continue;
    for (const quest of Object.values(npc.availableQuests)) {
      if (!quest || activeQuests[quest.id]) continue;
      const score = evaluateQuest(quest);
      if (score > bestScore) {
        bestScore = score;
        best = { npc, quest };
      }
    }
  }
  return best;
};

/**
 * Returns NPCs from units that have non-empty availableQuests.
 */
export const findQuestGivers = (
  units: readonly ClientSideNPC[],
): ClientSideNPC[] => {
  return units.filter((u) => u.availableQuests && Object.keys(u.availableQuests).length > 0);
};

/**
 * Picks one active quest to abandon, one per call — used to drain the quest
 * log a single quest at a time when quest pursuit is disabled.
 */
export const findQuestToAbandon = (
  activeQuests: ActiveQuests,
): ActiveQuest | null => {
  const quests = Object.values(activeQuests);
  return quests.length > 0 ? quests[0] : null;
};
