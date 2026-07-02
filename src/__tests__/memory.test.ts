import { describe, it, expect } from 'vitest';
import { Monsters } from 'programming-game/monsters';
import { NPC_TYPE } from 'programming-game/types';
import type { ClientSideNPC, ClientSideMonster, GameObject, ActiveQuest } from 'programming-game/types';
import {
  openMemoryDb,
  getEntity,
  getKnownEntities,
  recordSafeLocation,
  getSafeLocations,
  findNearestSafeLocation,
  recordMerchant,
  getMerchantPrices,
  recordExploredCell,
  isCellExplored,
  getExploredCells,
  recordMonsterSighting,
  recordNpcSighting,
  recordResourceSighting,
  getHeatMapSightings,
  recordCombatHit,
  recordMonsterKill,
  getCombatHistory,
  recordDrop,
  getDropRates,
  recordQuestSighting,
  getQuestSighting,
  getKnownQuestsForNpc,
} from '../memory';

const makeMerchantNpc = (overrides: Partial<ClientSideNPC> = {}): ClientSideNPC =>
  ({
    id: 'npc-1',
    type: 'npc',
    npcType: 'merchant',
    name: 'Wandering Trader',
    position: { x: 5, y: 5 },
    trades: {
      wants: {},
      offers: {},
      buying: { ['copperOre']: { price: 2, quantity: 50 } },
      selling: { ['copperIngot']: { price: 10, quantity: 20 } },
    },
    availableQuests: {},
    ...overrides,
  }) as unknown as ClientSideNPC;

const makeMonster = (overrides: Partial<ClientSideMonster> = {}): ClientSideMonster =>
  ({
    id: 'mon-1',
    type: 'monster',
    monsterId: Monsters.rat,
    name: 'Rat',
    hp: 12,
    position: { x: 100, y: -40 },
    ...overrides,
  }) as unknown as ClientSideMonster;

const makeTree = (overrides: Partial<GameObject> = {}): GameObject =>
  ({
    id: 'tree-1',
    type: 'tree',
    treeType: 'pine',
    label: 'Pine Tree',
    radius: 1,
    position: { x: 20, y: 30 },
    ...overrides,
  }) as GameObject;

describe('openMemoryDb', () => {
  it('creates all expected tables and sets schema version to 1', () => {
    const db = openMemoryDb(':memory:');
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row: any) => row.name);
    expect(tables).toEqual(
      expect.arrayContaining([
        'schema_version',
        'safe_locations',
        'entities',
        'merchants',
        'merchant_prices',
        'explored_cells',
        'heat_map',
        'combat_history',
        'monster_kills',
        'drop_counts',
        'quests',
      ]),
    );
    const version = db.prepare('SELECT version FROM schema_version').get() as { version: number };
    expect(version.version).toBe(1);
    db.close();
  });

  it('is idempotent — opening twice against the same file does not error or duplicate the version row', () => {
    const db1 = openMemoryDb(':memory:');
    db1.close();
    const db2 = openMemoryDb(':memory:');
    const rows = db2.prepare('SELECT version FROM schema_version').all();
    expect(rows.length).toBe(1);
    db2.close();
  });
});

