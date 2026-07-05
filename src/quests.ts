import type { ActiveQuests, ActiveQuest, ClientSideNPC } from 'programming-game/types';

const isStepComplete = (step: ActiveQuest['steps'][number]): boolean => {
  if (step.type === 'goto') return step.completed;
  if (step.type === 'kill') {
    return Object.values(step.targets).every(t => t != null && t.killed >= t.required);
  }
  return false; // turn_in is the final step; never marked complete client-side
};

/**
 * All item IDs required across active quests whose current step is a turn_in,
 * regardless of how many we already own. Use this for sell/deposit protection.
 */
export const findQuestTurnInRequiredItemIds = (activeQuests: ActiveQuests): Set<string> => {
  const ids = new Set<string>();
  for (const quest of Object.values(activeQuests)) {
    const currentStep = quest.steps.find(step => !isStepComplete(step));
    if (!currentStep || currentStep.type !== 'turn_in' || !currentStep.requiredItems) continue;
    for (const itemId of Object.keys(currentStep.requiredItems)) ids.add(itemId);
  }
  return ids;
};

/**
 * Items still needed (shortfall vs pocket inventory) across active quests whose
 * current step is a turn_in. Use this to decide what to buy or withdraw.
 */
export const findPendingQuestTurnInItems = (
  activeQuests: ActiveQuests,
  inventory: Partial<Record<string, number>>,
): Partial<Record<string, number>> => {
  const needed: Partial<Record<string, number>> = {};
  for (const quest of Object.values(activeQuests)) {
    const currentStep = quest.steps.find(step => !isStepComplete(step));
    if (!currentStep || currentStep.type !== 'turn_in' || !currentStep.requiredItems) continue;
    for (const [itemId, qty] of Object.entries(currentStep.requiredItems)) {
      if (typeof qty !== 'number') continue;
      const shortfall = Math.max(0, qty - (inventory[itemId] ?? 0));
      if (shortfall > 0) needed[itemId] = (needed[itemId] ?? 0) + shortfall;
    }
  }
  return needed;
};

/**
 * Active quests whose current step is a turn_in requiring an item that's both
 * short in inventory and not currently obtainable (caller decides what counts
 * as obtainable — e.g. not in storage and not sold by any known merchant).
 * These can't complete until something about the world changes, so they're
 * candidates for abandonment to free a quest slot. See `findQuestToAbandon`.
 */
export const findStalledQuests = (
  activeQuests: ActiveQuests,
  inventory: Partial<Record<string, number>>,
  unobtainableItemIds: ReadonlySet<string>,
): ActiveQuest[] => {
  const result: ActiveQuest[] = [];
  for (const quest of Object.values(activeQuests)) {
    const currentStep = quest.steps.find(step => !isStepComplete(step));
    if (!currentStep || currentStep.type !== 'turn_in' || !currentStep.requiredItems) continue;
    const stalled = Object.entries(currentStep.requiredItems).some(([itemId, qty]) => {
      if (typeof qty !== 'number') return false;
      return (inventory[itemId] ?? 0) < qty && unobtainableItemIds.has(itemId);
    });
    if (stalled) result.push(quest);
  }
  return result;
};

/**
 * Returns the first active quest whose CURRENT step (first incomplete step)
 * is a turn_in with all requiredItems present in inventory.
 */
