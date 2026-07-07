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
 *
 * Station gating uses two different sets, deliberately kept separate:
 *   - knownStationTypes — persisted (memory), "has a station of this type ever
 *     been seen anywhere". Governs whether something counts as obtainable at
 *     all (tier 4 vs 5, and every recursive ingredient a chain depends on) —
 *     a recipe requiring a station type we've never seen anywhere is treated
 *     as unreachable, exactly like having no recipe at all, so it doesn't get
 *     preferred over a genuinely obtainable alternative. Must stay stable
 *     across the bot's current location, which is the whole point of
 *     sourcing it from memory.
 *   - availableStationTypes — live, this tick's visible stations. Governs
 *     whether something may be treated as craftable *right now* (tier 2) — a
 *     station-gated recipe must never be reported "craft now" unless the bot
 *     is actually standing at a matching station.
 * Mixing these up would let the bot pick a station recipe as its immediate
 * craft target with no station in reach.
 */

/** True if a recipe has no station requirement, or its required station type is in `stationTypes`. */
export const isRecipeAvailable = (
  recipe: { station?: string | null },
  stationTypes: ReadonlySet<string> = new Set(),
): boolean => recipe.station == null || stationTypes.has(recipe.station);

/**
 * TEMPORARY manual override — remove once recipe selection can rank multiple
 * candidate recipes per output by cost/obtainability instead of every
 * `recipes.find(r => itemId in r.output ...)` call site (src/craft.ts,
 * src/equipment.ts, src/harvest.ts, this file) just taking the first array
 * match. Until then, disabling only the coin-melt step itself
 * (`chunkOfCopper`, which spends `copperCoin` currency) isn't enough: its
 * consumer `copperIngot` (chunkOfCopper → copperIngot) would still be the
 * first match for output `copperIngot`, and — now unable to obtain
 * chunkOfCopper — would report the whole ingot as blocked (tier 5) instead
 * of falling through to `copperIngot2` (copperOre → copperIngot, mined for
 * free besides tool wear). So both recipe ids in the coin-melt chain are
 * disabled together, letting `.find()` land on the ore-based recipe.
 *
 * Revisit when smelting/copperIngot upgrade targets actually come up — for
 * now mining is cheap and coins are not, see index.ts's KNOWN_HARVESTABLE_ITEMS.
 */
const DISABLED_RECIPE_IDS: ReadonlySet<string> = new Set(['chunkOfCopper', 'copperIngot']);

/**
 * Preprocessing pass: strips DISABLED_RECIPE_IDS out of a recipe list. Call
 * this once, right where the raw heartbeat recipe list is turned into the
 * `RecipeList` every planning function consumes (index.ts) — everything
 * downstream then simply never sees the disabled recipes exist.
 */
