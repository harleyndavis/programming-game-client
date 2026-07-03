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
 * Gross quantity of every item (targets + transitive ingredients + required
 * tools) needed to craft one of each target via no-station recipes.
 *
 * Deliberately ignores current inventory: callers use the result as a
 * "keep this many, anything beyond is sellable surplus" bound, so it must not
 * shrink as materials are gathered. Shared ingredients accumulate across
 * targets (axe + knife each needing stone → stone: 2).
 */
export const computeChainNeeds = (
  targetItemIds: string[],
  recipes: RecipeList,
): Record<string, number> => {
  const needs: Record<string, number> = {};
  const walk = (itemId: string, qty: number, visited: Set<string>): void => {
    if (visited.has(itemId)) return;
    needs[itemId] = (needs[itemId] ?? 0) + qty;
    const recipe = recipes.find(r => itemId in (r.output ?? {}) && r.station == null);
    if (!recipe) return;
    const outQty = (recipe.output ?? {})[itemId] ?? 1;
    const crafts = Math.ceil(qty / outQty);
    const next = new Set(visited);
    next.add(itemId);
    for (const [inputId, inputQty] of Object.entries(recipe.input ?? {})) {
      walk(inputId, (inputQty ?? 0) * crafts, next);
    }
    for (const reqId of recipe.required ?? []) {
      walk(String(reqId), 1, next);
    }
  };
  for (const targetId of Array.from(new Set(targetItemIds))) {
    walk(targetId, 1, new Set());
  }
  return needs;
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
  const recipe = recipes.find(r => itemId in (r.output ?? {}) && r.station == null);
  if (recipe) {
    return (
      Object.keys(recipe.input).every(id => canObtainChain(id, inventory, allMerchantSelling, recipes, next)) &&
      (recipe.required ?? []).every(id => canObtainChain(id as string, inventory, allMerchantSelling, recipes, next))
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
  const recipe = recipes.find(r => itemId in (r.output ?? {}) && r.station == null);
  if (!recipe) return [];

  const result: Array<{ itemId: string; reason: string }> = [];
  const check = (id: string) => {
    if (canObtainChain(id, inventory, allMerchantSelling, recipes)) return;
    const sub = recipes.find(r => id in (r.output ?? {}) && r.station == null);
    const atMerchant = !!(allMerchantSelling[id]?.quantity ?? 0);
    let reason: string;
    if (!sub && !atMerchant) reason = "Not in inventory, no recipe, and not sold at any merchant";
    else if (sub) reason = "Has a recipe but its ingredients are also not obtainable";
    else reason = "Not obtainable";
    result.push({ itemId: id, reason });
  };

  for (const inputId of Object.keys(recipe.input)) check(inputId);
  for (const reqId of recipe.required ?? []) check(String(reqId));
  return result;
};

export const computeDifficultyTier = (opts: {
  itemId: string;
  recipe: { id: string; input: Partial<Record<string, number>>; required: readonly string[] } | null;
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
