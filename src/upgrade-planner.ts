export type QuestMap = Record<string, { steps: Array<{ type: string; requiredItems?: Partial<Record<string, number>> }> }>;
export type RecipeList = ReadonlyArray<{
  id?: string;
  input: Partial<Record<string, number>>;
  output: Partial<Record<string, number>>;
  required?: readonly string[];
  station?: string | null;
}>;
export type ItemMap = Record<string, { type?: string; calories?: number; stats?: { defense?: number }; damage?: number; attacksPerSecond?: number; ammoType?: string }>;

export type UpgradeTarget = {
  itemId: string;
  slot: string;
  tier: number;
  gain: number;
  reachable: boolean;
  recipe: {
    id: string;
    input: Partial<Record<string, number>>;
    required: readonly string[];
  } | null;
};

export const ITEM_TYPE_TO_SLOT: Partial<Record<string, string>> = {
  helm: 'helm', chest: 'chest', legs: 'legs', feet: 'feet', hands: 'hands',
  dagger: 'weapon', oneHandedSword: 'weapon', oneHandedAxe: 'weapon',
  oneHandedMace: 'weapon', twoHandedSword: 'weapon', twoHandedAxe: 'weapon',
  twoHandedMace: 'weapon', bow: 'weapon', staff: 'weapon',
  fellingAxe: 'weapon', pickaxe: 'weapon',
  shield: 'offhand', grimmoire: 'offhand',
  ring: 'ring', amulet: 'amulet',
};

export const BUYABLE_SLOTS = new Set(['helm', 'chest', 'legs', 'feet', 'hands', 'weapon', 'offhand']);

export const WEAPON_AMMO_REQUIREMENT: Partial<Record<string, string>> = {
  bow: 'arrow',
};

export const getChainedIngredients = (
  targetItemId: string,
  recipes: RecipeList,
  visited = new Set<string>(),
): Set<string> => {
  if (visited.has(targetItemId)) return new Set();
  visited.add(targetItemId);
  const result = new Set<string>();
  const recipe = recipes.find(r => targetItemId in r.output);
  if (!recipe) return result;
  for (const inputId of Object.keys(recipe.input)) {
    result.add(inputId);
    getChainedIngredients(inputId, recipes, visited).forEach(id => result.add(id));
  }
  return result;
};

export const canObtainChain = (
  itemId: string,
  inventory: Partial<Record<string, number>>,
  allMerchantSelling: Record<string, { price: number; quantity: number } | undefined>,
  recipes: RecipeList,
  visited = new Set<string>(),
): boolean => {
  if (visited.has(itemId)) return false;
  const next = new Set(visited);
  next.add(itemId);
  if ((inventory[itemId] ?? 0) > 0) return true;
  const offer = allMerchantSelling[itemId];
  if (offer && offer.quantity > 0) return true;
  const recipe = recipes.find(r => itemId in r.output && r.station == null);
  if (recipe) {
    return (
      Object.keys(recipe.input).every(id => canObtainChain(id, inventory, allMerchantSelling, recipes, next)) &&
      (recipe.required ?? []).every(id => canObtainChain(id as string, inventory, allMerchantSelling, recipes, next))
    );
  }
  return false;
};

export const computeDifficultyTier = (opts: {
  itemId: string;
  recipe: UpgradeTarget['recipe'] | null;
  allMerchantSelling: Record<string, { price: number; quantity: number } | undefined>;
  inventory: Partial<Record<string, number>>;
  playerCoins: number;
  recipes: RecipeList;
}): number => {
  const { itemId, recipe, allMerchantSelling, inventory, playerCoins, recipes } = opts;
  const offer = allMerchantSelling[itemId];
  const inMerchant = !!offer && offer.quantity > 0;

  const buyTier: number = inMerchant ? (offer!.price <= playerCoins ? 1 : 3) : Infinity;

  let craftTier: number = Infinity;
  if (recipe) {
    const inv = inventory as Record<string, number>;
    const hasAllIngredients = Object.entries(recipe.input).every(([id, qty]) => (inv[id] ?? 0) >= (qty ?? 0));
    const hasAllTools = recipe.required.every(id => (inv[id] ?? 0) >= 1);
    if (hasAllIngredients && hasAllTools) {
      craftTier = 2;
    } else {
      const allObtainable =
        Object.keys(recipe.input).every(id => canObtainChain(id, inventory, allMerchantSelling, recipes)) &&
        recipe.required.every(id => canObtainChain(id as string, inventory, allMerchantSelling, recipes));
      craftTier = allObtainable ? 4 : 5;
    }
  }

  const best = Math.min(buyTier, craftTier);
  return best === Infinity ? 5 : best;
};

