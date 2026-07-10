import type Database from 'better-sqlite3';
import { UNIT_TYPE, NPC_TYPE } from 'programming-game/types';
import type { ClientSideUnit, ClientSideNPC, ClientSideMonster, GameObject, Position } from 'programming-game/types';
import { isFinitePosition, distanceBetween } from './utils';
import {
  recordResourceSighting,
  recordMonsterSighting,
  recordNpcSighting,
  recordMerchantTrades,
  recordQuestSighting,
  getKnownStationTypes,
  getKnownLootItems,
  getKnownQuestRewardItems,
  ASSUMED_SIGHT_RANGE,
} from './memory';
import type { AvailableQuest } from './memory';

// Perception/recall layer: turns the current heartbeat plus memory.ts reads
// into "what we currently know" — no target selection, no craft/buy/attack
// decisions. Every function here is stateless; index.ts calls them explicitly
// each tick and threads the results down, same as it does for craft.ts/
// equipment.ts/harvest.ts. Deliberate, narrow exception to the "no module but
// index.ts imports memory.ts" rule — see CLAUDE.md's src/knowledge.ts entry.

export type GameObjectScanResult = {
  treesFound: Array<{ id: string; treeType: string; pos: { x: number; y: number } }>;
  miningNodesFound: Array<{ id: string; oreType: string; pos: { x: number; y: number } }>;
  stationsFound: Array<{ id: string; stationType: string; stationSubtype: string; pos: { x: number; y: number } }>;
  portalsFound: Array<{ id: string; pos: { x: number; y: number } }>;
  hazardsFound: Array<{ id: string; pos: { x: number; y: number } }>;
};

/**
 * Single pass over every game object: records its sighting into memory and
 * buckets it by type for tick logging. Covers all five GameObjectTypes —
 * recordResourceSighting treats them all uniformly (portals/hazards fall
 * through its `default` case as a plain resource sighting keyed by object.type).
 */
export const scanGameObjects = (
  db: Database.Database,
  gameObjects: Record<string, GameObject>,
  now: number,
): GameObjectScanResult => {
  const treesFound: GameObjectScanResult['treesFound'] = [];
  const miningNodesFound: GameObjectScanResult['miningNodesFound'] = [];
  const stationsFound: GameObjectScanResult['stationsFound'] = [];
  const portalsFound: GameObjectScanResult['portalsFound'] = [];
  const hazardsFound: GameObjectScanResult['hazardsFound'] = [];
  for (const obj of Object.values(gameObjects)) {
    if (!isFinitePosition(obj.position)) continue;
    if (obj.type === 'tree') {
      treesFound.push({ id: obj.id, treeType: obj.treeType, pos: obj.position });
    } else if (obj.type === 'miningNode') {
      miningNodesFound.push({ id: obj.id, oreType: obj.oreType, pos: obj.position });
    } else if (obj.type === 'station') {
      stationsFound.push({ id: obj.id, stationType: obj.stationType, stationSubtype: obj.stationSubtype, pos: obj.position });
    } else if (obj.type === 'portal') {
      portalsFound.push({ id: obj.id, pos: obj.position });
    } else if (obj.type === 'hazard') {
      hazardsFound.push({ id: obj.id, pos: obj.position });
    }
    recordResourceSighting(db, obj, ASSUMED_SIGHT_RANGE, now);
  }
  return { treesFound, miningNodesFound, stationsFound, portalsFound, hazardsFound };
};

/** Nearest live hunt-target monster from an already-collected monster list (see scanUnits). */
export const findNearbyHuntTarget = (
  monsters: readonly ClientSideMonster[],
  playerPosition: Position,
  huntTargets: readonly string[],
): { unit: ClientSideMonster; distance: number } | undefined =>
  monsters
    .filter(
      (unit) =>
        huntTargets.includes(String(unit.race)) &&
        (typeof unit.hp !== "number" || unit.hp > 0),
    )
    .map((unit) => ({
      unit,
      distance: distanceBetween(playerPosition, unit.position as { x: number; y: number }),
    }))
    .sort((a, b) => a.distance - b.distance)[0];

/**
 * Nearest live monster within threatRadius that isn't in passiveRaces, from an
 * already-collected monster list (see scanUnits). Not gated on hunting —
 * monstersFound is collected every tick regardless of hunting state.
 */
export const findNearbyThreat = (
  monsters: readonly ClientSideMonster[],
  playerPosition: Position,
  passiveRaces: readonly string[],
  threatRadius: number,
): ClientSideMonster | undefined =>
  monsters.find(
    (unit) =>
      !passiveRaces.includes(String(unit.race)) &&
      (typeof unit.hp !== "number" || unit.hp > 0) &&
      distanceBetween(playerPosition, unit.position as { x: number; y: number }) < threatRadius,
  );

export type UnitScanResult = {
  visibleNpcs: ClientSideNPC[];
  visibleMerchants: Array<{ unit: ClientSideUnit; selling: Record<string, { price: number; quantity: number } | undefined>; buying: Record<string, { price: number; quantity: number } | undefined> }>;
  visibleBankers: ClientSideUnit[];
  /** Selling offers from merchants visible this scan only, not merged with persisted memory. */
  visibleMerchantSelling: Record<string, { price: number; quantity: number } | undefined>;
  monstersFound: ClientSideMonster[];
};

/**
 * Single pass over every visible unit, whatever its type: monsters are
 * recorded and collected into monstersFound, so findNearbyMonster/
 * findHuntScanResult can filter that instead of each re-scanning the full
 * units record. NPCs are recorded, with merchants additionally recording
 * trades and any NPC's quest offers recorded the same way regardless of role.
 */
