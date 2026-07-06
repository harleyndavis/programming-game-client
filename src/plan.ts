import type { RecipeList } from "../bot-types";

/**
 * Shared acquisition-planning primitives.
 * Equipment, harvest, and craft planners all import from here so the
 * tier/reachability vocabulary is consistent across the codebase.
 *
 * Tier semantics (used in UpgradePlanItem and ToolPlanItem):
 *   1 — buyable and affordable right now
 *   2 — craftable right now (have all ingredients + tools)
 *   3 — buyable at a merchant but can't afford yet
 *   4 — craftable eventually (chain is obtainable but missing some pieces)
 *   5 — blocked (no known acquisition path)
 */

export const getChainedIngredients = (
  targetItemId: string,
  recipes: RecipeList,
  visited = new Set<string>(),
): Set<string> => {
  if (visited.has(targetItemId)) return new Set();
  visited.add(targetItemId);
  const result = new Set<string>();
  const recipe = recipes.find(r => targetItemId in (r.output ?? {}));
  if (!recipe) return result;
  for (const inputId of Object.keys(recipe.input)) {
    result.add(inputId);
    getChainedIngredients(inputId, recipes, visited).forEach(id => result.add(id));
  }
  return result;
};

/**
 * Quantity of every item (targets + transitive ingredients + required tools)
 * consumed by crafting one of each target. Callers use this as a "keep this
 * many, anything beyond is sellable surplus" bound. Shared ingredients
 * accumulate across targets (axe + knife each needing stone → stone: 2).
 *
 * When `inventory` is provided, intermediate items already present in the
 * required quantity are protected (added to needs) but not recursed into —
 * their sub-ingredients are not needed since the assembled item is on hand.
 */
export const computeChainNeeds = (
  targetItemIds: string[],
  recipes: RecipeList,
  inventory: Partial<Record<string, number>> = {},
): Record<string, number> => {
  const needs: Record<string, number> = {};
  const walk = (itemId: string, qty: number, visited: Set<string>): void => {
    if (visited.has(itemId)) return;
    needs[itemId] = (needs[itemId] ?? 0) + qty;
    // If we already have enough of this item, its sub-ingredients don't need
    // to be kept — we won't be crafting it from scratch.
    if ((inventory[itemId] ?? 0) >= qty) return;
    const recipe = recipes.find(r => itemId in (r.output ?? {}));
    if (!recipe) return;
    const outQty = (recipe.output ?? {})[itemId] ?? 1;
    const crafts = Math.ceil(qty / outQty);
    const next = new Set(visited);
    next.add(itemId);
    for (const [inputId, inputQty] of Object.entries(recipe.input ?? {})) {
      walk(inputId, (inputQty ?? 0) * crafts, next);
    }
    for (const reqId of recipe.required ?? []) {
      const req = String(reqId);
      // Required tools are not consumed — skip if already in needs, since one
      // satisfies every recipe that uses it and its sub-ingredients were already
      // computed the first time it was encountered.
      if (req in needs) continue;
      walk(req, 1, next);
    }
  };

  for (const targetId of Array.from(new Set(targetItemIds))) {
    walk(targetId, 1, new Set());
  }
  return needs;
};

/**
 * Whether at least `neededQty` of itemId can be obtained — already on hand,
 * sold by a visible merchant, or craftable from ingredients that are
 * themselves obtainable in the quantities the recipe actually consumes.
 *
 * neededQty matters: owning 1 copper coin doesn't mean a recipe that melts
 * down 1000 coins into a chunk of copper is obtainable. Ingredient quantities
 * scale with how many crafts of the parent are needed (e.g. needing 3 swords
 * from a recipe that outputs 2 per craft means 2 crafts, so inputs are ×2).
 */
