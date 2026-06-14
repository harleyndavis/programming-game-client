import { connect } from "programming-game";
import { config } from "dotenv";
import { UNIT_TYPE, NPC_TYPE, ClientSideUnit, ClientSideNPC, ClientSideMonster, GameObject } from "programming-game/types";
import { createDashboard } from "./dashboard";
import { toDashboardSnapshot } from "./snapshot";
import { UpgradePlanItem } from "./bot-types";
import * as logger from "./src/logger";

config({
  path: ".env",
});


const dashboard = createDashboard(Number(process.env.DASHBOARD_PORT ?? "8787"));

const clampThresholdPercent = (value: number) => {
  if (!Number.isFinite(value)) {
    return 25;
  }
  return Math.min(95, Math.max(1, value));
};

let lowHpThresholdPercent = clampThresholdPercent(
  Number(process.env.LOW_HP_THRESHOLD_PERCENT ?? "25"),
);
const HOME_POSITION = { x: 0, y: 0 };

const HUNT_TARGETS = ['chicken', 'rat', 'snake'];
const HUNT_RADIUS_INCREMENT = 30;
const HUNT_TICKS_PER_PASS = 150;
const HUNT_PASSES_TO_ESCALATE = 2;
const HUNT_THREAT_RADIUS = 20;
const FLEE_DROP_RADIUS = 12; // drop heaviest item to outrun a monster within this distance
const HOME_CHORES_CLEAR_RADIUS = 15; // must be this close to home before declaring chores done
const COINS_TO_KEEP = 200; // pocket change; rest goes to storage

let recoveringAtHome = false;
let idlingAtHome = false;
// Set when a home visit begins (recovery or manual idle); cleared only once
// HP is full AND all pending tasks (equip, buy, sell) are finished.
let finishingHomeChores = false;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isFinitePosition = (
  value: unknown,
): value is { x: number; y: number } => {
  if (!value || typeof value !== "object") {
    return false;
  }

  const maybePosition = value as { x?: unknown; y?: unknown };
  return isFiniteNumber(maybePosition.x) && isFiniteNumber(maybePosition.y);
};

const distanceBetween = (
  left: { x: number; y: number },
  right: { x: number; y: number },
) => Math.hypot(left.x - right.x, left.y - right.y);

const getHuntTierInfo = (tier: number) => ({
  targets: HUNT_TARGETS.slice(0, Math.min(tier + 1, HUNT_TARGETS.length)),
  radius: (tier + 1) * HUNT_RADIUS_INCREMENT,
});

// Orbits HOME_POSITION at the given radius by aiming 90° ahead of the current angle.
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

// ── Inventory weight ──────────────────────────────────────────────────────────
// Mirrors the game constant encumbranceThreshold = 0.7; movement slows above this.
const ENCUMBRANCE_THRESHOLD = 0.7;

const getInventoryWeight = (
  inventory: Partial<Record<string, number>>,
  items: Record<string, { weight?: number }>,
  equipment?: Record<string, string | null | undefined>,
): number => {
  let total = 0;
  for (const [itemId, qty] of Object.entries(inventory)) {
    if (typeof qty !== "number" || qty <= 0) continue;
    const w = items[itemId]?.weight;
    if (typeof w === "number") total += w * qty;
  }
  if (equipment) {
    for (const itemId of Object.values(equipment)) {
      if (!itemId) continue;
      const w = items[itemId]?.weight;
      if (typeof w === "number") total += w;
    }
  }
  return total;
};

const findHeaviestInventoryItem = (
  inventory: Partial<Record<string, number>>,
  items: Record<string, { weight?: number }>,
): { item: string; amount: number } | null => {
  let heaviest: { item: string; amount: number; totalWeight: number } | null = null;
  for (const [itemId, qty] of Object.entries(inventory)) {
    if (typeof qty !== "number" || qty <= 0) continue;
    const totalWeight = (items[itemId]?.weight ?? 0) * qty;
    if (!heaviest || totalWeight > heaviest.totalWeight) {
      heaviest = { item: itemId, amount: qty, totalWeight };
    }
  }
  return heaviest ? { item: heaviest.item, amount: heaviest.amount } : null;
};

const findCheapestFood = (
  inventory: Partial<Record<string, number>>,
  items: Record<string, { calories?: number }>,
): { item: string; calories: number } | null => {
  let cheapest: { item: string; calories: number } | null = null;
  for (const [itemId, qty] of Object.entries(inventory)) {
    if (typeof qty !== "number" || qty <= 0) continue;
    const cal = items[itemId]?.calories;
    if (typeof cal !== "number" || cal <= 0) continue;
    if (!cheapest || cal < cheapest.calories) {
      cheapest = { item: itemId, calories: cal };
    }
  }
  return cheapest;
};

// ── Home inventory management ─────────────────────────────────────────────────

type QuestMap = Record<string, { steps: Array<{ type: string; requiredItems?: Partial<Record<string, number>> }> }>;
type RecipeList = ReadonlyArray<{
  id?: string;
  input: Partial<Record<string, number>>;
  output: Partial<Record<string, number>>;
  required?: readonly string[];
  station?: string | null;
}>;
type ItemMap = Record<string, { type?: string; calories?: number; stats?: { defense?: number }; damage?: number; attacksPerSecond?: number; ammoType?: string }>;

// Returns items required for active quest turn-ins, keyed by itemId → quantity.
const getQuestItems = (quests: QuestMap): Partial<Record<string, number>> => {
  const result: Partial<Record<string, number>> = {};
  for (const quest of Object.values(quests)) {
    for (const step of quest.steps ?? []) {
      if (step.type === 'turn_in' && step.requiredItems) {
        for (const [itemId, qty] of Object.entries(step.requiredItems)) {
          if (typeof qty === 'number') result[itemId] = Math.max(result[itemId] ?? 0, qty);
        }
      }
    }
  }
  return result;
};

// Maps item type strings to equipment slot names.
const ITEM_TYPE_TO_SLOT: Partial<Record<string, string>> = {
  helm: 'helm', chest: 'chest', legs: 'legs', feet: 'feet', hands: 'hands',
  dagger: 'weapon', oneHandedSword: 'weapon', oneHandedAxe: 'weapon',
  oneHandedMace: 'weapon', twoHandedSword: 'weapon', twoHandedAxe: 'weapon',
  twoHandedMace: 'weapon', bow: 'weapon', staff: 'weapon',
  fellingAxe: 'weapon', pickaxe: 'weapon',
  shield: 'offhand', grimmoire: 'offhand',
  ring: 'ring', amulet: 'amulet',
};

// Slots considered when buying/equipping from a merchant.
const BUYABLE_SLOTS = new Set(['helm', 'chest', 'legs', 'feet', 'hands', 'weapon', 'offhand']);

// Maps weapon types to the ammo category they require.
const WEAPON_AMMO_REQUIREMENT: Partial<Record<string, string>> = {
  bow: 'arrow',
};