describe('entity catalog', () => {
  it('is populated by a sighting write, independent of location', () => {
    const db = openMemoryDb(':memory:');
    recordMonsterSighting(db, makeMonster(), 1000);
    const entity = getEntity(db, 'monster', Monsters.rat);
    expect(entity).toEqual({ id: expect.any(Number), entityType: 'monster', entityName: Monsters.rat });
    db.close();
  });

  it('is shared across every write path that touches the same entity — a heat_map sighting and a combat hit resolve to the same row, not a duplicate', () => {
    const db = openMemoryDb(':memory:');
    recordMonsterSighting(db, makeMonster(), 1000);
    const firstId = getEntity(db, 'monster', Monsters.rat)?.id;
    recordCombatHit(db, Monsters.rat, 12, 3, 2000);
    const entities = getKnownEntities(db, { entityType: 'monster' });
    expect(entities.length).toBe(1);
    expect(entities[0].id).toBe(firstId);
    db.close();
  });

  it('getKnownEntities lists distinct entity types/names seen, independent of where', () => {
    const db = openMemoryDb(':memory:');
    recordResourceSighting(db, makeTree(), 1000);
    recordResourceSighting(db, makeTree({ id: 'tree-2', treeType: 'oak', position: { x: 99, y: 99 } } as any), 1000);
    recordMonsterSighting(db, makeMonster(), 1000);
    const resources = getKnownEntities(db, { entityType: 'resource' });
    expect(resources.map((e) => e.entityName).sort()).toEqual(['oak', 'pine']);
    expect(getKnownEntities(db).length).toBe(3);
    db.close();
  });

  it('getEntity returns null for an entity never seen', () => {
    const db = openMemoryDb(':memory:');
    expect(getEntity(db, 'monster', Monsters.troll)).toBeNull();
    db.close();
  });
});

describe('safe locations', () => {
  it('records a new safe location with first_seen_at and last_seen_at equal', () => {
    const db = openMemoryDb(':memory:');
    recordSafeLocation(db, 'Home', 'town', { x: 0, y: 0 }, 1000);
    const locations = getSafeLocations(db);
    expect(locations).toEqual([
      { name: 'Home', type: 'town', position: { x: 0, y: 0 }, firstSeenAt: 1000, lastSeenAt: 1000 },
    ]);
    db.close();
  });

  it('re-recording the same location updates last_seen_at but keeps first_seen_at', () => {
    const db = openMemoryDb(':memory:');
    recordSafeLocation(db, 'Home', 'town', { x: 0, y: 0 }, 1000);
    recordSafeLocation(db, 'Home', 'town', { x: 1, y: 1 }, 2000);
    const [location] = getSafeLocations(db);
    expect(location.firstSeenAt).toBe(1000);
    expect(location.lastSeenAt).toBe(2000);
    expect(location.position).toEqual({ x: 1, y: 1 });
    db.close();
  });

  it('treats the same name with a different type as a distinct location', () => {
    const db = openMemoryDb(':memory:');
    recordSafeLocation(db, 'Riverdale', 'town', { x: 0, y: 0 }, 1000);
    recordSafeLocation(db, 'Riverdale', 'healer', { x: 2, y: 2 }, 1000);
    expect(getSafeLocations(db).length).toBe(2);
    db.close();
  });

  it('findNearestSafeLocation returns the closest recorded location', () => {
    const db = openMemoryDb(':memory:');
    recordSafeLocation(db, 'Near', 'town', { x: 1, y: 0 }, 1000);
    recordSafeLocation(db, 'Far', 'town', { x: 100, y: 0 }, 1000);
    const nearest = findNearestSafeLocation(db, { x: 0, y: 0 });
    expect(nearest?.name).toBe('Near');
    db.close();
  });

  it('findNearestSafeLocation returns null when nothing is recorded', () => {
    const db = openMemoryDb(':memory:');
    expect(findNearestSafeLocation(db, { x: 0, y: 0 })).toBeNull();
    db.close();
  });
});

