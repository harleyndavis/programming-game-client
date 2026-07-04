import type { GameObject, Position, Station } from "programming-game/types";
import type { RecipeList, UpgradeTarget } from "../bot-types";
import { distanceBetween, isFinitePosition } from "./utils";

/** Every station game object currently visible (same appear/disappear visibility as merchants/bankers/trees). */
export const collectVisibleStations = (
  gameObjects: Record<string, GameObject>,
): Station[] => {
  const stations: Station[] = [];
  for (const obj of Object.values(gameObjects)) {
    if (obj.type === 'station') stations.push(obj as Station);
  }
  return stations;
};

/** The set of station types (e.g. 'smithing') currently visible — gates real-time craftability. */
export const getAvailableStationTypes = (stations: Station[]): Set<string> =>
  new Set(stations.map(s => s.stationType));

/** Nearest currently-visible station matching a recipe's required station type, for execution. */
export const findStationForType = (
  stationType: string | null | undefined,
  stations: Station[],
  playerPosition: Position,
): Station | null => {
  if (!stationType) return null;
  let closest: Station | null = null;
  let closestDistance = Infinity;
  for (const station of stations) {
    if (station.stationType !== stationType || !isFinitePosition(station.position)) continue;
    const dist = distanceBetween(playerPosition, station.position as { x: number; y: number });
    if (dist < closestDistance) {
      closest = station;
      closestDistance = dist;
    }
  }
  return closest;
};

export const findCraftableTarget = (
  targets: UpgradeTarget[],
  inventory: Partial<Record<string, number>>,
  recipes: RecipeList,
  availableStationTypes: Set<string> = new Set(),
): UpgradeTarget | null => {
  for (const target of targets) {
    if (!target.recipe) continue;
    const stationReady = target.recipe.station == null || availableStationTypes.has(target.recipe.station);
    let canCraft = stationReady;
    for (const [inputId, qty] of Object.entries(target.recipe.input)) {
      if ((inventory[inputId] ?? 0) < (qty ?? 0)) { canCraft = false; break; }
    }
    if (canCraft) {
      for (const toolId of target.recipe.required) {
        if ((inventory[toolId as string] ?? 0) < 1) { canCraft = false; break; }
      }
      if (canCraft) return target;
    }
    // Only pre-craft a sub-step when the full parent recipe is achievable from
    // the current inventory (all ingredients present or recursively craftable).
    // Without this guard we'd e.g. craft leather for a chest that also needs
    // copperBar (not in inventory, no recipe) — wasting materials on a dead end.
    if (isFullyAchievableFromInventory(target.recipe, inventory, recipes)) {
      const subStep = findCraftableSubStep(target.recipe, inventory, recipes, new Set<string>(), availableStationTypes);
      if (subStep) {
        return {
          itemId: subStep.recipeId,
          slot: target.slot,
          tier: 0,
          gain: 0,
          reachable: true,
          recipe: subStep.recipe,
        };
      }
    }
  }
  return null;
};

export const findNextCraftTarget = (targets: UpgradeTarget[]): UpgradeTarget | null => {
  for (const target of targets) {
    if (target.reachable) return target;
  }
  return targets[0] ?? null;
};

export function findCraftableFromList(
  itemIds: string[],
  inventory: Partial<Record<string, number>>,
  recipes: RecipeList,
  availableStationTypes: Set<string> = new Set(),
): { itemId: string; recipe: { id: string; input: Partial<Record<string, number>>; required: readonly string[]; station?: string | null } } | null {
  for (const itemId of itemIds) {
    const recipe = recipes.find(r => itemId in (r.output ?? {}) && r.station == null); // TEST: reinstated station filter
    if (!recipe) continue;
    const stationReady = recipe.station == null || availableStationTypes.has(recipe.station);
    let canCraft = stationReady;
    for (const [inputId, qty] of Object.entries(recipe.input ?? {})) {
      if ((inventory[inputId] ?? 0) < (qty ?? 0)) { canCraft = false; break; }
    }
    if (canCraft) {
      for (const toolId of recipe.required ?? []) {
        if ((inventory[toolId as string] ?? 0) < 1) { canCraft = false; break; }
      }
    }
    if (canCraft) {
      return {
        itemId,
        recipe: { id: recipe.id!, input: recipe.input as Partial<Record<string, number>>, required: recipe.required ?? [], station: recipe.station },
      };
    }
    const subRecipe: { id: string; input: Partial<Record<string, number>>; required: readonly string[]; station?: string | null } = {
      id: recipe.id!,
      input: recipe.input as Partial<Record<string, number>>,
      required: recipe.required ?? [],
      station: recipe.station,
    };
    if (isFullyAchievableFromInventory(subRecipe, inventory, recipes)) {
      const subStep = findCraftableSubStep(subRecipe, inventory, recipes, new Set<string>(), availableStationTypes);
      if (subStep && subStep.recipe) return { itemId: subStep.recipeId, recipe: subStep.recipe };
    }
  }
  return null;
}

