export type QuestMap = Record<string, { steps: Array<{ type: string; requiredItems?: Partial<Record<string, number>> }> }>;
export type ItemMap = Record<string, { type?: string; calories?: number; stats?: { defense?: number }; damage?: number; attacksPerSecond?: number; ammoType?: string }>;

export const getQuestItems = (quests: QuestMap): Partial<Record<string, number>> => {
  const result: Partial<Record<string, number>> = {};
  for (const quest of Object.values(quests)) {
    for (const step of quest.steps ?? []) {
      if (step.type === 'turn_in' && step.requiredItems) {
        for (const [itemId, qty] of Object.entries(step.requiredItems)) {
          if (typeof qty === 'number') result[itemId] = Math.max(result[itemId] ?? 0, qty);
        }
      }
    }
  }
  return result;
};

// Duplicated from the future src/character.ts; will be de-duped in the wiring PR.
const computeFoodToKeep = (
  inventory: Partial<Record<string, number>>,
  items: ItemMap,
  targetCalories: number,
): Partial<Record<string, number>> => {
  const result: Partial<Record<string, number>> = {};
  let remaining = targetCalories;
  const foodEntries = Object.entries(inventory)
    .filter(([id, qty]) => typeof qty === 'number' && qty > 0 && (items[id]?.calories ?? 0) > 0)
    .sort(([aId], [bId]) => (items[bId]?.calories ?? 0) - (items[aId]?.calories ?? 0));
  for (const [itemId, qty] of foodEntries) {
    if (remaining <= 0) break;
    const cal = items[itemId]?.calories ?? 0;
    const keepQty = Math.min(qty as number, Math.ceil(remaining / cal));
    result[itemId] = keepQty;
    remaining -= keepQty * cal;
  }
  return result;
};

export const computeItemsToSell = (opts: {
  inventory: Partial<Record<string, number>>;
  items: ItemMap;
  quests: QuestMap;
  keepItems: Set<string>;
  maxCalories: number;
}): Partial<Record<string, number>> => {
  const { inventory, items, quests, keepItems, maxCalories } = opts;
  const questItems = getQuestItems(quests);
  const foodToKeep = computeFoodToKeep(inventory, items, maxCalories);

  const toSell: Partial<Record<string, number>> = {};
  for (const [itemId, qty] of Object.entries(inventory)) {
    if (typeof qty !== 'number' || qty <= 0) continue;
    if (items[itemId]?.type === 'currency') continue;
    const pocketQty = Math.max(foodToKeep[itemId] ?? 0, questItems[itemId] ?? 0);
    const surplus = qty - pocketQty;
    if (surplus <= 0) continue;
    if (!keepItems.has(itemId)) toSell[itemId] = surplus;
  }
  return toSell;
};
