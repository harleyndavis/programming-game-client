import { connect } from "programming-game";
import { config } from "dotenv";
import { UNIT_TYPE, NPC_TYPE, ClientSideUnit, ClientSideNPC, ClientSideMonster, GameObject, Station, Tree, MiningNode, ActiveQuest } from "programming-game/types";
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
import { openMemoryDb, getEntity, recordResourceSighting, recordMerchantTrades, recordNpcSighting, recordQuestSighting, recordMonsterKill, recordHarvest, recordLoot, recordMonsterSighting, recordCombatHit, recordMonsterMaxHp, recordSafeLocation, recordExploredCell, recordQuestEndNpc, recordQuestCompleted, getKnownStationTypes, getAllKnownSellingOffers, getKnownLootItems, getKnownQuestRewardItems, ASSUMED_SIGHT_RANGE } from "./src/memory";

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
// Coincidentally the same value as memory.ts's ASSUMED_SIGHT_RANGE (imported
// below) but a distinct, independent constant — one sizes a memory grid, the
// other gates real-time hunting-threat proximity; they shouldn't move
// together just because they happen to match today.
const HOME_CHORES_CLEAR_RADIUS = 2; // must be this close to home before declaring chores done
// If we've closed to within this distance of a remembered quest NPC position and
// still can't see/act on them, give up rather than sitting on the spot forever —
// see "No chase-to-NPC" postmortem in CONTEXT.md for why an unconditional chase
// with no exit condition is a deadlock, not a tuning problem.
const QUEST_NPC_ARRIVAL_RADIUS = 2;
// Floor for how many of a tool-type item (toolItemIds) is "enough" — one,
// maybe a spare — once the active craft chains no longer need more. Used both
// to stop a repeatable quest reward from cycling forever (QuestScoringOpts.
// stockedItems) and, as a fallback in chainKeepNeeds below, to bound tools
// that fall outside any *currently* active chain (e.g. a harvest-tool
// prerequisite like stoneCutterTools once its axe/pickaxe is already owned):
// without a fallback those tools have no chainKeepNeeds entry at all and are
// protected indefinitely with no sell path, no matter how many pile up.
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

// Last seen merchant offer per item, across every merchant ever visible.
// Used to judge whether a quest turn-in item is buyable *somewhere* even when
// that merchant is currently out of sight (e.g. while standing at the quest
// giver deciding whether to walk home and buy).
const rememberedMerchantSelling: Record<string, { price: number; quantity: number }> = {};
// Last known position of a quest NPC, updated whenever they're actually visible.
// Used to close the distance when they're out of sight but we have business with
// them. Cleared once we've arrived and confirmed they're genuinely not there —
// see QUEST_NPC_ARRIVAL_RADIUS — so a stale or imprecise memory can't strand the
// bot walking toward the same empty spot forever.
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

// ── Home inventory management ─────────────────────────────────────────────────

// ── Upgrade targeting ──────────────────────────────────────────────────────────

// Returns true if itemId has any known acquisition path: in inventory, sold
// by any known merchant (visible now or remembered from memory), or craftable
// from ingredients that are themselves obtainable — including station-gated
// recipes once memory has seen a station of the required type anywhere
// (knownStationTypes), independent of whether the bot is standing at one
// right now. See src/plan.ts's isRecipeAvailable and the knownStationTypes vs
// availableStationTypes split (the latter still correctly gates "craftable this
// instant" on actually being at a matching station).
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
// When disabled, the bot stops accepting new quests and abandons any active ones.
let pursueQuestsEnabled = true;
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
// Snapshots updated every overworld tick, used only to resolve identity for
// memory-write event correlation in onEvent (which has no heartbeat access of
// its own) — e.g. looking up a killed unit's monsterId, or a harvested
// object's treeType/oreType, before it disappears from the next heartbeat.
let lastUnits: Record<string, ClientSideUnit> = {};
let lastGameObjects: Record<string, GameObject> = {};

