import type { Position, Tree, MiningNode, GameObject } from "programming-game/types";
import type { RecipeList } from "../bot-types";
import { isFinitePosition, distanceBetween } from "./utils";
import { isRecipeAvailable } from "./plan";

export const HARVEST_WEAPON_TYPES = new Set(['fellingAxe', 'pickaxe']);

export const HARVEST_WEAPON_TYPE: Record<string, string> = {
  tree: 'fellingAxe',
  miningNode: 'pickaxe',
};

export function isHarvestWeaponType(type: string): boolean {
  return HARVEST_WEAPON_TYPES.has(type);
}

/**
 * A-priori knowledge of what a resource node yields, keyed by its
 * `treeType`/`oreType` — the "kickstart" so the bot can go mine copper ore
 * the first time it needs copperIngot, without first having to stumble onto
 * a copper node and loot it once. Confirmed empirically thereafter via
 * `getLootRates`/`getKnownLootItems` (src/memory.ts), which record the SDK's
 * own `loot` event for a harvest the same way as a monster kill — this table
 * is only the cold-start guess, not a replacement for that.
 */
export const TREE_TYPE_LOG_ITEM: Record<string, string> = {
  pine: 'pinewoodLog',
  oak: 'oakLog',
  mesquite: 'mesquiteLog',
  hemlock: 'hemlockLog',
  cypress: 'cypressLog',
  bloodwood: 'bloodwoodLog',
  rosewood: 'rosewoodLog',
  ebony: 'ebonyLog',
};

export const ORE_TYPE_ITEM: Record<string, string> = {
  copper: 'copperOre',
  tin: 'tinOre',
  iron: 'ironOre',
  cobalt: 'cobaltOre',
  titanium: 'titaniumOre',
  coal: 'coalChunk',
  mythril: 'mythrilOre',
  adamantite: 'adamantiteOre',
  gold: 'goldOre',
};

/** Every item obtainable by harvesting some tree or mining node, per the guess table above. */
export const KNOWN_HARVESTABLE_ITEMS: ReadonlySet<string> = new Set([
  ...Object.values(TREE_TYPE_LOG_ITEM),
  ...Object.values(ORE_TYPE_ITEM),
]);

export function collectHarvestToolItemIds(
  items: Record<string, { type?: string }>,
): Set<string> {
  const ids = new Set<string>();
  for (const [itemId, def] of Object.entries(items)) {
    if (def?.type && HARVEST_WEAPON_TYPES.has(def.type)) ids.add(itemId);
  }
  return ids;
}

/** What a tree/mining node is expected to yield, per the guess table (see KNOWN_HARVESTABLE_ITEMS). */
const guessedYield = (obj: Tree | MiningNode): string | undefined =>
  obj.type === 'tree' ? TREE_TYPE_LOG_ITEM[obj.treeType] : ORE_TYPE_ITEM[obj.oreType];

/**
 * Nearest harvestable tree/mining node the equipped tool can work, optionally
 * biased toward `neededItems` — item IDs the current craft chain is actually
 * short on (see neededHarvestItems in index.ts, which already nets off
 * combinedInventory — an item drops out the moment we have enough, so this
 * isn't "we needed one an hour ago," it's recomputed fresh every tick).
 *
 * When neededItems is non-empty, ONLY a node guessed to yield one of them is
 * returned — never a nearer node yielding something unneeded. Without this,
 * once nothing matched a need the old fallback ("nearest of any type") would
 * still send the bot to chop/mine whatever's closest regardless of whether
 * it's wanted, which is how you end up encumbered with logs nobody asked
 * for, dropping them, and going right back to cut more.
 *
 * The opportunistic "nearest of any type" behavior only applies when
 * neededItems is empty (nothing is currently needed at all) — the previous,
 * need-agnostic default, preserved for idle/no-active-chain gathering. That
 * pass still requires the currently-equipped tool to match, since there's no
 * specific need driving it — just harvest along the way with whatever's
 * already equipped.
 *
 * The needed-item pass (closestNeeded), by contrast, does NOT filter by the
 * currently-equipped tool: it reports the nearest node yielding something
 * needed regardless of what's in the weapon slot right now. Equipping the
 * right tool is the caller's job once it decides to act on this target (see
 * the harvestTarget branch in index.ts) — done that way so the equip only
 * fires when there's an actual node to walk to, not just because some chain
 * need exists somewhere in the abstract (e.g. while sitting at home).
 */