export const computeUpgradeTargets = (opts: {
  equipment: Record<string, string | null | undefined>;
  inventory: Partial<Record<string, number>>;
  items: ItemMap;
  recipes: RecipeList;
  allMerchantSelling: Record<string, { price: number; quantity: number } | undefined>;
  playerCoins: number;
}): UpgradeTarget[] => {
  const { equipment, inventory, items, recipes, allMerchantSelling, playerCoins } = opts;
  const targets: UpgradeTarget[] = [];

  for (const slot of Array.from(BUYABLE_SLOTS)) {
    const equippedId = equipment[slot] ?? null;
    const equippedDef = equippedId ? items[equippedId] : null;
    const equippedDefense = equippedDef?.stats?.defense ?? 0;
    const equippedDps = ((equippedDef as any)?.damage ?? 0) * ((equippedDef as any)?.attacksPerSecond ?? 1);

    let bestNonBlocked: { itemId: string; tier: number; gain: number; reachable: boolean; recipe: UpgradeTarget['recipe'] } | null = null;
    let bestBlocked: { itemId: string; tier: number; gain: number; reachable: boolean; recipe: UpgradeTarget['recipe'] } | null = null;

    for (const [itemId, itemDef] of Object.entries(items)) {
      if (!itemDef) continue;
      if (ITEM_TYPE_TO_SLOT[itemDef.type ?? ''] !== slot) continue;
      if (itemId === equippedId) continue;
      if ((inventory[itemId] ?? 0) > 0) continue;

      const defense = itemDef.stats?.defense ?? 0;
      const dps = ((itemDef as any).damage ?? 0) * ((itemDef as any).attacksPerSecond ?? 1);
      if (defense <= equippedDefense && dps <= equippedDps) continue;

      const recipe = recipes.find(r => itemId in r.output && r.station == null) ?? null;
      const inMerchant = itemId in allMerchantSelling && !!allMerchantSelling[itemId];
      const reachable = !!recipe || !!inMerchant;

      const gain = (defense - equippedDefense) + (dps - equippedDps);
      const recipeEntry = recipe?.id
        ? { id: recipe.id, input: recipe.input as Partial<Record<string, number>>, required: recipe.required ?? [] }
        : null;

      const tier = computeDifficultyTier({ itemId, recipe: recipeEntry, allMerchantSelling, inventory, playerCoins, recipes });

      if (tier < 5) {
        if (bestNonBlocked === null || tier < bestNonBlocked.tier || (tier === bestNonBlocked.tier && gain < bestNonBlocked.gain)) {
          bestNonBlocked = { itemId, tier, gain, reachable, recipe: recipeEntry };
        }
      } else {
        if (bestBlocked === null || gain < bestBlocked.gain) {
          bestBlocked = { itemId, tier, gain, reachable, recipe: recipeEntry };
        }
      }
    }

    const winner = bestNonBlocked ?? bestBlocked;
    if (winner) targets.push({ itemId: winner.itemId, slot, tier: winner.tier, gain: winner.gain, reachable: winner.reachable, recipe: winner.recipe });
  }

  targets.sort((a, b) => {
    if (a.reachable !== b.reachable) return a.reachable ? -1 : 1;
    return a.tier - b.tier || b.gain - a.gain;
  });
  return targets;
};