describe('merchant knowledge', () => {
  it('references its entity catalog entry for npcType', () => {
    const db = openMemoryDb(':memory:');
    recordMerchant(db, makeMerchantNpc(), 1000);
    const entity = getEntity(db, 'npc', 'merchant');
    const row = db.prepare('SELECT entity_id FROM merchants WHERE name = ?').get('Wandering Trader') as { entity_id: number };
    expect(row.entity_id).toBe(entity?.id);
    db.close();
  });

  it('records a merchant unit and its buying/selling prices', () => {
    const db = openMemoryDb(':memory:');
    recordMerchant(db, makeMerchantNpc(), 1000);
    const buyOffers = getMerchantPrices(db, 'copperOre');
    expect(buyOffers).toEqual([
      {
        merchantName: 'Wandering Trader',
        position: { x: 5, y: 5 },
        buying: { price: 2, quantity: 50 },
        selling: undefined,
      },
    ]);
    const sellOffers = getMerchantPrices(db, 'copperIngot');
    expect(sellOffers).toEqual([
      {
        merchantName: 'Wandering Trader',
        position: { x: 5, y: 5 },
        buying: undefined,
        selling: { price: 10, quantity: 20 },
      },
    ]);
    db.close();
  });

  it('updates prices and position on re-sighting the same merchant', () => {
    const db = openMemoryDb(':memory:');
    recordMerchant(db, makeMerchantNpc(), 1000);
    recordMerchant(
      db,
      makeMerchantNpc({
        position: { x: 9, y: 9 },
        trades: {
          wants: {},
          offers: {},
          buying: { ['copperOre']: { price: 3, quantity: 40 } },
          selling: { ['copperIngot']: { price: 10, quantity: 20 } },
        },
      } as any),
      2000,
    );
    const offers = getMerchantPrices(db, 'copperOre');
    expect(offers).toEqual([
      { merchantName: 'Wandering Trader', position: { x: 9, y: 9 }, buying: { price: 3, quantity: 40 }, selling: undefined },
    ]);
    db.close();
  });

  it('returns an empty array for an item no known merchant trades', () => {
    const db = openMemoryDb(':memory:');
    recordMerchant(db, makeMerchantNpc(), 1000);
    expect(getMerchantPrices(db, 'pinewoodLog')).toEqual([]);
    db.close();
  });
});

describe('explored cells', () => {
  it('records the cell containing a position, sized by the given sight range', () => {
    const db = openMemoryDb(':memory:');
    recordExploredCell(db, { x: 25, y: 35 }, 10, 1000);
    expect(isCellExplored(db, { x: 22, y: 31 }, 10)).toBe(true);
    expect(isCellExplored(db, { x: 45, y: 35 }, 10)).toBe(false);
    db.close();
  });

  it('handles negative coordinates correctly (floor, not truncate)', () => {
    const db = openMemoryDb(':memory:');
    recordExploredCell(db, { x: -5, y: -5 }, 10, 1000);
    expect(isCellExplored(db, { x: -1, y: -9 }, 10)).toBe(true);
    db.close();
  });

  it('re-recording the same cell updates last_seen_at and sight_range without duplicating rows', () => {
    const db = openMemoryDb(':memory:');
    recordExploredCell(db, { x: 5, y: 5 }, 10, 1000);
    recordExploredCell(db, { x: 6, y: 6 }, 12, 2000);
    const cells = getExploredCells(db);
    expect(cells.length).toBe(1);
    expect(cells[0]).toEqual({ cellX: 0, cellY: 0, sightRange: 12, lastSeenAt: 2000 });
    db.close();
  });
});

