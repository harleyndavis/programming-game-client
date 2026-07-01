import { connect } from "programming-game";
import { config } from "dotenv";
import { UNIT_TYPE, NPC_TYPE, ClientSideUnit, ClientSideNPC, ClientSideMonster, GameObject, Tree, MiningNode, ActiveQuest } from "programming-game/types";
import { createDashboard } from "./dashboard";
import { toDashboardSnapshot } from "./snapshot";
import { UpgradePlanItem, QuestMap, RecipeList, ItemMap, UpgradeTarget } from "./bot-types";
import * as logger from "./src/logger";
import { isFiniteNumber, isFinitePosition, distanceBetween } from "./src/utils";
import { ENCUMBRANCE_THRESHOLD, getInventoryWeight, findHeaviestInventoryItem, findCheapestFood, computeItemsToSell } from "./src/inventory";
import { getChainedIngredients, canObtainChain, computeDifficultyTier, computeUpgradeTargets, getTargetItemsToKeep, getEquippedRecipeInputs, computeTargetsToBuyFromMerchant, findGearToEquip } from "./src/equipment";
import { findCraftableTarget, findNextCraftTarget, findCraftableFromList } from "./src/craft";
import { getHarvestableTarget, getMissingHarvestToolIds, collectHarvestToolItemIds } from "./src/harvest";
import { findBestSellMerchant } from "./src/trade";
import { findCompletableQuest, findTurnInNpc, findBestQuestToAccept, findQuestGivers } from "./src/quests";

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
const HOME_CHORES_CLEAR_RADIUS = 2; // must be this close to home before declaring chores done
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

// ── Home inventory management ─────────────────────────────────────────────────

// ── Upgrade targeting ──────────────────────────────────────────────────────────

// Returns true if itemId has any known acquisition path reachable without world
// exploration memory: in inventory, sold by a visible merchant, or craftable
// (no-station recipe) from ingredients that are themselves obtainable.
// Only no-station recipes are considered since the bot has no station-visiting logic.
// Acquisition difficulty tier for a single candidate item (lower = easier):
//   1  immediately buyable  — merchant visible and we can afford it
//   2  immediately craftable — all ingredients + tools already in inventory
//   3  buyable but can't afford yet
//   4  craftable; full ingredient chain is obtainable but not all in hand
//   5  blocked — one or more ingredients have no known acquisition path
// For each buyable slot, selects the best upgrade target.
// Primary sort: difficulty tier (non-blocked preferred; blocked only if every
// candidate for the slot is blocked). Secondary sort: smallest stat gain
// (stay incremental within a tier).
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
  | { type: "withdraw"; items: Partial<Record<string, number>>; banker: ClientSideUnit }
  | { type: "attack"; targetId: string; distance: number }
  | { type: "explore"; to: { x: number; y: number } }
  | { type: "harvest"; targetId: string }
  | { type: "acceptQuest"; npc: ClientSideNPC; questId: string }
  | { type: "turnInQuest"; npc: ClientSideNPC; questId: string };

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
let exploreDirectionIndex = 0;
let pendingDepositItem: string | null = null;
let lastDepositMessage = '';
let depositInProgress = false;
let depositCachedItems: Record<string, number> | null = null;
let depositCachedBanker: ClientSideUnit | null = null;
// Last known equipped item per slot — persists across death so recovery
// materials remain protected even when equipment is temporarily empty.
const lastEquipment: Record<string, string> = {};

