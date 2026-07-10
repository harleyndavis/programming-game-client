import { connect } from "programming-game";
import { config } from "dotenv";
import { UNIT_TYPE, ClientSideUnit, ClientSideNPC, ClientSideMonster, GameObject, Station, Tree, MiningNode, ActiveQuest } from "programming-game/types";
import { createDashboard } from "./dashboard";
import { toDashboardSnapshot } from "./snapshot";
import { UpgradePlanItem, ToolPlanItem, UpgradeRequirement, QuestMap, RecipeList, ItemMap, UpgradeTarget } from "./bot-types";
import * as logger from "./src/logger";
import { isFiniteNumber, isFinitePosition, distanceBetween } from "./src/utils";
import { ENCUMBRANCE_THRESHOLD, getInventoryWeight, findHeaviestInventoryItem, findCheapestFood, computeItemsToSell } from "./src/inventory";
import { getChainedIngredients, canObtainChain, computeChainNeeds, computeDifficultyTier, findBlockingItems, isRecipeAvailable, filterDisabledRecipes } from "./src/plan";
import { computeUpgradeTargets, computeTargetsToBuyFromMerchant, findGearToEquip } from "./src/equipment";
import { findCraftableTarget, findNextCraftTarget, findCraftableFromList, computeCraftIngredientsToBuyFromMerchant, collectVisibleStations, getAvailableStationTypes, findStationForType } from "./src/craft";
import { getHarvestableTarget, getMissingHarvestToolIds, collectHarvestToolItemIds, collectHarvestCraftingChainToolIds, collectCraftableInputIngredients, resolveHarvestToolForTarget, findHarvestToolToWithdraw, isHarvestWeaponType, KNOWN_HARVESTABLE_ITEMS } from "./src/harvest";
import { findBestSellMerchant, getStorageFeeInfo } from "./src/trade";
import { findCompletableQuest, findTurnInNpc, findBestQuestToAccept, findBestAvailableQuest, findQuestGivers, findQuestTurnInRequiredItemIds, findPendingQuestTurnInItems, findStalledQuests, findQuestToAbandon, findQuestToDismiss } from "./src/quests";
import { openMemoryDb, getEntity, recordMonsterKill, recordHarvest, recordLoot, recordCombatHit, recordMonsterMaxHp, recordSafeLocation, recordExploredCell, recordQuestEndNpc, recordQuestCompleted, getAllKnownSellingOffers, ASSUMED_SIGHT_RANGE } from "./src/memory";
import { scanGameObjects, scanUnits, findNearbyHuntTarget, findNearbyThreat, findNearbyBanker, findNearbyMonster, computeCombinedInventory, computePlanningInventory, getKnownSets } from "./src/knowledge";

config({
  path: ".env",
});


const memoryDb = openMemoryDb(process.env.MEMORY_DB_PATH ?? "memory.db");

const dashboard = createDashboard(Number(process.env.DASHBOARD_PORT ?? "8787"), memoryDb);


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
const PASSIVE_MONSTERS = ['chicken', 'rat'];
const HOME_CHORES_CLEAR_RADIUS = 2; // must be this close to home before declaring chores done
// Distance to a remembered quest NPC position at which we give up and clear it.
const QUEST_NPC_ARRIVAL_RADIUS = 2;
// Minimum quantity of a tool-type item to keep on hand.
const TOOL_KEEP_CAP = 2;
const COINS_TO_KEEP = 0; // pocket change; rest goes to storage
const STORAGE_FEE_BUFFER = 100; // keep 100× the per-charge fee in storage at minimum
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

const questRewards: Record<string, { items: Record<string, number> }> = {};

// Last known position of a quest NPC, updated whenever they're visible.
let lastQuestNpcPosition: { x: number; y: number } | null = null;
let toolItemIds: Set<string> | null = null;
let recoveringAtHome = false;
let idlingAtHome = false;
let finishingHomeChores = false;


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
  | { type: "craft"; recipeId: string; stationId?: string }
  | { type: "drop"; item: string; amount: number }
  | { type: "deposit"; items: Partial<Record<string, number>>; banker: ClientSideUnit }
  | { type: "withdraw"; items: Partial<Record<string, number>>; banker: ClientSideUnit }
  | { type: "attack"; targetId: string; distance: number }
  | { type: "explore"; to: { x: number; y: number } }
  | { type: "harvest"; targetId: string }
  | { type: "acceptQuest"; npc: ClientSideNPC; questId: string }
  | { type: "turnInQuest"; npc: ClientSideNPC; questId: string }
  | { type: "abandonQuest"; questId: string };

/** Returns true when two decisions are meaningfully different. */
const decisionChanged = (prev: Decision | null, next: Decision): boolean => {
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
  if (next.type === "acceptQuest" && prev.type === "acceptQuest")
    return prev.questId !== next.questId;
  if (next.type === "turnInQuest" && prev.type === "turnInQuest")
    return prev.questId !== next.questId;
  if (next.type === "abandonQuest" && prev.type === "abandonQuest")
    return prev.questId !== next.questId;
  return false;
};

let lastDecision: Decision | null = null;
let decisionStableTicks = 0;
// Consecutive ticks where the server is idle while we expect movement
let unexpectedIdleTicks = 0;
const UNEXPECTED_IDLE_WARN_AFTER = 3;

// Holds the current monster target for a few ticks even if it briefly
// disappears from heartbeat.units.
let stickyTargetId: string | null = null;
let stickyTargetLostTicks = 0;
const STICKY_TARGET_GRACE_TICKS = 3;

let huntTier = 0;
let huntIdleTicks = 0;
let exploreDirectionIndex = 0;
let pendingDepositItem: string | null = null;
// When disabled, the bot stops accepting new quests and abandons any active ones.
let pursueQuestsEnabled = true;
let lastDepositMessage = '';
let depositInProgress = false;
let depositCachedItems: Record<string, number> | null = null;
let depositCachedBanker: ClientSideUnit | null = null;
// Last known equipped item per slot, persisted across death.
const lastEquipment: Record<string, string> = {};

let lastAttackerId: string | null = null;
let lastAttackerTicksLeft = 0;
const LAST_ATTACKER_TICK_TIMEOUT = 15;
let myUnitId: string | null = null;
// Snapshot of units/gameObjects, used by onEvent to resolve identity by id.
let lastUnits: Record<string, ClientSideUnit> = {};
let lastGameObjects: Record<string, GameObject> = {};

// Most recent kill/harvest, used to attribute an unattributed loot event
// within LOOT_ATTRIBUTION_WINDOW_MS.
let recentKill: { monsterId: string; at: number } | null = null;
let recentHarvest: { resourceName: string; at: number } | null = null;
const LOOT_ATTRIBUTION_WINDOW_MS = 2000;

type RawEvent = { ts: string; name: string; data: unknown };
const EVENT_BUFFER_SIZE = 200;
const ARENA_EVENT_BUFFER_SIZE = 20;
let isMatchEntry: boolean = false;
let arenaOpponentId: string | null = null;

const storageEventBuffer: RawEvent[] = [];
const harvestEventBuffer: RawEvent[] = [];
const combatEventBuffer: RawEvent[] = [];
const arenaEventBuffer: RawEvent[] = [];

const pushEvent = (buffer: RawEvent[], maxSize: number, name: string, data: unknown) => {
  buffer.push({ ts: new Date().toISOString(), name, data });
  if (buffer.length > maxSize) buffer.shift();
};