describe('heat map sightings', () => {
  it('records a monster sighting derived from a ClientSideMonster', () => {
    const db = openMemoryDb(':memory:');
    recordMonsterSighting(db, makeMonster(), 1000);
    const sightings = getHeatMapSightings(db, { entityType: 'monster' });
    expect(sightings).toEqual([
      {
        entityId: expect.any(Number),
        entityType: 'monster',
        entityName: Monsters.rat,
        position: { x: 100, y: -40 },
        observationCount: 1,
        lastSeenAt: 1000,
      },
    ]);
    db.close();
  });

  it('increments observation_count when the same monster is seen again at the same tile', () => {
    const db = openMemoryDb(':memory:');
    recordMonsterSighting(db, makeMonster(), 1000);
    recordMonsterSighting(db, makeMonster(), 2000);
    const [sighting] = getHeatMapSightings(db, { entityType: 'monster' });
    expect(sighting.observationCount).toBe(2);
    expect(sighting.lastSeenAt).toBe(2000);
    db.close();
  });

  it('records an NPC sighting keyed by npcType', () => {
    const db = openMemoryDb(':memory:');
    recordNpcSighting(db, makeMerchantNpc(), 1000);
    const sightings = getHeatMapSightings(db, { entityType: 'npc' });
    expect(sightings[0]).toMatchObject({ entityType: 'npc', entityName: 'merchant', position: { x: 5, y: 5 } });
    db.close();
  });

  it('records a resource sighting derived from a GameObject tree', () => {
    const db = openMemoryDb(':memory:');
    recordResourceSighting(db, makeTree(), 1000);
    const sightings = getHeatMapSightings(db, { entityType: 'resource' });
    expect(sightings[0]).toMatchObject({ entityType: 'resource', entityName: 'pine', position: { x: 20, y: 30 } });
    db.close();
  });

  it('filters by entityName as well as entityType', () => {
    const db = openMemoryDb(':memory:');
    recordMonsterSighting(db, makeMonster(), 1000);
    recordMonsterSighting(db, makeMonster({ monsterId: Monsters.goblin, position: { x: 1, y: 1 } } as any), 1000);
    const rats = getHeatMapSightings(db, { entityType: 'monster', entityName: Monsters.rat });
    expect(rats.length).toBe(1);
    expect(rats[0].entityName).toBe(Monsters.rat);
    db.close();
  });

  it("sighting's entityId matches the entity catalog row, so other entity_id-keyed tables can cross-reference it", () => {
    const db = openMemoryDb(':memory:');
    recordMonsterSighting(db, makeMonster(), 1000);
    const [sighting] = getHeatMapSightings(db, { entityType: 'monster' });
    const entity = getEntity(db, 'monster', Monsters.rat);
    expect(sighting.entityId).toBe(entity?.id);
    db.close();
  });
});

describe('combat history', () => {
  it('accumulates hits received and damage, tracking the latest known monster hp', () => {
    const db = openMemoryDb(':memory:');
    recordCombatHit(db, Monsters.rat, 12, 3, 1000);
    recordCombatHit(db, Monsters.rat, 9, 5, 1500);
    const history = getCombatHistory(db, Monsters.rat);
    expect(history).toEqual({
      monsterId: Monsters.rat,
      monsterHp: 9,
      killCount: 0,
      hitsReceived: 2,
      totalDamageReceived: 8,
      avgDamagePerHit: 4,
      lastUpdatedAt: 1500,
    });
    db.close();
  });

  it('recordMonsterKill increments kill_count on combat_history and total_kills on monster_kills', () => {
    const db = openMemoryDb(':memory:');
    recordCombatHit(db, Monsters.rat, 12, 3, 1000);
    recordMonsterKill(db, Monsters.rat, 1200);
    recordMonsterKill(db, Monsters.rat, 1300);
    const history = getCombatHistory(db, Monsters.rat);
    expect(history?.killCount).toBe(2);
    db.close();
  });

  it('returns null for a monster never recorded', () => {
    const db = openMemoryDb(':memory:');
    expect(getCombatHistory(db, Monsters.troll)).toBeNull();
    db.close();
  });

  it('avgDamagePerHit is 0 when no hits have been received yet (kill without prior hit records)', () => {
    const db = openMemoryDb(':memory:');
    recordMonsterKill(db, Monsters.rat, 1000);
    const history = getCombatHistory(db, Monsters.rat);
    expect(history?.avgDamagePerHit).toBe(0);
    expect(history?.hitsReceived).toBe(0);
    db.close();
  });
});

