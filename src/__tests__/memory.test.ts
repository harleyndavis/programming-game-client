import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Monsters } from 'programming-game/monsters';
import type { ClientSideNPC, ClientSideMonster, GameObject, ActiveQuest } from 'programming-game/types';
import {
  openMemoryDb,
  getEntity,
  getKnownEntities,
  getKnownStationTypes,
  getKnownLootItems,
  getKnownQuestRewardItems,
  recordSafeLocation,
  getSafeLocations,
  findNearestSafeLocation,
  recordMerchantTrades,
  getMerchantTrades,
  getAllKnownSellingOffers,
  getLastKnownPosition,
  recordExploredCell,
  isCellExplored,
  getExploredCells,
  recordMonsterSighting,
  recordNpcSighting,
  recordResourceSighting,
  getHeatMapSightings,
  recordCombatHit,
  recordMonsterMaxHp,
  recordMonsterKill,
  recordHarvest,
  getCombatHistory,
  recordLoot,
  getLootRates,
  recordQuestSighting,
  recordQuestEndNpc,
  recordQuestCompleted,
  getQuestSighting,
  getKnownQuestsForNpc,
} from '../memory';
import type { AvailableQuest } from '../memory';

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

const makeStation = (overrides: Partial<GameObject> = {}): GameObject =>
  ({
    id: 'station-1',
    type: 'station',
    stationType: 'smithing',
    stationSubtype: 'anvil',
    facing: 0,
    label: 'Anvil',
    radius: 1,
    position: { x: 40, y: 50 },
    ...overrides,
  }) as GameObject;

describe('openMemoryDb', () => {
  it('creates all expected tables and sets schema version to the current version', () => {
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
        'merchant_trades',
        'explored_cells',
        'heat_map',
        'combat_history',
        'action_counts',
        'loot_counts',
        'quests',
        'quest_reward_items',
        'quest_kill_requirements',
        'quest_required_items',
      ]),
    );
    const version = db.prepare('SELECT version FROM schema_version').get() as { version: number };
    // A fresh database is created directly at the latest shape — no migration needed.
    expect(version.version).toBe(3);
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

describe('schema migration v1 -> v2 (heat_map re-keyed by cell)', () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
  });

  /**
   * Hand-writes a pre-migration (schema version 1) database file — the exact
   * shape real accumulated data had before cell-bucketing. Includes
   * combat_history in its pre-v3 shape (monster_hp, not monster_max_hp) too,
   * since a real v1 database already had that table — opening it runs both
   * the v1->v2 and v2->v3 migrations in sequence.
   */
  const makeV1Db = (path: string): void => {
    const raw = new Database(path);
    raw.exec(`
      CREATE TABLE schema_version (version INTEGER NOT NULL);
      CREATE TABLE entities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_type TEXT NOT NULL,
        entity_name TEXT NOT NULL,
        UNIQUE (entity_type, entity_name)
      );
      CREATE TABLE heat_map (
        entity_id INTEGER NOT NULL REFERENCES entities(id),
        x INTEGER NOT NULL,
        y INTEGER NOT NULL,
        observation_count INTEGER NOT NULL DEFAULT 1,
        last_seen_at INTEGER NOT NULL,
        PRIMARY KEY (entity_id, x, y)
      );
      CREATE TABLE combat_history (
        entity_id INTEGER PRIMARY KEY REFERENCES entities(id),
        monster_hp INTEGER NOT NULL DEFAULT 0,
        hits_received INTEGER NOT NULL DEFAULT 0,
        total_damage_received INTEGER NOT NULL DEFAULT 0,
        min_damage_per_hit INTEGER,
        max_damage_per_hit INTEGER,
        last_updated_at INTEGER NOT NULL
      );
    `);
    raw.prepare('INSERT INTO schema_version (version) VALUES (1)').run();
    const ratId = raw.prepare('INSERT INTO entities (entity_type, entity_name) VALUES (?, ?)').run('monster', Monsters.rat).lastInsertRowid;
    const goblinId = raw.prepare('INSERT INTO entities (entity_type, entity_name) VALUES (?, ?)').run('monster', Monsters.goblin).lastInsertRowid;
    const insertSighting = raw.prepare('INSERT INTO heat_map (entity_id, x, y, observation_count, last_seen_at) VALUES (?, ?, ?, ?, ?)');
    // Same cell at ASSUMED_SIGHT_RANGE (20): floor(100/20)=5, floor(108/20)=5; floor(-40/20)=-2, floor(-32/20)=-2.
    insertSighting.run(ratId, 100, -40, 3, 1000);
    insertSighting.run(ratId, 108, -32, 2, 2000);
    // A different cell for the same entity: floor(500/20)=25.
    insertSighting.run(ratId, 500, 500, 1, 1500);
    // Same (x,y) as the rat's first row, but a different entity — must not merge with the rat's bucket.
    insertSighting.run(goblinId, 100, -40, 1, 3000);
    raw.close();
  };

  it('collapses old exact-position rows into cell-bucketed rows, aggregating per entity, and bumps schema_version to the current version', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memory-migration-test-'));
    tempDirs.push(dir);
    const path = join(dir, 'memory.db');
    makeV1Db(path);

    const db = openMemoryDb(path);
    const version = db.prepare('SELECT version FROM schema_version').get() as { version: number };
    // Chains through v2->v3 (combat_history rename) too, since a v1 database is below both.
    expect(version.version).toBe(3);

    const ratSightings = getHeatMapSightings(db, { entityType: 'monster', entityName: Monsters.rat });
    expect(ratSightings).toHaveLength(2);
    const byPosition = Object.fromEntries(ratSightings.map((s) => [`${s.position.x},${s.position.y}`, s]));
    expect(byPosition['110,-30']).toMatchObject({ observationCount: 5, lastSeenAt: 2000 });
    expect(byPosition['510,510']).toMatchObject({ observationCount: 1, lastSeenAt: 1500 });

    const goblinSightings = getHeatMapSightings(db, { entityType: 'monster', entityName: Monsters.goblin });
    expect(goblinSightings).toHaveLength(1);
    expect(goblinSightings[0]).toMatchObject({ position: { x: 110, y: -30 }, observationCount: 1, lastSeenAt: 3000 });

    db.close();
  });

  it('is idempotent — reopening an already-migrated file does not re-run the migration or error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memory-migration-test-'));
    tempDirs.push(dir);
    const path = join(dir, 'memory.db');
    makeV1Db(path);

    const db1 = openMemoryDb(path);
    db1.close();
    const db2 = openMemoryDb(path);
    const version = db2.prepare('SELECT version FROM schema_version').get() as { version: number };
    expect(version.version).toBe(3);
    const rows = db2.prepare('SELECT version FROM schema_version').all();
    expect(rows.length).toBe(1);
    expect(getHeatMapSightings(db2, { entityType: 'monster', entityName: Monsters.rat })).toHaveLength(2);
    db2.close();
  });
});

