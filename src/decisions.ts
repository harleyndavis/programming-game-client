import { ClientSideUnit, Tree } from "programming-game/types";

type UpgradeTarget = {
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

export type Decision =
  | { type: "respawn" }
  | { type: "return-home-recover" }
  | { type: "return-home-idle" }
  | { type: "return-home-overloaded" }
  | { type: "eat"; item: string }
  | { type: "sell"; items: Partial<Record<string, number>>; merchant: ClientSideUnit }
  | { type: "buy"; items: Partial<Record<string, number>>; merchant: ClientSideUnit }
  | { type: "equip"; item: string; slot: string }
  | { type: "craft"; recipeId: string }
  | { type: "drop"; item: string; amount: number }
  | { type: "deposit"; items: Partial<Record<string, number>>; banker: ClientSideUnit }
  | { type: "withdraw"; items: Partial<Record<string, number>>; banker: ClientSideUnit }
  | { type: "attack"; targetId: string; distance: number }
  | { type: "explore"; to: { x: number; y: number } }
  | { type: "harvest"; targetId: string };

const HOME_POSITION = { x: 0, y: 0 };
const FLEE_DROP_RADIUS = 12;
const HOME_CHORES_CLEAR_RADIUS = 15;
const EXPLORE_DIRECTIONS = [
  { x: 0, y: -1 },   // N
  { x: 0, y: 1 },    // S
  { x: 1, y: -1 },   // NE
  { x: -1, y: 1 },   // SW
  { x: 1, y: 0 },    // E
  { x: -1, y: 0 },   // W
  { x: 1, y: 1 },    // SE
  { x: -1, y: -1 },  // NW
];

const distanceBetween = (
  left: { x: number; y: number },
  right: { x: number; y: number },
) => Math.hypot(left.x - right.x, left.y - right.y);

const huntPatrolTo = (playerPos: { x: number; y: number }, radius: number): { x: number; y: number } => {
  const dx = playerPos.x - HOME_POSITION.x;
  const dy = playerPos.y - HOME_POSITION.y;
  const currentAngle = Math.hypot(dx, dy) < 1 ? 0 : Math.atan2(dy, dx);
  const nextAngle = currentAngle + Math.PI / 2;
  return {
    x: HOME_POSITION.x + Math.cos(nextAngle) * radius,
    y: HOME_POSITION.y + Math.sin(nextAngle) * radius,
  };
};

export const decisionChanged = (prev: Decision | null, next: Decision): boolean => {
  if (!prev || prev.type !== next.type) return true;
  if (next.type === "attack" && prev.type === "attack")
    return prev.targetId !== next.targetId;
  if (next.type === "sell" && prev.type === "sell")
    return prev.merchant.id !== next.merchant.id;
  if (next.type === "deposit" && prev.type === "deposit")
    return prev.banker.id !== next.banker.id || JSON.stringify(prev.items) !== JSON.stringify(next.items);
  if (next.type === "withdraw" && prev.type === "withdraw")
    return prev.banker.id !== next.banker.id || JSON.stringify(prev.items) !== JSON.stringify(next.items);
  if (next.type === "buy" && prev.type === "buy")
    return prev.merchant.id !== next.merchant.id || JSON.stringify(prev.items) !== JSON.stringify(next.items);
  if (next.type === "equip" && prev.type === "equip")
    return prev.item !== next.item;
  if (next.type === "craft" && prev.type === "craft")
    return prev.recipeId !== next.recipeId;
  if (next.type === "eat" && prev.type === "eat")
    return prev.item !== next.item;
  if (next.type === "harvest" && prev.type === "harvest")
    return prev.targetId !== next.targetId;
  return false;
};

export const decide = (opts: {
  playerHp: number;
  maxHp: number;
  lowHpThreshold: number;
  playerPosition: { x: number; y: number };
  nearbyMonster:
  | { unit: { id: string; position: { x: number; y: number } }; distance: number }
  | undefined;
  isEncumbered: boolean;
  sellOpportunity: { merchant: ClientSideUnit; items: Partial<Record<string, number>> } | null;
  heaviestInventoryItem: { item: string; amount: number } | null;
  playerCalories: number;
  maxCalories: number;
  cheapestFood: { item: string; calories: number } | null;
  isHunting: boolean;
  huntRadius: number;
  nearbyHuntTarget: { unit: ClientSideUnit; distance: number } | undefined;
  nearbyThreat: ClientSideUnit | undefined;
  upgradesPlan: Array<{ items: Partial<Record<string, number>>; merchant: ClientSideUnit }>;
  gearToEquip: { item: string; slot: string } | null;
  recipeToCraft: UpgradeTarget | null;
  finishingHomeChores: boolean;
  nearbyTree: { obj: Tree; distance: number } | undefined;
  isHarvesting: boolean;
  attackingMonster:
  | { unit: { id: string; position: { x: number; y: number } }; distance: number }
  | undefined;
  recoveringAtHome: boolean;
  idlingAtHome: boolean;
  exploreDirectionIndex: number;
}): Decision => {
  const { playerHp, maxHp, lowHpThreshold, playerPosition, nearbyMonster, isEncumbered, sellOpportunity, heaviestInventoryItem, playerCalories, maxCalories, cheapestFood, isHunting, huntRadius, nearbyHuntTarget, nearbyThreat, upgradesPlan, gearToEquip, recipeToCraft, finishingHomeChores, nearbyTree, isHarvesting, attackingMonster, recoveringAtHome, idlingAtHome, exploreDirectionIndex } = opts;

  if (playerHp <= 0) return { type: "respawn" };

  if (recoveringAtHome) {
    if (distanceBetween(playerPosition, HOME_POSITION) < HOME_CHORES_CLEAR_RADIUS) {
      if (gearToEquip) return { type: "equip", item: gearToEquip.item, slot: gearToEquip.slot };
      if (recipeToCraft) return { type: "craft", recipeId: recipeToCraft.recipe!.id };
      if (upgradesPlan.length > 0) {
        return { type: "buy", items: upgradesPlan[0].items, merchant: upgradesPlan[0].merchant };
      }
      if (sellOpportunity) return { type: "sell", items: sellOpportunity.items, merchant: sellOpportunity.merchant };
    }
    return { type: "return-home-recover" };
  }
  const calorieDeficit = maxCalories - playerCalories;
  if (cheapestFood !== null && calorieDeficit >= cheapestFood.calories) {
    return { type: "eat", item: cheapestFood.item };
  }
  if (isEncumbered) {
    const closeMonster = nearbyMonster !== undefined && nearbyMonster.distance < FLEE_DROP_RADIUS;
    const closeThreat = nearbyThreat !== undefined;
    if ((closeMonster || closeThreat) && heaviestInventoryItem) {
      return { type: "drop", ...heaviestInventoryItem };
    }
    if (sellOpportunity) return { type: "sell", items: sellOpportunity.items, merchant: sellOpportunity.merchant };
    return { type: "return-home-overloaded" };
  }
  if (isHunting) {
    if (nearbyThreat) return { type: "explore", to: HOME_POSITION };
    if (nearbyHuntTarget) return { type: "attack", targetId: nearbyHuntTarget.unit.id, distance: nearbyHuntTarget.distance };
    return { type: "explore", to: huntPatrolTo(playerPosition, huntRadius) };
  }
  if (attackingMonster)
    return { type: "attack", targetId: attackingMonster.unit.id, distance: attackingMonster.distance };
  if (idlingAtHome || finishingHomeChores) {
    if (gearToEquip) return { type: "equip", item: gearToEquip.item, slot: gearToEquip.slot };
    if (recipeToCraft) return { type: "craft", recipeId: recipeToCraft.recipe!.id };
    if (upgradesPlan.length > 0) {
      return { type: "buy", items: upgradesPlan[0].items, merchant: upgradesPlan[0].merchant };
    }
    if (sellOpportunity) return { type: "sell", items: sellOpportunity.items, merchant: sellOpportunity.merchant };
    return { type: "return-home-idle" };
  }
  if (nearbyMonster)
    return { type: "attack", targetId: nearbyMonster.unit.id, distance: nearbyMonster.distance };
  if (nearbyTree && !isHarvesting) {
    const treeDist = distanceBetween(playerPosition, nearbyTree.obj.position!);
    if (treeDist < 1.0) {
      return { type: "harvest", targetId: nearbyTree.obj.id };
    }
    return { type: "explore", to: nearbyTree.obj.position! };
  }
  const dir = EXPLORE_DIRECTIONS[exploreDirectionIndex];
  return { type: "explore", to: { x: playerPosition.x + dir.x * 10, y: playerPosition.y + dir.y * 10 } };
};