// Tracks the last unit that attacked us, for defensive combat.
let lastAttackerId: string | null = null;
let lastAttackerTicksLeft = 0;
const LAST_ATTACKER_TICK_TIMEOUT = 15;
// Captured from the first heartbeat — used for event target comparisons.
let myUnitId: string | null = null;

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
  toolToCraft: { itemId: string; recipe: { id: string; input: Partial<Record<string, number>>; required: readonly string[] } } | null;
  finishingHomeChores: boolean;
  harvestTarget: { target: Tree | MiningNode; distance: number } | null;
  isHarvesting: boolean;
  attackingMonster:
  | { unit: { id: string; position: { x: number; y: number } }; distance: number }
  | undefined;
  completableQuest: { quest: ActiveQuest; npc: ClientSideNPC } | null;
  questToAccept: { npc: ClientSideNPC; quest: ClientSideNPC['availableQuests'][string] } | null;
}): Decision => {
  const { playerHp, maxHp, lowHpThreshold, playerPosition, nearbyMonster, isEncumbered, sellOpportunity, heaviestInventoryItem, playerCalories, maxCalories, cheapestFood, isHunting, huntRadius, nearbyHuntTarget, nearbyThreat, upgradesPlan, gearToEquip, recipeToCraft, toolToCraft, finishingHomeChores, harvestTarget, isHarvesting, attackingMonster, completableQuest, questToAccept } = opts;

  if (playerHp <= 0) return { type: "respawn" };

  if (recoveringAtHome) {
    // Only do housekeeping once close to home; otherwise go home.
    if (distanceBetween(playerPosition, HOME_POSITION) < HOME_CHORES_CLEAR_RADIUS) {
      if (gearToEquip) return { type: "equip", item: gearToEquip.item, slot: gearToEquip.slot };
      if (recipeToCraft) return { type: "craft", recipeId: recipeToCraft.recipe!.id };
      if (toolToCraft) return { type: "craft", recipeId: toolToCraft.recipe.id };
      if (upgradesPlan.length > 0) {
        return { type: "buy", items: upgradesPlan[0].items, merchant: upgradesPlan[0].merchant };
      }
      if (completableQuest) return { type: "turnInQuest", npc: completableQuest.npc, questId: completableQuest.quest.id };
      if (sellOpportunity) return { type: "sell", items: sellOpportunity.items, merchant: sellOpportunity.merchant };
      if (questToAccept) return { type: "acceptQuest", npc: questToAccept.npc, questId: questToAccept.quest.id };
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
    if (sellOpportunity) return { type: "sell", items: sellOpportunity.items, merchant: sellOpportunity.merchant };
    return { type: "return-home-overloaded" };
  }
  // Hunt for food — only engage target animals, flee from everything else.
  if (isHunting) {
    if (nearbyThreat) return { type: "explore", to: HOME_POSITION };
    if (nearbyHuntTarget) return { type: "attack", targetId: nearbyHuntTarget.unit.id, distance: nearbyHuntTarget.distance };
    return { type: "explore", to: huntPatrolTo(playerPosition, huntRadius) };
  }
  // Self-defense when not recovering: fight back if attacked while doing chores.
  if (attackingMonster)
    return { type: "attack", targetId: attackingMonster.unit.id, distance: attackingMonster.distance };
  // idlingAtHome / finishingHomeChores: equip, craft, buy, sell; no combat or exploration.
  if (idlingAtHome || finishingHomeChores) {
    if (gearToEquip) return { type: "equip", item: gearToEquip.item, slot: gearToEquip.slot };
    if (recipeToCraft) return { type: "craft", recipeId: recipeToCraft.recipe!.id };
    if (toolToCraft) return { type: "craft", recipeId: toolToCraft.recipe.id };
    if (upgradesPlan.length > 0) {
      return { type: "buy", items: upgradesPlan[0].items, merchant: upgradesPlan[0].merchant };
    }
    if (completableQuest) return { type: "turnInQuest", npc: completableQuest.npc, questId: completableQuest.quest.id };
    if (sellOpportunity) return { type: "sell", items: sellOpportunity.items, merchant: sellOpportunity.merchant };
    if (questToAccept) return { type: "acceptQuest", npc: questToAccept.npc, questId: questToAccept.quest.id };
    return { type: "return-home-idle" };
  }
  // Attack nearby monsters when not busy.
  if (nearbyMonster)
    return { type: "attack", targetId: nearbyMonster.unit.id, distance: nearbyMonster.distance };
  // Try harvesting nearby trees or mining nodes when not busy.
  if (harvestTarget && !isHarvesting) {
    if (harvestTarget.distance < 1.0) {
      return { type: "harvest", targetId: harvestTarget.target.id };
    }
    return { type: "explore", to: harvestTarget.target.position! };
  }
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

// ── Arena match bookkeeping ───────────────────────────────────────────────────
// Arena heartbeats are a full snapshot every tick, so targeting decisions are
// made fresh each tick straight from heartbeat.units — nothing about opponents
// is cached. Only the match transition (start/end) persists across ticks, since
// there's no explicit match-id field; it's derived from the countdown timer.
let arenaMatchActive = false;
let arenaMatchStartMs = 0;
let arenaMatchDuration = 60000; // updated when arena event fires; default 60s
let lastArenaHp = 0;
let lastArenaMaxHp = 100;
let lastArenaCalories = 0;
let lastArenaPos = { x: 0, y: 0 };
let lastArenaOpponentAlive = false;

// ── Crash recovery ───────────────────────────────────────────────────────────
// If an uncaught exception fires, set this flag so the next tick returns a
// move-home intent before the process exits, keeping the character out of
// the open rather than freezing in place mid-hunt.
let emergencyModeActive = false;

let disconnectFromGame: (() => void) | null = null;

const activateEmergencyMode = (label: string, reason: unknown, exitCode = 1) => {
  if (emergencyModeActive) return;
  emergencyModeActive = true;
  try { logger.tick({ ctx: 'overworld', pos: { x: 0, y: 0 }, hp: 0, maxHp: 0, calories: 0, weight: 0, decision: `${label}: ${String(reason)}`, level: 'warn' }); } catch { /* never block shutdown */ }
  try { dashboard.stop(); } catch { /* never block shutdown */ }
  // Keep alive briefly so one onTick fires the move-home intent; then exit.
  // Disconnect from game AFTER the delay so heartbeats keep flowing for the tick.
  setTimeout(() => {
    try { disconnectFromGame?.(); } catch { /* never block shutdown */ }
    // Destroy stdio pipes to release the IPC handle PM2 uses — this is the handle
    // that can keep a Windows process alive even after process.exit() is called.
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
      console.log(`Arena event: ${_instance}`, evt);
      pushEvent(arenaEventBuffer, ARENA_EVENT_BUFFER_SIZE, eventName, evt);
      arenaMatchDuration = evt.duration;
      arenaMatchStartMs = Date.now(); // Align wall-clock with SDK timer
      if (!arenaMatchActive) {
        arenaMatchActive = true;
        isMatchEntry = true;
        logger.openArenaMatch(new Date());
      }
    } else if (_instance === '1v1Arena') {
      if (eventName === 'unitAppeared') {
        console.log(`Arena opponent appeared: ${evt.unit.id}`);
        if (evt.unit.id !== myUnitId) {
          arenaOpponentId = evt.unit.id;
        }
      }
      if (eventName === 'unitDisappeared') console.log(`Arena opponent disappeared: ${evt.unitId}`);
      if (eventName === 'despawn') console.log(`Arena opponent despawned: ${evt.unitId}`);
      pushEvent(arenaEventBuffer, ARENA_EVENT_BUFFER_SIZE, eventName, evt);
    } else if (eventName === 'beganHarvesting' || eventName === 'harvested') {
      pushEvent(harvestEventBuffer, EVENT_BUFFER_SIZE, eventName, evt);
      logger.addExtra(eventName, { objectId: evt.objectId, ...(eventName === 'beganHarvesting' ? { duration: evt.duration, gameTime: evt.gameTime } : {}) });
    } else if (eventName === 'takingAction' && evt.action === 'attack' && myUnitId && evt.actionTarget === myUnitId) {
      // Proactive defense: a unit started an attack targeting us.
      lastAttackerId = evt.unitId;
      lastAttackerTicksLeft = LAST_ATTACKER_TICK_TIMEOUT;
      pushEvent(combatEventBuffer, EVENT_BUFFER_SIZE, 'attackStarted', { attacker: evt.unitId });
      logger.addExtra('defensiveTrigger', { attacker: evt.unitId, source: 'takingAction' });
    } else if (eventName === 'attacked' && myUnitId && evt.attacked === myUnitId) {
      lastAttackerId = evt.attacker;
      lastAttackerTicksLeft = LAST_ATTACKER_TICK_TIMEOUT;
      pushEvent(combatEventBuffer, EVENT_BUFFER_SIZE, eventName, evt);
      logger.addExtra('attacked', { attacker: evt.attacker, damage: evt.damage, hp: evt.hp });
    } else if (eventName === 'acceptedQuest') {
      logger.addExtra('acceptedQuest', { questId: evt.quest?.id, questName: evt.quest?.name });
    } else if (eventName === 'completedQuest') {
      delete questRewards[evt.questId];
      logger.addExtra('completedQuest', { questId: evt.questId, questName: evt.questName });
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

    // Close out any arena match that ended early via combat and whose exit tick
    // was never received. Uses duration from the arena event, falls back to 60 s.
    // 60 s is the maximum match duration.
    if (arenaMatchActive && arenaMatchStartMs > 0 && Date.now() - arenaMatchStartMs > 60_000) {
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
        reason: 'timeout',
      });
      logger.closeArenaMatch();
      arenaMatchActive = false;
    }

    // ── Arena tick ───────────────────────────────────────────────────────────
    if ('arenaTimeRemaining' in heartbeat) {
      const arenaTimeRemaining = heartbeat.arenaTimeRemaining;

      const { player } = heartbeat;
      if (!myUnitId && player.id) myUnitId = player.id;

      // Open the match log on the first arena tick (arena event may arrive late).
      if (!arenaMatchActive) {
        logger.openArenaMatch(new Date());
        arenaMatchActive = true;
        arenaMatchStartMs = Date.now();
        isMatchEntry = true;
      }
      const arenaHp = isFiniteNumber(player.hp) ? player.hp : 0;
      const arenaPosition = isFinitePosition(player.position) ? player.position : { x: 0, y: 0 };
      const arenaMaxCalories = typeof heartbeat.constants?.maxCalories === "number" ? heartbeat.constants.maxCalories : 3_000;
      const arenaCalories = isFiniteNumber(player.calories) ? player.calories : arenaMaxCalories;
      const arenaMaxHp =
        typeof player.stats?.maxHp === "number" && player.stats.maxHp > 0
          ? player.stats.maxHp
          : Math.max(100, arenaHp);
      // Arena is strictly 1v1 — heartbeat.units should contain exactly two units,
      // self and the opponent. The opponent's unit type varies (player, npc, or
      // monster depending on the match), so it's identified purely by not being
      // self, never by type.
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

      // The living opponent — re-evaluated fresh from the heartbeat every tick.
      // The arena is 1v1, so there's at most one valid target and nothing about
      // it is worth caching across ticks. Not filtered by type: the opponent can
      // be a player, npc, or monster unit depending on the match.

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

    // Scan for nearby harvestable objects (trees, mining nodes) given equipped weapon.
    const harvestTarget = getHarvestableTarget(
      heartbeat.gameObjects ?? {},
      (player.equipment ?? {}) as Record<string, string | null | undefined>,
      heartbeat.items ?? {},
      playerPosition,
    );
    const treeObjects = Object.values(heartbeat.gameObjects ?? {}).filter(
      (obj): obj is Tree => obj.type === 'tree' && isFinitePosition(obj.position),
    );
    if (treeObjects.length > 0) {
      tickExtras.treesFound = treeObjects.map(t => ({ id: t.id, treeType: t.treeType, pos: t.position }));
    }
    const miningNodeObjects = Object.values(heartbeat.gameObjects ?? {}).filter(
      (obj): obj is MiningNode => obj.type === 'miningNode' && isFinitePosition(obj.position),
    );
    if (miningNodeObjects.length > 0) {
      tickExtras.miningNodesFound = miningNodeObjects.map(n => ({ id: n.id, oreType: n.oreType, pos: n.position }));
    }
    const isHarvesting = player.action === 'harvest';
    if (isHarvesting && player.actionStart) {
      tickExtras.isHarvesting = { duration: player.actionDuration, target: player.actionTarget, remaining: (player.actionStart + (player.actionDuration ?? 0)) - (heartbeat.gameTime ?? 0) };
    }

    // Attacker tracking: if something hit us recently, fight back regardless
    // of harvest or hunting state.
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

    // bookkeeping: update recovery state once per tick before deciding
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
    const visibleMerchants: Array<{ unit: ClientSideUnit; selling: Record<string, { price: number; quantity: number } | undefined>; buying: Record<string, { price: number; quantity: number } | undefined> }> = [];
    const allMerchantSelling: Record<string, { price: number; quantity: number } | undefined> = {};
    for (const unit of Object.values(heartbeat.units)) {
      if (
        unit.type !== UNIT_TYPE.npc ||
        (unit as { npcType?: string }).npcType !== NPC_TYPE.merchant ||
        !isFinitePosition(unit.position)
      ) continue;
      const selling = ((unit as any).trades?.selling ?? {}) as Record<string, { price: number; quantity: number } | undefined>;
      const buying = ((unit as any).trades?.buying ?? {}) as Record<string, { price: number; quantity: number } | undefined>;
      if (!lastLoggedMerchants.has(unit.id)) {
        lastLoggedMerchants.add(unit.id);
        const seen = (tickExtras.merchantsSeen as Array<{ id: string; sells: string[] }> | undefined) ?? [];
        seen.push({ id: unit.id, sells: Object.keys(selling) });
        tickExtras.merchantsSeen = seen;
      }
      visibleMerchants.push({ unit, selling, buying });
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

    // heartbeat.recipes is typed as Recipe[] but the server sends a Record keyed by id at runtime.
    const recipesArray: RecipeList = Array.isArray(heartbeat.recipes)
      ? heartbeat.recipes
      : Object.values(heartbeat.recipes as any);

    // Determine next upgrade target per slot from all items we know how to acquire.
    // This drives sell-protection, buy plans, and craft decisions.
    // Merge storage + inventory so items in storage are visible for crafting/buy planning.
    // Without this, depositing a craftable ingredient would make it disappear from the
    // upgrade targets, dropping it from keepItems → non-protected withdraw pulls it back →
    // deposit again → infinite cycle (e.g. rat pelts ↔ leather armor).
    // Merge storage + inventory by summing quantities (spread overwrites, doesn't add).
    const combinedInventory: Partial<Record<string, number>> = {};
    for (const source of [heartbeat.player.storage, player.inventory]) {
      if (!source) continue;
      for (const [itemId, qty] of Object.entries(source)) {
        if (typeof qty === 'number' && qty > 0) {
          combinedInventory[itemId] = (combinedInventory[itemId] ?? 0) + qty;
        }
      }
    }
    const upgradeTargets = computeUpgradeTargets({
      equipment: (player.equipment ?? {}) as Record<string, string | null | undefined>,
      inventory: combinedInventory,
      items: heartbeat.items as unknown as ItemMap,
      recipes: recipesArray,
      allMerchantSelling,
      playerCoins,
    });
    const keepItems = getTargetItemsToKeep(upgradeTargets, recipesArray);
    // Update lastEquipment each tick but never clear on death: this keeps
    // recovery materials protected across the window when equipment is empty.
    for (const [slot, itemId] of Object.entries((player.equipment ?? {}) as Record<string, string | null | undefined>)) {
      if (itemId) lastEquipment[slot] = itemId;
    }
    const recoveryItems = getEquippedRecipeInputs(lastEquipment, recipesArray);
    // Tool IDs are computed once from recipe required arrays + harvesting weapon
    // types. Recipes and the item catalog don't change after the initial heartbeat.
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
    const protectedItems = new Set(Array.from(keepItems).concat(Array.from(recoveryItems), Array.from(toolItemIds)));
    const atHome = recoveringAtHome || idlingAtHome || finishingHomeChores;

    // The upgrade target we'd craft next from combined (storage + pocket) inventory.
    // Drives deposit exclusion and the withdraw-for-craft override below.
    const activeCraft = atHome ? findCraftableTarget(upgradeTargets, combinedInventory, recipesArray) : null;
    // Display-only — no inventory or withdraw impact (risk of death loss).
    const nextCraftTarget = activeCraft ?? findNextCraftTarget(upgradeTargets);

    // Only protect ingredients for the currently-craftable target from deposit.
    // Non-craftable targets are shown on the dashboard via isNextCraft but must not
    // affect inventory — carrying unprotected ingredients risks losing them on death.
    const activeCraftItems: Set<string> = activeCraft?.recipe
      ? new Set([
        ...Object.keys(activeCraft.recipe.input),
        ...activeCraft.recipe.required.map(String),
      ])
      : new Set();

    // Compute what to deposit: spare coins + keepItems currently in inventory,
    // excluding items needed for the active craft so they aren't deposited then
    // immediately re-withdrawn.
    const invRecord = (player.inventory ?? {}) as Record<string, number>;
    const toDeposit: Partial<Record<string, number>> = {};
    if (playerCoins > COINS_TO_KEEP) {
      toDeposit.copperCoin = playerCoins - COINS_TO_KEEP;
    }
    for (const [itemId, qty] of Object.entries(invRecord)) {
      if (itemId === 'copperCoin' || qty <= 0) continue;
      if (protectedItems.has(itemId) && !activeCraftItems.has(itemId)) toDeposit[itemId] = qty;
    }

    const toSell = computeItemsToSell({
      inventory: player.inventory ?? {},
      items: heartbeat.items as unknown as ItemMap,
      quests: (player.quests ?? {}) as QuestMap,
      keepItems: protectedItems,
      maxCalories,
    });
    const sellOpportunity = findBestSellMerchant(visibleMerchants, toSell);
    const heaviestInventoryItem = isEncumbered
      ? findHeaviestInventoryItem(player.inventory ?? {}, heartbeat.items)
      : null;

    // Compute storage fee buffer for withdrawal calculations.
    const storageRecord = heartbeat.player.storage ?? {};
    const storageCoins = typeof storageRecord.copperCoin === 'number' ? storageRecord.copperCoin : 0;
    const storageItemsWeight = Object.entries(storageRecord)
      .filter(([id]) => id !== 'copperCoin')
      .reduce((sum, [id, qty]) => {
        const defW = (heartbeat.items as Record<string, { weight?: number }> | undefined)?.[id]?.weight ?? 0;
        return sum + defW * (typeof qty === 'number' ? qty : 1);
      }, 0);
    const storageWeight = storageItemsWeight + storageCoins;
    const feePerCharge = Math.ceil(storageWeight * 0.0025);
    const minStorageCoins = feePerCharge * STORAGE_FEE_BUFFER;
    const availableStorageWithdrawal = Math.max(0, storageCoins - minStorageCoins);

    // Build per-merchant buy baskets using effective coins (pocket + storage beyond fee buffer).
    const effectiveCoins = playerCoins + availableStorageWithdrawal;
    const upgradesPlan: Array<{ items: Partial<Record<string, number>>; merchant: ClientSideUnit }> = [];
    if (atHome) {
      for (const { unit, selling } of visibleMerchants) {
        const basket = computeTargetsToBuyFromMerchant({
          targets: upgradeTargets,
          merchantSelling: selling,
          playerCoins: effectiveCoins,
          inventory: combinedInventory,
        });
        if (Object.keys(basket).length > 0) {
          upgradesPlan.push({ items: basket, merchant: unit });
        }
      }
      upgradesPlan.sort((a, b) => Object.keys(b.items).length - Object.keys(a.items).length);
    }

    // Compute total cost of the first merchant's buy basket.
    let buyCost = 0;
    if (upgradesPlan.length > 0) {
      const firstBasket = upgradesPlan[0];
      const merchantSelling = visibleMerchants.find(m => m.unit.id === firstBasket.merchant.id)?.selling ?? {};
      for (const [itemId, qty = 1] of Object.entries(firstBasket.items)) {
        buyCost += (merchantSelling[itemId]?.price ?? 0) * qty;
      }
    }

    // Only keep coins in inventory if we can afford the purchase (with or without a withdrawal).
    // If we can't afford it, deposit everything to avoid losing coins on death.
    if (buyCost > 0 && toDeposit.copperCoin && toDeposit.copperCoin > 0) {
      const canAffordPurchase = playerCoins >= buyCost || availableStorageWithdrawal >= (buyCost - playerCoins);
      if (canAffordPurchase) {
        toDeposit.copperCoin = Math.max(0, (playerCoins - COINS_TO_KEEP) - buyCost);
      } else {
        toDeposit.copperCoin = playerCoins - COINS_TO_KEEP;
      }
    }

    // Remove 0-value entries from toDeposit to avoid pointless no-op deposit commands.
    for (const [key, val] of Object.entries(toDeposit)) {
      if (val === undefined || val <= 0) delete toDeposit[key as keyof typeof toDeposit];
    }

    const gearToEquip = atHome
      ? findGearToEquip({
        inventory: player.inventory ?? {},
        equipment: (player.equipment ?? {}) as Record<string, string | null | undefined>,
        items: heartbeat.items as unknown as ItemMap,
      })
      : null;

    const recipeToCraft = atHome
      ? findCraftableTarget(upgradeTargets, player.inventory ?? {}, recipesArray)
      : null;

    const missingHarvestTools = getMissingHarvestToolIds(
      (player.equipment ?? {}) as Record<string, string | null | undefined>,
      player.inventory ?? {},
      heartbeat.items as Record<string, { type?: string }>,
    );
    const toolToCraft = atHome && missingHarvestTools.length > 0
      ? findCraftableFromList(missingHarvestTools, player.inventory ?? {}, recipesArray)
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
        isNextCraft: nextCraftTarget?.itemId === target.itemId,
      };
    });

    const coverage = feePerCharge > 0 ? storageCoins / feePerCharge : 0;

    dashboard.publish({
      ...toDashboardSnapshot(heartbeat, {
        recoveringAtHome,
        idlingAtHome,
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
      world: {
        npcs: units.filter((u) => u.type === UNIT_TYPE.npc) as ClientSideNPC[],
        mobs: units.filter((u) => u.type === UNIT_TYPE.monster) as ClientSideMonster[],
        objects: Object.values(heartbeat.gameObjects ?? {}) as GameObject[],
      },
      upgradePlans: upgradePlanItems,
      storageEvents: [...storageEventBuffer],
      harvestEvents: [...harvestEventBuffer],
      combatEvents: [...combatEventBuffer],
      arenaEvents: [...arenaEventBuffer],
    });

    // Clear finishingHomeChores once healthy, back at home base, and all tasks done.
    // The position check is critical: HP can heal en route while the merchant is still
    // out of range, which would make upgradesPlan appear empty — a false "no tasks".
    const nearHome = distanceBetween(playerPosition, HOME_POSITION) < HOME_CHORES_CLEAR_RADIUS;
    if (finishingHomeChores && !recoveringAtHome && playerHp >= maxHp && nearHome) {
      const hasChores =
        gearToEquip !== null ||
        recipeToCraft !== null ||
        toolToCraft !== null ||
        activeCraft !== null ||
        upgradesPlan.length > 0;
      if (!hasChores) finishingHomeChores = false;
    }

    // ── Auto-deposit spare coins and keepItems ──────────────────────────────
    if (!depositOverride && atHome && nearbyBanker && Object.keys(toDeposit).length > 0) {
      depositOverride = { type: "deposit", items: toDeposit, banker: nearbyBanker };
      tickExtras.autoDeposit = { items: toDeposit, banker: nearbyBanker.id };
    }

    // ── Withdraw coins from storage for purchases, leaving 100× storage fee ──
    let withdrawOverride: Decision | null = null;
    if (atHome && nearbyBanker && buyCost > 0 && playerCoins < buyCost && availableStorageWithdrawal >= (buyCost - playerCoins)) {
      const deficit = buyCost - playerCoins;
      withdrawOverride = { type: "withdraw", items: { copperCoin: deficit }, banker: nearbyBanker };
      tickExtras.autoWithdraw = { amount: deficit, deficit, playerCoins, storageFee: feePerCharge, storageFeeBuffer: minStorageCoins };
    }

    // ── Withdraw ingredients/tools from storage for the active craft ─────────
    // Only withdraw for targets that are actually craftable — withdrawing for
    // non-craftable targets would put valuable items at risk of death loss.
    if (!withdrawOverride && atHome && nearbyBanker && activeCraft?.recipe) {
      const toWithdrawForCraft: Partial<Record<string, number>> = {};
      const storageRec = storageRecord as Record<string, number>;
      for (const [itemId, qty] of Object.entries(activeCraft.recipe.input)) {
        const haveInPocket = invRecord[itemId] ?? 0;
        const needed = qty ?? 0;
        if (haveInPocket < needed) {
          const canWithdraw = Math.min(needed - haveInPocket, storageRec[itemId] ?? 0);
          if (canWithdraw > 0) toWithdrawForCraft[itemId] = canWithdraw;
        }
      }
      for (const toolId of activeCraft.recipe.required) {
        const toolStr = String(toolId);
        if ((invRecord[toolStr] ?? 0) < 1) {
          const canWithdraw = Math.min(1, storageRec[toolStr] ?? 0);
          if (canWithdraw > 0) toWithdrawForCraft[toolStr] = canWithdraw;
        }
      }
      if (Object.keys(toWithdrawForCraft).length > 0) {
        withdrawOverride = { type: "withdraw", items: toWithdrawForCraft, banker: nearbyBanker };
        tickExtras.withdrawForCraft = { items: Object.keys(toWithdrawForCraft) };
      }
    }

    // ── Withdraw non-protected items from storage to sell ────────────────────
    if (!withdrawOverride && !depositOverride && atHome && nearbyBanker) {
      const storageRecord = heartbeat.player.storage ?? {};
      const toWithdrawFromStorage: Partial<Record<string, number>> = {};
      for (const [itemId, qty] of Object.entries(storageRecord)) {
        if (itemId === 'copperCoin' || typeof qty !== 'number' || qty <= 0) continue;
        if (!protectedItems.has(itemId)) toWithdrawFromStorage[itemId] = qty;
      }
      if (Object.keys(toWithdrawFromStorage).length > 0) {
        withdrawOverride = { type: "withdraw", items: toWithdrawFromStorage, banker: nearbyBanker };
        tickExtras.autoWithdrawItems = { items: Object.keys(toWithdrawFromStorage), banker: nearbyBanker.id };
      }
    }

    // ── Quest checks ─────────────────────────────────────────────────────────
    // Check for completable quests (all required items in inventory) with nearby
    // turn-in NPCs. Also find available quests to accept from nearby givers.
    const activeQuests = (player.quests ?? {}) as QuestMap;
    const visibleNpcs = Object.values(heartbeat.units).filter(
      (u): u is ClientSideNPC => u.type === UNIT_TYPE.npc && isFinitePosition(u.position),
    );
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
    const questToAccept: { npc: ClientSideNPC; quest: ClientSideNPC['availableQuests'][string] } | null =
      atHome || !isHunting
        ? findBestQuestToAccept(questGivers, activeQuests, maxActiveQuests)
        : null;
    if (completableQuest) tickExtras.completableQuest = { questId: completableQuest.quest.id, npcId: completableQuest.npc.id };
    if (questToAccept) tickExtras.questToAccept = { questId: questToAccept.quest.id, npcId: questToAccept.npc.id };

    const decision = withdrawOverride ?? depositOverride ?? decide({
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
      toolToCraft,
      finishingHomeChores,
      harvestTarget,
      isHarvesting,
      attackingMonster,
      completableQuest,
      questToAccept,
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
      if (d.type === "withdraw") return "withdraw";
      if (d.type === "equip") return "equip";
      if (d.type === "craft") return "craft";
      if (d.type === "eat") return "eat";
      if (d.type === "harvest") return "harvest";
      if (d.type === "acceptQuest") return "acceptQuest";
      if (d.type === "turnInQuest") return "turnInQuest";
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
      !(decision.type === "withdraw" && serverIntentType === "move") &&
      !(decision.type === "harvest" && serverIntentType === "move") &&
      !(decision.type === "acceptQuest" && serverIntentType === "move") &&
      !(decision.type === "turnInQuest" && serverIntentType === "move") &&
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
    }
  },
});