// Collects all direct + chained recipe input IDs needed to produce targetItemId.
const getChainedIngredients = (
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

// ── Upgrade targeting ──────────────────────────────────────────────────────────

// For each slot, the item we're working toward and how to acquire it.
type UpgradeTarget = {
  itemId: string;
  slot: string;
  // null means buy-only (no craftable recipe available)
  recipe: {
    id: string;
    input: Partial<Record<string, number>>;
    required: readonly string[];
  } | null;
};

// Returns true if itemId has any known acquisition path reachable without world
// exploration memory: in inventory, sold by a visible merchant, or craftable
// (no-station recipe) from ingredients that are themselves obtainable.
// Only no-station recipes are considered since the bot has no station-visiting logic.
const canObtainChain = (
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

// Acquisition difficulty tier for a single candidate item (lower = easier):
//   1  immediately buyable  — merchant visible and we can afford it
//   2  immediately craftable — all ingredients + tools already in inventory
//   3  buyable but can't afford yet
//   4  craftable; full ingredient chain is obtainable but not all in hand
//   5  blocked — one or more ingredients have no known acquisition path
const computeDifficultyTier = (opts: {
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

// For each buyable slot, selects the best upgrade target.
// Primary sort: difficulty tier (non-blocked preferred; blocked only if every
// candidate for the slot is blocked). Secondary sort: smallest stat gain
// (stay incremental within a tier).
// Ranged weapons are gated on ammo availability before entering scoring.
const computeUpgradeTargets = (opts: {
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

    let bestNonBlocked: { itemId: string; tier: number; gain: number; recipe: UpgradeTarget['recipe'] } | null = null;
    let bestBlocked: { itemId: string; gain: number; recipe: UpgradeTarget['recipe'] } | null = null;

    for (const [itemId, itemDef] of Object.entries(items)) {
      if (!itemDef) continue;
      if (ITEM_TYPE_TO_SLOT[itemDef.type ?? ''] !== slot) continue;
      if (itemId === equippedId) continue;
      if ((inventory[itemId] ?? 0) > 0) continue; // already in bag → equip path

      const defense = itemDef.stats?.defense ?? 0;
      const dps = ((itemDef as any).damage ?? 0) * ((itemDef as any).attacksPerSecond ?? 1);
      if (defense <= equippedDefense && dps <= equippedDps) continue;

      // Gate ranged weapons on ammo availability.
      const requiredAmmoType = WEAPON_AMMO_REQUIREMENT[itemDef.type ?? ''];
      if (requiredAmmoType) {
        const ammoObtainable = Object.entries(items).some(([ammoId, ammoDef]) =>
          ammoDef?.ammoType === requiredAmmoType &&
          canObtainChain(ammoId, inventory, allMerchantSelling, recipes)
        );
        if (!ammoObtainable) continue;
      }

      const recipe = recipes.find(r => itemId in r.output && r.station == null) ?? null;
      const inMerchant = itemId in allMerchantSelling && !!allMerchantSelling[itemId];
      if (!recipe && !inMerchant) continue; // no known acquisition path

      const gain = (defense - equippedDefense) + (dps - equippedDps);
      const recipeEntry = recipe?.id
        ? { id: recipe.id, input: recipe.input as Partial<Record<string, number>>, required: recipe.required ?? [] }
        : null;

      const tier = computeDifficultyTier({ itemId, recipe: recipeEntry, allMerchantSelling, inventory, playerCoins, recipes });

      if (tier < 5) {
        if (bestNonBlocked === null || tier < bestNonBlocked.tier || (tier === bestNonBlocked.tier && gain < bestNonBlocked.gain)) {
          bestNonBlocked = { itemId, tier, gain, recipe: recipeEntry };
        }
      } else {
        if (bestBlocked === null || gain < bestBlocked.gain) {
          bestBlocked = { itemId, gain, recipe: recipeEntry };
        }
      }
    }

    const winner = bestNonBlocked ?? bestBlocked;
    if (winner) targets.push({ itemId: winner.itemId, slot, recipe: winner.recipe });
  }

  return targets;
};

// Returns item IDs to protect from selling: chained recipe inputs and required
// tools for every craftable upgrade target.
const getTargetItemsToKeep = (
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

// For a single merchant, builds a purchase basket driven by the upgrade targets:
// - Gear items whose only acquisition path is buying (no craftable recipe)
// - Required crafting tools we don't yet own
const computeTargetsToBuyFromMerchant = (opts: {
  targets: UpgradeTarget[];
  merchantSelling: Record<string, { price: number; quantity: number } | undefined>;
  playerCoins: number;
  inventory: Partial<Record<string, number>>;
}): Partial<Record<string, number>> => {
  const { targets, merchantSelling, playerCoins, inventory } = opts;
  const basket: Partial<Record<string, number>> = {};
  let coinsLeft = playerCoins;

  for (const target of targets) {
    // Buy gear directly when: no recipe, OR has recipe but can't craft it right now
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
    // Buy required tools for craftable targets
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

// Returns the first upgrade target whose recipe can be crafted right now
// (all inputs and required tools present in inventory).
const findCraftableTarget = (
  targets: UpgradeTarget[],
  inventory: Partial<Record<string, number>>,
): UpgradeTarget | null => {
  for (const target of targets) {
    if (!target.recipe) continue;
    let canCraft = true;
    for (const [inputId, qty] of Object.entries(target.recipe.input)) {
      if ((inventory[inputId] ?? 0) < (qty ?? 0)) { canCraft = false; break; }
    }
    if (!canCraft) continue;
    for (const toolId of target.recipe.required) {
      if ((inventory[toolId as string] ?? 0) < 1) { canCraft = false; break; }
    }
    if (canCraft) return target;
  }
  return null;
};

// Find gear already in inventory that is an upgrade over what is currently equipped.
const findGearToEquip = (opts: {
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
    if (!equippedId) return { item: itemId, slot }; // empty slot
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


// Returns how many of each food item to keep in inventory to cover targetCalories.
// Prefers highest-calorie items first.
const computeFoodToKeep = (
  inventory: Partial<Record<string, number>>,
  items: ItemMap,
  targetCalories: number,
): Partial<Record<string, number>> => {
  const result: Partial<Record<string, number>> = {};
  let remaining = targetCalories;
  const foodEntries = Object.entries(inventory)
    .filter(([id, qty]) => typeof qty === 'number' && qty > 0 && (items[id]?.calories ?? 0) > 0)
    .sort(([aId], [bId]) => (items[bId]?.calories ?? 0) - (items[aId]?.calories ?? 0));
  for (const [itemId, qty] of foodEntries) {
    if (remaining <= 0) break;
    const cal = items[itemId]?.calories ?? 0;
    const keepQty = Math.min(qty as number, Math.ceil(remaining / cal));
    result[itemId] = keepQty;
    remaining -= keepQty * cal;
  }
  return result;
};

// Returns items to sell: surplus over what should be kept (food reserve, quest
// items, upgrade ingredients/tools).  Currency is never sold.
const computeItemsToSell = (opts: {
  inventory: Partial<Record<string, number>>;
  items: ItemMap;
  quests: QuestMap;
  keepItems: Set<string>;
  maxCalories: number;
}): Partial<Record<string, number>> => {
  const { inventory, items, quests, keepItems, maxCalories } = opts;
  const questItems = getQuestItems(quests);
  const foodToKeep = computeFoodToKeep(inventory, items, maxCalories);

  const toSell: Partial<Record<string, number>> = {};
  for (const [itemId, qty] of Object.entries(inventory)) {
    if (typeof qty !== 'number' || qty <= 0) continue;
    if (items[itemId]?.type === 'currency') continue;
    const pocketQty = Math.max(foodToKeep[itemId] ?? 0, questItems[itemId] ?? 0);
    const surplus = qty - pocketQty;
    if (surplus <= 0) continue;
    if (!keepItems.has(itemId)) toSell[itemId] = surplus;
  }
  return toSell;
};

// ── Decision types ────────────────────────────────────────────────────────────

type Decision =
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
  | { type: "attack"; targetId: string; distance: number }
  | { type: "explore"; to: { x: number; y: number } };

/** Returns true when two decisions are meaningfully different. */
const decisionChanged = (prev: Decision | null, next: Decision): boolean => {
  if (!prev || prev.type !== next.type) return true;
  if (next.type === "attack" && prev.type === "attack")
    return prev.targetId !== next.targetId;
  if (next.type === "sell" && prev.type === "sell")
    return prev.merchant.id !== next.merchant.id;
  if (next.type === "deposit" && prev.type === "deposit")
    return prev.banker.id !== next.banker.id || JSON.stringify(prev.items) !== JSON.stringify(next.items);
  if (next.type === "buy" && prev.type === "buy")
    return prev.merchant.id !== next.merchant.id || JSON.stringify(prev.items) !== JSON.stringify(next.items);
  if (next.type === "equip" && prev.type === "equip")
    return prev.item !== next.item;
  if (next.type === "craft" && prev.type === "craft")
    return prev.recipeId !== next.recipeId;
  if (next.type === "eat" && prev.type === "eat")
    return prev.item !== next.item;
  return false;
};

let lastDecision: Decision | null = null;
let decisionStableTicks = 0;
// Consecutive ticks where the server is idle while we expect movement
let unexpectedIdleTicks = 0;
const UNEXPECTED_IDLE_WARN_AFTER = 3;

// Sticky target: once we lock onto a monster, hold it for a few ticks even if
// it briefly disappears from heartbeat.units (e.g. during server replication).
let stickyTargetId: string | null = null;
let stickyTargetLostTicks = 0;
const STICKY_TARGET_GRACE_TICKS = 3;

let huntTier = 0;
let huntIdleTicks = 0;
const lastLoggedMerchants = new Set<string>();
let pendingDepositItem: string | null = null;
let lastDepositMessage = '';
let depositInProgress = false;
let depositCachedItems: Record<string, number> | null = null;
let depositCachedBanker: ClientSideUnit | null = null;

const RAW_EVENT_BUFFER_SIZE = 200;
const rawEventBuffer: Array<{ ts: string; name: string; data: unknown }> = [];

// ── Decision logic ────────────────────────────────────────────────────────────

const decide = (opts: {
  playerHp: number;
  maxHp: number;
  lowHpThreshold: number;
  playerPosition: { x: number; y: number };
  nearbyMonster:
  | { unit: { id: string; position: { x: number; y: number } }; distance: number }
  | undefined;
  isEncumbered: boolean;
  nearbyMerchant: ClientSideUnit | undefined;
  toSell: Partial<Record<string, number>>;
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
}): Decision => {
  const { playerHp, maxHp, lowHpThreshold, playerPosition, nearbyMonster, isEncumbered, nearbyMerchant, toSell, heaviestInventoryItem, playerCalories, maxCalories, cheapestFood, isHunting, huntRadius, nearbyHuntTarget, nearbyThreat, upgradesPlan, gearToEquip, recipeToCraft, finishingHomeChores } = opts;

  if (playerHp <= 0) return { type: "respawn" };

  if (recoveringAtHome) {
    // While waiting to heal, equip better gear, craft upgrades, or buy from a nearby merchant.
    if (gearToEquip) return { type: "equip", item: gearToEquip.item, slot: gearToEquip.slot };
    if (recipeToCraft) return { type: "craft", recipeId: recipeToCraft.recipe!.id };
    if (upgradesPlan.length > 0) {
      return { type: "buy", items: upgradesPlan[0].items, merchant: upgradesPlan[0].merchant };
    }
    return { type: "return-home-recover" };
  }
  // Survival behaviors — run regardless of idlingAtHome.
  // Eat if we have food and the deficit is at least as large as its calorie value (no wasted calories).
  const calorieDeficit = maxCalories - playerCalories;
  if (cheapestFood !== null && calorieDeficit >= cheapestFood.calories) {
    return { type: "eat", item: cheapestFood.item };
  }
  // Overweight: drop to flee if a threat is very close, otherwise head home to sell.
  if (isEncumbered) {
    const closeMonster = nearbyMonster !== undefined && nearbyMonster.distance < FLEE_DROP_RADIUS;
    const closeThreat = nearbyThreat !== undefined;
    if ((closeMonster || closeThreat) && heaviestInventoryItem) {
      return { type: "drop", ...heaviestInventoryItem };
    }
    if (nearbyMerchant && Object.keys(toSell).length > 0) {
      return { type: "sell", items: toSell, merchant: nearbyMerchant };
    }
    return { type: "return-home-overloaded" };
  }
  // Hunt for food — only engage target animals, flee from everything else.
  if (isHunting) {
    if (nearbyThreat) return { type: "explore", to: HOME_POSITION };
    if (nearbyHuntTarget) return { type: "attack", targetId: nearbyHuntTarget.unit.id, distance: nearbyHuntTarget.distance };
    return { type: "explore", to: huntPatrolTo(playerPosition, huntRadius) };
  }
  // idlingAtHome / finishingHomeChores: equip, craft, buy, sell; no combat or exploration.
  if (idlingAtHome || finishingHomeChores) {
    if (gearToEquip) return { type: "equip", item: gearToEquip.item, slot: gearToEquip.slot };
    if (recipeToCraft) return { type: "craft", recipeId: recipeToCraft.recipe!.id };
    if (upgradesPlan.length > 0) {
      return { type: "buy", items: upgradesPlan[0].items, merchant: upgradesPlan[0].merchant };
    }
    if (nearbyMerchant && Object.keys(toSell).length > 0) {
      // return { type: "sell", items: toSell, merchant: nearbyMerchant };
    }
    return { type: "return-home-idle" };
  }
  // Let the SDK handle moving into range — attack() is "move to and attack".
  if (nearbyMonster)
    return { type: "attack", targetId: nearbyMonster.unit.id, distance: nearbyMonster.distance };
  return { type: "explore", to: { x: playerPosition.x + 10, y: playerPosition.y } };
};

dashboard.configureThreshold({
  getThresholdPercent() {
    return lowHpThresholdPercent;
  },
  setThresholdPercent(nextPercent) {
    lowHpThresholdPercent = clampThresholdPercent(nextPercent);
    logger.addExtra('thresholdChanged', lowHpThresholdPercent);
    return lowHpThresholdPercent;
  },
});

dashboard.configureIdleAtHome({
  getIdleAtHome() {
    return idlingAtHome;
  },
  setIdleAtHome(value) {
    idlingAtHome = value;
    logger.addExtra('idleAtHomeChanged', idlingAtHome);
    return idlingAtHome;
  },
});

dashboard.configureDepositRequest({
  getPendingItem() {
    return pendingDepositItem;
  },
  setPendingItem(item) {
    pendingDepositItem = item;
  },
});

dashboard.start();

const assertEnv = (key: string): string => {
  const val = process.env[key];
  if (!val) {
    throw new Error(
      `Missing env var ${key}, please check your .env file, you can get these values from https://programming-game.com/dashboard`,
    );
  }
  return val;
};

// ── Pending death snapshots ───────────────────────────────────────────────────
// Captured on the first dead tick; written just before the first alive tick so
// recentTicks includes all the dead-wait ticks and the write happens exactly once.
type PendingSnapshot = Omit<logger.DeathSnapshot, 'ts' | 'recentTicks'>;
let pendingOverworldDeath: PendingSnapshot | null = null;
let pendingArenaDeath: PendingSnapshot | null = null;

// ── Arena sticky target ───────────────────────────────────────────────────────
let arenaStickyTargetId: string | null = null;
let arenaStickyTargetLostTicks = 0;
let prevArenaTimeRemaining = -1;
let arenaMatchActive = false;
let arenaMatchStartMs = 0;
let lastArenaHp = 0;
let lastArenaOpponents: Array<{ id: string; hp: number | null }> = [];

// ── Crash recovery ───────────────────────────────────────────────────────────
// If an uncaught exception fires, set this flag so the next tick returns a
// move-home intent before the process exits, keeping the character out of
// the open rather than freezing in place mid-hunt.
let emergencyModeActive = false;

const activateEmergencyMode = (label: string, reason: unknown, exitCode = 1) => {
  if (emergencyModeActive) return;
  emergencyModeActive = true;
  logger.tick({ ctx: 'overworld', pos: { x: 0, y: 0 }, hp: 0, maxHp: 0, calories: 0, weight: 0, decision: `${label}: ${String(reason)}`, level: 'warn' });
  // Release port 8787 immediately so PM2 can restart cleanly, then keep
  // the process alive briefly so one onTick fires the move-home intent.
  dashboard.stop();
  setTimeout(() => process.exit(exitCode), 500);
};

process.on('uncaughtException', (err) => activateEmergencyMode('uncaughtException', err));
process.on('unhandledRejection', (reason) => activateEmergencyMode('unhandledRejection', reason));
process.on('SIGINT', () => activateEmergencyMode('SIGINT', 'process interrupted', 0));
process.on('SIGTERM', () => activateEmergencyMode('SIGTERM', 'process terminated', 0));
// PM2 sends a 'shutdown' IPC message when shutdown_with_message is enabled —
// more reliable than signals on Windows.
process.on('message', (msg: unknown) => {
  if (msg === 'shutdown') activateEmergencyMode('shutdown', 'PM2 shutdown', 0);
});

const userId = assertEnv("USER_ID");
connect({
  credentials: {
    id: userId,
    key: assertEnv("API_KEY"),
  },
  onEvent(_instance, _charId, eventName, evt: any) {
    if (eventName === 'storageCharged' || eventName === 'storageEmptied' || eventName === 'deposited' || eventName === 'withdrew') {
      rawEventBuffer.push({ ts: new Date().toISOString(), name: eventName, data: evt });
      if (rawEventBuffer.length > RAW_EVENT_BUFFER_SIZE) rawEventBuffer.shift();
    }
    if (eventName === 'storageCharged') {
      logger.addExtra('storageCharged', { coinsLeft: evt.coinsLeft, charged: evt.charged });
    } else if (eventName === 'storageEmptied') {
      logger.addExtra('storageEmptied', true);
    } else if (eventName === 'deposited') {
      logger.addExtra('deposited', evt.items);
      depositInProgress = false;
      depositCachedItems = null;
      depositCachedBanker = null;
      lastDepositMessage = 'Deposit confirmed';
    } else if (eventName === 'withdrew') {
      logger.addExtra('withdrew', evt.items);
    }
  },
  onTick(heartbeat) {
    if (emergencyModeActive) {
      return heartbeat.inArena ? heartbeat.player?.idle() : heartbeat.player.move(HOME_POSITION);
    }
    // Arena ticks are isolated: they must not read or write overworld state.
    // The arena player is always at a separate HP from the overworld player,
    // and arena outcomes only affect leaderboards — resources spent here are free.
    if (heartbeat.inArena) {
      const arenaTimeRemaining = heartbeat.arenaTimeRemaining;
      const prevTime = prevArenaTimeRemaining;
      // Timer only decreases during a match. A jump means a new match started.
      const isMatchEntry = arenaTimeRemaining > prevTime;
      // Crosses from positive to ≤ 0 exactly once per match.
      const isMatchEnd = !isMatchEntry && arenaTimeRemaining <= 0 && prevTime > 0;
      prevArenaTimeRemaining = arenaTimeRemaining;

      const { player } = heartbeat;
      const arenaHp = isFiniteNumber(player.hp) ? player.hp : 0;
      const arenaPosition = isFinitePosition(player.position) ? player.position : { x: 0, y: 0 };
      const arenaMaxCalories = typeof heartbeat.constants?.maxCalories === "number" ? heartbeat.constants.maxCalories : 3_000;
      const arenaCalories = isFiniteNumber(player.calories) ? player.calories : arenaMaxCalories;
      const arenaMaxHp =
        typeof player.stats?.maxHp === "number" && player.stats.maxHp > 0
          ? player.stats.maxHp
          : Math.max(100, arenaHp);

      const opponents = Object.entries(heartbeat.units)
        .filter(([id]) => id !== player.id)
        .map(([id, u]) => ({
          id,
          hp: typeof u.hp === 'number' ? u.hp : null,
          pos: isFinitePosition(u.position) ? u.position : null,
        }));

      // Save match state for close-out outcome detection. Skip on entry ticks so
      // the close-out at isMatchEntry reads the previous match's final values.
      if (!isMatchEntry) {
        lastArenaHp = arenaHp;
        lastArenaOpponents = opponents;
      }

      const logArena = (
        decision: string,
        extras: Record<string, unknown> = {},
        level: logger.LogLevel = 'info',
      ) => {
        logger.tick({
          ctx: 'arena',
          pos: arenaPosition,
          hp: arenaHp,
          maxHp: arenaMaxHp,
          calories: arenaCalories,
          weight: 0,
          decision,
          level,
          speed: player.stats?.movementSpeed ?? null,
          opponents,
          ...extras,
        });
      };

      if (isMatchEntry) {
        // Close out any previous match that never got an explicit exit log
        // (server dropped ticks before timer hit 0). Derive outcome from the
        // last known arena state rather than assuming.
        if (arenaMatchActive) {
          const closeOutcome =
            lastArenaHp <= 0 ? 'lost' :
              lastArenaOpponents.length > 0 && lastArenaOpponents.every(o => o.hp !== null && o.hp <= 0) ? 'won' :
                'unknown';
          logArena('matchExit', { outcome: closeOutcome, aliveAtExit: lastArenaHp > 0, reason: 'newMatchDetected' });
        }
        arenaMatchActive = true;
        arenaMatchStartMs = Date.now();
        arenaStickyTargetId = null;
        arenaStickyTargetLostTicks = 0;
        logger.openArenaMatch(new Date());
        logArena('matchEntry', { timeRemaining: arenaTimeRemaining });
      }

      if (isMatchEnd) {
        const nonSelfUnits = Object.entries(heartbeat.units).filter(([id]) => id !== player.id);
        const allOpponentsDead = nonSelfUnits.length > 0 &&
          nonSelfUnits.every(([, u]) => typeof u.hp === 'number' && u.hp <= 0);
        const outcome = arenaHp <= 0 ? 'lost' : allOpponentsDead ? 'won' : 'drew';
        logArena('matchExit', { outcome, aliveAtExit: arenaHp > 0, reason: 'timerExpired' });
        logger.closeArenaMatch();
        arenaMatchActive = false;
        return arenaHp <= 0 ? player.respawn() : player.idle();
      }

      // Timer has already expired — match is over, ticks still arriving before units clear.
      if (arenaTimeRemaining <= 0) {
        return player.idle();
      }

      if (arenaHp <= 0) {
        if (arenaMatchActive) {
          logArena('matchExit', { outcome: 'lost', aliveAtExit: false, reason: 'playerDied' });
          logger.closeArenaMatch();
          arenaMatchActive = false;
        }
        if (pendingArenaDeath === null) {
          pendingArenaDeath = {
            ctx: 'arena',
            hp: arenaHp,
            pos: arenaPosition,
            calories: arenaCalories,
            weight: 0,
            equipment: (player.equipment ?? {}) as Record<string, string | null | undefined>,
            inventory: (player.inventory ?? {}) as Partial<Record<string, number>>,
            statusEffects: Object.keys(player.statusEffects ?? {}),
            lastDecision: lastDecision?.type ?? null,
            nearbyMonsters: Object.values(heartbeat.units)
              .filter(u => u.type === UNIT_TYPE.monster && isFinitePosition(u.position))
              .map(u => ({ id: u.id, hp: typeof u.hp === 'number' ? u.hp : undefined, distance: distanceBetween(arenaPosition, u.position as { x: number; y: number }) })),
            nearbyNpcs: [],
            causeOfDeath: 'combat',
          };
        }
        return player.respawn();
      }

      if (pendingArenaDeath !== null) {
        logger.writeDeathSnapshot(pendingArenaDeath);
        pendingArenaDeath = null;
      }

      // Eat freely — arena doesn't count against real-world resources.
      const arenaFood = findCheapestFood(player.inventory ?? {}, heartbeat.items);
      if (arenaFood !== null && arenaMaxCalories - arenaCalories >= arenaFood.calories) {
        logArena('eat', { food: arenaFood.item });
        return player.eat(arenaFood.item as any);
      }

      // Sticky target: hold current target a few ticks through replication gaps.
      if (arenaStickyTargetId) {
        const stickyUnit = heartbeat.units[arenaStickyTargetId];
        const alive = stickyUnit && isFinitePosition(stickyUnit.position) && (typeof stickyUnit.hp !== "number" || stickyUnit.hp > 0);
        if (alive) {
          arenaStickyTargetLostTicks = 0;
        } else {
          arenaStickyTargetLostTicks += 1;
          if (arenaStickyTargetLostTicks >= STICKY_TARGET_GRACE_TICKS) {
            arenaStickyTargetId = null;
            arenaStickyTargetLostTicks = 0;
          }
        }
      }

      // Nearest living unit — exclude self by player.id (the actual server-side unit key),
      // not userId (the credential ID), which may differ.
      const arenaTarget = Object.entries(heartbeat.units)
        .filter(([id, unit]) => id !== player.id && isFinitePosition(unit.position) && (typeof unit.hp !== "number" || unit.hp > 0))
        .map(([id, unit]) => ({ id, unit, distance: distanceBetween(arenaPosition, unit.position as { x: number; y: number }) }))
        .sort((a, b) => a.distance - b.distance)[0];

      if (arenaTarget) {
        const prevStickyId = arenaStickyTargetId;
        if (!arenaStickyTargetId) arenaStickyTargetId = arenaTarget.id;
        const attackUnit = arenaStickyTargetId ? heartbeat.units[arenaStickyTargetId] ?? arenaTarget.unit : arenaTarget.unit;
        if ((attackUnit as any)?.id === player.id) {
          arenaStickyTargetId = null;
          logArena('idle', { selfAttackPrevented: true }, 'warn');
          return player.idle();
        }
        logArena('attack', {
          distance: arenaTarget.distance,
          ...(prevStickyId !== arenaStickyTargetId ? { targetAcquired: true } : {}),
        });
        return player.attack(attackUnit as any);
      }

      const allOpponentsDead = opponents.length > 0 && opponents.every(o => o.hp !== null && o.hp <= 0);
      logArena(allOpponentsDead ? 'waitingMatchEnd' : 'idle');
      return player.idle();
    }

    const tickExtras: Record<string, unknown> = {};
    let tickLevel: logger.LogLevel = 'info';
    let depositOverride: Decision | null = null;

    // 60-second timeout: arena matches last exactly 60s. If we're back in the
    // overworld and that much time has elapsed since match start, it's over.
    if (arenaMatchActive && arenaMatchStartMs > 0 && Date.now() - arenaMatchStartMs > 60_000) {
      const timeoutOutcome =
        lastArenaHp <= 0 ? 'lost' :
          lastArenaOpponents.length > 0 && lastArenaOpponents.every(o => o.hp !== null && o.hp <= 0) ? 'won' :
            'unknown';
      logger.tick({
        ctx: 'arena',
        pos: { x: 0, y: 0 },
        hp: lastArenaHp,
        maxHp: 0,
        calories: 0,
        weight: 0,
        decision: 'matchExit',
        outcome: timeoutOutcome,
        aliveAtExit: lastArenaHp > 0,
        reason: 'timeout',
      });
      logger.closeArenaMatch();
      arenaMatchActive = false;
    }

    const { player } = heartbeat;
    const playerHp = isFiniteNumber(player.hp) ? player.hp : 0;
    const playerPosition = isFinitePosition(player.position)
      ? player.position
      : HOME_POSITION;
    const maxHp =
      typeof player.stats?.maxHp === "number" && player.stats.maxHp > 0
        ? player.stats.maxHp
        : Math.max(100, playerHp);
    const lowHpThreshold = (maxHp * lowHpThresholdPercent) / 100;
    const shouldRecover = playerHp > 0 && playerHp <= lowHpThreshold;
    let nearbyMonster = Object.values(heartbeat.units)
      .filter(
        (unit) =>
          unit.type === UNIT_TYPE.monster &&
          isFinitePosition(unit.position) &&
          // Exclude dead monsters — the server keeps them in units briefly
          // after death. Attacking a dead target is silently rejected, causing
          // the bot to stand idle with a stale attack intent.
          (typeof unit.hp !== "number" || unit.hp > 0),
      )
      .map((unit) => ({
        unit,
        distance: distanceBetween(playerPosition, unit.position),
      }))
      .sort((left, right) => left.distance - right.distance)[0];

    // Sticky target: prefer the monster we were already attacking over
    // immediately switching to explore when it briefly drops out of units.
    if (stickyTargetId) {
      const stickyUnit = heartbeat.units[stickyTargetId];
      const stickyAlive =
        stickyUnit &&
        isFinitePosition(stickyUnit.position) &&
        (typeof stickyUnit.hp !== "number" || stickyUnit.hp > 0);
      if (stickyAlive) {
        stickyTargetLostTicks = 0;
        // Keep the sticky unit as the effective target if it's still valid
        if (!nearbyMonster || nearbyMonster.unit.id !== stickyTargetId) {
          nearbyMonster = {
            unit: stickyUnit,
            distance: distanceBetween(playerPosition, stickyUnit.position),
          };
        }
      } else {
        stickyTargetLostTicks += 1;
        if (stickyTargetLostTicks >= STICKY_TARGET_GRACE_TICKS) {
          stickyTargetId = null;
          stickyTargetLostTicks = 0;
        }
      }
    }
    // Acquire new sticky target when none is held
    if (nearbyMonster && !stickyTargetId) {
      stickyTargetId = nearbyMonster.unit.id;
      stickyTargetLostTicks = 0;
    }
    // Release sticky target when recovery, return-home-idle, or finishing chores kicks in
    if (recoveringAtHome || idlingAtHome || finishingHomeChores || playerHp <= 0) {
      stickyTargetId = null;
      stickyTargetLostTicks = 0;
    }

    // bookkeeping: update recovery state once per tick before deciding
    if (playerHp <= 0) {
      recoveringAtHome = false;
      finishingHomeChores = false; // reset on death
    } else if (shouldRecover) {
      if (!recoveringAtHome) finishingHomeChores = true; // start a home visit
      recoveringAtHome = true;
    }
    if (recoveringAtHome && playerHp >= maxHp) {
      recoveringAtHome = false;
    }

    const units = Object.values(heartbeat.units);

    // ── Decide ──────────────────────────────────────────────────────────────

    const maxCarryWeight =
      typeof heartbeat.constants?.maxCarryWeight === "number"
        ? heartbeat.constants.maxCarryWeight
        : 70_000;
    const maxCalories =
      typeof heartbeat.constants?.maxCalories === "number"
        ? heartbeat.constants.maxCalories
        : 3_000;
    const playerCalories = isFiniteNumber(player.calories) ? player.calories : maxCalories;
    const cheapestFood = findCheapestFood(player.inventory ?? {}, heartbeat.items);
    const isHunting = playerCalories < maxCalories * 0.5 && cheapestFood === null;

    if (!isHunting) {
      huntTier = 0;
      huntIdleTicks = 0;
    }

    const { targets: huntTargets, radius: huntRadius } = getHuntTierInfo(huntTier);

    const nearbyHuntTarget = isHunting
      ? Object.values(heartbeat.units)
        .filter(
          (unit) =>
            unit.type === UNIT_TYPE.monster &&
            isFinitePosition(unit.position) &&
            huntTargets.includes(String((unit as any).race)) &&
            (typeof unit.hp !== "number" || unit.hp > 0),
        )
        .map((unit) => ({
          unit,
          distance: distanceBetween(playerPosition, unit.position as { x: number; y: number }),
        }))
        .sort((a, b) => a.distance - b.distance)[0]
      : undefined;

    const nearbyThreat = isHunting
      ? Object.values(heartbeat.units).find(
        (unit) =>
          unit.type === UNIT_TYPE.monster &&
          isFinitePosition(unit.position) &&
          !huntTargets.includes(String((unit as any).race)) &&
          (typeof unit.hp !== "number" || unit.hp > 0) &&
          distanceBetween(playerPosition, unit.position as { x: number; y: number }) < HUNT_THREAT_RADIUS,
      )
      : undefined;

    if (isHunting) {
      if (nearbyHuntTarget) {
        huntIdleTicks = 0;
      } else {
        huntIdleTicks += 1;
        if (huntIdleTicks >= HUNT_TICKS_PER_PASS * HUNT_PASSES_TO_ESCALATE) {
          huntTier += 1;
          huntIdleTicks = 0;
          const next = getHuntTierInfo(huntTier);
          tickExtras.huntEscalated = { tier: huntTier, targets: next.targets, radius: next.radius };
        }
      }
    }
    const inventoryWeight = getInventoryWeight(player.inventory ?? {}, heartbeat.items, player.equipment);
    const isEncumbered = inventoryWeight >= maxCarryWeight * ENCUMBRANCE_THRESHOLD;

    // Collect selling inventories from every visible merchant — used both for
    // upgrade-target computation (to know what's buyable) and for building
    // per-merchant buy baskets.
    const visibleMerchants: Array<{ unit: ClientSideUnit; selling: Record<string, { price: number; quantity: number } | undefined> }> = [];
    const allMerchantSelling: Record<string, { price: number; quantity: number } | undefined> = {};
    for (const unit of Object.values(heartbeat.units)) {
      if (
        unit.type !== UNIT_TYPE.npc ||
        (unit as { npcType?: string }).npcType !== NPC_TYPE.merchant ||
        !isFinitePosition(unit.position)
      ) continue;
      const selling = ((unit as any).trades?.selling ?? {}) as Record<string, { price: number; quantity: number } | undefined>;
      if (!lastLoggedMerchants.has(unit.id)) {
        lastLoggedMerchants.add(unit.id);
        const seen = (tickExtras.merchantsSeen as Array<{ id: string; sells: string[] }> | undefined) ?? [];
        seen.push({ id: unit.id, sells: Object.keys(selling) });
        tickExtras.merchantsSeen = seen;
      }
      visibleMerchants.push({ unit, selling });
      Object.assign(allMerchantSelling, selling);
    }

    // ── Banker detection ──────────────────────────────────────────────────────
    const visibleBankers = Object.values(heartbeat.units).filter(
      (unit) =>
        unit.type === UNIT_TYPE.npc &&
        (unit as { npcType?: string }).npcType === NPC_TYPE.banker &&
        isFinitePosition(unit.position),
    ) as ClientSideUnit[];
    if (visibleBankers.length > 0) {
      tickExtras.bankersFound = visibleBankers.map(u => ({ id: u.id, pos: u.position }));
    }

    const nearbyBanker = visibleBankers
      .map((unit) => ({
        unit,
        distance: distanceBetween(playerPosition, unit.position as { x: number; y: number }),
      }))
      .sort((a, b) => a.distance - b.distance)[0]?.unit;

    // ── Manual deposit via dashboard ───────────────────────────────────────────
    if (depositInProgress && depositCachedItems && depositCachedBanker) {
      depositOverride = { type: "deposit", items: depositCachedItems, banker: depositCachedBanker };
      tickExtras.manualDeposit = { items: depositCachedItems, banker: depositCachedBanker.id, reissued: true };
    }
    const depositItemRequest = pendingDepositItem;
    if (depositItemRequest !== null) {
      tickExtras.pendingDeposit = { item: depositItemRequest, bankerFound: !!nearbyBanker, bankersVisible: visibleBankers.length };
      if (nearbyBanker) {
        const inv = player.inventory as Record<string, number>;
        const coinsToDeposit = Math.min(inv['copperCoin'] ?? 0, 100);
        const depositItems: Record<string, number> = {};
        if (coinsToDeposit > 0) depositItems.copperCoin = coinsToDeposit;
        if (depositItemRequest !== 'copperCoin') {
          const itemQty = inv[depositItemRequest] ?? 0;
          if (itemQty > 0) depositItems[depositItemRequest] = 1;
        }
        if (Object.keys(depositItems).length > 0) {
          lastDepositMessage = `Depositing ${JSON.stringify(depositItems)} with banker ${nearbyBanker.id}`;
          tickExtras.manualDeposit = { items: depositItems, banker: nearbyBanker.id, coins_in_inv: inv['copperCoin'] };
          depositInProgress = true;
          depositCachedItems = depositItems;
          depositCachedBanker = nearbyBanker;
          pendingDepositItem = null;
          depositOverride = { type: "deposit", items: depositItems, banker: nearbyBanker };
        } else {
          lastDepositMessage = `Skipped: no items to deposit (pending=${depositItemRequest}, coins=${inv['copperCoin']}, qty=${inv[depositItemRequest]})`;
          tickExtras.manualDepositSkipped = lastDepositMessage;
          depositInProgress = false;
          depositCachedItems = null;
          depositCachedBanker = null;
          pendingDepositItem = null;
        }
      } else {
        lastDepositMessage = `Skipped: no banker found (pending=${depositItemRequest}, visible=${visibleBankers.length})`;
        tickExtras.manualDepositSkipped = lastDepositMessage;
        depositInProgress = false;
        depositCachedItems = null;
        depositCachedBanker = null;
        pendingDepositItem = null;
      }
    }

    const playerCoins = (player.inventory as Record<string, number>)['copperCoin'] ?? 0;

    // heartbeat.recipes is typed as Recipe[] but the server sends a Record keyed by id at runtime.
    const recipesArray: RecipeList = Array.isArray(heartbeat.recipes)
      ? heartbeat.recipes
      : Object.values(heartbeat.recipes as any);

    // Determine next upgrade target per slot from all items we know how to acquire.
    // This drives sell-protection, buy plans, and craft decisions.
    const upgradeTargets = computeUpgradeTargets({
      equipment: (player.equipment ?? {}) as Record<string, string | null | undefined>,
      inventory: player.inventory ?? {},
      items: heartbeat.items as unknown as ItemMap,
      recipes: recipesArray,
      allMerchantSelling,
      playerCoins,
    });
    const keepItems = getTargetItemsToKeep(upgradeTargets, recipesArray);

    // Compute what to deposit: spare coins + keepItems currently in inventory.
    const invRecord = (player.inventory ?? {}) as Record<string, number>;
    const toDeposit: Partial<Record<string, number>> = {};
    if (playerCoins > COINS_TO_KEEP) {
      toDeposit.copperCoin = playerCoins - COINS_TO_KEEP;
    }
    for (const [itemId, qty] of Object.entries(invRecord)) {
      if (itemId === 'copperCoin' || qty <= 0) continue;
      if (keepItems.has(itemId)) toDeposit[itemId] = qty;
    }

    const nearbyMerchant = visibleMerchants
      .map(({ unit }) => ({
        unit,
        distance: distanceBetween(playerPosition, unit.position as { x: number; y: number }),
      }))
      .sort((a, b) => a.distance - b.distance)[0]?.unit;

    const toSell = computeItemsToSell({
      inventory: player.inventory ?? {},
      items: heartbeat.items as unknown as ItemMap,
      quests: (player.quests ?? {}) as QuestMap,
      keepItems,
      maxCalories,
    });
    const heaviestInventoryItem = isEncumbered
      ? findHeaviestInventoryItem(player.inventory ?? {}, heartbeat.items)
      : null;

    const atHome = recoveringAtHome || idlingAtHome || finishingHomeChores;

    // Build per-merchant buy baskets from the upgrade targets.
    const upgradesPlan: Array<{ items: Partial<Record<string, number>>; merchant: ClientSideUnit }> = [];
    if (atHome) {
      for (const { unit, selling } of visibleMerchants) {
        const basket = computeTargetsToBuyFromMerchant({
          targets: upgradeTargets,
          merchantSelling: selling,
          playerCoins,
          inventory: player.inventory ?? {},
        });
        if (Object.keys(basket).length > 0) {
          upgradesPlan.push({ items: basket, merchant: unit });
        }
      }
      upgradesPlan.sort((a, b) => Object.keys(b.items).length - Object.keys(a.items).length);
    }

    const gearToEquip = atHome
      ? findGearToEquip({
        inventory: player.inventory ?? {},
        equipment: (player.equipment ?? {}) as Record<string, string | null | undefined>,
        items: heartbeat.items as unknown as ItemMap,
      })
      : null;

    const recipeToCraft = atHome
      ? findCraftableTarget(upgradeTargets, player.inventory ?? {})
      : null;

    const upgradePlanItems: UpgradePlanItem[] = upgradeTargets.map((target, index) => {
      const inventory = (player.inventory ?? {}) as Record<string, number>;
      const equipped = (player.equipment ?? {}) as Record<string, string | null | undefined>;
      const requirements = target.recipe
        ? Object.entries(target.recipe.input).map(([itemId, qty]) => ({
          item: itemId as any,
          quantity: qty ?? 0,
          have: inventory[itemId] ?? 0,
        }))
        : [];
      return {
        id: target.itemId,
        targetItem: target.itemId as any,
        slot: target.slot as any,
        name: target.itemId,
        priority: index + 1,
        completed: equipped[target.slot] === target.itemId,
        requirements,
        recipeId: (target.recipe?.id ?? null) as any,
        canBuy: target.itemId in allMerchantSelling && !!allMerchantSelling[target.itemId],
      };
    });

    dashboard.publish({
      ...toDashboardSnapshot(heartbeat, {
        recoveringAtHome,
        idlingAtHome,
        lowHpThresholdPercent,
        lowHpThreshold,
        depositItem: pendingDepositItem,
        depositMessage: lastDepositMessage,
      }),
      world: {
        npcs: units.filter((u) => u.type === UNIT_TYPE.npc) as ClientSideNPC[],
        mobs: units.filter((u) => u.type === UNIT_TYPE.monster) as ClientSideMonster[],
        objects: Object.values(heartbeat.gameObjects ?? {}) as GameObject[],
      },
      upgradePlans: upgradePlanItems,
      events: [...rawEventBuffer],
    });

    // Clear finishingHomeChores once healthy, back at home base, and all tasks done.
    // The position check is critical: HP can heal en route while the merchant is still
    // out of range, which would make upgradesPlan appear empty — a false "no tasks".
    const nearHome = distanceBetween(playerPosition, HOME_POSITION) < HOME_CHORES_CLEAR_RADIUS;
    if (finishingHomeChores && !recoveringAtHome && playerHp >= maxHp && nearHome) {
      const hasChores =
        gearToEquip !== null ||
        recipeToCraft !== null ||
        upgradesPlan.length > 0;
      if (!hasChores) finishingHomeChores = false;
    }

    const decision = depositOverride ?? decide({
      playerHp,
      maxHp,
      lowHpThreshold,
      playerPosition,
      nearbyMonster,
      isEncumbered,
      nearbyMerchant,
      toSell,
      heaviestInventoryItem,
      playerCalories,
      maxCalories,
      cheapestFood,
      isHunting,
      huntRadius,
      nearbyHuntTarget,
      nearbyThreat,
      upgradesPlan,
      gearToEquip,
      recipeToCraft,
      finishingHomeChores,
    });

    // Track decision stability for intent conflict detection.
    const prevDecision = lastDecision;
    if (decisionChanged(lastDecision, decision)) {
      decisionStableTicks = 1;
      lastDecision = decision;
    } else {
      decisionStableTicks += 1;
    }

    // Warn when the server's stored intent actively conflicts with our decision.
    // "idle" is excluded — it is normal during the global cooldown (0.5s) between
    // actions, so intent: idle while deciding attack/move is expected and not a bug.
    const decisionToIntentType = (d: Decision): string => {
      if (d.type === "attack") return "attack";
      if (d.type === "respawn") return "respawn";
      if (d.type === "sell") return "sellItems";
      if (d.type === "buy") return "buyItems";
      if (d.type === "deposit") return "deposit";
      if (d.type === "equip") return "equip";
      if (d.type === "craft") return "craft";
      if (d.type === "eat") return "eat";
      return "move"; // recover, return-home-idle, return-home, explore, and drop produce a move/idle intent
    };
    const expectedIntent = decisionToIntentType(decision);
    const serverIntentType = typeof player.intent?.type === "string" ? player.intent.type : null;

    // How many stable ticks to wait after a decision change before checking for
    // intent conflicts. The server takes several ticks to acknowledge a new intent
    // (e.g. stale 'attack' lingers after a kill, 'move' lingers on attack approach).
    const INTENT_TRANSITION_GRACE_TICKS = 8;

    const isConflictingIntent =
      serverIntentType !== null &&
      serverIntentType !== "idle" &&
      serverIntentType !== expectedIntent &&
      // When attacking, the server emits intent='move' for as long as it takes
      // to walk into attack range. This is normal — suppress it entirely.
      !(decision.type === "attack" && serverIntentType === "move") &&
      // Selling/buying/depositing also emits intent='move' while walking to the NPC.
      !(decision.type === "sell" && serverIntentType === "move") &&
      !(decision.type === "buy" && serverIntentType === "move") &&
      !(decision.type === "deposit" && serverIntentType === "move") &&
      // After any decision change, give the server time to acknowledge the new
      // intent before treating a mismatch as a problem.
      decisionStableTicks > INTENT_TRANSITION_GRACE_TICKS;

    if (isConflictingIntent) {
      unexpectedIdleTicks += 1;
      if (unexpectedIdleTicks >= UNEXPECTED_IDLE_WARN_AFTER) {
        tickLevel = 'warn';
        tickExtras.intentConflict = {
          serverIntent: serverIntentType,
          expectedIntent,
          ticks: unexpectedIdleTicks,
          serverAction: player.action,
        };
      }
    } else {
      unexpectedIdleTicks = 0;
    }

    // Explain why an attack was dropped.
    let lostTargetReason: string | null = null;
    if (prevDecision?.type === "attack" && decision.type !== "attack") {
      const prevTargetId = (prevDecision as { type: "attack"; targetId: string }).targetId;
      const rawUnit = heartbeat.units[prevTargetId];
      if (!rawUnit) {
        lostTargetReason = "target no longer in units";
      } else if (typeof rawUnit.hp === "number" && rawUnit.hp <= 0) {
        lostTargetReason = `target dead (hp=${rawUnit.hp})`;
      } else if (!isFinitePosition(rawUnit.position)) {
        lostTargetReason = "target position invalid";
      } else {
        const dist = distanceBetween(playerPosition, rawUnit.position);
        if (decision.type === "return-home-recover") {
          lostTargetReason = `recovering (low HP, dist=${dist.toFixed(1)})`;
        } else if (decision.type === "return-home-overloaded") {
          lostTargetReason = `returning home (overweight, dist=${dist.toFixed(1)})`;
        } else if (decision.type === "sell") {
          lostTargetReason = `selling to merchant (overweight, dist=${dist.toFixed(1)})`;
        } else if (decision.type === "drop") {
          lostTargetReason = `dropping to flee (overweight + threat, dist=${dist.toFixed(1)})`;
        } else {
          lostTargetReason = `target out of range (dist=${dist.toFixed(1)})`;
        }
      }
    }

    if (playerHp > 0 && pendingOverworldDeath !== null) {
      logger.writeDeathSnapshot(pendingOverworldDeath);
      pendingOverworldDeath = null;
    }

    logger.tick({
      ctx: 'overworld',
      pos: playerPosition,
      hp: playerHp,
      maxHp,
      calories: playerCalories,
      weight: inventoryWeight,
      decision: decision.type,
      level: tickLevel,
      was: prevDecision?.type ?? 'none',
      ...(lostTargetReason ? { lostTargetReason } : {}),
      threshold: lowHpThreshold,
      recovering: recoveringAtHome,
      ...(decision.type === "sell" ? { merchant: decision.merchant.id, sellItems: Object.keys(decision.items).length } : {}),
      ...(decision.type === "buy" ? { buyFrom: decision.merchant.id, buyItems: Object.keys(decision.items), coins: playerCoins } : {}),
      ...(decision.type === "deposit" ? { depositTo: decision.banker.id, depositItems: Object.keys(decision.items) } : {}),
      ...(decision.type === "equip" ? { equipItem: decision.item, equipSlot: decision.slot } : {}),
      ...(decision.type === "craft" ? { craftRecipe: decision.recipeId } : {}),
      target: nearbyMonster
        ? { id: nearbyMonster.unit.id, hp: typeof nearbyMonster.unit.hp === 'number' ? nearbyMonster.unit.hp : null, distance: nearbyMonster.distance }
        : null,
      speed: player.stats?.movementSpeed ?? null,
      serverAction: player.action,
      serverIntent: serverIntentType,
      statusEffects: Object.keys(player.statusEffects ?? {}),
      ...tickExtras,
    });

    // ── Execute ─────────────────────────────────────────────────────────────

    switch (decision.type) {
      case "respawn": {
        if (pendingOverworldDeath === null) {
          pendingOverworldDeath = {
            ctx: 'overworld',
            hp: playerHp,
            pos: playerPosition,
            calories: playerCalories,
            weight: inventoryWeight,
            equipment: (player.equipment ?? {}) as Record<string, string | null | undefined>,
            inventory: (player.inventory ?? {}) as Partial<Record<string, number>>,
            statusEffects: Object.keys(player.statusEffects ?? {}),
            lastDecision: prevDecision?.type ?? null,
            nearbyMonsters: Object.values(heartbeat.units)
              .filter(u => u.type === UNIT_TYPE.monster && isFinitePosition(u.position))
              .map(u => ({ id: u.id, hp: typeof u.hp === 'number' ? u.hp : undefined, distance: distanceBetween(playerPosition, u.position as { x: number; y: number }) })),
            nearbyNpcs: Object.values(heartbeat.units)
              .filter(u => u.type === UNIT_TYPE.npc && isFinitePosition(u.position))
              .map(u => ({ id: u.id, distance: distanceBetween(playerPosition, u.position as { x: number; y: number }) })),
            causeOfDeath:
              (nearbyMonster && nearbyMonster.distance < 5) ? 'combat'
                : (playerCalories === 0 && findCheapestFood(player.inventory ?? {}, heartbeat.items) === null) ? 'starvation'
                  : 'unknown',
          };
        }
        return player.respawn();
      }
      case "return-home-recover":
        return player.move(HOME_POSITION);
      case "return-home-idle":
        return player.move(HOME_POSITION);
      case "eat":
        return player.eat(decision.item as any);
      case "return-home-overloaded":
        return player.move(HOME_POSITION);
      case "sell":
        return player.sell({ items: decision.items as any, to: decision.merchant });
      case "buy":
        return player.buy({ items: decision.items as any, from: decision.merchant });
      case "equip":
        return player.equip(decision.item as any, decision.slot as any);
      case "craft":
        return player.craft(decision.recipeId as any);
      case "drop":
        return player.drop({ item: decision.item as any, amount: decision.amount });
      case "deposit":
        return player.deposit(decision.banker as any, decision.items as any);
      case "attack": {
        const target = heartbeat.units[decision.targetId];
        return target ? player.attack(target as any) : player.idle();
      }
      case "explore":
        return player.move(decision.to);
    }
  },
});
