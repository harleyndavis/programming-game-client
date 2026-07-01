import type { Position, Tree, MiningNode, GameObject } from "programming-game/types";
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