/**
 * Returns items to buy from a single merchant to enable crafting any of the
 * given target item IDs (including their sub-crafts). Gathers ingredients for
 * station-gated recipes too — buying ahead of a station visit is fine even
 * when the station isn't in view right now. Does not spend more than playerCoins.
 */
export function computeCraftIngredientsToBuyFromMerchant(
  targetItemIds: string[],
  inventory: Partial<Record<string, number>>,
  recipes: RecipeList,
  merchantSelling: Record<string, { price: number; quantity: number } | undefined>,
  playerCoins: number,
): Partial<Record<string, number>> {
  const basket: Partial<Record<string, number>> = {};
  let coinsLeft = playerCoins;

  const gatherNeeded = (itemId: string, qty: number, visited: Set<string>): void => {
    if (visited.has(itemId)) return;
    const have = (inventory[itemId] ?? 0) + (basket[itemId] ?? 0);
    const shortfall = Math.max(0, qty - have);
    if (shortfall <= 0) return;

    const offer = merchantSelling[itemId];
    if (offer && offer.quantity > 0 && offer.price > 0) {
      const canBuy = Math.min(shortfall, Math.floor(coinsLeft / offer.price));
      if (canBuy > 0) {
        basket[itemId] = (basket[itemId] ?? 0) + canBuy;
        coinsLeft -= offer.price * canBuy;
      }
      return;
    }

    const recipe = recipes.find(r => itemId in (r.output ?? {}) && r.station == null); // TEST: reinstated station filter
    if (!recipe) return;
    const outQty = (recipe.output ?? {})[itemId] ?? 1;
    const craftsNeeded = Math.ceil(shortfall / outQty);
    const nextVisited = new Set(visited);
    nextVisited.add(itemId);
    for (const [inputId, inputQty] of Object.entries(recipe.input ?? {})) {
      gatherNeeded(inputId, (inputQty ?? 0) * craftsNeeded, nextVisited);
    }
    // Required tools must be owned (qty 1 each) — recurse so their ingredients are bought too
    for (const reqId of recipe.required ?? []) {
      gatherNeeded(String(reqId), 1, nextVisited);
    }
  };

  for (const toolId of targetItemIds) {
    const recipe = recipes.find(r => toolId in (r.output ?? {}) && r.station == null); // TEST: reinstated station filter
    if (!recipe) continue;
    const visited = new Set<string>([toolId]);
    for (const [inputId, qty] of Object.entries(recipe.input ?? {})) {
      gatherNeeded(inputId, qty ?? 0, visited);
    }
    for (const reqId of recipe.required ?? []) {
      gatherNeeded(String(reqId), 1, visited);
    }
  }

  return basket;
}

/**
 * Returns true if every ingredient in the recipe is either already in
 * inventory or can be crafted (recursively) from what IS in inventory.
 * Ingredients with no recipe and not in inventory → false.
 *
 * This is used to gate sub-step crafting: we only pre-craft an intermediate
 * item (e.g. leather) when the parent recipe is fully achievable from the
 * current inventory — if a "hard" ingredient is missing (no recipe, not in
 * combined), we skip the sub-step rather than wasting materials.
 */