export const scanUnits = (
  db: Database.Database,
  units: Record<string, ClientSideUnit>,
  now: number,
): UnitScanResult => {
  const visibleNpcs: ClientSideNPC[] = [];
  const visibleMerchants: UnitScanResult['visibleMerchants'] = [];
  const visibleBankers: ClientSideUnit[] = [];
  const monstersFound: ClientSideMonster[] = [];
  const visibleMerchantSelling: Record<string, { price: number; quantity: number } | undefined> = {};

  for (const unit of Object.values(units)) {
    if (!isFinitePosition(unit.position)) continue;

    if (unit.type === UNIT_TYPE.monster) {
      const monster = unit as ClientSideMonster;
      monstersFound.push(monster);
      recordMonsterSighting(db, monster, ASSUMED_SIGHT_RANGE, now);
      continue;
    }

    if (unit.type !== UNIT_TYPE.npc) continue;
    const npc = unit as unknown as ClientSideNPC;
    visibleNpcs.push(npc);
    const npcType = (unit as { npcType?: string }).npcType;

    // Every NPC gets exactly one sighting call, regardless of role.
    recordNpcSighting(db, npc, ASSUMED_SIGHT_RANGE, now);

    if (npcType === NPC_TYPE.merchant) {
      const selling = ((unit as any).trades?.selling ?? {}) as Record<string, { price: number; quantity: number } | undefined>;
      const buying = ((unit as any).trades?.buying ?? {}) as Record<string, { price: number; quantity: number } | undefined>;
      visibleMerchants.push({ unit, selling, buying });
      Object.assign(visibleMerchantSelling, selling);
      recordMerchantTrades(db, npc, now);
    } else if (npcType === NPC_TYPE.banker) {
      visibleBankers.push(unit);
    }

    // Every NPC's quest offers are recorded the same way, regardless of role.
    if (npc.availableQuests) {
      for (const quest of Object.values(npc.availableQuests) as AvailableQuest[]) {
        recordQuestSighting(db, npc.name, quest, now);
      }
    }
  }

  return { visibleNpcs, visibleMerchants, visibleBankers, visibleMerchantSelling, monstersFound };
};

export const findNearbyBanker = (
  visibleBankers: ClientSideUnit[],
  playerPosition: Position,
): ClientSideUnit | undefined =>
  visibleBankers
    .map((unit) => ({
      unit,
      distance: distanceBetween(playerPosition, unit.position as { x: number; y: number }),
    }))
    .sort((a, b) => a.distance - b.distance)[0]?.unit;

/** Nearest live monster from an already-collected monster list (see scanUnits). */
export const findNearbyMonster = (
  monsters: readonly ClientSideMonster[],
  playerPosition: Position,
): { unit: ClientSideMonster; distance: number } | undefined =>
  monsters
    .filter(
      (unit) =>
        // Exclude dead monsters — the server keeps them in units briefly
        // after death. Attacking a dead target is silently rejected, causing
        // the bot to stand idle with a stale attack intent.
        (typeof unit.hp !== "number" || unit.hp > 0),
    )
    .map((unit) => ({
      unit,
      distance: distanceBetween(playerPosition, unit.position as { x: number; y: number }),
    }))
    .sort((left, right) => left.distance - right.distance)[0];

/** Merges storage + inventory by summing quantities, so items deposited mid-chain stay visible for planning. */
export const computeCombinedInventory = (
  storage: Record<string, number> | undefined,
  inventory: Record<string, number> | undefined,
): Partial<Record<string, number>> => {
  const combinedInventory: Partial<Record<string, number>> = {};
  for (const source of [storage, inventory]) {
    if (!source) continue;
    for (const [itemId, qty] of Object.entries(source)) {
      if (typeof qty === 'number' && qty > 0) {
        combinedInventory[itemId] = (combinedInventory[itemId] ?? 0) + qty;
      }
    }
  }
  return combinedInventory;
};

/**
 * Augments an inventory with active quest reward items (qty=1 each if not
 * already owned) so canObtainChain treats quest-rewarded items as reachable
 * during upgrade/craft planning, even before the quest is turned in.
 */
export const computePlanningInventory = (
  combinedInventory: Partial<Record<string, number>>,
  questRewards: Record<string, { items: Record<string, number> }>,
): Partial<Record<string, number>> => {
  const planningInventory: Partial<Record<string, number>> = { ...combinedInventory };
  for (const reward of Object.values(questRewards)) {
    for (const itemId of Object.keys(reward.items ?? {})) {
      if ((planningInventory[itemId] ?? 0) === 0) planningInventory[itemId] = 1;
    }
  }
  return planningInventory;
};

/**
 * Station knowledge for stabilizing upgrade-plan reachability across location:
 * knownStationTypes (persisted memory) governs "obtainable in principle" so the
 * plan doesn't flicker with visibility — see src/plan.ts's isRecipeAvailable
 * and the knownStationTypes/availableStationTypes split documented there.
 * extraKnownLootItems lets index.ts fold in KNOWN_HARVESTABLE_ITEMS (owned by
 * src/harvest.ts) without knowledge.ts importing a peer domain module.
 */
export const getKnownSets = (
  db: Database.Database,
  extraKnownLootItems: readonly string[] = [],
): { knownStationTypes: ReadonlySet<string>; knownLootItems: ReadonlySet<string>; knownQuestRewardItems: ReadonlySet<string> } => ({
  knownStationTypes: new Set(getKnownStationTypes(db)),
  knownLootItems: new Set([...getKnownLootItems(db), ...extraKnownLootItems]),
  knownQuestRewardItems: new Set(getKnownQuestRewardItems(db)),
});