describe('drop tables', () => {
  it('computes drop rate from accumulated drops divided by total kills', () => {
    const db = openMemoryDb(':memory:');
    recordMonsterKill(db, Monsters.rat, 1000);
    recordMonsterKill(db, Monsters.rat, 1100);
    recordMonsterKill(db, Monsters.rat, 1200);
    recordMonsterKill(db, Monsters.rat, 1300);
    recordDrop(db, Monsters.rat, { ['ratPelt']: 1 }, 1000);
    recordDrop(db, Monsters.rat, { ['ratPelt']: 1 }, 1200);
    const rates = getDropRates(db, Monsters.rat);
    expect(rates).toEqual([{ item: 'ratPelt', count: 2, dropRate: 0.5 }]);
    db.close();
  });

  it('accumulates multi-item loot drops from a single event', () => {
    const db = openMemoryDb(':memory:');
    recordMonsterKill(db, Monsters.rat, 1000);
    recordDrop(db, Monsters.rat, { ['ratPelt']: 2, ['copperCoin']: 5 }, 1000);
    const rates = getDropRates(db, Monsters.rat);
    const byItem = Object.fromEntries(rates.map((r) => [r.item, r.count]));
    expect(byItem['ratPelt']).toBe(2);
    expect(byItem['copperCoin']).toBe(5);
    db.close();
  });

  it('returns an empty array when the monster has no recorded kills', () => {
    const db = openMemoryDb(':memory:');
    expect(getDropRates(db, Monsters.troll)).toEqual([]);
    db.close();
  });
});

describe('quests memory', () => {
  const quest: ActiveQuest = {
    id: 'q1',
    start_npc: 'Elder',
    end_npc: 'Elder',
    name: 'Rat Extermination',
    steps: [],
  };

  it('records and rehydrates a quest sighting as the original SDK shape', () => {
    const db = openMemoryDb(':memory:');
    recordQuestSighting(db, 'Elder', quest, 'active', 1000);
    const sighting = getQuestSighting(db, 'Elder', 'q1');
    expect(sighting).toEqual({ npcName: 'Elder', questId: 'q1', status: 'active', entityId: null, quest, lastSeenAt: 1000 });
    db.close();
  });

  it('links to the entity catalog when the giving NPC type is known', () => {
    const db = openMemoryDb(':memory:');
    recordQuestSighting(db, 'Elder', quest, 'available', 1000, NPC_TYPE.guard);
    const sighting = getQuestSighting(db, 'Elder', 'q1');
    const entity = getEntity(db, 'npc', 'guard');
    expect(sighting?.entityId).toBe(entity?.id);
    db.close();
  });

  it('keeps the existing entity link when a later sighting omits npcType', () => {
    const db = openMemoryDb(':memory:');
    recordQuestSighting(db, 'Elder', quest, 'available', 1000, NPC_TYPE.guard);
    recordQuestSighting(db, 'Elder', quest, 'active', 2000);
    const sighting = getQuestSighting(db, 'Elder', 'q1');
    expect(sighting?.entityId).not.toBeNull();
    expect(sighting?.status).toBe('active');
    db.close();
  });

  it('returns null for a quest never seen', () => {
    const db = openMemoryDb(':memory:');
    expect(getQuestSighting(db, 'Elder', 'missing')).toBeNull();
    db.close();
  });

  it('getKnownQuestsForNpc lists all quests recorded for a given NPC', () => {
    const db = openMemoryDb(':memory:');
    recordQuestSighting(db, 'Elder', quest, 'active', 1000);
    recordQuestSighting(db, 'Elder', { ...quest, id: 'q2', name: 'Second Quest' }, 'available', 1000);
    recordQuestSighting(db, 'OtherNpc', { ...quest, id: 'q3' }, 'active', 1000);
    const known = getKnownQuestsForNpc(db, 'Elder');
    expect(known.map((q) => q.questId).sort()).toEqual(['q1', 'q2']);
    db.close();
  });

  it('updates status and lastSeenAt when the same quest is seen again', () => {
    const db = openMemoryDb(':memory:');
    recordQuestSighting(db, 'Elder', quest, 'available', 1000);
    recordQuestSighting(db, 'Elder', quest, 'active', 2000);
    const sighting = getQuestSighting(db, 'Elder', 'q1');
    expect(sighting?.status).toBe('active');
    expect(sighting?.lastSeenAt).toBe(2000);
    db.close();
  });
});