export const isFullyAchievableFromInventory = (
  recipe: NonNullable<UpgradeTarget['recipe']>,
  inventory: Partial<Record<string, number>>,
  recipes: RecipeList,
  visited = new Set<string>(),
): boolean => {
  for (const [inputId, qty] of Object.entries(recipe.input)) {
    if ((inventory[inputId] ?? 0) >= (qty ?? 0)) continue;
    if (visited.has(inputId)) return false;
    const next = new Set(visited);
    next.add(inputId);
    const subRecipe = recipes.find(r => inputId in (r.output ?? {}) && r.station == null); // TEST: reinstated station filter
    if (!subRecipe || !subRecipe.id) return false;
    if (!isFullyAchievableFromInventory({ id: subRecipe.id, input: subRecipe.input as Partial<Record<string, number>>, required: subRecipe.required ?? [], station: subRecipe.station }, inventory, recipes, next)) return false;
  }
  for (const toolId of recipe.required) {
    if ((inventory[String(toolId)] ?? 0) < 1) return false;
  }
  return true;
};

export const findCraftableSubStep = (
  recipe: NonNullable<UpgradeTarget['recipe']>,
  inventory: Partial<Record<string, number>>,
  recipes: RecipeList,
  visited: Set<string>,
  availableStationTypes: Set<string> = new Set(),
): { recipeId: string; recipe: UpgradeTarget['recipe'] } | null => {
  // Check required tools first — a missing craftable tool blocks the whole recipe
  for (const toolId of recipe.required) {
    const toolStr = String(toolId);
    if ((inventory[toolStr] ?? 0) >= 1) continue;
    if (visited.has(toolStr)) continue;
    visited.add(toolStr);
    const toolRecipe = recipes.find(r => toolStr in r.output && r.station == null); // TEST: reinstated station filter
    if (!toolRecipe || !toolRecipe.id) continue;
    const stationReady = toolRecipe.station == null || availableStationTypes.has(toolRecipe.station);
    let canCraft = stationReady;
    for (const [subId, subQty] of Object.entries(toolRecipe.input)) {
      if ((inventory[subId] ?? 0) < (subQty ?? 0)) { canCraft = false; break; }
    }
    if (canCraft) {
      for (const reqId of toolRecipe.required ?? []) {
        if ((inventory[String(reqId)] ?? 0) < 1) { canCraft = false; break; }
      }
    }
    if (canCraft) {
      return {
        recipeId: toolRecipe.id,
        recipe: {
          id: toolRecipe.id,
          input: toolRecipe.input as Partial<Record<string, number>>,
          required: toolRecipe.required ?? [],
          station: toolRecipe.station,
        },
      };
    }
    const subRecipe: UpgradeTarget['recipe'] = {
      id: toolRecipe.id,
      input: toolRecipe.input as Partial<Record<string, number>>,
      required: toolRecipe.required ?? [],
      station: toolRecipe.station,
    };
    const deeper = findCraftableSubStep(subRecipe, inventory, recipes, visited, availableStationTypes);
    if (deeper) return deeper;
  }

  // Then check missing ingredients
  for (const [inputId, neededQty] of Object.entries(recipe.input)) {
    const have = inventory[inputId] ?? 0;
    if (have >= (neededQty ?? 0)) continue;
    if (visited.has(inputId)) continue;
    visited.add(inputId);
    const inputRecipe = recipes.find(r => inputId in r.output && r.station == null); // TEST: reinstated station filter
    if (!inputRecipe || !inputRecipe.id) continue;
    const stationReady = inputRecipe.station == null || availableStationTypes.has(inputRecipe.station);
    let canCraft = stationReady;
    for (const [subId, subQty] of Object.entries(inputRecipe.input)) {
      if ((inventory[subId] ?? 0) < (subQty ?? 0)) { canCraft = false; break; }
    }
    if (canCraft) {
      for (const toolId of inputRecipe.required ?? []) {
        if ((inventory[toolId as string] ?? 0) < 1) { canCraft = false; break; }
      }
    }
    if (canCraft) {
      return {
        recipeId: inputRecipe.id,
        recipe: {
          id: inputRecipe.id,
          input: inputRecipe.input as Partial<Record<string, number>>,
          required: inputRecipe.required ?? [],
          station: inputRecipe.station,
        },
      };
    }
    const subRecipe: UpgradeTarget['recipe'] = {
      id: inputRecipe.id,
      input: inputRecipe.input as Partial<Record<string, number>>,
      required: inputRecipe.required ?? [],
      station: inputRecipe.station,
    };
    const deeper = findCraftableSubStep(subRecipe, inventory, recipes, visited, availableStationTypes);
    if (deeper) return deeper;
  }
  return null;
};
