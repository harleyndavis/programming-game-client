import type { Position, Tree, MiningNode, GameObject } from "programming-game/types";
import type { RecipeList } from "../bot-types";
import { isFinitePosition, distanceBetween } from "./utils";

export const HARVEST_WEAPON_TYPES = new Set(['fellingAxe', 'pickaxe']);

export const HARVEST_WEAPON_TYPE: Record<string, string> = {
  tree: 'fellingAxe',
  miningNode: 'pickaxe',
};

export function isHarvestWeaponType(type: string): boolean {
  return HARVEST_WEAPON_TYPES.has(type);
}

export function collectHarvestToolItemIds(
  items: Record<string, { type?: string }>,
): Set<string> {
  const ids = new Set<string>();
  for (const [itemId, def] of Object.entries(items)) {
    if (def?.type && HARVEST_WEAPON_TYPES.has(def.type)) ids.add(itemId);
  }
  return ids;
}

export function getHarvestableTarget(
  gameObjects: Record<string, GameObject>,
  equipment: Record<string, string | null | undefined>,
  items: Record<string, { type?: string }>,
  playerPosition: Position,
): { target: Tree | MiningNode; distance: number } | null {
  const weaponType = equipment.weapon ? items[equipment.weapon]?.type : undefined;
  let closest: { target: Tree | MiningNode; distance: number } | null = null;

  for (const obj of Object.values(gameObjects)) {
    if (obj.type !== 'tree' && obj.type !== 'miningNode') continue;
    if (!isFinitePosition(obj.position)) continue;
    const requiredType = HARVEST_WEAPON_TYPE[obj.type];
    if (!requiredType || weaponType !== requiredType) continue;
    const dist = distanceBetween(playerPosition, obj.position!);
    if (!closest || dist < closest.distance) {
      closest = { target: obj as Tree | MiningNode, distance: dist };
    }
  }
  return closest;
}

export const HARVEST_TOOL_TIER_ORDER: Record<string, number> = {
  stoneFellingAxe: 1,
  stonePickaxe: 1,
  copperFellingAxe: 2,
  copperPickaxe: 2,
};

/**
 * Walks the no-station recipe chain for each missing harvest tool and collects
 * every item ID that appears in a `required` array — these are the crafting
 * tools (e.g. stoneCarvingKnife) and purchasable tools (e.g. stoneCutterTools)
 * needed as prerequisites before any harvest tool can be made.
 * Items that are themselves harvest weapons are excluded (they're tracked separately).
 */
export function collectHarvestCraftingChainToolIds(
  missingHarvestToolIds: string[],
  recipes: RecipeList,
): string[] {
  const result = new Set<string>();

  const visit = (itemId: string, seen: Set<string>): void => {
    if (seen.has(itemId)) return;
    seen.add(itemId);
    const recipe = recipes.find(r => itemId in (r.output ?? {}) && r.station == null);
    if (!recipe) return;
    for (const reqId of recipe.required ?? []) {
      const reqStr = String(reqId);
      if (!HARVEST_WEAPON_TYPES.has(reqStr)) result.add(reqStr);
      visit(reqStr, seen);
    }
    for (const inputId of Object.keys(recipe.input ?? {})) {
      visit(inputId, seen);
    }
  };

  for (const toolId of missingHarvestToolIds) {
    visit(toolId, new Set());
  }
  return Array.from(result);
}

/**
 * For each target item (harvest tools + their required-tool prerequisites),
 * walks recipe inputs recursively and returns craftable ingredient IDs that
 * we're short on in combinedInventory — in dependency order (deepest dep first).
 *
 * Example: stoneFellingAxe needs pinewoodAxeHandle (craftable) + stone (not
 * craftable). Only pinewoodAxeHandle is returned.  If pinewoodAxeHandle itself
 * needs a craftable sub-ingredient, that comes out first.
 */
export function collectCraftableInputIngredients(
  targetItemIds: string[],
  combinedInventory: Partial<Record<string, number>>,
  recipes: RecipeList,
): string[] {
  const result: string[] = [];
  const visited = new Set<string>();

  const walk = (itemId: string): void => {
    if (visited.has(itemId)) return;
    visited.add(itemId);

    const recipe = recipes.find(r => itemId in (r.output ?? {}) && r.station == null);
    if (!recipe) return;

    for (const reqId of recipe.required ?? []) walk(String(reqId));

    for (const [inputId, qty] of Object.entries(recipe.input ?? {})) {
      walk(inputId);
      const have = combinedInventory[inputId] ?? 0;
      const need = qty ?? 0;
      if (have < need) {
        const subRecipe = recipes.find(r => inputId in (r.output ?? {}) && r.station == null);
        if (subRecipe && !result.includes(inputId)) result.push(inputId);
      }
    }
  };

  for (const itemId of targetItemIds) walk(itemId);
  return result;
}

export function getMissingHarvestToolIds(
  equipment: Record<string, string | null | undefined>,
  inventory: Partial<Record<string, number>>,
  items: Record<string, { type?: string }>,
): string[] {
  const owned = new Set<string>();
  for (const itemId of Object.values(equipment)) {
    if (itemId) owned.add(itemId);
  }
  for (const [itemId, qty] of Object.entries(inventory)) {
    if (typeof qty === 'number' && qty > 0) owned.add(itemId);
  }

  const missing: string[] = [];
  for (const [itemId, def] of Object.entries(items)) {
    if (!def?.type || !HARVEST_WEAPON_TYPES.has(def.type)) continue;
    if (!owned.has(itemId)) missing.push(itemId);
  }

  missing.sort((a, b) => {
    const ta = HARVEST_TOOL_TIER_ORDER[a] ?? 99;
    const tb = HARVEST_TOOL_TIER_ORDER[b] ?? 99;
    return ta - tb || a.localeCompare(b);
  });
  return missing;
}