export const findCompletableQuest = (
  activeQuests: ActiveQuests,
  inventory: Partial<Record<string, number>>,
): ActiveQuest | null => {
  for (const quest of Object.values(activeQuests)) {
    const currentStep = quest.steps.find(step => !isStepComplete(step));
    if (!currentStep || currentStep.type !== 'turn_in') continue;
    if (!currentStep.requiredItems) return quest; // no items required — ready to turn in
    let satisfied = true;
    for (const [itemId, qty] of Object.entries(currentStep.requiredItems)) {
      if (typeof qty !== 'number') continue;
      if ((inventory[itemId] ?? 0) < qty) { satisfied = false; break; }
    }
    if (satisfied) return quest;
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

export type QuestScoringOpts = {
  /**
   * Items the bot currently needs (e.g. missing craft-chain ingredients).
   * A quest rewarding any of them outranks every quest that doesn't.
   */
  neededItems?: ReadonlySet<string>;
  /**
   * Items the bot already has plenty of (e.g. a tool it needs at most one or
   * two of, already sitting at 8). These contribute zero score when they
   * appear in a reward — not just "not bonused" like a neutral item, actively
   * zeroed — so a quest whose entire reward is already-stocked items scores
   * below the unknown-reward fallback (1) and stops winning acceptance purely
   * by being the only/repeatable option at an NPC. Without this, a repeatable
   * quest can cycle forever once its reward item is no longer useful.
   */
  stockedItems?: ReadonlySet<string>;
  /**
   * Reward items the server omits from availableQuests, keyed by quest id.
   * Without this, a progression quest like wood_for_stone scores the fallback 1
   * and always loses to filler quests.
   */
  rewardPatches?: Record<string, Record<string, number>>;
};

/** Score boost for quests rewarding a currently-needed item. */
const NEEDED_REWARD_BONUS = 1000;

/** True when a quest's reward includes an item currently needed (see QuestScoringOpts.neededItems). */
export const questRewardsNeededItem = (
  quest: ClientSideNPC['availableQuests'][string],
  neededItems: ReadonlySet<string> | undefined,
  rewardPatches?: Record<string, Record<string, number>>,
): boolean => {
  if (!neededItems || neededItems.size === 0) return false;
  const items = rewardPatches?.[quest.id] ?? quest.rewards?.items;
  if (!items) return false;
  return Object.keys(items).some(itemId => neededItems.has(itemId));
};

/**
 * Scores an NPC-offered quest by total reward item count, heavily boosted when
 * a reward item is currently needed and zeroed out for reward items already
 * stocked. Falls back to 1 if no reward items known.
 */
export const evaluateQuest = (
  quest: ClientSideNPC['availableQuests'][string],
  opts?: QuestScoringOpts,
): number => {
  const items = opts?.rewardPatches?.[quest.id] ?? quest.rewards?.items;
  if (!items) return 1;
  let score = 0;
  for (const [itemId, qty] of Object.entries(items)) {
    if (typeof qty !== 'number') continue;
    if (opts?.stockedItems?.has(itemId)) continue; // already have plenty — this reward is worth nothing
    score += qty;
  }
  const bonus = questRewardsNeededItem(quest, opts?.neededItems, opts?.rewardPatches) ? NEEDED_REWARD_BONUS : 0;
  return score + bonus;
};

const scanForBestQuest = (
  questGivers: readonly ClientSideNPC[],
  activeQuests: ActiveQuests,
  scoringOpts?: QuestScoringOpts,
): { npc: ClientSideNPC; quest: ClientSideNPC['availableQuests'][string] } | null => {
  let best: { npc: ClientSideNPC; quest: ClientSideNPC['availableQuests'][string] } | null = null;
  let bestScore = -1;

  for (const npc of questGivers) {
    if (!npc.availableQuests) continue;
    for (const quest of Object.values(npc.availableQuests)) {
      if (!quest || activeQuests[quest.id]) continue;
      const score = evaluateQuest(quest, scoringOpts);
      if (score <= 0) continue; // fully-stocked reward — reject, don't just rank low
      if (score > bestScore) {
        bestScore = score;
        best = { npc, quest };
      }
    }
  }
  return best;
};

/**
 * Picks the best available quest to accept from all nearby NPCs.
 * Skips quests already active. Returns null if at capacity or nothing available.
 */
export const findBestQuestToAccept = (
  questGivers: readonly ClientSideNPC[],
  activeQuests: ActiveQuests,
  maxActiveQuests: number,
  scoringOpts?: QuestScoringOpts,
): { npc: ClientSideNPC; quest: ClientSideNPC['availableQuests'][string] } | null => {
  if (Object.keys(activeQuests).length >= maxActiveQuests) return null;
  return scanForBestQuest(questGivers, activeQuests, scoringOpts);
};

/**
 * Same candidate scan as `findBestQuestToAccept` but ignores quest-slot
 * capacity. Used to judge whether a quest waiting to be accepted is valuable
 * enough to justify freeing a slot for it — see `findQuestToAbandon`.
 */
export const findBestAvailableQuest = (
  questGivers: readonly ClientSideNPC[],
  activeQuests: ActiveQuests,
  scoringOpts?: QuestScoringOpts,
): { npc: ClientSideNPC; quest: ClientSideNPC['availableQuests'][string] } | null =>
  scanForBestQuest(questGivers, activeQuests, scoringOpts);

/**
 * Picks a stalled quest to abandon, but only when it would actually unblock
 * progress: quest capacity must be genuinely full, and a quest that rewards
 * something currently needed must be waiting on that capacity. Abandoning a
 * stalled quest just to make room for more filler would throw away whatever
 * partial value it still has for nothing in return.
 *
 * With multiple stalled quests, drops the first found — they're all already
 * "can't complete right now", so there's no reward-based ranking worth doing
 * (active quests don't carry reward data client-side to rank by anyway).
 */
export const findQuestToAbandon = (
  stalledQuests: readonly ActiveQuest[],
  atCapacity: boolean,
  bestAvailableQuest: { npc: ClientSideNPC; quest: ClientSideNPC['availableQuests'][string] } | null,
  neededItems: ReadonlySet<string>,
  rewardPatches?: Record<string, Record<string, number>>,
): ActiveQuest | null => {
  if (!atCapacity || stalledQuests.length === 0 || !bestAvailableQuest) return null;
  if (!questRewardsNeededItem(bestAvailableQuest.quest, neededItems, rewardPatches)) return null;
  return stalledQuests[0];
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
 * Picks one active quest to dismiss, one per call — used to drain the quest
 * log a single quest at a time when quest pursuit is disabled entirely (as
 * opposed to findQuestToAbandon, which only ever drops a single stalled
 * quest to free capacity for a better one).
 */
export const findQuestToDismiss = (
  activeQuests: ActiveQuests,
): ActiveQuest | null => {
  const quests = Object.values(activeQuests);
  return quests.length > 0 ? quests[0] : null;
};
