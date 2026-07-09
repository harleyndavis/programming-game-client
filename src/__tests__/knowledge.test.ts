import { describe, it, expect } from 'vitest';
import { Monsters } from 'programming-game/monsters';
import { UNIT_TYPE, NPC_TYPE, RACE } from 'programming-game/types';
import type { ClientSideUnit, ClientSideMonster, GameObject } from 'programming-game/types';
import {
  openMemoryDb,
  getEntity,
  getSafeLocations,
  getQuestSighting,
  recordHarvest,
  recordLoot,
  recordQuestSighting,
} from '../memory';
import type { AvailableQuest } from '../memory';
import {
  scanGameObjects,
  findNearbyHuntTarget,
  findNearbyThreat,
  scanUnits,
  findNearbyBanker,
  findNearbyMonster,
  computeCombinedInventory,
  computePlanningInventory,
  getKnownSets,
} from '../knowledge';

const makeMonster = (overrides: Partial<any> = {}): ClientSideMonster =>
  ({
    id: 'mon-1',
    type: UNIT_TYPE.monster,
    monsterId: Monsters.rat,
    name: 'Rat',
    race: RACE.rat,
    hp: 12,
    position: { x: 10, y: 0 },
    ...overrides,
  }) as unknown as ClientSideMonster;

const makeMerchantNpc = (overrides: Partial<any> = {}): ClientSideUnit =>
  ({
    id: 'npc-1',
    type: UNIT_TYPE.npc,
    npcType: NPC_TYPE.merchant,
    name: 'Wandering Trader',
    position: { x: 5, y: 5 },
    trades: {
      wants: {},
      offers: {},
      buying: {},
      selling: { copperIngot: { price: 10, quantity: 20 } },
    },
    availableQuests: {},
    ...overrides,
  }) as unknown as ClientSideUnit;

const makeBankerNpc = (overrides: Partial<any> = {}): ClientSideUnit =>
  ({
    id: 'npc-2',
    type: UNIT_TYPE.npc,
    npcType: NPC_TYPE.banker,
    name: 'Bank Teller',
    position: { x: 1, y: 1 },
    trades: { wants: {}, offers: {}, buying: {}, selling: {} },
    availableQuests: {},
    ...overrides,
  }) as unknown as ClientSideUnit;

const makeTree = (overrides: Partial<any> = {}): GameObject =>
  ({ id: 'tree-1', type: 'tree', treeType: 'pine', label: 'Pine Tree', radius: 1, position: { x: 20, y: 30 }, ...overrides }) as GameObject;

const makeMiningNode = (overrides: Partial<any> = {}): GameObject =>
  ({ id: 'node-1', type: 'miningNode', oreType: 'copper', label: 'Copper Node', radius: 1, position: { x: 80, y: 10 }, ...overrides }) as GameObject;

const makeStation = (overrides: Partial<any> = {}): GameObject =>
  ({ id: 'station-1', type: 'station', stationType: 'smithing', stationSubtype: 'anvil', facing: 0, label: 'Anvil', radius: 1, position: { x: 40, y: 50 }, ...overrides }) as GameObject;

const makePortal = (overrides: Partial<any> = {}): GameObject =>
  ({ id: 'portal-1', type: 'portal', label: 'Portal', radius: 1, position: { x: 60, y: 60 }, ...overrides }) as GameObject;

const makeHazard = (overrides: Partial<any> = {}): GameObject =>
  ({ id: 'hazard-1', type: 'hazard', label: 'Hazard', radius: 1, position: { x: 70, y: 70 }, ...overrides }) as GameObject;

const availableQuest: AvailableQuest = {
  repeatable: false,
  id: 'q1',
  name: 'Rat Extermination',
  steps: [{ type: 'kill', targets: { [Monsters.rat]: 5 } }],
  rewards: { items: { stone: 10 } },
} as unknown as AvailableQuest;

describe('scanGameObjects', () => {
  it('buckets each game object by type', () => {
    const db = openMemoryDb(':memory:');
    const tree = makeTree();
    const node = makeMiningNode();
    const station = makeStation();
    const portal = makePortal();
    const hazard = makeHazard();
    const result = scanGameObjects(
      db,
      { [tree.id]: tree, [node.id]: node, [station.id]: station, [portal.id]: portal, [hazard.id]: hazard },
      1000,
    );
    expect(result.treesFound).toEqual([{ id: 'tree-1', treeType: 'pine', pos: tree.position }]);
    expect(result.miningNodesFound).toEqual([{ id: 'node-1', oreType: 'copper', pos: node.position }]);
    expect(result.stationsFound).toEqual([{ id: 'station-1', stationType: 'smithing', stationSubtype: 'anvil', pos: station.position }]);
    expect(result.portalsFound).toEqual([{ id: 'portal-1', pos: portal.position }]);
    expect(result.hazardsFound).toEqual([{ id: 'hazard-1', pos: hazard.position }]);
    db.close();
  });

  it('records a sighting for every object, including portals/hazards via the default case', () => {
    const db = openMemoryDb(':memory:');
    const portal = makePortal();
    scanGameObjects(db, { [portal.id]: portal }, 1000);
    expect(getEntity(db, 'resource', 'portal')).not.toBeNull();
    db.close();
  });

  it('skips objects without a finite position', () => {
    const db = openMemoryDb(':memory:');
    const tree = makeTree({ position: { x: NaN, y: 0 } });
    const result = scanGameObjects(db, { [tree.id]: tree }, 1000);
    expect(result.treesFound).toEqual([]);
    db.close();
  });
});