describe('schema migration v2 -> v3 (combat_history monster_hp renamed to monster_max_hp)', () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
  });

  /** Hand-writes a pre-migration (schema version 2) database file — combat_history in its old shape, with a populated row. */
  const makeV2Db = (path: string): void => {
    const raw = new Database(path);
    raw.exec(`
      CREATE TABLE schema_version (version INTEGER NOT NULL);
      CREATE TABLE entities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_type TEXT NOT NULL,
        entity_name TEXT NOT NULL,
        UNIQUE (entity_type, entity_name)
      );
      CREATE TABLE combat_history (
        entity_id INTEGER PRIMARY KEY REFERENCES entities(id),
        monster_hp INTEGER NOT NULL DEFAULT 0,
        hits_received INTEGER NOT NULL DEFAULT 0,
        total_damage_received INTEGER NOT NULL DEFAULT 0,
        min_damage_per_hit INTEGER,
        max_damage_per_hit INTEGER,
        last_updated_at INTEGER NOT NULL
      );
    `);
    raw.prepare('INSERT INTO schema_version (version) VALUES (2)').run();
    const ratId = raw.prepare('INSERT INTO entities (entity_type, entity_name) VALUES (?, ?)').run('monster', Monsters.rat).lastInsertRowid;
    // Old semantics: 4 is the rat's remaining HP at the moment it last hit the player, not its max HP.
    raw.prepare(
      'INSERT INTO combat_history (entity_id, monster_hp, hits_received, total_damage_received, min_damage_per_hit, max_damage_per_hit, last_updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(ratId, 4, 3, 15, 3, 8, 1000);
    raw.close();
  };

  it('renames monster_hp to monster_max_hp and resets stale values to 0, preserving the other columns, bumping schema_version to 3', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memory-migration-test-'));
    tempDirs.push(dir);
    const path = join(dir, 'memory.db');
    makeV2Db(path);

    const db = openMemoryDb(path);
    const version = db.prepare('SELECT version FROM schema_version').get() as { version: number };
    expect(version.version).toBe(3);

    const history = getCombatHistory(db, Monsters.rat);
    // The old value (4) is meaningless under the new semantics, so it's reset rather than carried forward.
    expect(history).toMatchObject({ monsterMaxHp: 0, hitsReceived: 3, totalDamageReceived: 15, minDamagePerHit: 3, maxDamagePerHit: 8 });
    db.close();
  });

  it('is idempotent — reopening an already-migrated file does not re-run the migration or error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memory-migration-test-'));
    tempDirs.push(dir);
    const path = join(dir, 'memory.db');
    makeV2Db(path);

    const db1 = openMemoryDb(path);
    db1.close();
    const db2 = openMemoryDb(path);
    const version = db2.prepare('SELECT version FROM schema_version').get() as { version: number };
    expect(version.version).toBe(3);
    const rows = db2.prepare('SELECT version FROM schema_version').all();
    expect(rows.length).toBe(1);
    db2.close();
  });
});