export const canObtainChain = (
  itemId: string,
  inventory: Partial<Record<string, number>>,
  allMerchantSelling: Record<string, { price: number; quantity: number } | undefined>,
  recipes: RecipeList,
  visited = new Set<string>(),
  neededQty = 1,
): boolean => {
  if (visited.has(itemId)) return false;
  const next = new Set(visited);
  next.add(itemId);
  if ((inventory[itemId] ?? 0) >= neededQty) return true;
  const offer = allMerchantSelling[itemId];
  if (offer && offer.quantity > 0) return true;
  const recipe = recipes.find(r => itemId in (r.output ?? {}));
  if (recipe) {
    const outQty = (recipe.output ?? {})[itemId] ?? 1;
    const craftsNeeded = Math.ceil(neededQty / outQty);
    return (
      Object.entries(recipe.input).every(([id, qty]) => canObtainChain(id, inventory, allMerchantSelling, recipes, next, (qty ?? 0) * craftsNeeded)) &&
      (recipe.required ?? []).every(id => canObtainChain(id as string, inventory, allMerchantSelling, recipes, next, 1))
    );
  }
  return false;
};

/**
 * For a blocked item (tier 5), returns the direct recipe inputs or required
 * tools that are themselves not obtainable. Each entry includes a human-readable
 * reason so the dashboard can surface it on hover.
 *
 * Returns an empty array when the item has no craftable recipe — in that case
 * the item itself is the dead end (no recipe, not sold, not in inventory).
 */
export const findBlockingItems = (
  itemId: string,
  inventory: Partial<Record<string, number>>,
  allMerchantSelling: Record<string, { price: number; quantity: number } | undefined>,
  recipes: RecipeList,
): Array<{ itemId: string; reason: string }> => {
  const recipe = recipes.find(r => itemId in (r.output ?? {}));
  if (!recipe) return [];

  const result: Array<{ itemId: string; reason: string }> = [];
  const check = (id: string, neededQty: number) => {
    if (canObtainChain(id, inventory, allMerchantSelling, recipes, undefined, neededQty)) return;
    const sub = recipes.find(r => id in (r.output ?? {}));
    const atMerchant = !!(allMerchantSelling[id]?.quantity ?? 0);
    let reason: string;
    if (!sub && !atMerchant) reason = "Not in inventory, no recipe, and not sold at any merchant";
    else if (sub) reason = "Has a recipe but its ingredients are also not obtainable";
    else reason = "Not obtainable";
    result.push({ itemId: id, reason });
  };

  for (const [inputId, qty] of Object.entries(recipe.input)) check(inputId, qty ?? 0);
  for (const reqId of recipe.required ?? []) check(String(reqId), 1);
  return result;
};

export const computeDifficultyTier = (opts: {
  itemId: string;
  recipe: { id: string; input: Partial<Record<string, number>>; required: readonly string[]; station?: string | null } | null;
  allMerchantSelling: Record<string, { price: number; quantity: number } | undefined>;
  inventory: Partial<Record<string, number>>;
  playerCoins: number;
  recipes: RecipeList;
  /** Station types currently visible (e.g. 'smithing') — gates tier 2 for station-gated recipes. */
  availableStationTypes?: Set<string>;
}): number => {
  const { itemId, recipe, allMerchantSelling, inventory, playerCoins, recipes, availableStationTypes = new Set<string>() } = opts;
  const offer = allMerchantSelling[itemId];
  const inMerchant = !!offer && offer.quantity > 0;

  const buyTier: number = inMerchant ? (offer!.price <= playerCoins ? 1 : 3) : Infinity;

  let craftTier: number = Infinity;
  if (recipe) {
    const inv = inventory as Record<string, number>;
    const hasAllIngredients = Object.entries(recipe.input).every(([id, qty]) => (inv[id] ?? 0) >= (qty ?? 0));
    const hasAllTools = recipe.required.every(id => (inv[id] ?? 0) >= 1);
    const stationReady = recipe.station == null || availableStationTypes.has(recipe.station);
    if (hasAllIngredients && hasAllTools && stationReady) {
      craftTier = 2;
    } else {
      const allObtainable =
        Object.entries(recipe.input).every(([id]) => canObtainChain(id, inventory, allMerchantSelling, recipes)) &&
        recipe.required.every(id => canObtainChain(id as string, inventory, allMerchantSelling, recipes));
      craftTier = allObtainable ? 4 : 5;
    }
  }

  const best = Math.min(buyTier, craftTier);
  return best === Infinity ? 5 : best;
};