export const getTargetItemsToKeep = (
  targets: UpgradeTarget[],
  recipes: RecipeList,
): Set<string> => {
  const result = new Set<string>();
  for (const target of targets) {
    if (!target.recipe) continue;
    getChainedIngredients(target.itemId, recipes).forEach(id => result.add(id));
    for (const toolId of target.recipe.required) result.add(toolId as string);
  }
  return result;
};

export const getEquippedRecipeInputs = (
  equipment: Record<string, string | null | undefined>,
  recipes: RecipeList,
): Set<string> => {
  const result = new Set<string>();
  for (const itemId of Object.values(equipment)) {
    if (!itemId) continue;
    getChainedIngredients(itemId, recipes).forEach(id => result.add(id));
    const recipe = recipes.find(r => itemId in r.output);
    if (recipe) {
      for (const toolId of (recipe.required ?? [])) result.add(toolId as string);
    }
  }
  return result;
};

export const computeTargetsToBuyFromMerchant = (opts: {
  targets: UpgradeTarget[];
  merchantSelling: Record<string, { price: number; quantity: number } | undefined>;
  playerCoins: number;
  inventory: Partial<Record<string, number>>;
}): Partial<Record<string, number>> => {
  const { targets, merchantSelling, playerCoins, inventory } = opts;
  const basket: Partial<Record<string, number>> = {};
  let coinsLeft = playerCoins;

  for (const target of targets) {
    if ((inventory[target.itemId] ?? 0) === 0 && !basket[target.itemId]) {
      const offer = merchantSelling[target.itemId];
      if (offer && offer.quantity > 0 && offer.price > 0 && offer.price <= coinsLeft) {
        const canCraftNow = target.recipe !== null &&
          Object.entries(target.recipe.input).every(([id, qty]) => (inventory[id] ?? 0) >= (qty ?? 0)) &&
          target.recipe.required.every(id => (inventory[id as string] ?? 0) >= 1);
        if (!canCraftNow) {
          basket[target.itemId] = 1;
          coinsLeft -= offer.price;
        }
      }
    }
    if (target.recipe) {
      for (const toolId of target.recipe.required) {
        const toolStr = toolId as string;
        if ((inventory[toolStr] ?? 0) >= 1 || basket[toolStr]) continue;
        const offer = merchantSelling[toolStr];
        if (!offer || offer.quantity <= 0 || offer.price <= 0 || offer.price > coinsLeft) continue;
        basket[toolStr] = 1;
        coinsLeft -= offer.price;
      }
    }
  }
  return basket;
};

export const findGearToEquip = (opts: {
  inventory: Partial<Record<string, number>>;
  equipment: Record<string, string | null | undefined>;
  items: ItemMap;
}): { item: string; slot: string } | null => {
  const { inventory, equipment, items } = opts;
  for (const [itemId, qty] of Object.entries(inventory)) {
    if (typeof qty !== 'number' || qty <= 0) continue;
    const itemDef = items[itemId];
    if (!itemDef) continue;
    const slot = ITEM_TYPE_TO_SLOT[itemDef.type ?? ''];
    if (!slot || !BUYABLE_SLOTS.has(slot)) continue;
    const equippedId = equipment[slot] ?? null;
    if (equippedId === itemId) continue;
    if (!equippedId) return { item: itemId, slot };
    const equippedDef = items[equippedId];
    const candidateDefense = itemDef.stats?.defense ?? 0;
    const equippedDefense = equippedDef?.stats?.defense ?? 0;
    const candidateDps = (itemDef.damage ?? 0) * (itemDef.attacksPerSecond ?? 1);
    const equippedDps = (equippedDef?.damage ?? 0) * (equippedDef?.attacksPerSecond ?? 1);
    if (candidateDefense > equippedDefense || candidateDps > equippedDps) {
      return { item: itemId, slot };
    }
  }
  return null;
};