// The SDK's `loot` event carries no source reference (just who received the
// items) — there is no correlation id anywhere linking it back to a kill or
// harvest. So a loot event is attributed to whichever of these is freshest
// within LOOT_ATTRIBUTION_WINDOW_MS; if both are fresh (ambiguous) or neither
// is, the loot event is discarded rather than risking a wrong attribution —
// min/max variance tracking is only trustworthy if attribution is trustworthy.
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

  // Shared home chores: runs for recoveringAtHome, idlingAtHome, and
  // finishingHomeChores. Returns a decision if there's a chore to do, or null
  // when nothing is left. Not gated by distance to home — each branch below
  // is already gated by the proximity it actually needs (nearbyBanker for
  // withdraw, a visible NPC for quest turn-in/accept, a visible merchant for
  // buy/sell), or needs none at all (equip, quest abandon/dismiss). Craft
  // execution is gated by safety (see recipeToCraft/toolToCraft's own
  // computation) rather than location.
  const homeChores = (): Decision | null => {
    // Skip a weapon-slot suggestion here when there's an active harvestTarget
    // to go interact with — same narrowing as reclaimWeapon below, just
    // applied to homeChores() too. homeChores() isn't gated by distance (see
    // above), so it can run mid-transit while harvestTarget is also set
    // (e.g. finishingHomeChores true while walking home past a node); without
    // this, gearToEquip's raw "best owned weapon overall" pick (sword beats
    // pickaxe on dps) would equip right back over the harvest tool the
    // harvestTarget branch further down just equipped, undoing it every tick.
    if (gearToEquip && !(gearToEquip.slot === 'weapon' && harvestTarget)) {
      return { type: "equip", item: gearToEquip.item, slot: gearToEquip.slot };
    }
    // A needed harvest tool sitting in storage instead of pocket — bring it
    // out so resolveHarvestToolForTarget (pocket-only) has something to work
    // with. See findHarvestToolToWithdraw (src/harvest.ts).
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

  // gearToEquip (src/equipment.ts) already picks whichever owned weapon has
  // the best stats, harvest tools included — a pickaxe with better dps than
  // whatever's equipped is a perfectly fine weapon. Narrowed to the weapon
  // slot here and only consulted right before an attack fires (below), not
  // generally: while there's no monster to fight, harvestToolToEquip is what
  // should be picking the weapon slot (it needs the *correct tool type* for
  // the resource being harvested, not the highest-dps one).
  const reclaimWeapon = gearToEquip?.slot === 'weapon' ? gearToEquip : null;

  if (recoveringAtHome) {
    const chore = homeChores();
    if (chore) return chore;
    return { type: "return-home-recover" };
  }
  // Survival behaviors — run regardless of idlingAtHome.
  // Eat if we have food and the deficit is at least as large as its calorie value (no wasted calories).
  const calorieDeficit = maxCalories - playerCalories;
  if (cheapestFood !== null && calorieDeficit >= cheapestFood.calories) {
    return { type: "eat", item: cheapestFood.item };
  }
  // Overweight: the default response is always to head home and sell off the
  // excess. Dropping is a last resort to regain movement speed while actually
  // fleeing — only when something is actively attacking us, not just
  // nearby. A monster merely being close by isn't a flee scenario on its
  // own; that was dumping real gear (e.g. a displaced weapon) for no reason
  // whenever an unrelated monster happened to wander within range.
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
  // Try harvesting nearby trees or mining nodes when not busy. The tool swap
  // (fellingAxe/pickaxe for the current need — e.g. copperOre short →
  // pickaxe) is folded into this decision rather than a standalone earlier
  // branch: getHarvestableTarget's needed-item search finds harvestTarget
  // regardless of what's currently equipped, so this only fires once we've
  // actually decided to go after a specific node — not just because some
  // chain need exists in the abstract with nothing harvestable in sight
  // (e.g. while sitting at home), which used to fight with gearToEquip
  // wanting the best combat weapon equipped there instead.
  if (harvestTarget) {
    if (harvestToolToEquip) {
      return { type: "equip", item: harvestToolToEquip.item, slot: harvestToolToEquip.slot };
    }
    // Only actually harvest once the equipped weapon matches what this
    // specific target requires (harvestToolReady). If it doesn't match and
    // nothing owned in pocket can fix that either (harvestToolToEquip null),
    // the required tool simply isn't owned at all — fall through rather than
    // issuing a harvest intent with the wrong tool equipped, which the server
    // would just reject.
    if (harvestToolReady) {
      // No client-side range gate, same as attack: player.harvest(target) is
      // a move-to-and-act intent (see get-handlers.ts), so the server
      // handles closing the distance. Gating on harvestTarget.distance here
      // just made the bot explore toward the object first and only ever
      // harvest once already within an arbitrary 1.0, which could undershoot
      // the object's actual interaction range (radius varies per object).
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
// Captured on the first dead tick; written just before the first alive tick so
// recentTicks includes all the dead-wait ticks and the write happens exactly once.
type PendingSnapshot = Omit<logger.DeathSnapshot, 'ts' | 'recentTicks'>;
let pendingOverworldDeath: PendingSnapshot | null = null;

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

// Closes out whatever match is currently open, if any. Shared by the 'arena'
// event handler (closing a stale previous match before opening a new one) and
// the duration-elapsed check in onTick.
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
      // Server patch: this now fires at the START of a match and accurately
      // resets the countdown (evt.duration, typically 60000ms) — the
      // authoritative signal for both open and close (close is inferred by
      // elapsing arenaMatchDuration in onTick below), not unitAppeared/
      // unitDisappeared. Close out any still-open previous match first in
      // case back-to-back matches outrun the duration-based close.
      pushEvent(arenaEventBuffer, ARENA_EVENT_BUFFER_SIZE, eventName, evt);
      closeArenaMatchIfActive('newMatchEvent');
      arenaMatchDuration = evt.duration;
      arenaMatchActive = true;
      isMatchEntry = true;
      arenaMatchStartMs = Date.now();
      logger.openArenaMatch(new Date());
    } else if (_instance === '1v1Arena') {
      // unitAppeared/unitDisappeared/despawn no longer drive match lifecycle
      // (see 'arena' handler above) — kept here only for opponent id tracking
      // and console visibility.
      if (eventName === 'unitAppeared') {
        if (evt.unit.id !== myUnitId) {
          arenaOpponentId = evt.unit.id;
        }
      }

      // Record combat history and kills in arena, same as overworld — but skip
      // loot (arena inventories are ephemeral and don't reflect overworld drops).
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
            // Captured on every hit we land, not just kills — a monster we
            // kill before it ever hits us (very possible) would otherwise
            // never get its maxHp recorded at all.
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
        // 'harvested' carries no item data — the yield itself arrives via a
        // later 'loot' event, attributed by timing (see the 'loot' branch below).
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
          // Captured on every hit we land, not just kills — a monster we
          // kill before it ever hits us (very possible) would otherwise
          // never get its maxHp recorded at all.
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
      // Neither 'attacked'/'died' nor 'harvested' carries the actual loot — this
      // is the sole source, and it carries no source reference at all. Attribute
      // to whichever of a recent kill/harvest is freshest; discard if both are
      // fresh (ambiguous) or neither is, rather than risk a wrong attribution.
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

    // The 'arena' event accurately resets the countdown at match start (server
    // patch), so elapsing arenaMatchDuration since then is the authoritative
    // close signal — not anything in the heartbeat itself. Overworld heartbeats
    // keep arriving interleaved throughout an active match, so arenaTimeRemaining
    // presence/absence still can't be used here.
    if (arenaMatchActive && arenaMatchStartMs > 0 && Date.now() - arenaMatchStartMs > arenaMatchDuration) {
      closeArenaMatchIfActive('durationElapsed');
    }

    // ── Arena tick ───────────────────────────────────────────────────────────
    if ('arenaTimeRemaining' in heartbeat) {
      // Snapshot arena units so onEvent can resolve monsterId from attacker/killed
      // unit IDs (same pattern as the overworld tick below).
      lastUnits = heartbeat.units;
      const arenaTimeRemaining = heartbeat.arenaTimeRemaining;

      const { player } = heartbeat;
      if (!myUnitId && player.id) myUnitId = player.id;

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

    // Snapshot units/gameObjects for onEvent's memory-write correlation, since
    // onEvent has no heartbeat access of its own (see recentKill/recentHarvest above).
    lastUnits = heartbeat.units;
    lastGameObjects = heartbeat.gameObjects ?? {};

    // harvestTarget (need-aware) is computed further down, once chainKeepNeeds
    // is available — see there for why.
    // Single pass over every game object: log it for debugging and record its
    // sighting into memory. recordResourceSighting already treats trees, mining
    // nodes, and stations uniformly (it derives entity type/name from the
    // object itself) — no reason to scan gameObjects three times to give each
    // type its own special-cased loop.
    const treesFound: Array<{ id: string; treeType: string; pos: { x: number; y: number } }> = [];
    const miningNodesFound: Array<{ id: string; oreType: string; pos: { x: number; y: number } }> = [];
    const stationsFound: Array<{ id: string; stationType: string; stationSubtype: string; pos: { x: number; y: number } }> = [];
    const gameObjectScanNow = Date.now();
    for (const obj of Object.values(heartbeat.gameObjects ?? {})) {
      if (!isFinitePosition(obj.position)) continue;
      if (obj.type === 'tree') {
        treesFound.push({ id: obj.id, treeType: obj.treeType, pos: obj.position });
      } else if (obj.type === 'miningNode') {
        miningNodesFound.push({ id: obj.id, oreType: obj.oreType, pos: obj.position });
      } else if (obj.type === 'station') {
        stationsFound.push({ id: obj.id, stationType: obj.stationType, stationSubtype: obj.stationSubtype, pos: obj.position });
      }
      recordResourceSighting(memoryDb, obj, ASSUMED_SIGHT_RANGE, gameObjectScanNow);
    }
    if (treesFound.length > 0) tickExtras.treesFound = treesFound;
    if (miningNodesFound.length > 0) tickExtras.miningNodesFound = miningNodesFound;
    if (stationsFound.length > 0) tickExtras.stationsFound = stationsFound;

    // Single pass over every visible monster: record its sighting into memory,
    // same one-scan-per-role idiom as the game-object and NPC scans.
    for (const unit of Object.values(heartbeat.units)) {
      if (unit.type !== UNIT_TYPE.monster || !isFinitePosition(unit.position)) continue;
      recordMonsterSighting(memoryDb, unit as ClientSideMonster, ASSUMED_SIGHT_RANGE, gameObjectScanNow);
    }

    // Marks the ground the bot has actually stood on as explored.
    recordExploredCell(memoryDb, playerPosition, ASSUMED_SIGHT_RANGE, gameObjectScanNow);
    recordSafeLocation(memoryDb, 'home', 'town', HOME_POSITION, gameObjectScanNow);
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
    // Overload starts a home visit exactly like low HP does (see shouldRecover
    // above) — without this, atHome (recoveringAtHome/idlingAtHome/finishingHomeChores)
    // never goes true for a purely-overweight return trip, so the bot can reach
    // HOME_POSITION and then just idle forever: decide()'s isEncumbered branch
    // keeps returning "return-home-overloaded" and the auto-deposit override
    // below is gated on atHome, which was never set.
    if (isEncumbered && !finishingHomeChores) {
      finishingHomeChores = true; // start a home visit
    }

    // ── NPC scan (single pass) ───────────────────────────────────────────────
    // One scan over every visible NPC, whatever its role: record its sighting,
    // additionally record merchant trades if it's a merchant, additionally
    // record any quests it's offering if it has any. Every other NPC-shaped
    // list below (merchants, bankers, quest givers) is derived from this one
    // pass instead of re-scanning heartbeat.units per role.
    const visibleNpcs: ClientSideNPC[] = [];
    const visibleMerchants: Array<{ unit: ClientSideUnit; selling: Record<string, { price: number; quantity: number } | undefined>; buying: Record<string, { price: number; quantity: number } | undefined> }> = [];
    const visibleBankers: ClientSideUnit[] = [];
    // Seeded from persisted memory so items sold by a merchant that isn't
    // currently visible don't flicker out of the upgrade plan — live sightings
    // below override remembered ones; remembered only fills gaps.
    const allMerchantSelling: Record<string, { price: number; quantity: number } | undefined> = {
      ...getAllKnownSellingOffers(memoryDb),
    };
    const npcScanNow = Date.now();
    for (const unit of Object.values(heartbeat.units)) {
      if (unit.type !== UNIT_TYPE.npc || !isFinitePosition(unit.position)) continue;
      const npc = unit as unknown as ClientSideNPC;
      visibleNpcs.push(npc);
      const npcType = (unit as { npcType?: string }).npcType;

      // Every NPC gets exactly one sighting call, regardless of role.
      recordNpcSighting(memoryDb, npc, ASSUMED_SIGHT_RANGE, npcScanNow);

      if (npcType === NPC_TYPE.merchant) {
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
        for (const [itemId, offer] of Object.entries(selling)) {
          if (offer) rememberedMerchantSelling[itemId] = offer;
        }
        recordMerchantTrades(memoryDb, npc, npcScanNow);
      } else if (npcType === NPC_TYPE.banker) {
        visibleBankers.push(unit);
        if (isFinitePosition(unit.position)) recordSafeLocation(memoryDb, npc.name, 'banker', unit.position, npcScanNow);
      }

      // Every NPC's quest offers are recorded the same way, regardless of role.
      if (npc.availableQuests) {
        for (const quest of Object.values(npc.availableQuests)) {
          recordQuestSighting(memoryDb, npc.name, quest, npcScanNow);
        }
      }
    }
    if (visibleBankers.length > 0) {
      tickExtras.bankersFound = visibleBankers.map(u => ({ id: u.id, pos: u.position }));
    }

    const nearbyBanker = visibleBankers
      .map((unit) => ({
        unit,
        distance: distanceBetween(playerPosition, unit.position as { x: number; y: number }),
      }))
      .sort((a, b) => a.distance - b.distance)[0]?.unit;

    // ── Station detection ──────────────────────────────────────────────────────
    // Stations (smithing, cooking, alchemy, etc.) only appear in heartbeat.gameObjects
    // when visible, same as merchants/bankers/trees. A station-gated recipe is only
    // craftable this tick if a matching station is currently in view.
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

    // heartbeat.recipes is typed as Recipe[] but the server sends a Record keyed by id at runtime.
    // filterDisabledRecipes is a preprocessing pass — every planning function
    // below consumes recipesArray, so applying it once here means nothing
    // downstream ever sees the disabled recipes at all (see src/plan.ts).
    const recipesArray: RecipeList = filterDisabledRecipes(
      Array.isArray(heartbeat.recipes) ? heartbeat.recipes : Object.values(heartbeat.recipes as any),
    );

    // Determine next upgrade target per slot from all items we know how to acquire.
    // This drives sell-protection, buy plans, and craft decisions.
    // Merge storage + inventory so items in storage are visible for crafting/buy planning.
    // Without this, depositing a craftable ingredient would make it disappear from the
    // upgrade targets, dropping it from chainKeepNeeds → withdrawn to sell → deposited again
    // → infinite cycle (e.g. rat pelts ↔ leather armor).
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
    // Augment combinedInventory with active quest reward items (qty=1 each if not owned)
    // so canObtainChain treats quest-rewarded items as reachable during planning.
    const planningInventory: Partial<Record<string, number>> = { ...combinedInventory };
    for (const reward of Object.values(questRewards)) {
      for (const itemId of Object.keys(reward.items ?? {})) {
        if ((planningInventory[itemId] ?? 0) === 0) planningInventory[itemId] = 1;
      }
    }

    // Station knowledge for stabilizing upgrade-plan reachability across location:
    // knownStationTypes (persisted memory) governs "obtainable in principle" so
    // the plan doesn't flicker with visibility; availableStationTypes (this tick's
    // visible stations, from collectVisibleStations/getAvailableStationTypes above)
    // still correctly gates "craftable right now" — see src/plan.ts's
    // isRecipeAvailable and the knownStationTypes/availableStationTypes split
    // documented there.
    const knownStationTypes = new Set(getKnownStationTypes(memoryDb));
    // Same "known persisted, stable regardless of visibility" role as
    // knownStationTypes, extended to the other two acquisition paths
    // canObtainChain/computeDifficultyTier didn't previously recognize at
    // all: a known loot/harvest source, or a known quest reward.
    // Seeded with KNOWN_HARVESTABLE_ITEMS (ore/log items per tree/oreType) so
    // e.g. copperOre is reachable via mining from the very first tick, before
    // the bot has ever actually harvested one — getKnownLootItems then
    // confirms/extends this empirically the same way it already does for
    // monster drops (see src/harvest.ts).
    const knownLootItems = new Set([...getKnownLootItems(memoryDb), ...Array.from(KNOWN_HARVESTABLE_ITEMS)]);
    const knownQuestRewardItems = new Set(getKnownQuestRewardItems(memoryDb));

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
    // Update lastEquipment each tick but never clear on death: this keeps
    // recovery materials protected across the window when equipment is empty.
    // Skip a harvest tool temporarily occupying the weapon slot (need-based
    // tool-switching, see resolveHarvestToolForTarget) — otherwise the real weapon
    // it displaced (e.g. copperSword) is overwritten here, drops out of
    // chainKeepNeeds below, and becomes sellable/droppable while it's just
    // sitting in pocket waiting to be re-equipped.
    for (const [slot, itemId] of Object.entries((player.equipment ?? {}) as Record<string, string | null | undefined>)) {
      if (!itemId) continue;
      const itemType = (heartbeat.items as Record<string, { type?: string }>)[itemId]?.type;
      if (itemType && isHarvestWeaponType(itemType)) continue;
      lastEquipment[slot] = itemId;
    }
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
    // Quest turn-in items need to stay in pocket (not deposited, not sold, not
    // auto-withdrawn-to-sell).
    const rawQuestsForProtection = (player.quests ?? {}) as QuestMap;
    const questTurnInItems = findQuestTurnInRequiredItemIds(rawQuestsForProtection);
    const pendingQuestTurnInItems = findPendingQuestTurnInItems(
      rawQuestsForProtection,
      player.inventory ?? {},
    );
    const atHome = recoveringAtHome || idlingAtHome || finishingHomeChores;

    // The upgrade target we'd craft next from combined (storage + pocket) inventory.
    // Drives deposit exclusion and the withdraw-for-craft override below — not
    // location-gated, since withdrawing just needs a nearby banker (checked
    // downstream in homeChores), not being at home.
    const activeCraft = findCraftableTarget(upgradeTargets, combinedInventory, recipesArray, availableStationTypes);
    // Display-only — no inventory or withdraw impact (risk of death loss).
    const nextCraftTarget = activeCraft ?? findNextCraftTarget(upgradeTargets);

    const missingHarvestTools = getMissingHarvestToolIds(
      (player.equipment ?? {}) as Record<string, string | null | undefined>,
      combinedInventory,
      heartbeat.items as Record<string, { type?: string }>,
    );
    // All required-tool IDs in the full recipe chain for missing harvest tools
    // (e.g. stoneCarvingKnife, stoneCutterTools). These are prerequisites that
    // must be owned before harvest tools can be crafted.
    const harvestChainToolIds = missingHarvestTools.length > 0
      ? collectHarvestCraftingChainToolIds(missingHarvestTools, recipesArray, knownStationTypes)
      : [];
    // Missing chain tools that have a craftable recipe (known station type, if any) — prepended
    // to the craft target list so they're tried before the harvest tools themselves.
    const missingCraftableChainTools = harvestChainToolIds.filter(id =>
      (combinedInventory[id] ?? 0) < 1 &&
      recipesArray.some(r => id in (r.output ?? {}) && isRecipeAvailable(r, knownStationTypes)),
    );
    // Craftable input ingredients we're short on (e.g. pinewoodAxeHandle for
    // stoneFellingAxe). These live in recipe.input, not recipe.required, so they
    // don't appear in harvestChainToolIds. Computed in dependency order so
    // sub-ingredients sort before the items that need them.
    const craftableInputIngredients = collectCraftableInputIngredients(
      [...missingHarvestTools, ...harvestChainToolIds],
      combinedInventory,
      recipesArray,
      knownStationTypes,
    );
    // Full craft target list: required-tool prerequisites → craftable input
    // ingredients → harvest tools themselves.
    const allToolCraftTargets = Array.from(new Set([
      ...missingCraftableChainTools,
      ...craftableInputIngredients,
      ...missingHarvestTools,
    ]));

    // Quantity bound for chain-protected materials: how many of each ingredient
    // the equipment upgrades, equipped-gear recovery, and harvest tool chains
    // actually consume. Anything beyond this is surplus we may sell. Without a
    // bound, protected ingredients (e.g. ratPelt for lightLeather) accumulate
    // in storage forever, and the storage fee grows with the hoard until the
    // fee buffer exceeds total wealth and locks every coin.
    const chainTargets = [
      ...upgradeTargets.filter(t => t.recipe).map(t => t.itemId),
      ...Object.values(lastEquipment).filter((id): id is string => !!id),
      ...allToolCraftTargets,
    ];
    const chainKeepNeeds = computeChainNeeds(chainTargets, recipesArray, combinedInventory);
    // Fallback bound for protected tools outside any currently active chain
    // (see TOOL_KEEP_CAP) — e.g. a harvest-tool prerequisite like
    // stoneCutterTools once its axe/pickaxe is already owned and it has
    // dropped out of allToolCraftTargets entirely. Without this, such a tool
    // has no chainKeepNeeds entry, stays in protectedItems via toolItemIds,
    // and hoards indefinitely no matter how many are obtained (e.g. from a
    // quest reward the server doesn't even list, so nothing else would flag
    // it). A genuine higher active need always wins (Math.max).
    for (const id of Array.from(toolItemIds ?? [])) {
      chainKeepNeeds[id] = Math.max(chainKeepNeeds[id] ?? 0, TOOL_KEEP_CAP);
    }
    // Raw resource items (no recipe produces them — e.g. copperOre,
    // pinewoodLog) that the active craft/tool chain is actually short on right
    // now. Drives need-aware harvest targeting below: which specific node
    // (by treeType/oreType) to walk to, instead of just the nearest one the
    // equipped tool can work regardless of what it yields.
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
    // Resolve the tool for the *specific* harvestTarget chosen above — keyed
    // off that object's own type (tree/miningNode), not the whole
    // neededHarvestItems set. getHarvestableTarget's needed-item search no
    // longer requires the currently-equipped weapon to match, so harvestTarget
    // can legitimately be a node the bot has no matching tool for at all; the
    // harvestTarget branch in decide() uses harvestToolReady/harvestToolToEquip
    // to equip the right tool, or refuse to harvest, rather than assuming a
    // generic neededHarvestItems-wide guess lines up with this exact node.
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
    // The needed tool sitting in storage instead of pocket — e.g. previously
    // crafted/bought then auto-deposited home. Without this, a tool stuck in
    // storage is invisible to resolveHarvestToolForTarget (pocket-only) and
    // never comes back out, so the bot never carries it and never harvests
    // what it's needed for.
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

    // toolToCraftFromStorage: what we'd craft next if all storage items were in pocket.
    // Used for deposit exclusion and storage withdrawal — keeps ingredients
    // safe. Not location-gated; withdrawal only needs a nearby banker
    // (checked downstream in homeChores).
    const toolToCraftFromStorage = allToolCraftTargets.length > 0
      ? findCraftableFromList(allToolCraftTargets, combinedInventory, recipesArray, availableStationTypes)
      : null;

    // Protect all ingredients needed for the full active craft — including the
    // parent recipe's inputs when activeCraft is a sub-step (tier 0).  Without
    // this, the parent's ingredients (e.g. stone needed for leatherChest) get
    // deposited while we're busy pre-crafting an intermediate (leather), then
    // re-withdrawn, causing a wasted round-trip every craft cycle.
    const activeCraftParent = activeCraft?.tier === 0
      ? upgradeTargets.find(t => t.recipe && t.slot === activeCraft.slot) ?? null
      : null;
    // Display-only: when activeCraft is a sub-step (e.g. lightLeather), the
    // dashboard should keep highlighting the ultimate goal (e.g.
    // lightLeatherHelm) as "next", with the sub-step itself surfaced
    // separately — otherwise the NEXT badge disappears from the real target
    // for however many ticks it takes to work through its ingredient chain.
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

    // Shared "don't give this up" set — chain-protected items (equipped gear,
    // ingredients, harvest tool chain) plus quest turn-in items. Used both for
    // selling and for the emergency drop below (findHeaviestInventoryItem).
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

    // Compute what to deposit: spare coins + keepItems currently in inventory,
    // excluding items needed for the active craft so they aren't deposited then
    // immediately re-withdrawn, and excluding quantities the sell plan is about
    // to sell (depositing them would bounce surplus between pocket and storage).
    const invRecord = (player.inventory ?? {}) as Record<string, number>;
    const toDeposit: Partial<Record<string, number>> = {};
    if (playerCoins > COINS_TO_KEEP) {
      toDeposit.copperCoin = playerCoins - COINS_TO_KEEP;
    }
    for (const [itemId, qty] of Object.entries(invRecord)) {
      if (itemId === 'copperCoin' || qty <= 0) continue;
      if (!(itemId in chainKeepNeeds) || activeCraftItems.has(itemId) || questTurnInItems.has(itemId)) continue;
      // Harvest tools (fellingAxe/pickaxe) must stay in pocket to ever get
      // equipped — chainKeepNeeds only protects them from being sold
      // (TOOL_KEEP_CAP), it isn't a "these belong in storage" signal. Without
      // this, a freshly crafted/bought pickaxe gets banked away on the next
      // home visit and resolveHarvestToolForTarget (pocket-only) never sees
      // it again; findHarvestToolToWithdraw (src/harvest.ts) recovers one already
      // stuck there, but the goal is to not put it there in the first place.
      const toolType = (heartbeat.items as Record<string, { type?: string }>)[itemId]?.type;
      if (toolType && isHarvestWeaponType(toolType)) continue;
      const beingSold = sellOpportunity?.items[itemId] ?? 0;
      // Don't deposit more than the chain keep target needs. Surplus stays in
      // pocket where it can be sold directly instead of cycling through storage.
      const alreadyStored = ((heartbeat.player.storage ?? {}) as Record<string, number>)[itemId] ?? 0;
      const roomInStorage = Math.max(0, (chainKeepNeeds[itemId] ?? 0) - alreadyStored);
      const depositQty = Math.min(qty - beingSold, roomInStorage);
      if (depositQty > 0) toDeposit[itemId] = depositQty;
    }
    const heaviestInventoryItem = isEncumbered
      ? findHeaviestInventoryItem(player.inventory ?? {}, heartbeat.items, protectedItems)
      : null;

    // Compute storage fee buffer for withdrawal calculations.
    const storageRecord = heartbeat.player.storage ?? {};
    const storageCoins = typeof storageRecord.copperCoin === 'number' ? storageRecord.copperCoin : 0;
    const {
      feePerCharge,
      minCoins: minStorageCoins,
      availableWithdrawal: availableStorageWithdrawal,
    } = getStorageFeeInfo(storageRecord, heartbeat.items as unknown as ItemMap, STORAGE_FEE_BUFFER);

    // Build per-merchant buy baskets using effective coins (pocket + storage beyond fee buffer).
    const effectiveCoins = playerCoins + availableStorageWithdrawal;

    // Quest turn-in items we can actually act on: already in storage, or sold
    // by a merchant we've seen (remembered stock — the merchant may be out of
    // sight right now) at a price we can cover. Items with no acquisition path
    // (e.g. feathers for a kill quest, with no seller) must not pin the bot at
    // home via hasChores or block the harvest-tool quest cycle below.
    const actionablePendingQuestItems: Partial<Record<string, number>> = {};
    for (const [itemId, shortfall] of Object.entries(pendingQuestTurnInItems)) {
      const inStorage = (storageRec[itemId] ?? 0) > 0;
      const offer = rememberedMerchantSelling[itemId];
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
        // Directly buy purchasable chain tools (e.g. stoneCutterTools) that have no
        // craftable recipe — computeCraftIngredientsToBuyFromMerchant handles them
        // recursively via gatherNeeded, but also include them explicitly here so they
        // appear in the buy basket even when coins are tight.
        for (const chainToolId of harvestChainToolIds) {
          if ((combinedInventory[chainToolId] ?? 0) >= 1 || basket[chainToolId]) continue;
          if (recipesArray.some(r => chainToolId in (r.output ?? {}) && isRecipeAvailable(r, knownStationTypes))) continue;
          const offer = selling[chainToolId];
          if (offer && offer.quantity > 0 && offer.price > 0 && offer.price <= effectiveCoins) {
            basket[chainToolId] = 1;
          }
        }
        // Buy missing quest turn-in items if this merchant sells them.
        // Quest items are bought ON TOP of whatever the craft pass already added —
        // do NOT subtract inBasket from the shortfall. A prior pass may have
        // added 1 pinewoodLog for an axe handle craft, but the quest also needs
        // its own log. Subtracting inBasket would cause the quest to take the
        // craft's log and the craft would never get one.
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

    // Not location-gated — may need to switch weapons/gear whenever mining or
    // fighting something, not just at home.
    const gearToEquip = findGearToEquip({
      inventory: player.inventory ?? {},
      equipment: (player.equipment ?? {}) as Record<string, string | null | undefined>,
      items: heartbeat.items as unknown as ItemMap,
    });

    // Craft execution is gated by safety, not location: station proximity is
    // already required internally (via availableStationTypes/isRecipeAvailable),
    // so the only additional gate needed is "not mid-combat" — if we can
    // finish crafting, do it and wear/use it now.
    //
    // Deliberately does NOT re-run findCraftableTarget/findCraftableFromList
    // against pocket-only inventory: that re-derives a fresh answer from
    // scratch, and isFullyAchievableFromInventory's required-tool check
    // (src/craft.ts) demands the *final* recipe's tool already be in pocket —
    // which stalls every intermediate sub-step (e.g. crafting lightLeather
    // from rat pelts) whenever that tool is sitting in storage, since the
    // tool isn't withdrawn until the last step actually needs it. Instead,
    // reuse activeCraft/toolToCraftFromStorage (already computed against
    // combinedInventory, so storage-only tools/ingredients count toward
    // reachability) and only check that *this* sub-step's own ingredients are
    // in pocket right now — the withdraw branches above pull them in first.
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
      // combinedInventory (storage + pocket), not player.inventory alone —
      // otherwise depositing an ingredient makes the dashboard show it as
      // freshly missing even though it's still owned and will be withdrawn
      // when needed.
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
    // Must be before hasChores so quest state can gate finishingHomeChores.
    // Must be before withdrawal overrides so sell-withdrawal doesn't fire
    // while the quest NPC is visible, moving the bot away before re-accept.
    const activeQuests = rawQuestsForProtection;
    // quest.start_npc/end_npc are raw SDK unit ids, not display names.
    // recordQuestEndNpc resolves start_npc_id from the existing quests row
    // (written correctly, by name, at sighting time) rather than re-deriving
    // identity from the id. end_npc has no prior row to fall back on, so its
    // name is resolved here via findTurnInNpc against this tick's visible
    // NPCs; null (left untouched) when the turn-in NPC isn't currently
    // visible. Update-only (see recordQuestEndNpc), so unconditional every
    // tick is safe: a no-op for any quest never seen as an AvailableQuest sighting.
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
    // Items the craft chains still need — quests rewarding one of these (e.g.
    // wood_for_stone → stone) must outrank filler quests, or the bot fills its
    // quest slots with junk right after a turn-in and the stone loop dies.
    // Use gross needs (not netted) so that selling existing stock doesn't make
    // an item look "no longer needed" and restart a quest/buy loop to get more.
    const questNeededItems = new Set(
      Object.entries(chainKeepNeeds)
        .filter(([itemId, need]) => (combinedInventory[itemId] ?? 0) < need)
        .map(([itemId]) => itemId),
    );
    // An item is stocked when combined inventory covers the full gross chain
    // need. TOOL_KEEP_CAP is already baked into chainKeepNeeds for tools, so
    // no separate floor is needed here.
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

    // Drop a stalled quest (turn-in items with no known source) to free a slot
    // for a quest that's actually useful right now. Only fires when capacity
    // is genuinely the bottleneck and something needed is waiting on it —
    // never abandon just to make room for more filler.
    const atQuestCapacity = Object.keys(activeQuests).length >= maxActiveQuests;
    const stalledActiveQuests = atQuestCapacity
      ? findStalledQuests(activeQuests, player.inventory ?? {}, new Set(stalledQuestItems))
      : [];
    const bestAvailableQuest = atQuestCapacity && stalledActiveQuests.length > 0
      ? findBestAvailableQuest(questGivers, activeQuests, { neededItems: questNeededItems, stockedItems: questStockedItems, chainItemIds: new Set(Object.keys(chainKeepNeeds)) })
      : null;
    const questToAbandon = findQuestToAbandon(stalledActiveQuests, atQuestCapacity, bestAvailableQuest, questNeededItems);
    if (questToAbandon) tickExtras.questToAbandon = { questId: questToAbandon.id, blockedQuestId: bestAvailableQuest?.quest.id };

    // Drain the whole quest log, one per tick, when the user disabled quest
    // pursuit from the dashboard — distinct from questToAbandon above (which
    // only ever drops a single stalled quest to free capacity for a better one).
    const questToDismiss: string | null = pursueQuestsEnabled ? null : (findQuestToDismiss(activeQuests)?.id ?? null);
    if (questToDismiss) tickExtras.questToDismiss = { questId: questToDismiss };

    // Update NPC position memory whenever a quest NPC we have business with is
    // actually visible. Used below to close the distance when they're not.
    const questNpcInRange = completableQuest?.npc ?? questToAccept?.npc ?? null;
    if (questNpcInRange && isFinitePosition(questNpcInRange.position)) {
      lastQuestNpcPosition = questNpcInRange.position as { x: number; y: number };
    }
    // Give up on the remembered spot once we've closed to arrival distance and
    // still have no visible NPC to act on — otherwise a stale or imprecise
    // memory strands the bot walking into the same empty spot forever (see
    // "No chase-to-NPC" postmortem in CONTEXT.md).
    if (
      lastQuestNpcPosition !== null &&
      questNpcInRange === null &&
      distanceBetween(playerPosition, lastQuestNpcPosition) < QUEST_NPC_ARRIVAL_RADIUS
    ) {
      lastQuestNpcPosition = null;
    }
    // When to close the distance toward the remembered NPC position:
    // 1. We have a completable quest (items in pocket) but the NPC is out of sight.
    // 2. We need to re-accept a quest for harvest tools, have spare quest
    //    capacity to do so, and have no other pending home tasks.
    // Only actionable turn-in items block case 2: an unfulfillable quest (e.g.
    // feathers nobody sells) must not stop the bot from walking back to the
    // quest giver to re-accept the stone quest.
    const needQuestForHarvestTools =
      missingHarvestTools.length > 0 &&
      Object.keys(activeQuests).length < maxActiveQuests &&
      Object.keys(actionablePendingQuestItems).length === 0 &&
      questToAccept === null &&
      upgradesPlan.length === 0 &&
      toolToCraft === null &&
      toolToCraftFromStorage === null;
    // Not location-gated — go to the quest NPC to turn in/re-accept wherever
    // it is, not just when already at home.
    const questNpcTarget: { x: number; y: number } | null =
      lastQuestNpcPosition !== null &&
        (completableQuestResult !== null || needQuestForHarvestTools)
        ? lastQuestNpcPosition
        : null;
    if (questNpcTarget) tickExtras.navigatingToQuestNpc = { position: questNpcTarget };

    // Clear finishingHomeChores once healthy, back at home base, and all tasks done.
    // The position check is critical: HP can heal en route while the merchant is still
    // out of range, which would make upgradesPlan appear empty — a false "no tasks".
    //
    // pendingQuestTurnInItems: we still need to buy/withdraw and turn in quest items.
    // These may not show in upgradesPlan (no visible merchant this tick) but keeping
    // finishingHomeChores alive ensures the bot stays home to complete the cycle next tick.
    const nearHome = distanceBetween(playerPosition, HOME_POSITION) < HOME_CHORES_CLEAR_RADIUS;
    if (finishingHomeChores && !recoveringAtHome && playerHp >= maxHp && nearHome) {
      const hasChores =
        gearToEquip !== null ||
        recipeToCraft !== null ||
        toolToCraft !== null ||
        // toolToCraftFromStorage covers the one-tick gap where ingredients are still in
        // storage and toolToCraft (pocket-only) is null. Without this, finishingHomeChores
        // clears the moment a craft completes and the next item's ingredients haven't been
        // withdrawn yet, breaking the chain.
        toolToCraftFromStorage !== null ||
        activeCraft !== null ||
        // A needed harvest tool is still in storage — stay home until it's
        // withdrawn, otherwise the bot leaves before it's carried.
        harvestToolToWithdraw !== null ||
        upgradesPlan.length > 0 ||
        // Only actionable turn-in items count as a chore. A quest needing items
        // with no acquisition path (nobody sells them, none in storage) must not
        // pin the bot at home forever — leaving lets it hunt/harvest, which is
        // usually how those items are obtained anyway.
        Object.keys(actionablePendingQuestItems).length > 0 ||
        // Sellable surplus in the pocket is a chore: finish the sale before
        // wandering off encumbered.
        sellOpportunity !== null ||
        // Keep alive during the quest cycle window: if there's a quest to turn
        // in or accept right now (NPC visible), we're mid-cycle and should not
        // clear until the quest action fires next tick.
        completableQuest !== null ||
        questToAccept !== null ||
        questToAbandon !== null ||
        // questNpcTarget means we're closing the distance on a quest NPC to
        // turn in or accept. It self-clears on arrival-without-resolution
        // (QUEST_NPC_ARRIVAL_RADIUS), so this can't hold chores open forever.
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
    // Only when at home with nothing better to do and not in a quest cycle.
    // !depositOverride: don't clobber a pending manual dashboard deposit.
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
          // Not part of any active chain at all — withdraw unconditionally.
          withdrawUpTo(itemId, qty);
          continue;
        }
        // Keep the gross chain need in storage; only withdraw the true surplus.
        // Using gross (not netted) needs avoids selling stock that the chain
        // still requires, which would restart quest/buy loops to replace it.
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
    // "explore"/"return-home-idle"/"return-home-recover" are decide()'s
    // "nothing left to do" outputs — deposit as the last thing once chores
    // are truly finished, not narrower than that. "return-home-overloaded" is
    // included too: decide()'s isEncumbered branch (checked before the
    // finishingHomeChores homeChores() branch) keeps returning that decision
    // for as long as isEncumbered is true, which stays true until a deposit
    // actually happens — without it here, an overloaded bot with nothing
    // sellable would arrive home and idle forever instead of depositing.
    if (atHome && nearbyBanker
      && (decision.type === "explore" || decision.type === "return-home-idle" || decision.type === "return-home-recover" || decision.type === "return-home-overloaded")
      && Object.keys(toDeposit).length > 0) {
      decision = { type: "deposit", items: toDeposit, banker: nearbyBanker };
      tickExtras.autoDeposit = { items: toDeposit, banker: nearbyBanker.id };
    }

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
      if (d.type === "abandonQuest") return "abandonQuest";
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