describe('entity catalog', () => {
  it('is populated by a sighting write, independent of location', () => {
    const db = openMemoryDb(':memory:');
    recordMonsterSighting(db, makeMonster(), 10, 1000);
    const entity = getEntity(db, 'monster', Monsters.rat);
    expect(entity).toEqual({ id: expect.any(Number), entityType: 'monster', entityName: Monsters.rat });
    db.close();
  });

  it('is shared across every write path that touches the same entity — a heat_map sighting and a combat hit resolve to the same row, not a duplicate', () => {
    const db = openMemoryDb(':memory:');
    recordMonsterSighting(db, makeMonster(), 10, 1000);
    const firstId = getEntity(db, 'monster', Monsters.rat)?.id;
    recordCombatHit(db, Monsters.rat, 12, 3, 2000);
    const entities = getKnownEntities(db, { entityType: 'monster' });
    expect(entities.length).toBe(1);
    expect(entities[0].id).toBe(firstId);
    db.close();
  });

  it('getKnownEntities lists distinct entity types/names seen, independent of where', () => {
    const db = openMemoryDb(':memory:');
    recordResourceSighting(db, makeTree(), 10, 1000);
    recordResourceSighting(db, makeTree({ id: 'tree-2', treeType: 'oak', position: { x: 99, y: 99 } } as any), 10, 1000);
    recordMonsterSighting(db, makeMonster(), 10, 1000);
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
  it('references its entity catalog entry, keyed by the NPC\'s own name (not its shared npcType) — no separate merchants table', () => {
    const db = openMemoryDb(':memory:');
    recordMerchantTrades(db, makeMerchantNpc(), 1000);
    const entity = getEntity(db, 'npc', 'Wandering Trader');
    expect(entity).not.toBeNull();
    db.close();
  });

  it('position comes from recordNpcSighting, the same call every NPC gets — recordMerchantTrades alone doesn\'t record one', () => {
    const db = openMemoryDb(':memory:');
    const npc = makeMerchantNpc();
    recordNpcSighting(db, npc, 10, 1000);
    recordMerchantTrades(db, npc, 1000);
    const entity = getEntity(db, 'npc', 'Wandering Trader');
    expect(getLastKnownPosition(db, entity!.id)).toEqual({ x: 5, y: 5 });
    db.close();
  });

  it('two different merchants are two different entities', () => {
    const db = openMemoryDb(':memory:');
    recordMerchantTrades(db, makeMerchantNpc(), 1000);
    recordMerchantTrades(db, makeMerchantNpc({ name: 'Village Trader', position: { x: 50, y: 50 } } as any), 1000);
    expect(getKnownEntities(db, { entityType: 'npc' }).map((e) => e.entityName).sort()).toEqual([
      'Village Trader',
      'Wandering Trader',
    ]);
    db.close();
  });

  it('records a merchant unit and its buying/selling prices', () => {
    const db = openMemoryDb(':memory:');
    const npc = makeMerchantNpc();
    recordNpcSighting(db, npc, 10, 1000);
    recordMerchantTrades(db, npc, 1000);
    const entity = getEntity(db, 'npc', 'Wandering Trader');
    const buyOffers = getMerchantTrades(db, 'copperOre');
    expect(buyOffers).toEqual([
      {
        entityId: entity?.id,
        merchantName: 'Wandering Trader',
        position: { x: 5, y: 5 },
        buying: { price: 2, quantity: 50 },
        selling: undefined,
      },
    ]);
    const sellOffers = getMerchantTrades(db, 'copperIngot');
    expect(sellOffers).toEqual([
      {
        entityId: entity?.id,
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
    const firstSighting = makeMerchantNpc();
    recordNpcSighting(db, firstSighting, 10, 1000);
    recordMerchantTrades(db, firstSighting, 1000);
    const resighting = makeMerchantNpc({
      // A genuinely different cell from the first sighting's (5,5) at sightRange
      // 10 (cell (0,0)) — (19,19) is cell (1,1) — so the position is expected
      // to actually move, not just resolve to the same cell.
      position: { x: 19, y: 19 },
      trades: {
        wants: {},
        offers: {},
        buying: { ['copperOre']: { price: 3, quantity: 40 } },
        selling: { ['copperIngot']: { price: 10, quantity: 20 } },
      },
    } as any);
    recordNpcSighting(db, resighting, 10, 2000);
    recordMerchantTrades(db, resighting, 2000);
    const entity = getEntity(db, 'npc', 'Wandering Trader');
    const offers = getMerchantTrades(db, 'copperOre');
    expect(offers).toEqual([
      {
        entityId: entity?.id,
        merchantName: 'Wandering Trader',
        position: { x: 15, y: 15 },
        buying: { price: 3, quantity: 40 },
        selling: undefined,
      },
    ]);
    db.close();
  });

  it('returns an empty array for an item no known merchant trades', () => {
    const db = openMemoryDb(':memory:');
    recordMerchantTrades(db, makeMerchantNpc(), 1000);
    expect(getMerchantTrades(db, 'pinewoodLog')).toEqual([]);
    db.close();
  });

  it('getAllKnownSellingOffers picks the cheapest known price per item across every merchant ever seen', () => {
    const db = openMemoryDb(':memory:');
    recordMerchantTrades(db, makeMerchantNpc(), 1000);
    recordMerchantTrades(
      db,
      makeMerchantNpc({
        name: 'Village Trader',
        position: { x: 50, y: 50 },
        trades: {
          wants: {},
          offers: {},
          buying: {},
          selling: { copperIngot: { price: 7, quantity: 5 } },
        },
      } as any),
      1000,
    );
    expect(getAllKnownSellingOffers(db)).toEqual({ copperIngot: { price: 7, quantity: 5 } });
    db.close();
  });

  it('getAllKnownSellingOffers excludes zero-quantity and null-price rows', () => {
    const db = openMemoryDb(':memory:');
    recordMerchantTrades(
      db,
      makeMerchantNpc({
        trades: {
          wants: {},
          offers: {},
          buying: {},
          selling: { copperIngot: { price: 10, quantity: 0 } },
        },
      } as any),
      1000,
    );
    expect(getAllKnownSellingOffers(db)).toEqual({});
    db.close();
  });
});

describe('station knowledge', () => {
  it('getKnownStationTypes lists distinct station types seen, independent of how many instances/positions', () => {
    const db = openMemoryDb(':memory:');
    recordResourceSighting(db, makeStation(), 10, 1000);
    recordResourceSighting(db, makeStation({ id: 'station-2', position: { x: 900, y: 900 } } as any), 10, 1000);
    recordResourceSighting(db, makeStation({ id: 'station-3', stationType: 'cooking', stationSubtype: 'campfire' } as any), 10, 1000);
    expect(getKnownStationTypes(db).sort()).toEqual(['cooking', 'smithing']);
    db.close();
  });

  it('returns an empty array when no station has ever been sighted', () => {
    const db = openMemoryDb(':memory:');
    expect(getKnownStationTypes(db)).toEqual([]);
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
    recordMonsterSighting(db, makeMonster(), 10, 1000);
    const sightings = getHeatMapSightings(db, { entityType: 'monster' });
    expect(sightings).toEqual([
      {
        entityId: expect.any(Number),
        entityType: 'monster',
        entityName: Monsters.rat,
        // makeMonster's (100,-40) at sightRange 10 buckets into cell (10,-4),
        // whose center is (105,-35) — the position isn't the exact sighting,
        // it's the cell's center (see recordSighting/positionForCell).
        position: { x: 105, y: -35 },
        observationCount: 1,
        lastSeenAt: 1000,
      },
    ]);
    db.close();
  });

  it('increments observation_count when the same monster is seen again at the same tile', () => {
    const db = openMemoryDb(':memory:');
    recordMonsterSighting(db, makeMonster(), 10, 1000);
    recordMonsterSighting(db, makeMonster(), 10, 2000);
    const [sighting] = getHeatMapSightings(db, { entityType: 'monster' });
    expect(sighting.observationCount).toBe(2);
    expect(sighting.lastSeenAt).toBe(2000);
    db.close();
  });

  it('collapses two sightings at different exact tiles into one row when both fall in the same cell', () => {
    const db = openMemoryDb(':memory:');
    // (100,-40) and (108,-32) are both in cell (10,-4) at sightRange 10 — a
    // moving monster that wanders a few tiles must not explode into a new
    // heat_map row per tile, only per cell.
    recordMonsterSighting(db, makeMonster(), 10, 1000);
    recordMonsterSighting(db, makeMonster({ position: { x: 108, y: -32 } } as any), 10, 2000);
    const sightings = getHeatMapSightings(db, { entityType: 'monster' });
    expect(sightings).toHaveLength(1);
    expect(sightings[0].observationCount).toBe(2);
    expect(sightings[0].position).toEqual({ x: 105, y: -35 });
    db.close();
  });

  it('records separate rows for sightings in different cells, even for the same entity', () => {
    const db = openMemoryDb(':memory:');
    recordMonsterSighting(db, makeMonster(), 10, 1000);
    recordMonsterSighting(db, makeMonster({ position: { x: 200, y: 200 } } as any), 10, 2000);
    const sightings = getHeatMapSightings(db, { entityType: 'monster' });
    expect(sightings).toHaveLength(2);
    db.close();
  });

  it("records an NPC sighting keyed by the NPC's own name, not its shared npcType", () => {
    const db = openMemoryDb(':memory:');
    recordNpcSighting(db, makeMerchantNpc(), 10, 1000);
    const sightings = getHeatMapSightings(db, { entityType: 'npc' });
    expect(sightings[0]).toMatchObject({ entityType: 'npc', entityName: 'Wandering Trader', position: { x: 5, y: 5 } });
    db.close();
  });

  it('records a resource sighting derived from a GameObject tree', () => {
    const db = openMemoryDb(':memory:');
    recordResourceSighting(db, makeTree(), 10, 1000);
    const sightings = getHeatMapSightings(db, { entityType: 'resource' });
    // makeTree's (20,30) at sightRange 10 buckets into cell (2,3), center (25,35).
    expect(sightings[0]).toMatchObject({ entityType: 'resource', entityName: 'pine', position: { x: 25, y: 35 } });
    db.close();
  });

  it('records a station sighting keyed by stationType (what recipes require), not stationSubtype (the fixture)', () => {
    const db = openMemoryDb(':memory:');
    recordResourceSighting(db, makeStation(), 10, 1000);
    const sightings = getHeatMapSightings(db, { entityType: 'station' });
    // makeStation's (40,50) at sightRange 10 buckets into cell (4,5), center (45,55).
    expect(sightings[0]).toMatchObject({ entityType: 'station', entityName: 'smithing', position: { x: 45, y: 55 } });
    db.close();
  });

  it('two stations of the same type in different locations collapse into one entity with two heat-map rows — same as two pine trees', () => {
    const db = openMemoryDb(':memory:');
    recordResourceSighting(db, makeStation(), 10, 1000);
    recordResourceSighting(db, makeStation({ id: 'station-2', position: { x: 900, y: 900 } } as any), 10, 1000);
    const entities = getKnownEntities(db, { entityType: 'station' });
    expect(entities).toHaveLength(1);
    expect(entities[0].entityName).toBe('smithing');
    const sightings = getHeatMapSightings(db, { entityType: 'station' });
    expect(sightings).toHaveLength(2);
    db.close();
  });

  it('filters by entityName as well as entityType', () => {
    const db = openMemoryDb(':memory:');
    recordMonsterSighting(db, makeMonster(), 10, 1000);
    recordMonsterSighting(db, makeMonster({ monsterId: Monsters.goblin, position: { x: 1, y: 1 } } as any), 10, 1000);
    const rats = getHeatMapSightings(db, { entityType: 'monster', entityName: Monsters.rat });
    expect(rats.length).toBe(1);
    expect(rats[0].entityName).toBe(Monsters.rat);
    db.close();
  });

  it("sighting's entityId matches the entity catalog row, so other entity_id-keyed tables can cross-reference it", () => {
    const db = openMemoryDb(':memory:');
    recordMonsterSighting(db, makeMonster(), 10, 1000);
    const [sighting] = getHeatMapSightings(db, { entityType: 'monster' });
    const entity = getEntity(db, 'monster', Monsters.rat);
    expect(sighting.entityId).toBe(entity?.id);
    db.close();
  });
});

describe('getLastKnownPosition', () => {
  it('returns the freshest sighted cell for an entity', () => {
    const db = openMemoryDb(':memory:');
    const entityId = recordMonsterSighting(db, makeMonster(), 10, 1000);
    recordMonsterSighting(db, makeMonster({ position: { x: 200, y: 200 } } as any), 10, 2000);
    // (200,200) at sightRange 10 buckets into cell (20,20), center (205,205).
    expect(getLastKnownPosition(db, entityId)).toEqual({ x: 205, y: 205 });
    db.close();
  });

  it('returns null for an entity never sighted', () => {
    const db = openMemoryDb(':memory:');
    expect(getLastKnownPosition(db, 999)).toBeNull();
    db.close();
  });
});

describe('combat history', () => {
  it('accumulates hits received and damage, tracking the monster\'s max hp', () => {
    const db = openMemoryDb(':memory:');
    recordCombatHit(db, Monsters.rat, 12, 3, 1000);
    recordCombatHit(db, Monsters.rat, 12, 5, 1500);
    const history = getCombatHistory(db, Monsters.rat);
    expect(history).toEqual({
      monsterId: Monsters.rat,
      monsterMaxHp: 12,
      killCount: 0,
      hitsReceived: 2,
      totalDamageReceived: 8,
      avgDamagePerHit: 4,
      minDamagePerHit: 3,
      maxDamagePerHit: 5,
      lastUpdatedAt: 1500,
    });
    db.close();
  });

  it('recordMonsterMaxHp records maxHp from the player\'s own attacks without touching hit-received counters', () => {
    const db = openMemoryDb(':memory:');
    // A monster killed before it ever hits the player — no recordCombatHit call at all.
    recordMonsterMaxHp(db, Monsters.rat, 12, 1000);
    const history = getCombatHistory(db, Monsters.rat);
    expect(history).toMatchObject({ monsterMaxHp: 12, hitsReceived: 0, totalDamageReceived: 0 });
    db.close();
  });

  it('recordMonsterMaxHp updates maxHp on an existing row without disturbing hit-received stats', () => {
    const db = openMemoryDb(':memory:');
    recordCombatHit(db, Monsters.rat, 0, 5, 1000);
    recordMonsterMaxHp(db, Monsters.rat, 12, 1500);
    const history = getCombatHistory(db, Monsters.rat);
    expect(history).toMatchObject({ monsterMaxHp: 12, hitsReceived: 1, totalDamageReceived: 5 });
    db.close();
  });

  it('tracks min/max damage per hit, not just the average — a rare big hit must not be hidden by the mean', () => {
    const db = openMemoryDb(':memory:');
    recordCombatHit(db, Monsters.rat, 12, 5, 1000);
    recordCombatHit(db, Monsters.rat, 12, 4, 1100);
    recordCombatHit(db, Monsters.rat, 12, 20, 1200);
    const history = getCombatHistory(db, Monsters.rat);
    expect(history?.minDamagePerHit).toBe(4);
    expect(history?.maxDamagePerHit).toBe(20);
    expect(history?.avgDamagePerHit).toBeCloseTo(29 / 3);
    db.close();
  });

  it('recordMonsterKill increments the shared action_counts denominator, readable via killCount', () => {
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
    expect(history?.minDamagePerHit).toBeNull();
    expect(history?.maxDamagePerHit).toBeNull();
    db.close();
  });
});

describe('loot tables', () => {
  it('computes drop chance from loot events divided by total kills, separate from average quantity per event', () => {
    const db = openMemoryDb(':memory:');
    recordMonsterKill(db, Monsters.rat, 1000);
    recordMonsterKill(db, Monsters.rat, 1100);
    recordMonsterKill(db, Monsters.rat, 1200);
    recordMonsterKill(db, Monsters.rat, 1300);
    const rat = getEntity(db, 'monster', Monsters.rat)!;
    recordLoot(db, rat.id, { ['ratPelt']: 1 }, 1000);
    recordLoot(db, rat.id, { ['ratPelt']: 1 }, 1200);
    const rates = getLootRates(db, 'monster', Monsters.rat);
    expect(rates).toEqual([
      { item: 'ratPelt', totalQuantity: 2, lootEvents: 2, minQuantity: 1, maxQuantity: 1, dropChance: 0.5, avgQuantityPerEvent: 1 },
    ]);
    db.close();
  });

  it('tracks min/max quantity per loot event, not just a running total — a lucky big drop must not be hidden by the sum', () => {
    const db = openMemoryDb(':memory:');
    recordMonsterKill(db, Monsters.rat, 1000);
    const rat = getEntity(db, 'monster', Monsters.rat)!;
    recordLoot(db, rat.id, { ['feather']: 5 }, 1000);
    recordLoot(db, rat.id, { ['feather']: 3 }, 1100);
    recordLoot(db, rat.id, { ['feather']: 1 }, 1200);
    const [rate] = getLootRates(db, 'monster', Monsters.rat);
    expect(rate.totalQuantity).toBe(9);
    expect(rate.lootEvents).toBe(3);
    expect(rate.minQuantity).toBe(1);
    expect(rate.maxQuantity).toBe(5);
    expect(rate.avgQuantityPerEvent).toBe(3);
    db.close();
  });

  it('accumulates multi-item loot from a single event', () => {
    const db = openMemoryDb(':memory:');
    recordMonsterKill(db, Monsters.rat, 1000);
    const rat = getEntity(db, 'monster', Monsters.rat)!;
    recordLoot(db, rat.id, { ['ratPelt']: 2, ['copperCoin']: 5 }, 1000);
    const rates = getLootRates(db, 'monster', Monsters.rat);
    const byItem = Object.fromEntries(rates.map((r) => [r.item, r.totalQuantity]));
    expect(byItem['ratPelt']).toBe(2);
    expect(byItem['copperCoin']).toBe(5);
    db.close();
  });

  it('returns an empty array when the monster has no recorded kills', () => {
    const db = openMemoryDb(':memory:');
    expect(getLootRates(db, 'monster', Monsters.troll)).toEqual([]);
    db.close();
  });

  it('recordHarvest and getLootRates work symmetrically for resource entities, sharing the same action_counts/loot_counts machinery as monsters', () => {
    const db = openMemoryDb(':memory:');
    recordHarvest(db, 'pine', 1000);
    recordHarvest(db, 'pine', 1100);
    const pine = getEntity(db, 'resource', 'pine')!;
    recordLoot(db, pine.id, { ['pinewoodLog']: 2 }, 1000);
    const [rate] = getLootRates(db, 'resource', 'pine');
    expect(rate).toEqual({
      item: 'pinewoodLog',
      totalQuantity: 2,
      lootEvents: 1,
      minQuantity: 2,
      maxQuantity: 2,
      dropChance: 0.5,
      avgQuantityPerEvent: 2,
    });
    db.close();
  });
});

describe('known loot items', () => {
  it('getKnownLootItems lists distinct items ever recorded as loot, across monster kills and harvests alike', () => {
    const db = openMemoryDb(':memory:');
    recordMonsterKill(db, Monsters.rat, 1000);
    const rat = getEntity(db, 'monster', Monsters.rat)!;
    recordLoot(db, rat.id, { ['ratPelt']: 1, ['copperCoin']: 2 }, 1000);
    recordHarvest(db, 'pine', 1000);
    const pine = getEntity(db, 'resource', 'pine')!;
    recordLoot(db, pine.id, { ['pinewoodLog']: 2 }, 1000);
    expect(getKnownLootItems(db).sort()).toEqual(['copperCoin', 'pinewoodLog', 'ratPelt']);
    db.close();
  });

  it('returns an empty array when nothing has ever been looted', () => {
    const db = openMemoryDb(':memory:');
    expect(getKnownLootItems(db)).toEqual([]);
    db.close();
  });
});

describe('quests memory', () => {
  const availableQuest: AvailableQuest = {
    repeatable: false,
    id: 'q1',
    name: 'Rat Extermination',
    steps: [
      { type: 'kill', targets: { [Monsters.rat]: 5 } },
      { type: 'turn_in', target: 'Elder', requiredItems: { ratPelt: 3 }, position: {} },
    ],
    rewards: { items: { stone: 10 } },
  };

  const activeQuest: ActiveQuest = {
    id: 'q1',
    start_npc: 'Elder',
    end_npc: 'Elder',
    name: 'Rat Extermination',
    steps: [
      { type: 'kill', targets: { [Monsters.rat]: { required: 5, killed: 2 } } },
      { type: 'turn_in', target: 'Elder', requiredItems: { ratPelt: 3 }, position: {} },
    ],
    rewards: { items: { stone: 10 } },
  };

  it('records an available quest sighting as a normalized QuestRecord, not the raw SDK object', () => {
    const db = openMemoryDb(':memory:');
    recordQuestSighting(db, 'Elder', availableQuest, 1000);
    const record = getQuestSighting(db, 'Elder', 'q1');
    const elder = getEntity(db, 'npc', 'Elder');
    const rat = getEntity(db, 'monster', Monsters.rat);
    expect(record).toEqual({
      questId: 'q1',
      name: 'Rat Extermination',
      startNpcId: elder?.id,
      endNpcId: null,
      repeatable: false,
      status: 'available',
      rewardItems: { stone: 10 },
      killRequirements: [{ monsterEntityId: rat?.id, required: 5 }],
      requiredItems: { ratPelt: 3 },
      lastSeenAt: 1000,
    });
    db.close();
  });

  it('reward items are directly SQL-queryable without parsing JSON', () => {
    const db = openMemoryDb(':memory:');
    recordQuestSighting(db, 'Elder', availableQuest, 1000);
    const rows = db.prepare('SELECT quest_id, quantity FROM quest_reward_items WHERE item = ?').all('stone');
    expect(rows).toEqual([{ quest_id: 'q1', quantity: 10 }]);
    db.close();
  });

  it("kill requirements reference the same monster entity a sighting would, so feasibility can join heat_map/combat_history", () => {
    const db = openMemoryDb(':memory:');
    recordQuestSighting(db, 'Elder', availableQuest, 1000);
    recordMonsterSighting(db, makeMonster({ monsterId: Monsters.rat }), 10, 2000);
    const rat = getEntity(db, 'monster', Monsters.rat);
    const record = getQuestSighting(db, 'Elder', 'q1');
    expect(record?.killRequirements).toEqual([{ monsterEntityId: rat?.id, required: 5 }]);
    const sightings = getHeatMapSightings(db, { entityType: 'monster', entityName: Monsters.rat });
    expect(sightings).toHaveLength(1);
    db.close();
  });

  it('a monster referenced only in a quest (never independently sighted) still gets an entity id, with no heat_map rows', () => {
    const db = openMemoryDb(':memory:');
    recordQuestSighting(db, 'Elder', availableQuest, 1000);
    const rat = getEntity(db, 'monster', Monsters.rat);
    expect(rat).not.toBeNull();
    expect(getHeatMapSightings(db, { entityType: 'monster', entityName: Monsters.rat })).toEqual([]);
    db.close();
  });

  it("links to the entity catalog entry for the giving NPC's own name, not a shared role", () => {
    const db = openMemoryDb(':memory:');
    recordQuestSighting(db, 'Elder', availableQuest, 1000);
    const record = getQuestSighting(db, 'Elder', 'q1');
    const entity = getEntity(db, 'npc', 'Elder');
    expect(record?.startNpcId).toBe(entity?.id);
    db.close();
  });

  it('two different quest-giving NPCs are two different entities', () => {
    const db = openMemoryDb(':memory:');
    recordQuestSighting(db, 'Elder', availableQuest, 1000);
    recordQuestSighting(db, 'Blacksmith', { ...availableQuest, id: 'q2' }, 1000);
    const elder = getQuestSighting(db, 'Elder', 'q1');
    const blacksmith = getQuestSighting(db, 'Blacksmith', 'q2');
    expect(elder?.startNpcId).not.toBe(blacksmith?.startNpcId);
    db.close();
  });

  it('returns null for a quest never seen', () => {
    const db = openMemoryDb(':memory:');
    expect(getQuestSighting(db, 'Elder', 'missing')).toBeNull();
    db.close();
  });

  it('getKnownQuestsForNpc lists all quests recorded for a given NPC', () => {
    const db = openMemoryDb(':memory:');
    recordQuestSighting(db, 'Elder', availableQuest, 1000);
    recordQuestSighting(db, 'Elder', { ...availableQuest, id: 'q2', name: 'Second Quest' }, 1000);
    recordQuestSighting(db, 'OtherNpc', { ...availableQuest, id: 'q3' }, 1000);
    const known = getKnownQuestsForNpc(db, 'Elder');
    expect(known.map((q) => q.questId).sort()).toEqual(['q1', 'q2']);
    db.close();
  });

  it('updates name, repeatable, and lastSeenAt when the same quest is seen again', () => {
    const db = openMemoryDb(':memory:');
    recordQuestSighting(db, 'Elder', availableQuest, 1000);
    recordQuestSighting(db, 'Elder', { ...availableQuest, name: 'Rat Extermination II', repeatable: true }, 2000);
    const record = getQuestSighting(db, 'Elder', 'q1');
    expect(record?.name).toBe('Rat Extermination II');
    expect(record?.repeatable).toBe(true);
    expect(record?.lastSeenAt).toBe(2000);
    db.close();
  });

  it('a re-sighting with a dropped kill step deletes the now-stale kill requirement instead of leaving it behind', () => {
    const db = openMemoryDb(':memory:');
    recordQuestSighting(db, 'Elder', availableQuest, 1000);
    recordQuestSighting(
      db,
      'Elder',
      { ...availableQuest, steps: [{ type: 'turn_in', target: 'Elder', requiredItems: { ratPelt: 3 }, position: {} }] },
      2000,
    );
    const record = getQuestSighting(db, 'Elder', 'q1');
    expect(record?.killRequirements).toEqual([]);
    expect(record?.requiredItems).toEqual({ ratPelt: 3 });
    db.close();
  });

  it('a re-sighting that drops a reward item deletes the now-stale reward row', () => {
    const db = openMemoryDb(':memory:');
    recordQuestSighting(db, 'Elder', { ...availableQuest, rewards: { items: { stone: 10, copperCoin: 5 } } }, 1000);
    recordQuestSighting(db, 'Elder', { ...availableQuest, rewards: { items: { stone: 10 } } }, 2000);
    const record = getQuestSighting(db, 'Elder', 'q1');
    expect(record?.rewardItems).toEqual({ stone: 10 });
    db.close();
  });

  it('recordQuestEndNpc records the turn-in NPC on an existing quest row without touching status, repeatable, or child tables', () => {
    const db = openMemoryDb(':memory:');
    recordQuestSighting(db, 'Elder', availableQuest, 1000);
    recordQuestEndNpc(db, activeQuest, 'Elder', 2000);
    const record = getQuestSighting(db, 'Elder', 'q1');
    const elder = getEntity(db, 'npc', 'Elder');
    expect(record?.endNpcId).toBe(elder?.id);
    expect(record?.status).toBe('available');
    expect(record?.repeatable).toBe(false);
    expect(record?.lastSeenAt).toBe(2000);
    expect(record?.killRequirements).toEqual([{ monsterEntityId: getEntity(db, 'monster', Monsters.rat)?.id, required: 5 }]);
    db.close();
  });

  it('recordQuestEndNpc is a no-op when the quest was never recorded via an available sighting', () => {
    const db = openMemoryDb(':memory:');
    recordQuestEndNpc(db, activeQuest, 'Elder', 1000);
    expect(getQuestSighting(db, 'Elder', 'q1')).toBeNull();
    db.close();
  });

  it('recordQuestEndNpc resolves the turn-in NPC via the caller-supplied name, not quest.end_npc\'s raw unit id', () => {
    const db = openMemoryDb(':memory:');
    recordQuestSighting(db, 'Elder', availableQuest, 1000);
    // quest.end_npc holds a raw SDK unit id here, not a display name — the
    // caller-supplied endNpcName ('Elder') must be what actually gets used.
    recordQuestEndNpc(db, { ...activeQuest, end_npc: 'npc_unit_42' }, 'Elder', 2000);
    const record = getQuestSighting(db, 'Elder', 'q1');
    const elder = getEntity(db, 'npc', 'Elder');
    expect(record?.endNpcId).toBe(elder?.id);
    expect(getEntity(db, 'npc', 'npc_unit_42')).toBeNull();
    db.close();
  });

  it('recordQuestCompleted marks a quest completed without touching its reward/requirement rows', () => {
    const db = openMemoryDb(':memory:');
    recordQuestSighting(db, 'Elder', availableQuest, 1000);
    recordQuestCompleted(db, 'q1', 2000);
    const record = getQuestSighting(db, 'Elder', 'q1');
    expect(record?.status).toBe('completed');
    expect(record?.lastSeenAt).toBe(2000);
    expect(record?.rewardItems).toEqual({ stone: 10 });
    db.close();
  });

  it('getKnownQuestRewardItems lists distinct reward items across every quest ever sighted as available, regardless of accept status', () => {
    const db = openMemoryDb(':memory:');
    recordQuestSighting(db, 'Elder', availableQuest, 1000);
    recordQuestSighting(db, 'Blacksmith', { ...availableQuest, id: 'q2', rewards: { items: { copperIngot: 3 } } }, 1000);
    expect(getKnownQuestRewardItems(db).sort()).toEqual(['copperIngot', 'stone']);
    db.close();
  });

  it('getKnownQuestRewardItems returns an empty array when no quest has ever been sighted', () => {
    const db = openMemoryDb(':memory:');
    expect(getKnownQuestRewardItems(db)).toEqual([]);
    db.close();
  });
});
