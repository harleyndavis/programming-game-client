import type { ItemMap, RecipeList, UpgradeTarget } from "../bot-types";
import { canObtainChain, computeDifficultyTier, isRecipeAvailable } from "./plan";

const ITEM_TYPE_TO_SLOT: Partial<Record<string, string>> = {
  helm: 'helm', chest: 'chest', legs: 'legs', feet: 'feet', hands: 'hands',
  dagger: 'weapon', oneHandedSword: 'weapon', oneHandedAxe: 'weapon',
  oneHandedMace: 'weapon', twoHandedSword: 'weapon', twoHandedAxe: 'weapon',
  twoHandedMace: 'weapon', bow: 'weapon', staff: 'weapon',
  fellingAxe: 'weapon', pickaxe: 'weapon',
  shield: 'offhand', grimmoire: 'offhand',
  ring: 'ring', amulet: 'amulet',
};

const BUYABLE_SLOTS = new Set(['helm', 'chest', 'legs', 'feet', 'hands', 'weapon', 'offhand']);

const WEAPON_AMMO_REQUIREMENT: Partial<Record<string, string>> = {
  bow: 'arrow',
};

const recipeInputCoverage = (
  recipe: { input: Partial<Record<string, number>> } | null,
  inventory: Partial<Record<string, number>>,
): number => {
  if (!recipe) return 0;
  let have = 0, need = 0;
  for (const [id, qty] of Object.entries(recipe.input)) {
    const required = qty ?? 0;
    need += required;
    have += Math.min(inventory[id] ?? 0, required);
  }
  return need === 0 ? 0 : have / need;
};

export const computeUpgradeTargets = (opts: {
  equipment: Record<string, string | null | undefined>;
  inventory: Partial<Record<string, number>>;
  items: ItemMap;
  recipes: RecipeList;
  allMerchantSelling: Record<string, { price: number; quantity: number } | undefined>;
  playerCoins: number;
  /** Persisted: does a station of the required type exist anywhere we know of. */
  knownStationTypes?: ReadonlySet<string>;
  /** Live: station types currently visible (e.g. 'smithing') — gates tier 2 for station-gated recipes. */
  availableStationTypes?: ReadonlySet<string>;
  /** Persisted: items ever recorded as loot (monster drop or harvest yield). */
  knownLootItems?: ReadonlySet<string>;
  /** Persisted: items ever seen as a quest reward, regardless of whether that quest was accepted. */
  knownQuestRewardItems?: ReadonlySet<string>;
}): UpgradeTarget[] => {
  const {
    equipment, inventory, items, recipes, allMerchantSelling, playerCoins,
    knownStationTypes = new Set(), availableStationTypes = new Set(),
    knownLootItems = new Set(), knownQuestRewardItems = new Set(),
  } = opts;
  const targets: UpgradeTarget[] = [];

  for (const slot of Array.from(BUYABLE_SLOTS)) {
    const equippedId = equipment[slot] ?? null;
    const equippedDef = equippedId ? items[equippedId] : null;
    const equippedDefense = equippedDef?.stats?.defense ?? 0;
    const equippedDps = ((equippedDef as any)?.damage ?? 0) * ((equippedDef as any)?.attacksPerSecond ?? 1);

    let bestNonBlocked: { itemId: string; tier: number; gain: number; coverage: number; reachable: boolean; recipe: UpgradeTarget['recipe'] } | null = null;
    let bestBlocked: { itemId: string; tier: number; gain: number; reachable: boolean; recipe: UpgradeTarget['recipe'] } | null = null;

    for (const [itemId, itemDef] of Object.entries(items)) {
      if (!itemDef) continue;
      if (ITEM_TYPE_TO_SLOT[itemDef.type ?? ''] !== slot) continue;
      if (itemId === equippedId) continue;
      if ((inventory[itemId] ?? 0) > 0) continue;

      const defense = itemDef.stats?.defense ?? 0;
      const dps = ((itemDef as any).damage ?? 0) * ((itemDef as any).attacksPerSecond ?? 1);
      if (defense <= equippedDefense && dps <= equippedDps) continue;

      const recipe = recipes.find(r => itemId in r.output && isRecipeAvailable(r, knownStationTypes)) ?? null;
      const inMerchant = itemId in allMerchantSelling && !!allMerchantSelling[itemId];
      const reachable = !!recipe || !!inMerchant;

      const gain = (defense - equippedDefense) + (dps - equippedDps);
      const recipeEntry = recipe?.id
        ? { id: recipe.id, input: recipe.input as Partial<Record<string, number>>, required: recipe.required ?? [], station: recipe.station ?? null }
        : null;

      const tier = computeDifficultyTier({
        itemId, recipe: recipeEntry, allMerchantSelling, inventory, playerCoins, recipes,
        knownStationTypes, availableStationTypes, knownLootItems, knownQuestRewardItems,
      });

      if (tier < 5) {
        const coverage = recipeInputCoverage(recipeEntry, inventory);
        if (
          bestNonBlocked === null ||
          tier < bestNonBlocked.tier ||
          (tier === bestNonBlocked.tier && coverage > bestNonBlocked.coverage) ||
          (tier === bestNonBlocked.tier && coverage === bestNonBlocked.coverage && gain < bestNonBlocked.gain)
        ) {
          bestNonBlocked = { itemId, tier, gain, coverage, reachable, recipe: recipeEntry };
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

export const computeTargetsToBuyFromMerchant = (opts: {
  targets: UpgradeTarget[];
  merchantSelling: Record<string, { price: number; quantity: number } | undefined>;
  playerCoins: number;
  inventory: Partial<Record<string, number>>;
  /** Live: a station-gated recipe only counts as "craft now" (skip buying) if standing at a matching station. */
  availableStationTypes?: ReadonlySet<string>;
}): Partial<Record<string, number>> => {
  const { targets, merchantSelling, playerCoins, inventory, availableStationTypes = new Set() } = opts;
  const basket: Partial<Record<string, number>> = {};
  let coinsLeft = playerCoins;

  for (const target of targets) {
    if ((inventory[target.itemId] ?? 0) === 0 && !basket[target.itemId]) {
      const offer = merchantSelling[target.itemId];
      if (offer && offer.quantity > 0 && offer.price > 0 && offer.price <= coinsLeft) {
        const canCraftNow = target.recipe !== null &&
          isRecipeAvailable(target.recipe, availableStationTypes) &&
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