describe('findNearbyHuntTarget', () => {
  const huntTargets = [RACE.rat, RACE.chicken];

  it('returns the nearest live monster whose race is a hunt target', () => {
    const far = makeMonster({ id: 'far', race: RACE.rat, position: { x: 100, y: 0 } });
    const near = makeMonster({ id: 'near', race: RACE.chicken, position: { x: 1, y: 0 } });
    const result = findNearbyHuntTarget([far, near], { x: 0, y: 0 }, huntTargets);
    expect(result?.unit.id).toBe('near');
  });

  it('ignores monsters whose race is not a hunt target', () => {
    const wolf = makeMonster({ race: RACE.wolf, position: { x: 1, y: 0 } });
    expect(findNearbyHuntTarget([wolf], { x: 0, y: 0 }, huntTargets)).toBeUndefined();
  });

  it('ignores dead hunt-target monsters', () => {
    const dead = makeMonster({ race: RACE.rat, hp: 0, position: { x: 1, y: 0 } });
    expect(findNearbyHuntTarget([dead], { x: 0, y: 0 }, huntTargets)).toBeUndefined();
  });

  it('returns undefined for an empty monster list', () => {
    expect(findNearbyHuntTarget([], { x: 0, y: 0 }, huntTargets)).toBeUndefined();
  });
});

describe('findNearbyThreat', () => {
  const passiveRaces = [RACE.rat, RACE.chicken];

  it('returns the nearest live monster not in passiveRaces within threatRadius', () => {
    const passive = makeMonster({ id: 'passive', race: RACE.rat, position: { x: 1, y: 0 } });
    const threat = makeMonster({ id: 'threat', race: RACE.wolf, position: { x: 2, y: 0 } });
    const result = findNearbyThreat([passive, threat], { x: 0, y: 0 }, passiveRaces, 10);
    expect(result?.id).toBe('threat');
  });

  it('ignores monsters outside threatRadius', () => {
    const wolf = makeMonster({ race: RACE.wolf, position: { x: 100, y: 0 } });
    expect(findNearbyThreat([wolf], { x: 0, y: 0 }, passiveRaces, 10)).toBeUndefined();
  });

  it('ignores dead monsters', () => {
    const wolf = makeMonster({ race: RACE.wolf, hp: 0, position: { x: 1, y: 0 } });
    expect(findNearbyThreat([wolf], { x: 0, y: 0 }, passiveRaces, 10)).toBeUndefined();
  });

  it('ignores passive-race monsters even within radius', () => {
    const rat = makeMonster({ race: RACE.rat, position: { x: 1, y: 0 } });
    expect(findNearbyThreat([rat], { x: 0, y: 0 }, passiveRaces, 10)).toBeUndefined();
  });
});

describe('scanUnits', () => {
  it('collects monsters into monstersFound and records their sighting', () => {
    const db = openMemoryDb(':memory:');
    const monster = makeMonster();
    const result = scanUnits(db, { [monster.id]: monster }, 1000);
    expect(result.monstersFound).toEqual([monster]);
    expect(getEntity(db, 'monster', Monsters.rat)).not.toBeNull();
    db.close();
  });

  it('collects merchants into visibleMerchants/visibleMerchantSelling and records trades', () => {
    const db = openMemoryDb(':memory:');
    const merchant = makeMerchantNpc();
    const result = scanUnits(db, { [merchant.id]: merchant }, 1000);
    expect(result.visibleNpcs).toEqual([merchant]);
    expect(result.visibleMerchants).toEqual([
      { unit: merchant, selling: (merchant as any).trades.selling, buying: (merchant as any).trades.buying },
    ]);
    expect(result.visibleMerchantSelling).toEqual((merchant as any).trades.selling);
    expect(getEntity(db, 'npc', 'Wandering Trader')).not.toBeNull();
    db.close();
  });

  it('collects bankers into visibleBankers without recording a safe location', () => {
    const db = openMemoryDb(':memory:');
    const banker = makeBankerNpc();
    const result = scanUnits(db, { [banker.id]: banker }, 1000);
    expect(result.visibleBankers).toEqual([banker]);
    expect(getSafeLocations(db)).toEqual([]);
    db.close();
  });

  it('records quest sightings for any NPC with available quests, regardless of role', () => {
    const db = openMemoryDb(':memory:');
    const npc = makeMerchantNpc({ availableQuests: { q1: availableQuest } });
    scanUnits(db, { [npc.id]: npc }, 1000);
    expect(getQuestSighting(db, npc.name, 'q1')).not.toBeNull();
    db.close();
  });

  it('skips units without a finite position', () => {
    const db = openMemoryDb(':memory:');
    const monster = makeMonster({ position: { x: NaN, y: 0 } });
    const result = scanUnits(db, { [monster.id]: monster }, 1000);
    expect(result.monstersFound).toEqual([]);
    db.close();
  });

  it('reports visibleMerchantSelling from this scan only, not merged with persisted memory', () => {
    const db = openMemoryDb(':memory:');
    const result = scanUnits(db, {}, 1000);
    expect(result.visibleMerchantSelling).toEqual({});
    db.close();
  });
});