/** Returns items from storage needed to fulfill a recipe that aren't already in pocket. */
const computeRecipeWithdraw = (
  recipe: { input: Partial<Record<string, number>>; required: readonly string[] },
  invRecord: Record<string, number>,
  storageRec: Record<string, number>,
): Partial<Record<string, number>> => {
  const toWithdraw: Partial<Record<string, number>> = {};
  for (const [itemId, qty] of Object.entries(recipe.input)) {
    const have = invRecord[itemId] ?? 0;
    const need = qty ?? 0;
    if (have < need) {
      const inStorage = storageRec[itemId] ?? 0;
      const take = Math.min(need - have, inStorage);
      if (take > 0) toWithdraw[itemId] = take;
    }
  }
  for (const toolId of recipe.required) {
    const toolStr = String(toolId);
    if ((invRecord[toolStr] ?? 0) < 1 && (storageRec[toolStr] ?? 0) >= 1) {
      toWithdraw[toolStr] = 1;
    }
  }
  return toWithdraw;
};

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
  recipeToCraftStationId: string | undefined;
  toolToCraft: { itemId: string; recipe: { id: string; input: Partial<Record<string, number>>; required: readonly string[]; station?: string | null } } | null;
  toolToCraftStationId: string | undefined;
  finishingHomeChores: boolean;
  harvestTarget: { target: Tree | MiningNode; distance: number } | null;
  harvestToolReady: boolean;
  harvestToolToEquip: { item: string; slot: string } | null;
  harvestToolToWithdraw: { item: string } | null;
  isHarvesting: boolean;
  attackingMonster:
  | { unit: { id: string; position: { x: number; y: number } }; distance: number }
  | undefined;
  completableQuest: { quest: ActiveQuest; npc: ClientSideNPC } | null;
  questToAccept: { npc: ClientSideNPC; quest: ClientSideNPC['availableQuests'][string] } | null;
  /** Stalled quest to drop so a needed quest waiting on capacity can be accepted instead. */
  questToAbandon: ActiveQuest | null;
  /** Active quest to abandon because the user disabled quest pursuit from the dashboard — drains the whole log, one per tick. */
  questToDismiss: string | null;
  /** Position to close the distance toward when we have business with a quest NPC that's currently out of sight. */
  questNpcTarget: { x: number; y: number } | null;
  activeCraft: UpgradeTarget | null;
  toolToCraftFromStorage: { itemId: string; recipe: { id: string; input: Partial<Record<string, number>>; required: readonly string[]; station?: string | null } } | null;
  nearbyBanker: ClientSideUnit | undefined;
  buyCost: number;
  availableStorageWithdrawal: number;
  pendingQuestTurnInItems: Partial<Record<string, number>>;
  playerCoins: number;
  storageRecord: Record<string, number>;
  playerInventory: Record<string, number>;
}): Decision => {
  const { playerHp, maxHp, lowHpThreshold, playerPosition, nearbyMonster, isEncumbered, sellOpportunity, heaviestInventoryItem, playerCalories, maxCalories, cheapestFood, isHunting, huntRadius, nearbyHuntTarget, nearbyThreat, upgradesPlan, gearToEquip, recipeToCraft, recipeToCraftStationId, toolToCraft, toolToCraftStationId, finishingHomeChores, harvestTarget, harvestToolReady, harvestToolToEquip, harvestToolToWithdraw, isHarvesting, attackingMonster, completableQuest, questToAccept, questToAbandon, questToDismiss, questNpcTarget, activeCraft, toolToCraftFromStorage, nearbyBanker, buyCost, availableStorageWithdrawal, pendingQuestTurnInItems, playerCoins, storageRecord, playerInventory } = opts;

  if (playerHp <= 0) return { type: "respawn" };

  // Chore decision for recoveringAtHome, idlingAtHome, and finishingHomeChores;
  // returns null when there's nothing left to do.
  const homeChores = (): Decision | null => {
    // Skip a weapon-slot equip suggestion while there's an active harvestTarget.
    if (gearToEquip && !(gearToEquip.slot === 'weapon' && harvestTarget)) {
      return { type: "equip", item: gearToEquip.item, slot: gearToEquip.slot };
    }
    if (harvestToolToWithdraw && nearbyBanker) {
      return { type: "withdraw", items: { [harvestToolToWithdraw.item]: 1 }, banker: nearbyBanker };
    }
    if (activeCraft?.recipe && nearbyBanker) {
      const toWithdraw = computeRecipeWithdraw(activeCraft.recipe, playerInventory, storageRecord);
      if (Object.keys(toWithdraw).length > 0) return { type: "withdraw", items: toWithdraw, banker: nearbyBanker };
    }
    if (recipeToCraft) return { type: "craft", recipeId: recipeToCraft.recipe!.id, stationId: recipeToCraftStationId };
    if (nearbyBanker) {
      const toWithdraw: Partial<Record<string, number>> = {};
      for (const [itemId, shortfall] of Object.entries(pendingQuestTurnInItems)) {
        const inStorage = storageRecord[itemId] ?? 0;
        if (inStorage > 0) toWithdraw[itemId] = Math.min(inStorage, shortfall ?? 0);
      }
      if (Object.keys(toWithdraw).length > 0) return { type: "withdraw", items: toWithdraw, banker: nearbyBanker };
    }
    if (completableQuest) return { type: "turnInQuest", npc: completableQuest.npc, questId: completableQuest.quest.id };
    if (questToAccept) return { type: "acceptQuest", npc: questToAccept.npc, questId: questToAccept.quest.id };
    if (questToAbandon) return { type: "abandonQuest", questId: questToAbandon.id };
    if (nearbyBanker && buyCost > 0 && playerCoins < buyCost && availableStorageWithdrawal >= (buyCost - playerCoins)) {
      return { type: "withdraw", items: { copperCoin: buyCost - playerCoins }, banker: nearbyBanker };
    }
    if (upgradesPlan.length > 0 && playerCoins >= buyCost) {
      return { type: "buy", items: upgradesPlan[0].items, merchant: upgradesPlan[0].merchant };
    }
    if (questToDismiss) return { type: "abandonQuest", questId: questToDismiss };
    if (sellOpportunity) return { type: "sell", items: sellOpportunity.items, merchant: sellOpportunity.merchant };
    if (toolToCraftFromStorage?.recipe && nearbyBanker) {
      const toWithdraw = computeRecipeWithdraw(toolToCraftFromStorage.recipe, playerInventory, storageRecord);
      if (Object.keys(toWithdraw).length > 0) return { type: "withdraw", items: toWithdraw, banker: nearbyBanker };
    }
    if (toolToCraft) return { type: "craft", recipeId: toolToCraft.recipe.id, stationId: toolToCraftStationId };
    if (questNpcTarget) return { type: "explore", to: questNpcTarget };
    return null;
  };

  // gearToEquip narrowed to the weapon slot.
  const reclaimWeapon = gearToEquip?.slot === 'weapon' ? gearToEquip : null;

  if (recoveringAtHome) {
    const chore = homeChores();
    if (chore) return chore;
    return { type: "return-home-recover" };
  }
  // Eat if the calorie deficit covers the cheapest food's calorie value.
  const calorieDeficit = maxCalories - playerCalories;
  if (cheapestFood !== null && calorieDeficit >= cheapestFood.calories) {
    return { type: "eat", item: cheapestFood.item };
  }
  // While overweight: drop the heaviest item only while actively being
  // attacked, otherwise sell or head home.
  if (isEncumbered) {
    if (attackingMonster && heaviestInventoryItem) {
      return { type: "drop", ...heaviestInventoryItem };
    }
    if (sellOpportunity) return { type: "sell", items: sellOpportunity.items, merchant: sellOpportunity.merchant };
    return { type: "return-home-overloaded" };
  }
  // Hunt for food — only engage target animals, flee from everything else.
  if (isHunting) {
    if (nearbyThreat) return { type: "explore", to: HOME_POSITION };
    if (nearbyHuntTarget) {
      if (reclaimWeapon) return { type: "equip", item: reclaimWeapon.item, slot: reclaimWeapon.slot };
      return { type: "attack", targetId: nearbyHuntTarget.unit.id, distance: nearbyHuntTarget.distance };
    }
    return { type: "explore", to: huntPatrolTo(playerPosition, huntRadius) };
  }
  // Self-defense when not recovering: fight back if attacked while doing chores.
  if (attackingMonster) {
    if (reclaimWeapon) return { type: "equip", item: reclaimWeapon.item, slot: reclaimWeapon.slot };
    return { type: "attack", targetId: attackingMonster.unit.id, distance: attackingMonster.distance };
  }

  if (idlingAtHome) {
    const chore = homeChores();
    if (chore) return chore;
    return { type: "return-home-idle" };
  }

  if (finishingHomeChores) {
    const chore = homeChores();
    if (chore) return chore;
  }
  // Attack nearby monsters when not busy.
  if (nearbyMonster) {
    if (reclaimWeapon) return { type: "equip", item: reclaimWeapon.item, slot: reclaimWeapon.slot };
    return { type: "attack", targetId: nearbyMonster.unit.id, distance: nearbyMonster.distance };
  }
  // Harvest a nearby tree/mining node when not busy, equipping the right tool first.
  if (harvestTarget) {
    if (harvestToolToEquip) {
      return { type: "equip", item: harvestToolToEquip.item, slot: harvestToolToEquip.slot };
    }
    if (harvestToolReady) {
      return { type: "harvest", targetId: harvestTarget.target.id };
    }
  }
  if (questToAbandon) return { type: "abandonQuest", questId: questToAbandon.id };
  if (questToDismiss) return { type: "abandonQuest", questId: questToDismiss };
  // Accept available quests when not busy.
  if (questToAccept) return { type: "acceptQuest", npc: questToAccept.npc, questId: questToAccept.quest.id };
  const dir = EXPLORE_DIRECTIONS[exploreDirectionIndex];
  return { type: "explore", to: { x: playerPosition.x + dir.x * 10, y: playerPosition.y + dir.y * 10 } };
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

dashboard.configurePursueQuests({
  getPursueQuests() {
    return pursueQuestsEnabled;
  },
  setPursueQuests(value) {
    pursueQuestsEnabled = value;
    logger.addExtra('pursueQuestsChanged', pursueQuestsEnabled);
    return pursueQuestsEnabled;
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
// Captured on the first dead tick; written on the first alive tick.
type PendingSnapshot = Omit<logger.DeathSnapshot, 'ts' | 'recentTicks'>;
let pendingOverworldDeath: PendingSnapshot | null = null;

// ── Arena match bookkeeping ───────────────────────────────────────────────────
// Only the match transition (start/end) persists across ticks.
let arenaMatchActive = false;
let arenaMatchStartMs = 0;
let arenaMatchDuration = 60000; // updated when arena event fires; default 60s
let lastArenaHp = 0;
let lastArenaMaxHp = 100;
let lastArenaCalories = 0;
let lastArenaPos = { x: 0, y: 0 };
let lastArenaOpponentAlive = false;

// Shared by the 'arena' event handler and the duration-elapsed check in onTick.
const closeArenaMatchIfActive = (reason: 'durationElapsed' | 'newMatchEvent'): void => {
  if (!arenaMatchActive) return;
  const selfAlive = lastArenaHp > 0;
  const outcome = !selfAlive ? 'lost' : lastArenaOpponentAlive ? 'drew' : 'won';
  logger.tick({
    ctx: 'arena',
    pos: lastArenaPos,
    hp: lastArenaHp,
    maxHp: lastArenaMaxHp,
    calories: lastArenaCalories,
    weight: 0,
    decision: 'matchExit',
    outcome,
    aliveAtExit: selfAlive,
    reason,
  });
  logger.closeArenaMatch();
  arenaMatchActive = false;
};

// ── Crash recovery ───────────────────────────────────────────────────────────
// Set on any fatal signal; the next overworld tick returns a move-home intent
// before the process exits.
let emergencyModeActive = false;

let disconnectFromGame: (() => void) | null = null;

const activateEmergencyMode = (label: string, reason: unknown, exitCode = 1) => {
  if (emergencyModeActive) return;
  emergencyModeActive = true;
  try { logger.tick({ ctx: 'overworld', pos: { x: 0, y: 0 }, hp: 0, maxHp: 0, calories: 0, weight: 0, decision: `${label}: ${String(reason)}`, level: 'warn' }); } catch { /* never block shutdown */ }
  try { dashboard.stop(); } catch { /* never block shutdown */ }
  // Wait briefly for one more onTick to fire the move-home intent, then disconnect and exit.
  setTimeout(() => {
    try { disconnectFromGame?.(); } catch { /* never block shutdown */ }
    // Release stdio pipes so PM2's IPC handle doesn't block exit on Windows.
    try { process.stdin.destroy(); } catch { /* never block shutdown */ }
    try { process.stdout.destroy(); } catch { /* never block shutdown */ }
    try { process.stderr.destroy(); } catch { /* never block shutdown */ }
    process.exit(exitCode);
  }, 500);
};

process.on('uncaughtException', (err) => activateEmergencyMode('uncaughtException', err));
process.on('unhandledRejection', (reason) => activateEmergencyMode('unhandledRejection', reason));
process.on('SIGINT', () => activateEmergencyMode('SIGINT', 'process interrupted', 0));
process.on('SIGTERM', () => activateEmergencyMode('SIGTERM', 'process terminated', 0));
process.on('message', (msg: unknown) => {
  if (msg === 'shutdown') activateEmergencyMode('shutdown', 'PM2 shutdown', 0);
});

const userId = assertEnv("USER_ID");
disconnectFromGame = connect({
  credentials: {
    id: userId,
    key: assertEnv("API_KEY"),
  },
  onEvent(_instance, _charId, eventName, evt: any) {
    if (eventName === 'storageCharged' || eventName === 'storageEmptied' || eventName === 'deposited' || eventName === 'withdrew') {
      pushEvent(storageEventBuffer, EVENT_BUFFER_SIZE, eventName, evt);
    } else if (eventName === 'arena') {
      // Fires at match start; close any still-open previous match first.
      pushEvent(arenaEventBuffer, ARENA_EVENT_BUFFER_SIZE, eventName, evt);
      closeArenaMatchIfActive('newMatchEvent');
      arenaMatchDuration = evt.duration;
      arenaMatchActive = true;
      isMatchEntry = true;
      arenaMatchStartMs = Date.now();
      logger.openArenaMatch(new Date());
    } else if (_instance === '1v1Arena') {
      // Match lifecycle is driven entirely by the 'arena' handler above; this
      // branch only tracks opponent id and console visibility.
      if (eventName === 'unitAppeared') {
        if (evt.unit.id !== myUnitId) {
          arenaOpponentId = evt.unit.id;
        }
      }

      // Same combat/kill recording as overworld; loot is not recorded here.
      if (eventName === 'attacked' && myUnitId) {
        if (evt.attacked === myUnitId) {
          const attackerUnit = lastUnits[evt.attacker];
          const attackerMonsterId = attackerUnit?.type === UNIT_TYPE.monster ? (attackerUnit as ClientSideMonster).monsterId : undefined;
          if (attackerMonsterId) {
            const monsterMaxHp = typeof attackerUnit?.stats?.maxHp === "number" ? attackerUnit.stats.maxHp : 0;
            recordCombatHit(memoryDb, attackerMonsterId, monsterMaxHp, evt.damage ?? 0, Date.now());
          }
        }
        if (evt.attacker === myUnitId) {
          // Resolved from the last known unit snapshot before a kill despawns it.
          const attackedUnit = lastUnits[evt.attacked];
          const monsterId = attackedUnit?.type === UNIT_TYPE.monster ? (attackedUnit as ClientSideMonster).monsterId : undefined;
          if (monsterId) {
            // Captured on every hit landed, not just kills.
            const monsterMaxHp = typeof attackedUnit?.stats?.maxHp === "number" ? attackedUnit.stats.maxHp : 0;
            if (monsterMaxHp > 0) recordMonsterMaxHp(memoryDb, monsterId, monsterMaxHp, Date.now());
            if (evt.hp <= 0) recordMonsterKill(memoryDb, monsterId, Date.now());
          }
        }
      }

      pushEvent(arenaEventBuffer, ARENA_EVENT_BUFFER_SIZE, eventName, evt);
    } else if (eventName === 'beganHarvesting' || eventName === 'harvested') {
      pushEvent(harvestEventBuffer, EVENT_BUFFER_SIZE, eventName, evt);
      logger.addExtra(eventName, { objectId: evt.objectId, ...(eventName === 'beganHarvesting' ? { duration: evt.duration, gameTime: evt.gameTime } : {}) });
      if (eventName === 'harvested' && myUnitId && evt.unitId === myUnitId) {
        // The yield arrives separately via a later 'loot' event.
        const harvested = lastGameObjects[evt.objectId] as (Tree | MiningNode | undefined);
        const resourceName = harvested?.type === 'tree' ? harvested.treeType : harvested?.type === 'miningNode' ? harvested.oreType : undefined;
        if (resourceName) {
          const now = Date.now();
          recordHarvest(memoryDb, resourceName, now);
          recentHarvest = { resourceName, at: now };
        }
      }
    } else if (eventName === 'takingAction' && evt.action === 'attack' && myUnitId && evt.actionTarget === myUnitId) {
      // Proactive defense: a unit started an attack targeting us.
      lastAttackerId = evt.unitId;
      lastAttackerTicksLeft = LAST_ATTACKER_TICK_TIMEOUT;
      pushEvent(combatEventBuffer, EVENT_BUFFER_SIZE, 'attackStarted', { attacker: evt.unitId });
      logger.addExtra('defensiveTrigger', { attacker: evt.unitId, source: 'takingAction' });
    } else if (eventName === 'attacked' && myUnitId) {
      if (evt.attacked === myUnitId) {
        lastAttackerId = evt.attacker;
        lastAttackerTicksLeft = LAST_ATTACKER_TICK_TIMEOUT;
        pushEvent(combatEventBuffer, EVENT_BUFFER_SIZE, eventName, evt);
        logger.addExtra('attacked', { attacker: evt.attacker, damage: evt.damage, hp: evt.hp });
        // A hit we took — resolved from the last known unit snapshot, same as the kill branch below.
        const attackerUnit = lastUnits[evt.attacker];
        const attackerMonsterId = attackerUnit?.type === UNIT_TYPE.monster ? (attackerUnit as ClientSideMonster).monsterId : undefined;
        if (attackerMonsterId) {
          const monsterMaxHp = typeof attackerUnit?.stats?.maxHp === "number" ? attackerUnit.stats.maxHp : 0;
          recordCombatHit(memoryDb, attackerMonsterId, monsterMaxHp, evt.damage ?? 0, Date.now());
        }
      }
      if (evt.attacker === myUnitId) {
        // Resolved from the last known unit snapshot before a kill despawns it.
        const attackedUnit = lastUnits[evt.attacked];
        const monsterId = attackedUnit?.type === UNIT_TYPE.monster ? (attackedUnit as ClientSideMonster).monsterId : undefined;
        if (monsterId) {
          // Captured on every hit landed, not just kills.
          const monsterMaxHp = typeof attackedUnit?.stats?.maxHp === "number" ? attackedUnit.stats.maxHp : 0;
          if (monsterMaxHp > 0) recordMonsterMaxHp(memoryDb, monsterId, monsterMaxHp, Date.now());
          if (evt.hp <= 0) {
            const now = Date.now();
            recordMonsterKill(memoryDb, monsterId, now);
            recentKill = { monsterId, at: now };
          }
        }
      }
    } else if (eventName === 'loot' && myUnitId && evt.unitId === myUnitId) {
      // Attribute to whichever of a recent kill/harvest is freshest; discard if
      // both are fresh or neither is.
      const now = Date.now();
      const killFresh = !!recentKill && now - recentKill.at <= LOOT_ATTRIBUTION_WINDOW_MS;
      const harvestFresh = !!recentHarvest && now - recentHarvest.at <= LOOT_ATTRIBUTION_WINDOW_MS;
      if (killFresh && !harvestFresh) {
        const entity = getEntity(memoryDb, 'monster', recentKill!.monsterId);
        if (entity) recordLoot(memoryDb, entity.id, evt.items ?? {}, now);
      } else if (harvestFresh && !killFresh) {
        const entity = getEntity(memoryDb, 'resource', recentHarvest!.resourceName);
        if (entity) recordLoot(memoryDb, entity.id, evt.items ?? {}, now);
      }
      recentKill = null;
      recentHarvest = null;
    } else if (eventName === 'acceptedQuest') {
      logger.addExtra('acceptedQuest', { questId: evt.quest?.id, questName: evt.quest?.name });
    } else if (eventName === 'completedQuest') {
      delete questRewards[evt.questId];
      logger.addExtra('completedQuest', { questId: evt.questId, questName: evt.questName });
      recordQuestCompleted(memoryDb, evt.questId, Date.now());
    } else if (eventName === 'abandonedQuest') {
      delete questRewards[evt.questId];
      logger.addExtra('abandonedQuest', { questId: evt.questId, questName: evt.questName });
    } else if (eventName === 'questUpdate') {
      logger.addExtra('questUpdate', { questId: evt.quest?.id, name: evt.quest?.name });
    } else if (eventName === 'questAvailable') {
      logger.addExtra('questAvailable', { npcId: evt.npcId, questId: evt.quest?.id, name: evt.quest?.name });
    } else if (eventName === 'storageCharged') {
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
    // ── Upkeep ───────────────────────────────────────────────────────────────
    // Runs on every tick regardless of context. Does not process tick data —
    // only bot-level bookkeeping that isn't tied to arena or overworld state.

    if (emergencyModeActive && heartbeat.instanceId === 'overworld') {
      return heartbeat.player.move(HOME_POSITION);
    }

    // If the arena match has been going longer than arenaMatchDuration, close it.
    if (arenaMatchActive && arenaMatchStartMs > 0 && Date.now() - arenaMatchStartMs > arenaMatchDuration) {
      closeArenaMatchIfActive('durationElapsed');
    }

    // ── Arena tick ───────────────────────────────────────────────────────────
    if ('arenaTimeRemaining' in heartbeat) {
      // Snapshot for onEvent to resolve monsterId by unit id.
      lastUnits = heartbeat.units;
      const arenaTimeRemaining = heartbeat.arenaTimeRemaining;

      const { player } = heartbeat;
      if (!myUnitId && player.id) myUnitId = player.id;

      const arenaHp = isFiniteNumber(player.hp) ? player.hp : 0;
      const arenaPosition = isFinitePosition(player.position) ? player.position : { x: 0, y: 0 };
      const arenaMaxCalories = heartbeat.constants.maxCalories;
      const arenaCalories = isFiniteNumber(player.calories) ? player.calories : arenaMaxCalories;
      const arenaMaxHp =
        typeof player.stats?.maxHp === "number" && player.stats.maxHp > 0
          ? player.stats.maxHp
          : Math.max(100, arenaHp);
      // Opponent is whichever unit isn't self (type varies by match).
      const opponent = Object.values(heartbeat.units).find((unit) => unit.id !== myUnitId);

      lastArenaHp = arenaHp;
      lastArenaMaxHp = arenaMaxHp;
      lastArenaCalories = arenaCalories;
      lastArenaPos = arenaPosition;
      lastArenaOpponentAlive = opponent !== undefined && opponent.hp > 0;

      const logArena = (
        decision: string,
        extras: Record<string, unknown> = {},
        level: logger.LogLevel = 'info',
      ) => {
        try {
          logger.tick({
            ctx: 'arena',
            pos: arenaPosition,
            hp: arenaHp,
            maxHp: arenaMaxHp,
            calories: arenaCalories,
            weight: 0,
            decision,
            level,
            opponentName: opponent?.name ?? null,
            opennentId: opponent?.id ?? null,
            opponentHp: opponent && isFiniteNumber(opponent.hp) ? opponent.hp : null,
            timeRemaining: arenaTimeRemaining,
            ...extras,
          });
        } catch (e) {
          console.log('logArena error:', e);
        }
      };

      if (isMatchEntry) {
        logArena('matchEntry', { opponents: Object.values(heartbeat.units).filter((unit) => unit.id !== myUnitId).map(u => ({ id: u.id, type: u.type, name: u.name })) });
        isMatchEntry = false;
      }

      if (opponent) {
        logArena('attack', { timeRemaining: arenaTimeRemaining });
        return player.attack(opponent);
      }

      logArena(opponent ? 'waitingMatchEnd' : 'idle');
      return player.idle();
    }

    // ── Overworld tick ───────────────────────────────────────────────────────
    const tickExtras: Record<string, unknown> = {};
    let tickLevel: logger.LogLevel = 'info';
    let depositOverride: Decision | null = null;

    const { player } = heartbeat;
    if (!myUnitId && player.id) {
      myUnitId = player.id;
      tickExtras.myUnitId = myUnitId;
    }
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

    // Snapshot for onEvent, which has no heartbeat access of its own.
    lastUnits = heartbeat.units;
    lastGameObjects = heartbeat.gameObjects ?? {};

    const gameObjectScanNow = Date.now();
    const gameObjectScan = scanGameObjects(memoryDb, heartbeat.gameObjects ?? {}, gameObjectScanNow);
    if (gameObjectScan.treesFound.length > 0) tickExtras.treesFound = gameObjectScan.treesFound;
    if (gameObjectScan.miningNodesFound.length > 0) tickExtras.miningNodesFound = gameObjectScan.miningNodesFound;
    if (gameObjectScan.stationsFound.length > 0) tickExtras.stationsFound = gameObjectScan.stationsFound;
    if (gameObjectScan.portalsFound.length > 0) tickExtras.portalsFound = gameObjectScan.portalsFound;
    if (gameObjectScan.hazardsFound.length > 0) tickExtras.hazardsFound = gameObjectScan.hazardsFound;

    // Marks the ground the bot has actually stood on as explored.
    recordExploredCell(memoryDb, playerPosition, ASSUMED_SIGHT_RANGE, gameObjectScanNow);
    recordSafeLocation(memoryDb, 'home', 'town', HOME_POSITION, gameObjectScanNow);

    const npcScanNow = Date.now();
    const { visibleNpcs, visibleMerchants, visibleBankers, visibleMerchantSelling, monstersFound } = scanUnits(memoryDb, heartbeat.units, npcScanNow);
    if (visibleBankers.length > 0) {
      tickExtras.bankersFound = visibleBankers.map(u => ({ id: u.id, pos: u.position }));
    }
    // Persisted merchant offers, overridden by this tick's live sightings.
    const allMerchantSelling: Record<string, { price: number; quantity: number } | undefined> = {
      ...getAllKnownSellingOffers(memoryDb),
      ...visibleMerchantSelling,
    };
    const nearbyBanker = findNearbyBanker(visibleBankers, playerPosition);

    let nearbyMonster = findNearbyMonster(monstersFound, playerPosition);

    if (stickyTargetId) {
      const stickyUnit = heartbeat.units[stickyTargetId];
      const stickyAlive =
        stickyUnit &&
        isFinitePosition(stickyUnit.position) &&
        (typeof stickyUnit.hp !== "number" || stickyUnit.hp > 0);
      if (stickyAlive) {
        stickyTargetLostTicks = 0;
        if (!nearbyMonster || nearbyMonster.unit.id !== stickyTargetId) {
          // stickyTargetId is only ever set to a monster's id.
          nearbyMonster = {
            unit: stickyUnit as ClientSideMonster,
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
    if (nearbyMonster && !stickyTargetId) {
      stickyTargetId = nearbyMonster.unit.id;
      stickyTargetLostTicks = 0;
    }
    if (recoveringAtHome || idlingAtHome || finishingHomeChores || playerHp <= 0) {
      stickyTargetId = null;
      stickyTargetLostTicks = 0;
    }

    const isHarvesting = player.action === 'harvest';
    if (isHarvesting && player.actionStart) {
      tickExtras.isHarvesting = { duration: player.actionDuration, target: player.actionTarget, remaining: (player.actionStart + (player.actionDuration ?? 0)) - (heartbeat.gameTime ?? 0) };
    }

    if (lastAttackerTicksLeft > 0) lastAttackerTicksLeft -= 1;
    if (lastAttackerTicksLeft <= 0) lastAttackerId = null;
    const attackerUnit = lastAttackerId ? heartbeat.units[lastAttackerId] : undefined;
    const attackingMonster =
      attackerUnit && (typeof attackerUnit.hp !== "number" || attackerUnit.hp > 0) && isFinitePosition(attackerUnit.position)
        ? { unit: attackerUnit, distance: distanceBetween(playerPosition, attackerUnit.position!) }
        : undefined;
    if (attackingMonster) {
      tickExtras.attackingMonster = { id: attackingMonster.unit.id, distance: attackingMonster.distance, ticksLeft: lastAttackerTicksLeft };
    }

    if (playerHp <= 0) {
      recoveringAtHome = false;
      finishingHomeChores = false; // reset on death
    } else if (shouldRecover) {
      if (!recoveringAtHome) {
        finishingHomeChores = true; // start a home visit
        exploreDirectionIndex = (exploreDirectionIndex + 1) % EXPLORE_DIRECTIONS.length;
      }
      recoveringAtHome = true;
    }
    if (recoveringAtHome && playerHp >= maxHp) {
      recoveringAtHome = false;
    }

    const units = Object.values(heartbeat.units);

    // ── Decide ──────────────────────────────────────────────────────────────

    const maxCarryWeight = heartbeat.constants.maxCarryWeight;
    const maxCalories = heartbeat.constants.maxCalories;
    const playerCalories = isFiniteNumber(player.calories) ? player.calories : maxCalories;
    const cheapestFood = findCheapestFood(player.inventory ?? {}, heartbeat.items);
    const isHunting = playerCalories < maxCalories * 0.5 && cheapestFood === null;

    if (!isHunting) {
      huntTier = 0;
      huntIdleTicks = 0;
    }

    const { targets: huntTargets, radius: huntRadius } = getHuntTierInfo(huntTier);

    const nearbyHuntTarget = isHunting
      ? findNearbyHuntTarget(monstersFound, playerPosition, huntTargets)
      : undefined;

    // Computed unconditionally: safeToCraft (below) uses it regardless of hunting state.
    const nearbyThreat = findNearbyThreat(monstersFound, playerPosition, PASSIVE_MONSTERS, HUNT_THREAT_RADIUS);

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
    // Overload starts a home visit, same as low HP.
    if (isEncumbered && !finishingHomeChores) {
      finishingHomeChores = true;
    }

    // ── Station detection ──────────────────────────────────────────────────────
    // A station-gated recipe is only craftable when a matching station is in view.
    const visibleStations = collectVisibleStations(heartbeat.gameObjects ?? {});
    const availableStationTypes = getAvailableStationTypes(visibleStations);

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
          lastDepositMessage = `Skipped: no items to deposit(pending = ${depositItemRequest}, coins = ${inv['copperCoin']}, qty = ${inv[depositItemRequest]})`;
          tickExtras.manualDepositSkipped = lastDepositMessage;
          depositInProgress = false;
          depositCachedItems = null;
          depositCachedBanker = null;
          pendingDepositItem = null;
        }
      } else {
        lastDepositMessage = `Skipped: no banker found(pending = ${depositItemRequest}, visible = ${visibleBankers.length})`;
        tickExtras.manualDepositSkipped = lastDepositMessage;
        depositInProgress = false;
        depositCachedItems = null;
        depositCachedBanker = null;
        pendingDepositItem = null;
      }
    }

    const playerCoins = (player.inventory as Record<string, number>)['copperCoin'] ?? 0;

    // heartbeat.recipes is a Record keyed by id at runtime, despite its Recipe[] type.
    const recipesArray: RecipeList = filterDisabledRecipes(
      Array.isArray(heartbeat.recipes) ? heartbeat.recipes : Object.values(heartbeat.recipes as any),
    );

    // Merge storage + inventory so items in storage count for crafting/buy planning.
    const combinedInventory = computeCombinedInventory(heartbeat.player.storage as Record<string, number> | undefined, player.inventory as Record<string, number> | undefined);
    // Add active quest reward items (qty=1 if not owned).
    const planningInventory = computePlanningInventory(combinedInventory, questRewards);

    // knownStationTypes/knownLootItems/knownQuestRewardItems: persisted memory,
    // "obtainable in principle". availableStationTypes: visible this tick only.
    const { knownStationTypes, knownLootItems, knownQuestRewardItems } = getKnownSets(memoryDb, Array.from(KNOWN_HARVESTABLE_ITEMS));

    const upgradeTargets = computeUpgradeTargets({
      equipment: (player.equipment ?? {}) as Record<string, string | null | undefined>,
      inventory: combinedInventory,
      items: heartbeat.items as unknown as ItemMap,
      recipes: recipesArray,
      allMerchantSelling,
      knownLootItems,
      knownQuestRewardItems,
      playerCoins,
      knownStationTypes,
      availableStationTypes,
    });
    // Skip harvest tools temporarily occupying the weapon slot.
    for (const [slot, itemId] of Object.entries((player.equipment ?? {}) as Record<string, string | null | undefined>)) {
      if (!itemId) continue;
      const itemType = (heartbeat.items as Record<string, { type?: string }>)[itemId]?.type;
      if (itemType && isHarvestWeaponType(itemType)) continue;
      lastEquipment[slot] = itemId;
    }
    // Computed once; recipes and the item catalog don't change after the initial heartbeat.
    if (toolItemIds === null) {
      toolItemIds = new Set<string>();
      const itemCatalog = heartbeat.items as Record<string, { type?: string }> | undefined;
      for (const recipe of recipesArray) {
        if (!recipe.required) continue;
        for (const req of recipe.required) {
          if (typeof req !== 'string') continue;
          if (itemCatalog?.[req]?.type) toolItemIds.add(req);
        }
      }
      collectHarvestToolItemIds(itemCatalog ?? {}).forEach(id => toolItemIds!.add(id));
    }
    // Quest turn-in items stay in pocket: not deposited, sold, or auto-withdrawn-to-sell.
    const rawQuestsForProtection = (player.quests ?? {}) as QuestMap;
    const questTurnInItems = findQuestTurnInRequiredItemIds(rawQuestsForProtection);
    const pendingQuestTurnInItems = findPendingQuestTurnInItems(
      rawQuestsForProtection,
      player.inventory ?? {},
    );
    const atHome = recoveringAtHome || idlingAtHome || finishingHomeChores;

    // Next craft target from combined (storage + pocket) inventory.
    const activeCraft = findCraftableTarget(upgradeTargets, combinedInventory, recipesArray, availableStationTypes);
    // Display-only.
    const nextCraftTarget = activeCraft ?? findNextCraftTarget(upgradeTargets);

    const missingHarvestTools = getMissingHarvestToolIds(
      (player.equipment ?? {}) as Record<string, string | null | undefined>,
      combinedInventory,
      heartbeat.items as Record<string, { type?: string }>,
    );
    // Required-tool IDs in the full recipe chain for missing harvest tools.
    const harvestChainToolIds = missingHarvestTools.length > 0
      ? collectHarvestCraftingChainToolIds(missingHarvestTools, recipesArray, knownStationTypes)
      : [];
    const missingCraftableChainTools = harvestChainToolIds.filter(id =>
      (combinedInventory[id] ?? 0) < 1 &&
      recipesArray.some(r => id in (r.output ?? {}) && isRecipeAvailable(r, knownStationTypes)),
    );
    // Craftable ingredients we're short on, in dependency order.
    const craftableInputIngredients = collectCraftableInputIngredients(
      [...missingHarvestTools, ...harvestChainToolIds],
      combinedInventory,
      recipesArray,
      knownStationTypes,
    );
    // Required-tool prerequisites, then craftable inputs, then harvest tools.
    const allToolCraftTargets = Array.from(new Set([
      ...missingCraftableChainTools,
      ...craftableInputIngredients,
      ...missingHarvestTools,
    ]));

    // Quantity of each ingredient actually needed by active chains; the rest is sellable surplus.
    const chainTargets = [
      ...upgradeTargets.filter(t => t.recipe).map(t => t.itemId),
      ...Object.values(lastEquipment).filter((id): id is string => !!id),
      ...allToolCraftTargets,
    ];
    const chainKeepNeeds = computeChainNeeds(chainTargets, recipesArray, combinedInventory);
    // Fallback bound (TOOL_KEEP_CAP) for tools outside any active chain.
    for (const id of Array.from(toolItemIds ?? [])) {
      chainKeepNeeds[id] = Math.max(chainKeepNeeds[id] ?? 0, TOOL_KEEP_CAP);
    }
    // Raw resource items (no recipe produces them) the active chain is short on.
    const neededHarvestItems = new Set(
      Object.keys(chainKeepNeeds).filter(itemId =>
        (combinedInventory[itemId] ?? 0) < (chainKeepNeeds[itemId] ?? 0) &&
        !recipesArray.some(r => itemId in (r.output ?? {})),
      ),
    );
    // Scan for a harvestable object (tree/mining node) the equipped tool can
    // work, biased toward one of neededHarvestItems — see getHarvestableTarget.
    const harvestTarget = getHarvestableTarget(
      heartbeat.gameObjects ?? {},
      (player.equipment ?? {}) as Record<string, string | null | undefined>,
      heartbeat.items ?? {},
      playerPosition,
      neededHarvestItems,
    );
    // Tool resolved for the specific harvestTarget, keyed off its own type.
    const { ready: harvestToolReady, toEquip: harvestToolToEquip } = harvestTarget
      ? resolveHarvestToolForTarget(
        harvestTarget.target.type,
        player.inventory ?? {},
        (player.equipment ?? {}) as Record<string, string | null | undefined>,
        heartbeat.items ?? {},
      )
      : { ready: false, toEquip: null };
    // Pocket-level keep bound: quantities already covered by storage don't need
    // to stay in the pocket too.
    const storageRec = (heartbeat.player.storage ?? {}) as Record<string, number>;
    // Needed harvest tool sitting in storage instead of pocket.
    const harvestToolToWithdraw = findHarvestToolToWithdraw(
      neededHarvestItems,
      storageRec,
      player.inventory ?? {},
      (player.equipment ?? {}) as Record<string, string | null | undefined>,
      heartbeat.items ?? {},
    );
    const pocketKeepQuantities: Partial<Record<string, number>> = {};
    for (const [itemId, need] of Object.entries(chainKeepNeeds)) {
      const inStorage = typeof storageRec[itemId] === 'number' ? storageRec[itemId] : 0;
      pocketKeepQuantities[itemId] = Math.max(0, need - inStorage);
    }

    // What we'd craft next if all storage items were in pocket.
    const toolToCraftFromStorage = allToolCraftTargets.length > 0
      ? findCraftableFromList(allToolCraftTargets, combinedInventory, recipesArray, availableStationTypes)
      : null;

    // Parent recipe's inputs, protected too when activeCraft is a sub-step (tier 0).
    const activeCraftParent = activeCraft?.tier === 0
      ? upgradeTargets.find(t => t.recipe && t.slot === activeCraft.slot) ?? null
      : null;
    // Display-only: the ultimate goal item, not the sub-step, when activeCraft is a sub-step.
    const nextCraftTargetId = activeCraft?.tier === 0
      ? activeCraftParent?.itemId ?? null
      : nextCraftTarget?.itemId ?? null;
    const craftingStepItemId = activeCraft?.tier === 0 ? activeCraft.itemId : null;
    const activeCraftItems: Set<string> = new Set([
      ...(activeCraft?.recipe ? [
        ...Object.keys(activeCraft.recipe.input),
        ...activeCraft.recipe.required.map(String),
      ] : []),
      ...(activeCraftParent?.recipe ? [
        ...Object.keys(activeCraftParent.recipe.input),
        ...activeCraftParent.recipe.required.map(String),
      ] : []),
      ...(toolToCraftFromStorage?.recipe ? [
        ...Object.keys(toolToCraftFromStorage.recipe.input),
        ...toolToCraftFromStorage.recipe.required.map(String),
      ] : []),
    ]);

    // Chain-protected items plus quest turn-in items.
    const protectedItems = new Set(Object.keys(chainKeepNeeds).concat(Array.from(questTurnInItems)));
    const toSell = computeItemsToSell({
      inventory: player.inventory ?? {},
      items: heartbeat.items as unknown as ItemMap,
      quests: (player.quests ?? {}) as QuestMap,
      keepItems: protectedItems,
      keepQuantities: pocketKeepQuantities,
      maxCalories,
    });
    const sellOpportunity = findBestSellMerchant(visibleMerchants, toSell);

    // Spare coins + protected items, excluding active-craft and about-to-sell quantities.
    const invRecord = (player.inventory ?? {}) as Record<string, number>;
    const toDeposit: Partial<Record<string, number>> = {};
    if (playerCoins > COINS_TO_KEEP) {
      toDeposit.copperCoin = playerCoins - COINS_TO_KEEP;
    }
    for (const [itemId, qty] of Object.entries(invRecord)) {
      if (itemId === 'copperCoin' || qty <= 0) continue;
      if (!(itemId in chainKeepNeeds) || activeCraftItems.has(itemId) || questTurnInItems.has(itemId)) continue;
      // Harvest tools must stay in pocket to be equippable.
      const toolType = (heartbeat.items as Record<string, { type?: string }>)[itemId]?.type;
      if (toolType && isHarvestWeaponType(toolType)) continue;
      const beingSold = sellOpportunity?.items[itemId] ?? 0;
      // Cap deposit at the chain keep target; surplus stays in pocket to sell directly.
      const alreadyStored = ((heartbeat.player.storage ?? {}) as Record<string, number>)[itemId] ?? 0;
      const roomInStorage = Math.max(0, (chainKeepNeeds[itemId] ?? 0) - alreadyStored);
      const depositQty = Math.min(qty - beingSold, roomInStorage);
      if (depositQty > 0) toDeposit[itemId] = depositQty;
    }
    const heaviestInventoryItem = isEncumbered
      ? findHeaviestInventoryItem(player.inventory ?? {}, heartbeat.items, protectedItems)
      : null;

    const storageRecord = heartbeat.player.storage ?? {};
    const storageCoins = typeof storageRecord.copperCoin === 'number' ? storageRecord.copperCoin : 0;
    const {
      feePerCharge,
      minCoins: minStorageCoins,
      availableWithdrawal: availableStorageWithdrawal,
    } = getStorageFeeInfo(storageRecord, heartbeat.items as unknown as ItemMap, STORAGE_FEE_BUFFER);

    // Build per-merchant buy baskets using effective coins (pocket + storage beyond fee buffer).
    const effectiveCoins = playerCoins + availableStorageWithdrawal;

    // Quest turn-in items obtainable now: already in storage, or buyable from a known merchant.
    const actionablePendingQuestItems: Partial<Record<string, number>> = {};
    for (const [itemId, shortfall] of Object.entries(pendingQuestTurnInItems)) {
      const inStorage = (storageRec[itemId] ?? 0) > 0;
      const offer = allMerchantSelling[itemId];
      const buyable = !!offer && offer.quantity > 0 && offer.price > 0 && offer.price <= effectiveCoins;
      if (inStorage || buyable) actionablePendingQuestItems[itemId] = shortfall;
    }
    const stalledQuestItems = Object.keys(pendingQuestTurnInItems)
      .filter(itemId => !(itemId in actionablePendingQuestItems));
    if (stalledQuestItems.length > 0) tickExtras.stalledQuestItems = stalledQuestItems;
    const upgradesPlan: Array<{ items: Partial<Record<string, number>>; merchant: ClientSideUnit }> = [];
    if (atHome) {
      for (const { unit, selling } of visibleMerchants) {
        const basket = computeTargetsToBuyFromMerchant({
          targets: upgradeTargets,
          merchantSelling: selling,
          playerCoins: effectiveCoins,
          inventory: combinedInventory,
          availableStationTypes,
        });
        if (missingHarvestTools.length > 0) {
          const toolBasket = computeCraftIngredientsToBuyFromMerchant(
            missingHarvestTools,
            combinedInventory,
            recipesArray,
            selling,
            effectiveCoins,
            knownStationTypes,
            KNOWN_HARVESTABLE_ITEMS,
          );
          Object.assign(basket, toolBasket);
        }
        // Directly buy chain tools that have no craftable recipe.
        for (const chainToolId of harvestChainToolIds) {
          if ((combinedInventory[chainToolId] ?? 0) >= 1 || basket[chainToolId]) continue;
          if (recipesArray.some(r => chainToolId in (r.output ?? {}) && isRecipeAvailable(r, knownStationTypes))) continue;
          const offer = selling[chainToolId];
          if (offer && offer.quantity > 0 && offer.price > 0 && offer.price <= effectiveCoins) {
            basket[chainToolId] = 1;
          }
        }
        // Quest items are bought on top of the craft basket, not subtracted from it.
        for (const [itemId, shortfall] of Object.entries(pendingQuestTurnInItems)) {
          const inBasket = basket[itemId] ?? 0;
          const have = combinedInventory[itemId] ?? 0;
          const stillNeed = Math.max(0, (shortfall ?? 0) - have);
          if (stillNeed <= 0) continue;
          const offer = selling[itemId];
          if (offer && offer.quantity > 0 && offer.price > 0) {
            const canBuy = Math.min(stillNeed, Math.floor(effectiveCoins / offer.price));
            if (canBuy > 0) basket[itemId] = inBasket + canBuy;
          }
        }
        if (Object.keys(basket).length > 0) {
          upgradesPlan.push({ items: basket, merchant: unit });
        }
      }
      upgradesPlan.sort((a, b) => Object.keys(b.items).length - Object.keys(a.items).length);
    }

    let buyCost = 0;
    if (upgradesPlan.length > 0) {
      const firstBasket = upgradesPlan[0];
      const merchantSelling = visibleMerchants.find(m => m.unit.id === firstBasket.merchant.id)?.selling ?? {};
      for (const [itemId, qty = 1] of Object.entries(firstBasket.items)) {
        buyCost += (merchantSelling[itemId]?.price ?? 0) * qty;
      }
    }

    // Keep just enough coins in inventory to afford the purchase; deposit the rest.
    if (buyCost > 0 && toDeposit.copperCoin && toDeposit.copperCoin > 0) {
      const canAffordPurchase = playerCoins >= buyCost || availableStorageWithdrawal >= (buyCost - playerCoins);
      if (canAffordPurchase) {
        toDeposit.copperCoin = Math.max(0, (playerCoins - COINS_TO_KEEP) - buyCost);
      } else {
        toDeposit.copperCoin = playerCoins - COINS_TO_KEEP;
      }
    }

    // Drop 0-value entries.
    for (const [key, val] of Object.entries(toDeposit)) {
      if (val === undefined || val <= 0) delete toDeposit[key as keyof typeof toDeposit];
    }

    const gearToEquip = findGearToEquip({
      inventory: player.inventory ?? {},
      equipment: (player.equipment ?? {}) as Record<string, string | null | undefined>,
      items: heartbeat.items as unknown as ItemMap,
    });

    // Reuses activeCraft/toolToCraftFromStorage (computed against combinedInventory)
    // and checks only that this sub-step's own ingredients are in pocket now.
    const isReadyInPocket = (recipe: { input: Partial<Record<string, number>>; required: readonly string[]; station?: string | null } | null | undefined): boolean =>
      !!recipe &&
      Object.entries(recipe.input).every(([id, qty]) => (invRecord[id] ?? 0) >= (qty ?? 0)) &&
      recipe.required.every(id => (invRecord[String(id)] ?? 0) >= 1) &&
      isRecipeAvailable(recipe, availableStationTypes);

    const safeToCraft = !nearbyThreat && !attackingMonster;
    const recipeToCraft = safeToCraft && isReadyInPocket(activeCraft?.recipe)
      ? activeCraft
      : null;

    const toolToCraft = safeToCraft && isReadyInPocket(toolToCraftFromStorage?.recipe)
      ? toolToCraftFromStorage
      : null;

    const recipeToCraftStationId = recipeToCraft?.recipe
      ? findStationForType(recipeToCraft.recipe.station, visibleStations, playerPosition)?.id
      : undefined;
    const toolToCraftStationId = toolToCraft?.recipe
      ? findStationForType(toolToCraft.recipe.station, visibleStations, playerPosition)?.id
      : undefined;

    const upgradePlanItems: UpgradePlanItem[] = upgradeTargets.map((target, index) => {
      const equipped = (player.equipment ?? {}) as Record<string, string | null | undefined>;
      // combinedInventory (storage + pocket), not player.inventory alone.
      const requirements = target.recipe
        ? Object.entries(target.recipe.input).map(([itemId, qty]) => ({
          item: itemId as any,
          quantity: qty ?? 0,
          have: combinedInventory[itemId] ?? 0,
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
        isNextCraft: nextCraftTargetId === target.itemId,
        craftingStep: (craftingStepItemId && nextCraftTargetId === target.itemId) ? craftingStepItemId : undefined,
        tier: target.tier,
        blocked: !target.reachable,
        blockedBy: !target.reachable ? findBlockingItems(target.itemId, planningInventory, allMerchantSelling, recipesArray, knownStationTypes, knownLootItems, knownQuestRewardItems) : undefined,
      };
    });

    const allHarvestToolIds = collectHarvestToolItemIds(
      heartbeat.items as Record<string, { type?: string }>,
    );
    const equipped_ = (player.equipment ?? {}) as Record<string, string | null | undefined>;
    const invRecord_ = (player.inventory ?? {}) as Record<string, number>;
    const stRecord_ = (heartbeat.player.storage ?? {}) as Record<string, number>;
    const ownedCheck = (id: string): boolean =>
      Object.values(equipped_).includes(id) ||
      (invRecord_[id] ?? 0) > 0 ||
      (stRecord_[id] ?? 0) > 0;
    const toolPlanItems: ToolPlanItem[] = Array.from(allHarvestToolIds)
      .sort((a, b) => {
        const ta = { stoneFellingAxe: 1, stonePickaxe: 1, copperFellingAxe: 2, copperPickaxe: 2, ironFellingAxe: 3, ironPickaxe: 3, steelFellingAxe: 4, steelPickaxe: 4 }[a] ?? 99;
        const tb = { stoneFellingAxe: 1, stonePickaxe: 1, copperFellingAxe: 2, copperPickaxe: 2, ironFellingAxe: 3, ironPickaxe: 3, steelFellingAxe: 4, steelPickaxe: 4 }[b] ?? 99;
        return ta - tb || a.localeCompare(b);
      })
      .map((itemId, index) => {
        const recipe = recipesArray.find(r => itemId in (r.output ?? {}) && isRecipeAvailable(r, knownStationTypes));
        const tier = computeDifficultyTier({
          itemId,
          recipe: recipe ? { id: recipe.id!, input: recipe.input as Partial<Record<string, number>>, required: recipe.required ?? [], station: recipe.station ?? null } : null,
          allMerchantSelling,
          inventory: planningInventory,
          playerCoins: effectiveCoins,
          recipes: recipesArray,
          knownStationTypes,
          availableStationTypes,
          knownLootItems,
          knownQuestRewardItems,
        });
        const requirements: UpgradeRequirement[] = [];
        if (recipe) {
          for (const [id, qty] of Object.entries(recipe.input ?? {})) {
            requirements.push({
              item: id as any,
              quantity: qty ?? 0,
              have: combinedInventory[id] ?? 0,
            });
          }
          for (const toolId of recipe.required ?? []) {
            const toolStr = toolId as string;
            if (toolStr === itemId) continue;
            requirements.push({
              item: toolStr as any,
              quantity: 1,
              have: ownedCheck(toolStr) ? 1 : 0,
            });
          }
        }
        return {
          id: itemId,
          targetItem: itemId as any,
          name: itemId,
          priority: index + 1,
          completed: ownedCheck(itemId),
          requirements,
          recipeId: (recipe?.id ?? null) as any,
          canBuy: itemId in allMerchantSelling && !!allMerchantSelling[itemId],
          isNextCraft: toolToCraft?.itemId === itemId,
          tier,
          blocked: tier === 5,
          blockedBy: tier === 5 ? findBlockingItems(itemId, planningInventory, allMerchantSelling, recipesArray, knownStationTypes, knownLootItems, knownQuestRewardItems) : undefined,
        };
      });

    // All items that are prerequisites for harvest tools: required-chain tools +
    // craftable input ingredients. Shown in the dashboard before the harvest tools.
    const allChainPlanIds = Array.from(new Set([...harvestChainToolIds, ...craftableInputIngredients]));

    const chainToolPlanItems: ToolPlanItem[] = allChainPlanIds.map((itemId, index) => {
      const recipe = recipesArray.find(r => itemId in (r.output ?? {}) && isRecipeAvailable(r, knownStationTypes));
      const tier = computeDifficultyTier({
        itemId,
        recipe: recipe ? { id: recipe.id!, input: recipe.input as Partial<Record<string, number>>, required: recipe.required ?? [], station: recipe.station ?? null } : null,
        allMerchantSelling,
        inventory: planningInventory,
        playerCoins: effectiveCoins,
        recipes: recipesArray,
        knownStationTypes,
        availableStationTypes,
        knownLootItems,
        knownQuestRewardItems,
      });
      const requirements: UpgradeRequirement[] = [];
      if (recipe) {
        for (const [id, qty] of Object.entries(recipe.input ?? {})) {
          requirements.push({ item: id as any, quantity: qty ?? 0, have: combinedInventory[id] ?? 0 });
        }
        for (const toolId of recipe.required ?? []) {
          const toolStr = String(toolId);
          if (toolStr === itemId) continue;
          requirements.push({ item: toolStr as any, quantity: 1, have: ownedCheck(toolStr) ? 1 : 0 });
        }
      }
      return {
        id: itemId,
        targetItem: itemId as any,
        name: itemId,
        priority: -(allChainPlanIds.length - index),
        completed: ownedCheck(itemId),
        requirements,
        recipeId: (recipe?.id ?? null) as any,
        canBuy: itemId in allMerchantSelling && !!allMerchantSelling[itemId],
        isNextCraft: toolToCraft?.itemId === itemId,
        tier,
        blocked: tier === 5,
        blockedBy: tier === 5 ? findBlockingItems(itemId, planningInventory, allMerchantSelling, recipesArray, knownStationTypes, knownLootItems, knownQuestRewardItems) : undefined,
      };
    });

    const coverage = feePerCharge > 0 ? storageCoins / feePerCharge : 0;

    const { recipes, ...heartbeatWithoutRecipes } = heartbeat;
    dashboard.publish({
      ...toDashboardSnapshot(heartbeatWithoutRecipes, {
        recoveringAtHome,
        idlingAtHome,
        pursueQuestsEnabled,
        lowHpThresholdPercent,
        lowHpThreshold,
        depositItem: pendingDepositItem,
        depositMessage: lastDepositMessage,
        nearbyBankers: visibleBankers.length,
        nearbyMerchants: visibleMerchants.length,
        questRewards,
      }),
      storageFee: {
        coinsInStorage: storageCoins,
        perCharge: feePerCharge,
        buffer: minStorageCoins,
        coverage,
        availableWithdrawal: availableStorageWithdrawal,
      },
      upgradePlans: upgradePlanItems,
      toolPlans: [...chainToolPlanItems, ...toolPlanItems],
      chainKeepNeeds,
      storageEvents: [...storageEventBuffer],
      harvestEvents: [...harvestEventBuffer],
      combatEvents: [...combatEventBuffer],
      arenaEvents: [...arenaEventBuffer],
    });

    // ── Quest checks (computed before hasChores and overrides) ─────────────
    const activeQuests = rawQuestsForProtection;
    // end_npc name is resolved here from this tick's visible NPCs; left null if not visible.
    const activeQuestScanNow = Date.now();
    for (const quest of Object.values(activeQuests)) {
      const endNpcName = findTurnInNpc(quest, visibleNpcs)?.name ?? null;
      recordQuestEndNpc(memoryDb, quest, endNpcName, activeQuestScanNow);
    }
    const completableQuestResult = findCompletableQuest(activeQuests, player.inventory ?? {});
    const completableQuest: { quest: ActiveQuest; npc: ClientSideNPC } | null =
      completableQuestResult
        ? (() => {
          const npc = findTurnInNpc(completableQuestResult, visibleNpcs);
          return npc ? { quest: completableQuestResult, npc } : null;
        })()
        : null;
    const questGivers = findQuestGivers(visibleNpcs);
    const maxActiveQuests = typeof heartbeat.constants?.maxActiveQuests === "number" ? heartbeat.constants.maxActiveQuests : 5;
    // Items the craft chains still need, using gross (not netted) needs.
    const questNeededItems = new Set(
      Object.entries(chainKeepNeeds)
        .filter(([itemId, need]) => (combinedInventory[itemId] ?? 0) < need)
        .map(([itemId]) => itemId),
    );
    // Stocked when combined inventory covers the full gross chain need.
    const questStockedItems = new Set(
      Object.keys(chainKeepNeeds).filter(
        id => (combinedInventory[id] ?? 0) >= chainKeepNeeds[id],
      ),
    );

    const questToAccept: { npc: ClientSideNPC; quest: ClientSideNPC['availableQuests'][string] } | null =
      pursueQuestsEnabled && (atHome || !isHunting)
        ? findBestQuestToAccept(questGivers, activeQuests, maxActiveQuests, {
          neededItems: questNeededItems,
          stockedItems: questStockedItems,
          chainItemIds: new Set(Object.keys(chainKeepNeeds)),
        })
        : null;
    if (completableQuest) tickExtras.completableQuest = { questId: completableQuest.quest.id, npcId: completableQuest.npc.id };
    if (questToAccept) tickExtras.questToAccept = { questId: questToAccept.quest.id, npcId: questToAccept.npc.id };

    // Drop a stalled quest only when capacity is the bottleneck and something needed is waiting.
    const atQuestCapacity = Object.keys(activeQuests).length >= maxActiveQuests;
    const stalledActiveQuests = atQuestCapacity
      ? findStalledQuests(activeQuests, player.inventory ?? {}, new Set(stalledQuestItems))
      : [];
    const bestAvailableQuest = atQuestCapacity && stalledActiveQuests.length > 0
      ? findBestAvailableQuest(questGivers, activeQuests, { neededItems: questNeededItems, stockedItems: questStockedItems, chainItemIds: new Set(Object.keys(chainKeepNeeds)) })
      : null;
    const questToAbandon = findQuestToAbandon(stalledActiveQuests, atQuestCapacity, bestAvailableQuest, questNeededItems);
    if (questToAbandon) tickExtras.questToAbandon = { questId: questToAbandon.id, blockedQuestId: bestAvailableQuest?.quest.id };

    // Drains the whole quest log, one per tick, when the user disabled quest pursuit.
    const questToDismiss: string | null = pursueQuestsEnabled ? null : (findQuestToDismiss(activeQuests)?.id ?? null);
    if (questToDismiss) tickExtras.questToDismiss = { questId: questToDismiss };

    const questNpcInRange = completableQuest?.npc ?? questToAccept?.npc ?? null;
    if (questNpcInRange && isFinitePosition(questNpcInRange.position)) {
      lastQuestNpcPosition = questNpcInRange.position as { x: number; y: number };
    }
    // Clear the remembered position once we've arrived with no NPC to act on.
    if (
      lastQuestNpcPosition !== null &&
      questNpcInRange === null &&
      distanceBetween(playerPosition, lastQuestNpcPosition) < QUEST_NPC_ARRIVAL_RADIUS
    ) {
      lastQuestNpcPosition = null;
    }
    const needQuestForHarvestTools =
      missingHarvestTools.length > 0 &&
      Object.keys(activeQuests).length < maxActiveQuests &&
      Object.keys(actionablePendingQuestItems).length === 0 &&
      questToAccept === null &&
      upgradesPlan.length === 0 &&
      toolToCraft === null &&
      toolToCraftFromStorage === null;
    const questNpcTarget: { x: number; y: number } | null =
      lastQuestNpcPosition !== null &&
        (completableQuestResult !== null || needQuestForHarvestTools)
        ? lastQuestNpcPosition
        : null;
    if (questNpcTarget) tickExtras.navigatingToQuestNpc = { position: questNpcTarget };

    // Clears once healthy, at home, and no chores remain.
    const nearHome = distanceBetween(playerPosition, HOME_POSITION) < HOME_CHORES_CLEAR_RADIUS;
    if (finishingHomeChores && !recoveringAtHome && playerHp >= maxHp && nearHome) {
      const hasChores =
        gearToEquip !== null ||
        recipeToCraft !== null ||
        toolToCraft !== null ||
        toolToCraftFromStorage !== null ||
        activeCraft !== null ||
        harvestToolToWithdraw !== null ||
        upgradesPlan.length > 0 ||
        Object.keys(actionablePendingQuestItems).length > 0 ||
        sellOpportunity !== null ||
        completableQuest !== null ||
        questToAccept !== null ||
        questToAbandon !== null ||
        questNpcTarget !== null;
      if (!hasChores) finishingHomeChores = false;
    }

    const coreDecision = depositOverride ?? decide({
      playerHp,
      maxHp,
      lowHpThreshold,
      playerPosition,
      nearbyMonster,
      isEncumbered,
      sellOpportunity,
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
      recipeToCraftStationId,
      toolToCraft,
      toolToCraftStationId,
      finishingHomeChores,
      harvestTarget,
      harvestToolReady,
      harvestToolToEquip,
      harvestToolToWithdraw,
      isHarvesting,
      attackingMonster,
      completableQuest,
      questToAccept,
      questToAbandon,
      questToDismiss,
      questNpcTarget,
      activeCraft,
      toolToCraftFromStorage,
      nearbyBanker,
      buyCost,
      availableStorageWithdrawal,
      pendingQuestTurnInItems,
      playerCoins,
      storageRecord: storageRec,
      playerInventory: invRecord,
    });
    let decision = coreDecision;

    // ── Post-decision: sell surplus from storage ─────────────────────────────
    if (atHome && nearbyBanker && !depositOverride && decision.type !== "withdraw"
      && completableQuest === null && questToAccept === null) {
      const toWithdrawFromStorage: Partial<Record<string, number>> = {};
      let capacityLeft = Math.max(0, maxCarryWeight - inventoryWeight);
      const itemWeights = heartbeat.items as Record<string, { weight?: number }>;
      const withdrawUpTo = (itemId: string, qty: number) => {
        const weight = itemWeights[itemId]?.weight ?? 0;
        const maxByWeight = weight > 0 ? Math.floor(capacityLeft / weight) : qty;
        const take = Math.min(qty, maxByWeight);
        if (take <= 0) return;
        toWithdrawFromStorage[itemId] = take;
        capacityLeft -= take * weight;
      };
      for (const [itemId, qty] of Object.entries(storageRec)) {
        if (itemId === 'copperCoin' || typeof qty !== 'number' || qty <= 0) continue;
        if (questTurnInItems.has(itemId)) continue;
        if (!(itemId in chainKeepNeeds)) {
          withdrawUpTo(itemId, qty);
          continue;
        }
        // Gross (not netted) chain need stays in storage; only the surplus is withdrawn.
        const surplus = qty - chainKeepNeeds[itemId];
        if (surplus <= 0) continue;
        const hasBuyer = visibleMerchants.some(({ buying }) => {
          const offer = buying[itemId];
          return !!offer && offer.price > 0 && offer.quantity > 0;
        });
        if (hasBuyer) withdrawUpTo(itemId, surplus);
      }
      if (Object.keys(toWithdrawFromStorage).length > 0) {
        tickExtras.autoWithdrawItems = { items: Object.keys(toWithdrawFromStorage), banker: nearbyBanker.id };
        decision = { type: "withdraw", items: toWithdrawFromStorage, banker: nearbyBanker };
      }
    }

    // ── Post-decision: auto-deposit surplus ──────────────────────────────────
    if (atHome && nearbyBanker
      && (decision.type === "explore" || decision.type === "return-home-idle" || decision.type === "return-home-recover" || decision.type === "return-home-overloaded")
      && Object.keys(toDeposit).length > 0) {
      decision = { type: "deposit", items: toDeposit, banker: nearbyBanker };
      tickExtras.autoDeposit = { items: toDeposit, banker: nearbyBanker.id };
    }

    const prevDecision = lastDecision;
    if (decisionChanged(lastDecision, decision)) {
      decisionStableTicks = 1;
      lastDecision = decision;
    } else {
      decisionStableTicks += 1;
    }

    const decisionToIntentType = (d: Decision): string => {
      if (d.type === "attack") return "attack";
      if (d.type === "respawn") return "respawn";
      if (d.type === "sell") return "sellItems";
      if (d.type === "buy") return "buyItems";
      if (d.type === "deposit") return "deposit";
      if (d.type === "withdraw") return "withdraw";
      if (d.type === "equip") return "equip";
      if (d.type === "craft") return "craft";
      if (d.type === "eat") return "eat";
      if (d.type === "harvest") return "harvest";
      if (d.type === "acceptQuest") return "acceptQuest";
      if (d.type === "turnInQuest") return "turnInQuest";
      if (d.type === "abandonQuest") return "abandonQuest";
      return "move"; // recover, return-home-idle, return-home, explore, and drop produce a move/idle intent
    };
    const expectedIntent = decisionToIntentType(decision);
    const serverIntentType = typeof player.intent?.type === "string" ? player.intent.type : null;

    const INTENT_TRANSITION_GRACE_TICKS = 8;

    const isConflictingIntent =
      serverIntentType !== null &&
      serverIntentType !== "idle" &&
      serverIntentType !== expectedIntent &&
      !(decision.type === "attack" && serverIntentType === "move") &&
      !(decision.type === "sell" && serverIntentType === "move") &&
      !(decision.type === "buy" && serverIntentType === "move") &&
      !(decision.type === "deposit" && serverIntentType === "move") &&
      !(decision.type === "withdraw" && serverIntentType === "move") &&
      !(decision.type === "harvest" && serverIntentType === "move") &&
      !(decision.type === "acceptQuest" && serverIntentType === "move") &&
      !(decision.type === "turnInQuest" && serverIntentType === "move") &&
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

    let lostTargetReason: string | null = null;
    if (prevDecision?.type === "attack" && decision.type !== "attack") {
      const prevTargetId = (prevDecision as { type: "attack"; targetId: string }).targetId;
      const rawUnit = heartbeat.units[prevTargetId];
      if (!rawUnit) {
        lostTargetReason = "target no longer in units";
      } else if (typeof rawUnit.hp === "number" && rawUnit.hp <= 0) {
        lostTargetReason = `target dead(hp = ${rawUnit.hp})`;
      } else if (!isFinitePosition(rawUnit.position)) {
        lostTargetReason = "target position invalid";
      } else {
        const dist = distanceBetween(playerPosition, rawUnit.position);
        if (decision.type === "return-home-recover") {
          lostTargetReason = `recovering(low HP, dist = ${dist.toFixed(1)})`;
        } else if (decision.type === "return-home-overloaded") {
          lostTargetReason = `returning home(overweight, dist = ${dist.toFixed(1)})`;
        } else if (decision.type === "sell") {
          lostTargetReason = `selling to merchant(overweight, dist = ${dist.toFixed(1)})`;
        } else if (decision.type === "drop") {
          lostTargetReason = `dropping to flee(overweight + threat, dist = ${dist.toFixed(1)})`;
        } else {
          lostTargetReason = `target out of range(dist = ${dist.toFixed(1)})`;
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
      ...(atHome ? {
        playerCoins,
        storageCoins,
        buyCost,
        availableWithdrawal: availableStorageWithdrawal,
        effectiveCoins,
        toDepositCount: Object.keys(toDeposit).length,
        feePerCharge,
        minStorageCoins,
      } : {}),
      ...(decision.type === "sell" ? { merchant: decision.merchant.id, sellItems: Object.keys(decision.items).length } : {}),
      ...(decision.type === "buy" ? { buyFrom: decision.merchant.id, buyItems: Object.keys(decision.items), coins: playerCoins } : {}),
      ...(decision.type === "deposit" ? { depositTo: decision.banker.id, depositItems: Object.keys(decision.items) } : {}),
      ...(decision.type === "withdraw" ? { withdrawFrom: decision.banker.id, withdrawItems: Object.keys(decision.items) } : {}),
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
        return nearHome ? player.idle() : player.move(HOME_POSITION);
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
        return player.craft(decision.recipeId as any, decision.stationId);
      case "drop":
        return player.drop({ item: decision.item as any, amount: decision.amount });
      case "deposit":
        return player.deposit(decision.banker as any, decision.items as any);
      case "withdraw":
        return player.withdraw(decision.banker as any, decision.items as any);
      case "attack": {
        const target = heartbeat.units[decision.targetId];
        return target ? player.attack(target as any) : player.idle();
      }
      case "explore":
        return player.move(decision.to);
      case "harvest": {
        const target = heartbeat.gameObjects?.[decision.targetId] as Tree | MiningNode | undefined;
        return target ? player.harvest(target) : player.idle();
      }
      case "acceptQuest": {
        const availableQuest = decision.npc?.availableQuests?.[decision.questId];
        if (availableQuest?.rewards?.items) {
          questRewards[decision.questId] = { items: { ...availableQuest.rewards.items } };
        }
        return player.acceptQuest(decision.npc as any, decision.questId as any);
      }
      case "turnInQuest":
        return player.turnInQuest(decision.npc as any, decision.questId as any);
      case "abandonQuest":
        return player.abandonQuest(decision.questId as any);
    }
  },
});