export const filterDisabledRecipes = (recipes: RecipeList): RecipeList =>
  recipes.filter(r => !r.id || !DISABLED_RECIPE_IDS.has(r.id));

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
 * many, anything beyond is sellable surplus" bound — it deliberately does not
 * gate on station availability (a station-gated recipe's ingredients are kept
 * regardless of whether the station has ever been seen, since this is a
 * quantity bound, not a reachability check — see canObtainChain). Shared
 * ingredients accumulate across targets (axe + knife each needing stone →
 * stone: 2).
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
 * A recipe (at any depth of the chain) requiring a station type not in
 * `knownStationTypes` is treated as if it doesn't exist — a station we've
 * never seen anywhere is not a real acquisition path, so it must not make an
 * otherwise-blocked item look obtainable.
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
  knownStationTypes: ReadonlySet<string> = new Set(),
  knownLootItems: ReadonlySet<string> = new Set(),
  knownQuestRewardItems: ReadonlySet<string> = new Set(),
): boolean => {
  if (visited.has(itemId)) return false;
  const next = new Set(visited);
  next.add(itemId);
  if ((inventory[itemId] ?? 0) >= neededQty) return true;
  const offer = allMerchantSelling[itemId];
  if (offer && offer.quantity > 0) return true;
  // A known drop/harvest yield or quest reward is an obtainable path in
  // principle, same as a known merchant offer — independent of whether the
  // source is visible or in reach right now.
  if (knownLootItems.has(itemId)) return true;
  if (knownQuestRewardItems.has(itemId)) return true;
  const recipe = recipes.find(r => itemId in (r.output ?? {}) && isRecipeAvailable(r, knownStationTypes));
  if (recipe) {
    const outQty = (recipe.output ?? {})[itemId] ?? 1;
    const craftsNeeded = Math.ceil(neededQty / outQty);
    return (
      Object.entries(recipe.input).every(([id, qty]) => canObtainChain(id, inventory, allMerchantSelling, recipes, next, (qty ?? 0) * craftsNeeded, knownStationTypes, knownLootItems, knownQuestRewardItems)) &&
      (recipe.required ?? []).every(id => canObtainChain(id as string, inventory, allMerchantSelling, recipes, next, 1, knownStationTypes, knownLootItems, knownQuestRewardItems))
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
  knownStationTypes: ReadonlySet<string> = new Set(),
  knownLootItems: ReadonlySet<string> = new Set(),
  knownQuestRewardItems: ReadonlySet<string> = new Set(),
): Array<{ itemId: string; reason: string }> => {
  const recipe = recipes.find(r => itemId in (r.output ?? {}) && isRecipeAvailable(r, knownStationTypes));
  if (!recipe) return [];

  const result: Array<{ itemId: string; reason: string }> = [];
  const check = (id: string, neededQty: number) => {
    if (canObtainChain(id, inventory, allMerchantSelling, recipes, undefined, neededQty, knownStationTypes, knownLootItems, knownQuestRewardItems)) return;
    const sub = recipes.find(r => id in (r.output ?? {}) && isRecipeAvailable(r, knownStationTypes));
    const atMerchant = !!(allMerchantSelling[id]?.quantity ?? 0);
    const atLootSource = knownLootItems.has(id);
    const atQuestReward = knownQuestRewardItems.has(id);
    let reason: string;
    if (!sub && !atMerchant && !atLootSource && !atQuestReward) reason = "Not in inventory, no recipe, not sold, not a known loot drop, and not a known quest reward";
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
  /** Persisted: governs the tier-4-vs-5 "obtainable eventually" branch. */
  knownStationTypes?: ReadonlySet<string>;
  /** Live: station types currently visible (e.g. 'smithing') — gates tier 2 for station-gated recipes. */
  availableStationTypes?: ReadonlySet<string>;
  /** Persisted: items ever recorded as loot (monster drop or harvest yield) — same stability role as knownStationTypes. */
  knownLootItems?: ReadonlySet<string>;
  /** Persisted: items ever seen as a quest reward, regardless of whether that quest was accepted. */
  knownQuestRewardItems?: ReadonlySet<string>;
}): number => {
  const {
    itemId, recipe, allMerchantSelling, inventory, playerCoins, recipes,
    knownStationTypes = new Set(), availableStationTypes = new Set(),
    knownLootItems = new Set(), knownQuestRewardItems = new Set(),
  } = opts;
  const offer = allMerchantSelling[itemId];
  const inMerchant = !!offer && offer.quantity > 0;

  const buyTier: number = inMerchant ? (offer!.price <= playerCoins ? 1 : 3) : Infinity;

  let craftTier: number = Infinity;
  if (recipe) {
    const inv = inventory as Record<string, number>;
    const hasAllIngredients = Object.entries(recipe.input).every(([id, qty]) => (inv[id] ?? 0) >= (qty ?? 0));
    const hasAllTools = recipe.required.every(id => (inv[id] ?? 0) >= 1);
    if (hasAllIngredients && hasAllTools && isRecipeAvailable(recipe, availableStationTypes)) {
      craftTier = 2;
    } else {
      const allObtainable =
        Object.entries(recipe.input).every(([id, qty]) => canObtainChain(id, inventory, allMerchantSelling, recipes, new Set(), qty ?? 0, knownStationTypes, knownLootItems, knownQuestRewardItems)) &&
        recipe.required.every(id => canObtainChain(id as string, inventory, allMerchantSelling, recipes, new Set(), 1, knownStationTypes, knownLootItems, knownQuestRewardItems));
      craftTier = allObtainable ? 4 : 5;
    }
  }
  // The target item itself (not just its ingredients) may have no recipe at
  // all but still be reachable via harvesting/looting or a quest reward.
  const fallbackTier = (knownLootItems.has(itemId) || knownQuestRewardItems.has(itemId)) ? 4 : Infinity;

  const best = Math.min(buyTier, craftTier, fallbackTier);
  return best === Infinity ? 5 : best;
};