describe('findNearbyBanker', () => {
  it('returns the nearest banker', () => {
    const far = makeBankerNpc({ id: 'far', position: { x: 100, y: 0 } });
    const near = makeBankerNpc({ id: 'near', position: { x: 1, y: 0 } });
    expect(findNearbyBanker([far, near], { x: 0, y: 0 })?.id).toBe('near');
  });

  it('returns undefined for an empty list', () => {
    expect(findNearbyBanker([], { x: 0, y: 0 })).toBeUndefined();
  });
});

describe('findNearbyMonster', () => {
  it('returns the nearest live monster', () => {
    const far = makeMonster({ id: 'far', position: { x: 100, y: 0 } });
    const near = makeMonster({ id: 'near', position: { x: 1, y: 0 } });
    expect(findNearbyMonster([far, near], { x: 0, y: 0 })?.unit.id).toBe('near');
  });

  it('excludes dead monsters', () => {
    const dead = makeMonster({ hp: 0, position: { x: 1, y: 0 } });
    expect(findNearbyMonster([dead], { x: 0, y: 0 })).toBeUndefined();
  });

  it('returns undefined for an empty list', () => {
    expect(findNearbyMonster([], { x: 0, y: 0 })).toBeUndefined();
  });
});

describe('computeCombinedInventory', () => {
  it('sums quantities across storage and inventory', () => {
    const result = computeCombinedInventory({ copperOre: 5 }, { copperOre: 3, ratPelt: 2 });
    expect(result).toEqual({ copperOre: 8, ratPelt: 2 });
  });

  it('handles undefined sources', () => {
    expect(computeCombinedInventory(undefined, { ratPelt: 2 })).toEqual({ ratPelt: 2 });
    expect(computeCombinedInventory({ ratPelt: 2 }, undefined)).toEqual({ ratPelt: 2 });
    expect(computeCombinedInventory(undefined, undefined)).toEqual({});
  });

  it('skips zero or negative quantities', () => {
    expect(computeCombinedInventory({ ratPelt: 0, stone: -1 }, {})).toEqual({});
  });
});

describe('computePlanningInventory', () => {
  it('adds qty=1 for an unowned quest reward item', () => {
    const result = computePlanningInventory({ ratPelt: 2 }, { q1: { items: { stone: 10 } } });
    expect(result).toEqual({ ratPelt: 2, stone: 1 });
  });

  it('does not override an already-owned quantity', () => {
    const result = computePlanningInventory({ stone: 5 }, { q1: { items: { stone: 10 } } });
    expect(result.stone).toBe(5);
  });

  it('does not mutate the input combinedInventory', () => {
    const combined = { ratPelt: 2 };
    computePlanningInventory(combined, { q1: { items: { stone: 10 } } });
    expect(combined).toEqual({ ratPelt: 2 });
  });
});

describe('getKnownSets', () => {
  it('reads knownStationTypes/knownLootItems/knownQuestRewardItems from persisted memory', () => {
    const db = openMemoryDb(':memory:');
    scanGameObjects(db, { [makeStation().id]: makeStation() }, 1000);
    recordHarvest(db, 'pine', 1000);
    const pine = getEntity(db, 'resource', 'pine')!;
    recordLoot(db, pine.id, { pinewoodLog: 2 }, 1000);
    recordQuestSighting(db, 'Elder', availableQuest, 1000);

    const result = getKnownSets(db);
    expect(result.knownStationTypes).toEqual(new Set(['smithing']));
    expect(result.knownLootItems).toEqual(new Set(['pinewoodLog']));
    expect(result.knownQuestRewardItems).toEqual(new Set(['stone']));
    db.close();
  });

  it('folds extraKnownLootItems into knownLootItems', () => {
    const db = openMemoryDb(':memory:');
    const result = getKnownSets(db, ['copperOre']);
    expect(result.knownLootItems).toEqual(new Set(['copperOre']));
    db.close();
  });

  it('returns empty sets when nothing has ever been recorded', () => {
    const db = openMemoryDb(':memory:');
    const result = getKnownSets(db);
    expect(result.knownStationTypes.size).toBe(0);
    expect(result.knownLootItems.size).toBe(0);
    expect(result.knownQuestRewardItems.size).toBe(0);
    db.close();
  });
});