export function getHarvestableTarget(
  gameObjects: Record<string, GameObject>,
  equipment: Record<string, string | null | undefined>,
  items: Record<string, { type?: string }>,
  playerPosition: Position,
  neededItems: ReadonlySet<string> = new Set(),
): { target: Tree | MiningNode; distance: number } | null {
  const weaponType = equipment.weapon ? items[equipment.weapon]?.type : undefined;
  let closest: { target: Tree | MiningNode; distance: number } | null = null;
  let closestNeeded: { target: Tree | MiningNode; distance: number } | null = null;

  for (const obj of Object.values(gameObjects)) {
    if (obj.type !== 'tree' && obj.type !== 'miningNode') continue;
    if (!isFinitePosition(obj.position)) continue;
    const requiredType = HARVEST_WEAPON_TYPE[obj.type];
    if (!requiredType) continue;
    const dist = distanceBetween(playerPosition, obj.position!);
    const candidate = { target: obj as Tree | MiningNode, distance: dist };
    if (weaponType === requiredType && (!closest || dist < closest.distance)) closest = candidate;
    if (neededItems.size > 0) {
      const yields = guessedYield(candidate.target);
      if (yields && neededItems.has(yields) && (!closestNeeded || dist < closestNeeded.distance)) {
        closestNeeded = candidate;
      }
    }
  }
  return neededItems.size > 0 ? closestNeeded : closest;
}

export const HARVEST_TOOL_TIER_ORDER: Record<string, number> = {
  stoneFellingAxe: 1,
  stonePickaxe: 1,
  copperFellingAxe: 2,
  copperPickaxe: 2,
};

/** Harvest tool `type` (fellingAxe/pickaxe) that would let the bot obtain a given raw resource item. */
const HARVEST_ITEM_TOOL_TYPE: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const item of Object.values(TREE_TYPE_LOG_ITEM)) map[item] = 'fellingAxe';
  for (const item of Object.values(ORE_TYPE_ITEM)) map[item] = 'pickaxe';
  return map;
})();

/**
 * Which harvest tool type (if any) `neededItems` calls for that the currently
 * equipped weapon doesn't already satisfy. Used by findHarvestToolToWithdraw
 * (owned in storage) — the pocket-owned equivalent for a specific chosen
 * target is resolveHarvestToolForTarget, which doesn't need this tie-break
 * since it's keyed off the target's own object type instead of a whole
 * needed-items set.
 *
 * When items of both tool types are needed at once (e.g. a log and an ore
 * are both short), picks whichever type appears first in `neededItems` — an
 * arbitrary but deterministic tie-break, since only one tool fits the weapon
 * slot; the other need just waits its turn.
 */
function pickNeededToolType(
  neededItems: ReadonlySet<string>,
  equipment: Record<string, string | null | undefined>,
  items: Record<string, { type?: string }>,
): string | null {
  const equippedType = equipment.weapon ? items[equipment.weapon]?.type : undefined;
  const neededToolTypes = new Set<string>();
  for (const itemId of Array.from(neededItems)) {
    const toolType = HARVEST_ITEM_TOOL_TYPE[itemId];
    if (toolType) neededToolTypes.add(toolType);
  }
  if (neededToolTypes.size === 0 || (equippedType && neededToolTypes.has(equippedType))) return null;
  return Array.from(neededToolTypes)[0];
}

/** Highest-tier item of `toolType` with qty > 0 in `source` (HARVEST_TOOL_TIER_ORDER). */
function bestOwnedTool(
  toolType: string,
  source: Partial<Record<string, number>>,
  items: Record<string, { type?: string }>,
): string | null {
  let best: string | null = null;
  let bestTier = -1;
  for (const [itemId, qty] of Object.entries(source)) {
    if (typeof qty !== 'number' || qty <= 0) continue;
    if (items[itemId]?.type !== toolType) continue;
    const tier = HARVEST_TOOL_TIER_ORDER[itemId] ?? 0;
    if (tier > bestTier) { best = itemId; bestTier = tier; }
  }
  return best;
}

/**
 * Whether the currently equipped weapon already matches — or can be swapped
 * in pocket to match — the tool a *specific* harvestable object requires,
 * keyed off the object's own `type` (tree → fellingAxe, miningNode →
 * pickaxe) via HARVEST_WEAPON_TYPE. Used right before acting on a chosen
 * harvestTarget (see index.ts) — scoped to that exact target rather than the
 * whole neededHarvestItems set, since getHarvestableTarget's needed-item
 * search picks a target regardless of what's currently equipped, and a
 * pickNeededToolType-style tie-break over the full needed set could name a
 * different tool type than the specific node actually chosen when both a
 * log and an ore are needed at once (e.g. suggest a fellingAxe while the
 * chosen target is a mining node) — that mismatch would either equip the
 * wrong tool for this target or, worse, fall through to issuing the harvest
 * intent with the wrong tool equipped.
 *
 * `ready: true` means the equipped weapon already matches — go ahead and
 * harvest. `toEquip` is set when a matching tool is owned in pocket but not
 * yet equipped. Both false/null means the required tool isn't equipped and
 * isn't owned at all — nothing to do for this target until it's acquired
 * some other way (buy/craft), and the harvest intent must not be issued.
 */
export function resolveHarvestToolForTarget(
  targetType: string,
  inventory: Partial<Record<string, number>>,
  equipment: Record<string, string | null | undefined>,
  items: Record<string, { type?: string }>,
): { ready: boolean; toEquip: { item: string; slot: string } | null } {
  const requiredType = HARVEST_WEAPON_TYPE[targetType];
  if (!requiredType) return { ready: false, toEquip: null };
  const equippedType = equipment.weapon ? items[equipment.weapon]?.type : undefined;
  if (equippedType === requiredType) return { ready: true, toEquip: null };
  const best = bestOwnedTool(requiredType, inventory, items);
  return { ready: false, toEquip: best ? { item: best, slot: 'weapon' } : null };
}

/**
 * The harvest tool to withdraw from storage, when `neededItems` calls for a
 * tool type not already equipped, none is owned in pocket, but one is sitting
 * in storage — e.g. previously crafted/bought then auto-deposited home. Without
 * this, the pocket-only resolveHarvestToolForTarget check has nothing to work
 * with and the tool sits in storage forever while the bot never carries it
 * and never harvests the resource it's needed for.
 *
 * Returns null once anything matching is already in pocket — that's
 * resolveHarvestToolForTarget's job (via index.ts's harvestTarget branch)
 * from that point on.
 */
export function findHarvestToolToWithdraw(
  neededItems: ReadonlySet<string>,
  storage: Partial<Record<string, number>>,
  inventory: Partial<Record<string, number>>,
  equipment: Record<string, string | null | undefined>,
  items: Record<string, { type?: string }>,
): { item: string } | null {
  const toolType = pickNeededToolType(neededItems, equipment, items);
  if (!toolType) return null;
  if (bestOwnedTool(toolType, inventory, items)) return null;
  const best = bestOwnedTool(toolType, storage, items);
  return best ? { item: best } : null;
}

/**
 * Walks the recipe chain (available per knownStationTypes) for each missing
 * harvest tool and collects every item ID that appears in a `required` array
 * — these are the crafting tools (e.g. stoneCarvingKnife) and purchasable
 * tools (e.g. stoneCutterTools) needed as prerequisites before any harvest
 * tool can be made.
 * Items that are themselves harvest weapons are excluded (they're tracked separately).
 */
export function collectHarvestCraftingChainToolIds(
  missingHarvestToolIds: string[],
  recipes: RecipeList,
  knownStationTypes: ReadonlySet<string> = new Set(),
): string[] {
  const result = new Set<string>();

  const visit = (itemId: string, seen: Set<string>): void => {
    if (seen.has(itemId)) return;
    seen.add(itemId);
    const recipe = recipes.find(r => itemId in (r.output ?? {}) && isRecipeAvailable(r, knownStationTypes));
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
  knownStationTypes: ReadonlySet<string> = new Set(),
): string[] {
  const result: string[] = [];
  const visited = new Set<string>();

  const walk = (itemId: string): void => {
    if (visited.has(itemId)) return;
    visited.add(itemId);

    const recipe = recipes.find(r => itemId in (r.output ?? {}) && isRecipeAvailable(r, knownStationTypes));
    if (!recipe) return;

    for (const reqId of recipe.required ?? []) walk(String(reqId));

    for (const [inputId, qty] of Object.entries(recipe.input ?? {})) {
      walk(inputId);
      const have = combinedInventory[inputId] ?? 0;
      const need = qty ?? 0;
      if (have < need) {
        const subRecipe = recipes.find(r => inputId in (r.output ?? {}) && isRecipeAvailable(r, knownStationTypes));
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
