import Database from 'better-sqlite3';
import type {
  Position,
  ClientSideNPC,
  ClientSideMonster,
  GameObject,
  ActiveQuest,
} from 'programming-game/types';
import type { Items } from 'programming-game/items';
import type { Monsters } from 'programming-game/monsters';

// ── Setup ─────────────────────────────────────────────────────────────────
// A dumb store: records what it's told, applies no domain judgement about
// what's true, current, or worth acting on. Callers (planners, decisions)
// interpret this data; memory just persists it. See ADR-0002.

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS safe_locations (
  name           TEXT    NOT NULL,
  type           TEXT    NOT NULL,
  x              REAL    NOT NULL,
  y              REAL    NOT NULL,
  first_seen_at  INTEGER NOT NULL,
  last_seen_at   INTEGER NOT NULL,
  PRIMARY KEY (name, type)
);

CREATE TABLE IF NOT EXISTS entities (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type    TEXT    NOT NULL,
  entity_name    TEXT    NOT NULL,
  UNIQUE (entity_type, entity_name)
);

CREATE TABLE IF NOT EXISTS explored_cells (
  cell_x         INTEGER NOT NULL,
  cell_y         INTEGER NOT NULL,
  sight_range    REAL    NOT NULL,
  last_seen_at   INTEGER NOT NULL,
  PRIMARY KEY (cell_x, cell_y)
);

-- Keyed by cell, not exact tile position — linked to the same sight-range-sized
-- grid as explored_cells (same cellCoordsFor helper computes both), not a
-- separate concept. Many exact sightings of the same entity type collapse into
-- one cell row instead of exploding one row per tile ever stood near — the
-- server itself takes over final approach once a target is visible/in range,
-- so cell-level precision is all any consumer of this table actually needs.
CREATE TABLE IF NOT EXISTS heat_map (
  entity_id          INTEGER NOT NULL REFERENCES entities(id),
  cell_x             INTEGER NOT NULL,
  cell_y             INTEGER NOT NULL,
  sight_range        REAL    NOT NULL,
  observation_count  INTEGER NOT NULL DEFAULT 1,
  last_seen_at       INTEGER NOT NULL,
  PRIMARY KEY (entity_id, cell_x, cell_y)
);

-- buying_price/qty: what the merchant pays the PLAYER (player earns this selling to them).
-- selling_price/qty: what the merchant charges the PLAYER (player pays this buying from them).
-- Named after the SDK's own trades.buying/trades.selling, not "buy"/"sell", because
-- those read as the player's verb and are backwards from that perspective — see
-- docs/game-reference.md -> Merchants.
CREATE TABLE IF NOT EXISTS merchant_trades (
  entity_id      INTEGER NOT NULL REFERENCES entities(id),
  item           TEXT    NOT NULL,
  buying_price   INTEGER,
  buying_qty     INTEGER,
  selling_price  INTEGER,
  selling_qty    INTEGER,
  last_seen_at   INTEGER NOT NULL,
  PRIMARY KEY (entity_id, item)
);

-- monster_max_hp is the monster's maximum HP (UnitStats.maxHp), not its
-- current/remaining HP at the moment of the last hit — recordMonsterMaxHp
-- writes it from either side's attacks (see index.ts), independent of the
-- hit-received counters below, which are specifically about damage the
-- player took.
CREATE TABLE IF NOT EXISTS combat_history (
  entity_id              INTEGER PRIMARY KEY REFERENCES entities(id),
  monster_max_hp         INTEGER NOT NULL DEFAULT 0,
  hits_received          INTEGER NOT NULL DEFAULT 0,
  total_damage_received  INTEGER NOT NULL DEFAULT 0,
  min_damage_per_hit     INTEGER,
  max_damage_per_hit     INTEGER,
  last_updated_at        INTEGER NOT NULL
);

-- Generalized "how many times has this entity been finished off" counter, shared by
-- monster kills and resource harvests — an entity is either a monster or a resource,
-- never both, so entities.entity_type already disambiguates which one a row means
-- without a redundant type column here (a monster entity is only ever killed, a
-- resource entity only ever harvested).
CREATE TABLE IF NOT EXISTS action_counts (
  entity_id        INTEGER PRIMARY KEY REFERENCES entities(id),
  total_count      INTEGER NOT NULL DEFAULT 0,
  last_updated_at  INTEGER NOT NULL
);

-- Named after the SDK's own 'loot' event, which is the sole source for both monster-kill
-- drops and harvest yields. total_quantity is the cumulative sum across every loot event;
-- loot_events counts the events themselves (distinct from total_quantity) so a per-event
-- average/min/max can be recovered instead of only a running total — a monster that drops
-- 5 feathers once and 3 the next time must not collapse into "always drops quantity 8".
CREATE TABLE IF NOT EXISTS loot_counts (
  entity_id       INTEGER NOT NULL REFERENCES entities(id),
  item            TEXT    NOT NULL,
  total_quantity  INTEGER NOT NULL DEFAULT 0,
  loot_events     INTEGER NOT NULL DEFAULT 0,
  min_quantity    INTEGER,
  max_quantity    INTEGER,
  last_seen_at    INTEGER NOT NULL,
  PRIMARY KEY (entity_id, item)
);

-- start_npc_id: the NPC the quest was sighted from (an available offer, or an
-- active quest's start_npc). end_npc_id: the turn-in NPC, only known once the
-- quest has been seen active (AvailableQuest carries no end_npc). Both are
-- entity references, never raw name strings, same as every other NPC
-- reference in this schema. repeatable is only known once the quest has been
-- seen as an AvailableQuest (ActiveQuest doesn't carry it), so both
-- end_npc_id and repeatable are nullable and preserved via COALESCE upsert
-- rather than clobbered by a sighting that doesn't have that field.
CREATE TABLE IF NOT EXISTS quests (
  start_npc_id   INTEGER NOT NULL REFERENCES entities(id),
  quest_id       TEXT    NOT NULL,
  end_npc_id     INTEGER REFERENCES entities(id),
  name           TEXT    NOT NULL,
  repeatable     INTEGER,
  status         TEXT    NOT NULL,
  last_seen_at   INTEGER NOT NULL,
  PRIMARY KEY (start_npc_id, quest_id)
);

-- Fixed once a quest is defined; variable-width (a quest can reward any
-- number of items), which is why this is a child table rather than a column.
CREATE TABLE IF NOT EXISTS quest_reward_items (
  start_npc_id   INTEGER NOT NULL,
  quest_id       TEXT    NOT NULL,
  item           TEXT    NOT NULL,
  quantity       INTEGER NOT NULL,
  PRIMARY KEY (start_npc_id, quest_id, item),
  FOREIGN KEY (start_npc_id, quest_id) REFERENCES quests(start_npc_id, quest_id)
);

-- Only the fixed requirement (required kill count per monster), never the
-- mutable killed-so-far progress -- that only matters while a quest is
-- active and the live heartbeat already has it. monster_entity_id lets
-- feasibility checks join against heat_map/combat_history to answer "have we
-- even seen/can we fight this monster" without memory tracking progress
-- itself.
CREATE TABLE IF NOT EXISTS quest_kill_requirements (
  start_npc_id       INTEGER NOT NULL,
  quest_id           TEXT    NOT NULL,
  monster_entity_id  INTEGER NOT NULL REFERENCES entities(id),
  required           INTEGER NOT NULL,
  PRIMARY KEY (start_npc_id, quest_id, monster_entity_id),
  FOREIGN KEY (start_npc_id, quest_id) REFERENCES quests(start_npc_id, quest_id)
);

-- Turn-in requirements (from a turn_in step's requiredItems), for the same
-- "can this quest actually be completed" feasibility question.
CREATE TABLE IF NOT EXISTS quest_required_items (
  start_npc_id   INTEGER NOT NULL,
  quest_id       TEXT    NOT NULL,
  item           TEXT    NOT NULL,
  quantity       INTEGER NOT NULL,
  PRIMARY KEY (start_npc_id, quest_id, item),
  FOREIGN KEY (start_npc_id, quest_id) REFERENCES quests(start_npc_id, quest_id)
);
`;

const CURRENT_SCHEMA_VERSION = 3;

/**
 * v1 -> v2: heat_map was keyed by exact (x, y); re-key by cell to match
 * explored_cells' grid. Old rows carry no sight_range, so every row is
 * bucketed using ASSUMED_SIGHT_RANGE — the same value live recording uses
 * going forward, so migrated and newly-recorded cells align. Aggregated in
 * JS, not SQL, to reuse the exact same cellCoordsFor the rest of the module
 * uses (SQLite integer division truncates toward zero, not floor, which
 * silently disagrees with Math.floor for negative coordinates — not worth
 * the risk of a subtly-wrong hand-rolled SQL floor-div).
 */
const migrateV1ToV2_bucketHeatMapByCell = (db: Database.Database): void => {
  type Bucket = { entityId: number; cellX: number; cellY: number; observationCount: number; lastSeenAt: number };

  // Wrapped as a single transaction so a crash mid-migration (e.g. between the
  // rename and the drop) can't leave the DB in a broken intermediate state —
  // SQLite fully supports transactional DDL, so ALTER/CREATE/DROP TABLE here
  // all commit or roll back together with the row migration.
  db.transaction(() => {
    db.exec('ALTER TABLE heat_map RENAME TO heat_map_v1');
    db.exec(`
      CREATE TABLE heat_map (
        entity_id          INTEGER NOT NULL REFERENCES entities(id),
        cell_x             INTEGER NOT NULL,
        cell_y             INTEGER NOT NULL,
        sight_range        REAL    NOT NULL,
        observation_count  INTEGER NOT NULL DEFAULT 1,
        last_seen_at       INTEGER NOT NULL,
        PRIMARY KEY (entity_id, cell_x, cell_y)
      )
    `);
    const oldRows = db.prepare(
      'SELECT entity_id, x, y, observation_count, last_seen_at FROM heat_map_v1',
    ).all() as { entity_id: number; x: number; y: number; observation_count: number; last_seen_at: number }[];

    const buckets = new Map<string, Bucket>();
    for (const row of oldRows) {
      const { cellX, cellY } = cellCoordsFor({ x: row.x, y: row.y }, ASSUMED_SIGHT_RANGE);
      const key = `${row.entity_id}:${cellX}:${cellY}`;
      const existing = buckets.get(key);
      if (existing) {
        existing.observationCount += row.observation_count;
        existing.lastSeenAt = Math.max(existing.lastSeenAt, row.last_seen_at);
      } else {
        buckets.set(key, { entityId: row.entity_id, cellX, cellY, observationCount: row.observation_count, lastSeenAt: row.last_seen_at });
      }
    }

    const insert = db.prepare(`
      INSERT INTO heat_map (entity_id, cell_x, cell_y, sight_range, observation_count, last_seen_at)
      VALUES (@entityId, @cellX, @cellY, @sightRange, @observationCount, @lastSeenAt)
    `);
    for (const r of Array.from(buckets.values())) insert.run({ ...r, sightRange: ASSUMED_SIGHT_RANGE });

    db.exec('DROP TABLE heat_map_v1');
  })();
};

/**
 * v2 -> v3: combat_history's monster_hp column was actually the monster's
 * current/remaining HP at the moment it last hit the player (from
 * attackerUnit.hp), not its maximum HP — despite the dashboard displaying it
 * as "Monster HP" implying total health. Renamed to monster_max_hp to match
 * what's now actually stored (UnitStats.maxHp, see index.ts). Old values are
 * meaningless under the new semantics (a snapshot of remaining HP at some
 * past hit has no relationship to the monster's actual max HP), so they're
 * reset to 0 rather than carried forward as if they were ever valid —
 * recordMonsterMaxHp repopulates it correctly the next time that monster is
 * fought, from either side's attacks.
 */
const migrateV2ToV3_renameMonsterHpToMaxHp = (db: Database.Database): void => {
  db.transaction(() => {
    db.exec('ALTER TABLE combat_history RENAME COLUMN monster_hp TO monster_max_hp');
    db.exec('UPDATE combat_history SET monster_max_hp = 0');
  })();
};

const migrate = (db: Database.Database): void => {
  // Creates any missing tables at the current shape; a no-op for tables that
  // already exist, regardless of whether their actual shape matches — schema
  // upgrades for existing tables are handled explicitly below, by version.
  db.exec(SCHEMA_SQL);
  const row = db.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined;
  if (!row) {
    // Genuinely fresh database — SCHEMA_SQL just created everything at the
    // latest shape directly, so there's nothing to migrate.
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(CURRENT_SCHEMA_VERSION);
    return;
  }
  let version = row.version;
  if (version < 2) {
    migrateV1ToV2_bucketHeatMapByCell(db);
    version = 2;
  }
  if (version < 3) {
    migrateV2ToV3_renameMonsterHpToMaxHp(db);
    version = 3;
  }
  if (version !== row.version) {
    db.prepare('UPDATE schema_version SET version = ?').run(version);
  }
};

/** Opens (creating if necessary) the SQLite-backed bot memory store and runs migrations. */
export const openMemoryDb = (path: string): Database.Database => {
  const db = new Database(path);
  if (path !== ':memory:') {
    db.pragma('journal_mode = WAL');
  }
  migrate(db);
  return db;
};

// ── Entity catalog ───────────────────────────────────────────────────────
// The canonical registry of every distinct entity the bot has ever observed
// — one row per (entityType, entityName). Pure identity, nothing else: no
// position, no timestamp. Heat map sightings, merchant trades, quests,
// combat history, and drop tables all reference an entity by id here
// instead of duplicating the type/name pair across every row; each of
// those tables already tracks its own "when" for its own context, so the
// catalog doesn't need to.
//
// What entityName holds depends on whether individuals of that type are
// unique or interchangeable. Monsters and resources are interchangeable
// instances of a species/type (monster.monsterId; treeType/oreType — many
// different rat instances, or many different pine trees, all collapse
// into one entity), but NPCs are individually named, persistent characters
// — the entity is npc.name (e.g. "Aigor the Merchant"), never npcType,
// which is a shared role rather than an identity.

export type EntityType = 'monster' | 'npc' | 'resource' | 'station';

export type Entity = {
  id: number;
  entityType: EntityType;
  entityName: string;
};

/** Looks up (or creates) the catalog row for an entity type/name, returning its id. */
const getOrCreateEntity = (db: Database.Database, entityType: EntityType, entityName: string): number => {
  const existing = db
    .prepare('SELECT id FROM entities WHERE entity_type = ? AND entity_name = ?')
    .get(entityType, entityName) as { id: number } | undefined;
  if (existing) return existing.id;
  const inserted = db
    .prepare('INSERT INTO entities (entity_type, entity_name) VALUES (?, ?) RETURNING id')
    .get(entityType, entityName) as { id: number };
  return inserted.id;
};

type EntityRow = { id: number; entity_type: EntityType; entity_name: string };

const toEntity = (row: EntityRow): Entity => ({
  id: row.id,
  entityType: row.entity_type,
  entityName: row.entity_name,
});

export const getEntity = (db: Database.Database, entityType: EntityType, entityName: string): Entity | null => {
  const row = db
    .prepare('SELECT * FROM entities WHERE entity_type = ? AND entity_name = ?')
    .get(entityType, entityName) as EntityRow | undefined;
  return row ? toEntity(row) : null;
};

/** Lists every entity type/name the bot has ever seen, optionally filtered to one entityType. */
export const getKnownEntities = (db: Database.Database, filter: { entityType?: EntityType } = {}): Entity[] => {
  const where = filter.entityType ? 'WHERE entity_type = @entityType' : '';
  return (db
    .prepare(`SELECT * FROM entities ${where}`)
    .all(filter.entityType ? { entityType: filter.entityType } : {}) as EntityRow[])
    .map(toEntity);
};

/** Every distinct station type (e.g. 'smithing', 'smelting') ever sighted, world-wide. */
export const getKnownStationTypes = (db: Database.Database): string[] =>
  getKnownEntities(db, { entityType: 'station' }).map((e) => e.entityName);

/** Every distinct item ever recorded as loot — a monster drop or a harvest yield — world-wide. */
export const getKnownLootItems = (db: Database.Database): string[] =>
  (db.prepare('SELECT DISTINCT item FROM loot_counts').all() as { item: string }[]).map((row) => row.item);

/** Every distinct item ever seen as a quest reward, world-wide — regardless of whether that quest was ever accepted. */
export const getKnownQuestRewardItems = (db: Database.Database): string[] =>
  (db.prepare('SELECT DISTINCT item FROM quest_reward_items').all() as { item: string }[]).map((row) => row.item);

// ── Safe locations ───────────────────────────────────────────────────────

export type SafeLocationType = 'healer' | 'banker' | 'town' | 'player_structure';

export type SafeLocation = {
  name: string;
  type: SafeLocationType;
  position: Position;
  firstSeenAt: number;
  lastSeenAt: number;
};

export const recordSafeLocation = (
  db: Database.Database,
  name: string,
  type: SafeLocationType,
  position: Position,
  now: number,
): void => {
  db.prepare(
    `INSERT INTO safe_locations (name, type, x, y, first_seen_at, last_seen_at)
     VALUES (@name, @type, @x, @y, @now, @now)
     ON CONFLICT(name, type) DO UPDATE SET
       x = excluded.x,
       y = excluded.y,
       last_seen_at = excluded.last_seen_at`,
  ).run({ name, type, x: position.x, y: position.y, now });
};

type SafeLocationRow = { name: string; type: SafeLocationType; x: number; y: number; first_seen_at: number; last_seen_at: number };

const toSafeLocation = (row: SafeLocationRow): SafeLocation => ({
  name: row.name,
  type: row.type,
  position: { x: row.x, y: row.y },
  firstSeenAt: row.first_seen_at,
  lastSeenAt: row.last_seen_at,
});

export const getSafeLocations = (db: Database.Database): SafeLocation[] =>
  (db.prepare('SELECT * FROM safe_locations').all() as SafeLocationRow[]).map(toSafeLocation);

export const findNearestSafeLocation = (
  db: Database.Database,
  from: Position,
): SafeLocation | null => {
  const locations = getSafeLocations(db);
  if (locations.length === 0) return null;
  let nearest = locations[0];
  let nearestDistSq = Infinity;
  for (const location of locations) {
    const dx = location.position.x - from.x;
    const dy = location.position.y - from.y;
    const distSq = dx * dx + dy * dy;
    if (distSq < nearestDistSq) {
      nearestDistSq = distSq;
      nearest = location;
    }
  }
  return nearest;
};

// ── Explored cells ───────────────────────────────────────────────────────

export type ExploredCell = {
  cellX: number;
  cellY: number;
  sightRange: number;
  lastSeenAt: number;
};

// No real sight-range constant exists anywhere in the heartbeat or SDK
// constants today (checked both) — this is a stand-in, shared by
// explored-cell sizing and heat-map cell bucketing so the two stay on the
// same grid (that's the whole point of linking them), and by the v1->v2
// heat_map migration so migrated cells align with newly-recorded ones.
export const ASSUMED_SIGHT_RANGE = 20;

const cellCoordsFor = (position: Position, cellSize: number): { cellX: number; cellY: number } => ({
  cellX: Math.floor(position.x / cellSize),
  cellY: Math.floor(position.y / cellSize),
});

/** The center of a cell — a reasonable "walk here" point when all that's known is which cell, not the exact tile. */
const positionForCell = (cellX: number, cellY: number, sightRange: number): Position => ({
  x: (cellX + 0.5) * sightRange,
  y: (cellY + 0.5) * sightRange,
});

/** Marks the grid cell containing `position` as explored, sized by the sight range observed at the time. */
export const recordExploredCell = (
  db: Database.Database,
  position: Position,
  sightRange: number,
  now: number,
): void => {
  const { cellX, cellY } = cellCoordsFor(position, sightRange);
  db.prepare(
    `INSERT INTO explored_cells (cell_x, cell_y, sight_range, last_seen_at)
     VALUES (@cellX, @cellY, @sightRange, @now)
     ON CONFLICT(cell_x, cell_y) DO UPDATE SET
       sight_range = excluded.sight_range,
       last_seen_at = excluded.last_seen_at`,
  ).run({ cellX, cellY, sightRange, now });
};

export const isCellExplored = (db: Database.Database, position: Position, cellSize: number): boolean => {
  const { cellX, cellY } = cellCoordsFor(position, cellSize);
  const row = db
    .prepare('SELECT 1 FROM explored_cells WHERE cell_x = ? AND cell_y = ?')
    .get(cellX, cellY);
  return row !== undefined;
};

export const getExploredCells = (db: Database.Database): ExploredCell[] =>
  (db
    .prepare('SELECT * FROM explored_cells')
    .all() as { cell_x: number; cell_y: number; sight_range: number; last_seen_at: number }[])
    .map((row) => ({
      cellX: row.cell_x,
      cellY: row.cell_y,
      sightRange: row.sight_range,
      lastSeenAt: row.last_seen_at,
    }));

// ── World heat map ───────────────────────────────────────────────────────
// Every sighting starts as an expiring observation and earns confidence
// through re-confirmation — there's no separate "permanent fixture" table,
// since whether resources/stations relocate on respawn isn't confirmed yet.
// Purely spatial: "where/when have we seen this entity" — see the entity
// catalog above for "have we ever seen this at all".

export type HeatMapSighting = {
  entityId: number;
  entityType: EntityType;
  entityName: string;
  position: Position;
  observationCount: number;
  lastSeenAt: number;
};

/**
 * Records a sighting and returns the entity's id, so callers can reuse it without a
 * second lookup. Bucketed into the same sight-range-sized grid as explored_cells
 * (same cellCoordsFor helper) — every entity type, NPCs included, since the server
 * takes over final approach once a target is visible/in range, so cell-level
 * precision is all a "where was this last seen" fact needs to support.
 */
const recordSighting = (
  db: Database.Database,
  entityType: EntityType,
  entityName: string,
  position: Position,
  sightRange: number,
  now: number,
): number => {
  const entityId = getOrCreateEntity(db, entityType, entityName);
  const { cellX, cellY } = cellCoordsFor(position, sightRange);
  db.prepare(
    `INSERT INTO heat_map (entity_id, cell_x, cell_y, sight_range, observation_count, last_seen_at)
     VALUES (@entityId, @cellX, @cellY, @sightRange, 1, @now)
     ON CONFLICT(entity_id, cell_x, cell_y) DO UPDATE SET
       sight_range = excluded.sight_range,
       observation_count = observation_count + 1,
       last_seen_at = excluded.last_seen_at`,
  ).run({ entityId, cellX, cellY, sightRange, now });
  return entityId;
};

/** Records a monster sighting, keyed by the SDK's `monsterId` — never a bot-invented label. */
export const recordMonsterSighting = (db: Database.Database, monster: ClientSideMonster, sightRange: number, now: number): number =>
  recordSighting(db, 'monster', monster.monsterId, monster.position, sightRange, now);

/**
 * Records an NPC sighting, keyed by its proper name (e.g. "Aigor the Merchant") — NPCs
 * are individually named, persistent characters, not interchangeable instances of a
 * type the way monsters are, so each one gets its own entity rather than sharing a
 * `npcType` bucket with every other NPC of the same role. Still cell-bucketed like
 * every other entity type — see recordSighting.
 */
export const recordNpcSighting = (db: Database.Database, npc: ClientSideNPC, sightRange: number, now: number): number =>
  recordSighting(db, 'npc', npc.name, npc.position, sightRange, now);

const resourceSightingParts = (object: GameObject): { entityType: EntityType; entityName: string } => {
  switch (object.type) {
    case 'tree':
      return { entityType: 'resource', entityName: object.treeType };
    case 'miningNode':
      return { entityType: 'resource', entityName: object.oreType };
    case 'station':
      // Keyed by stationType (what recipes actually require — 'smithing', 'smelting', ...),
      // not stationSubtype (the visual fixture — 'anvil', 'forge', ...). A station is just
      // another interchangeable-instance entity like a tree or ore node: two smithing
      // stations in different spots are both sightings of the same (station, smithing)
      // entity, the same way two pine trees are both sightings of (resource, pine).
      return { entityType: 'station', entityName: object.stationType };
    default:
      return { entityType: 'resource', entityName: object.type };
  }
};

/** Records a resource/station sighting from a raw `GameObject` — tree, mining node, or crafting station. */
export const recordResourceSighting = (db: Database.Database, object: GameObject, sightRange: number, now: number): number => {
  const { entityType, entityName } = resourceSightingParts(object);
  return recordSighting(db, entityType, entityName, object.position, sightRange, now);
};

export const getHeatMapSightings = (
  db: Database.Database,
  filter: { entityType?: EntityType; entityName?: string } = {},
): HeatMapSighting[] => {
  const clauses: string[] = [];
  const params: Record<string, string> = {};
  if (filter.entityType) {
    clauses.push('e.entity_type = @entityType');
    params.entityType = filter.entityType;
  }
  if (filter.entityName) {
    clauses.push('e.entity_name = @entityName');
    params.entityName = filter.entityName;
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  type HeatMapRow = {
    entity_id: number;
    cell_x: number;
    cell_y: number;
    sight_range: number;
    observation_count: number;
    last_seen_at: number;
    entity_type: EntityType;
    entity_name: string;
  };
  return (db
    .prepare(
      `SELECT h.*, e.entity_type, e.entity_name
       FROM heat_map h
       JOIN entities e ON e.id = h.entity_id
       ${where}`,
    )
    .all(params) as HeatMapRow[])
    .map((row) => ({
      entityId: row.entity_id,
      entityType: row.entity_type,
      entityName: row.entity_name,
      position: positionForCell(row.cell_x, row.cell_y, row.sight_range),
      observationCount: row.observation_count,
      lastSeenAt: row.last_seen_at,
    }));
};

/** The freshest known cell position for an entity, or null if it's never been sighted. */
export const getLastKnownPosition = (db: Database.Database, entityId: number): Position | null => {
  const row = db
    .prepare('SELECT cell_x, cell_y, sight_range FROM heat_map WHERE entity_id = ? ORDER BY last_seen_at DESC LIMIT 1')
    .get(entityId) as { cell_x: number; cell_y: number; sight_range: number } | undefined;
  return row ? positionForCell(row.cell_x, row.cell_y, row.sight_range) : null;
};

// ── Merchant knowledge ───────────────────────────────────────────────────
// No standalone "merchants" table — position is heat_map's job, recorded via
// the same recordNpcSighting every other NPC gets (there's no merchant-specific
// sighting call; a merchant is an NPC that additionally has trade data, not a
// different kind of thing). This table holds only what's specific to being a
// merchant: per-item trades, written by recordMerchantTrades.

export type MerchantTradeOffer = {
  entityId: number;
  merchantName: string;
  position: Position | null;
  /** What the merchant pays the player — the player earns this selling to them. */
  buying: { price: number; quantity: number } | undefined;
  /** What the merchant charges the player — the player pays this buying from them. */
  selling: { price: number; quantity: number } | undefined;
};

/**
 * Records every item a merchant is currently seen buying/selling. Deliberately
 * doesn't record the NPC's sighting/position itself — call recordNpcSighting
 * separately, the same call every NPC gets regardless of role. This only adds
 * the merchant-specific trade data on top of that shared sighting.
 */
export const recordMerchantTrades = (db: Database.Database, npc: ClientSideNPC, now: number): void => {
  const entityId = getOrCreateEntity(db, 'npc', npc.name);

  const buying = npc.trades?.buying ?? {};
  const selling = npc.trades?.selling ?? {};
  const items = new Set<string>([...Object.keys(buying), ...Object.keys(selling)]);

  const upsertTrade = db.prepare(
    `INSERT INTO merchant_trades (entity_id, item, buying_price, buying_qty, selling_price, selling_qty, last_seen_at)
     VALUES (@entityId, @item, @buyingPrice, @buyingQty, @sellingPrice, @sellingQty, @now)
     ON CONFLICT(entity_id, item) DO UPDATE SET
       buying_price = COALESCE(excluded.buying_price, merchant_trades.buying_price),
       buying_qty = COALESCE(excluded.buying_qty, merchant_trades.buying_qty),
       selling_price = COALESCE(excluded.selling_price, merchant_trades.selling_price),
       selling_qty = COALESCE(excluded.selling_qty, merchant_trades.selling_qty),
       last_seen_at = excluded.last_seen_at`,
  );

  for (const item of Array.from(items)) {
    const buyingOffer = (buying as Record<string, { price: number; quantity: number } | undefined>)[item];
    const sellingOffer = (selling as Record<string, { price: number; quantity: number } | undefined>)[item];
    upsertTrade.run({
      entityId,
      item,
      buyingPrice: buyingOffer?.price ?? null,
      buyingQty: buyingOffer?.quantity ?? null,
      sellingPrice: sellingOffer?.price ?? null,
      sellingQty: sellingOffer?.quantity ?? null,
      now,
    });
  }
};

type MerchantTradeRowRaw = {
  entity_id: number;
  buying_price: number | null;
  buying_qty: number | null;
  selling_price: number | null;
  selling_qty: number | null;
  entity_name: string;
};

export const getMerchantTrades = (db: Database.Database, item: Items): MerchantTradeOffer[] =>
  (db
    .prepare(
      `SELECT mt.entity_id, mt.buying_price, mt.buying_qty, mt.selling_price, mt.selling_qty, e.entity_name
       FROM merchant_trades mt
       JOIN entities e ON e.id = mt.entity_id
       WHERE mt.item = ?`,
    )
    .all(item) as MerchantTradeRowRaw[])
    .map((row) => ({
      entityId: row.entity_id,
      merchantName: row.entity_name,
      position: getLastKnownPosition(db, row.entity_id),
      buying: row.buying_price != null ? { price: row.buying_price, quantity: row.buying_qty! } : undefined,
      selling: row.selling_price != null ? { price: row.selling_price, quantity: row.selling_qty! } : undefined,
    }));

export type MerchantTradeRow = MerchantTradeOffer & { item: Items };

/** Every known merchant trade offer, unfiltered by item — the "list everything" counterpart to getMerchantTrades. */
export const getAllMerchantTrades = (db: Database.Database): MerchantTradeRow[] =>
  (db
    .prepare(
      `SELECT mt.entity_id, mt.item, mt.buying_price, mt.buying_qty, mt.selling_price, mt.selling_qty, e.entity_name
       FROM merchant_trades mt
       JOIN entities e ON e.id = mt.entity_id`,
    )
    .all() as (MerchantTradeRowRaw & { item: Items })[])
    .map((row) => ({
      entityId: row.entity_id,
      merchantName: row.entity_name,
      item: row.item,
      position: getLastKnownPosition(db, row.entity_id),
      buying: row.buying_price != null ? { price: row.buying_price, quantity: row.buying_qty! } : undefined,
      selling: row.selling_price != null ? { price: row.selling_price, quantity: row.selling_qty! } : undefined,
    }));

/**
 * The cheapest known selling offer per item across every merchant ever seen, ignoring
 * current visibility — the persisted counterpart to a single tick's visible-merchant-only
 * selling map. Used to keep upgrade-plan reachability stable across the bot's location.
 */
export const getAllKnownSellingOffers = (
  db: Database.Database,
): Record<string, { price: number; quantity: number }> => {
  const rows = db
    .prepare(
      `SELECT item, selling_price, selling_qty FROM merchant_trades
       WHERE selling_price IS NOT NULL AND selling_qty > 0`,
    )
    .all() as Array<{ item: string; selling_price: number; selling_qty: number }>;
  const result: Record<string, { price: number; quantity: number }> = {};
  for (const row of rows) {
    const existing = result[row.item];
    if (!existing || row.selling_price < existing.price) {
      result[row.item] = { price: row.selling_price, quantity: row.selling_qty };
    }
  }
  return result;
};

// ── Combat history ───────────────────────────────────────────────────────

export type CombatStats = {
  monsterId: Monsters;
  monsterMaxHp: number;
  killCount: number;
  hitsReceived: number;
  totalDamageReceived: number;
  /** Computed at query time, not stored — see issue #6. */
  avgDamagePerHit: number;
  /** Smallest/largest single hit ever observed — an average alone can hide a dangerous outlier. */
  minDamagePerHit: number | null;
  maxDamagePerHit: number | null;
  lastUpdatedAt: number;
};

/**
 * Records one hit the player took from `monsterId`, and the monster's
 * maximum HP (UnitStats.maxHp — not its current/remaining HP at the moment
 * of this hit, which tells you nothing about its total health).
 */
export const recordCombatHit = (
  db: Database.Database,
  monsterId: Monsters,
  monsterMaxHp: number,
  damageToPlayer: number,
  now: number,
): void => {
  const entityId = getOrCreateEntity(db, 'monster', monsterId);
  db.prepare(
    `INSERT INTO combat_history (entity_id, monster_max_hp, hits_received, total_damage_received, min_damage_per_hit, max_damage_per_hit, last_updated_at)
     VALUES (@entityId, @monsterMaxHp, 1, @damageToPlayer, @damageToPlayer, @damageToPlayer, @now)
     ON CONFLICT(entity_id) DO UPDATE SET
       monster_max_hp = excluded.monster_max_hp,
       hits_received = hits_received + 1,
       total_damage_received = total_damage_received + excluded.total_damage_received,
       min_damage_per_hit = MIN(min_damage_per_hit, excluded.min_damage_per_hit),
       max_damage_per_hit = MAX(max_damage_per_hit, excluded.max_damage_per_hit),
       last_updated_at = excluded.last_updated_at`,
  ).run({ entityId, monsterMaxHp, damageToPlayer, now });
};

/**
 * Records only a monster's maximum HP, without touching the hit-received
 * counters — for capturing it from the player's own outgoing attacks, not
 * just hits taken (recordCombatHit above). Without this, a monster killed
 * before it ever lands a hit (very possible — a rat dies in one swing) would
 * never get its maxHp recorded at all, since combat_history would have no
 * row for it yet.
 */
export const recordMonsterMaxHp = (
  db: Database.Database,
  monsterId: Monsters,
  monsterMaxHp: number,
  now: number,
): void => {
  const entityId = getOrCreateEntity(db, 'monster', monsterId);
  db.prepare(
    `INSERT INTO combat_history (entity_id, monster_max_hp, hits_received, total_damage_received, min_damage_per_hit, max_damage_per_hit, last_updated_at)
     VALUES (@entityId, @monsterMaxHp, 0, 0, NULL, NULL, @now)
     ON CONFLICT(entity_id) DO UPDATE SET
       monster_max_hp = excluded.monster_max_hp,
       last_updated_at = excluded.last_updated_at`,
  ).run({ entityId, monsterMaxHp, now });
};

/** Records a kill, bumping the shared kill/harvest denominator (action_counts). */
export const recordMonsterKill = (db: Database.Database, monsterId: Monsters, now: number): void => {
  const entityId = getOrCreateEntity(db, 'monster', monsterId);
  db.prepare(
    `INSERT INTO action_counts (entity_id, total_count, last_updated_at)
     VALUES (@entityId, 1, @now)
     ON CONFLICT(entity_id) DO UPDATE SET
       total_count = total_count + 1,
       last_updated_at = excluded.last_updated_at`,
  ).run({ entityId, now });
};

/** Records a harvest, bumping the shared kill/harvest denominator (action_counts) for a resource entity. */
export const recordHarvest = (db: Database.Database, resourceName: string, now: number): void => {
  const entityId = getOrCreateEntity(db, 'resource', resourceName);
  db.prepare(
    `INSERT INTO action_counts (entity_id, total_count, last_updated_at)
     VALUES (@entityId, 1, @now)
     ON CONFLICT(entity_id) DO UPDATE SET
       total_count = total_count + 1,
       last_updated_at = excluded.last_updated_at`,
  ).run({ entityId, now });
};

export const getCombatHistory = (db: Database.Database, monsterId: Monsters): CombatStats | null => {
  // Driven from entities (not combat_history) so a monster killed without ever landing a
  // hit on the player (action_counts only, no combat_history row) still returns a result —
  // but only when at least one of the two tables actually has data, so a monster merely
  // referenced by a quest (entity exists, never fought) still correctly returns null.
  const row = db
    .prepare(
      `SELECT e.entity_name,
              COALESCE(ch.monster_max_hp, 0) AS monster_max_hp,
              COALESCE(ch.hits_received, 0) AS hits_received,
              COALESCE(ch.total_damage_received, 0) AS total_damage_received,
              ch.min_damage_per_hit,
              ch.max_damage_per_hit,
              COALESCE(ac.total_count, 0) AS kill_count,
              COALESCE(ch.last_updated_at, ac.last_updated_at) AS last_updated_at
       FROM entities e
       LEFT JOIN combat_history ch ON ch.entity_id = e.id
       LEFT JOIN action_counts ac ON ac.entity_id = e.id
       WHERE e.entity_type = 'monster' AND e.entity_name = ?
         AND (ch.entity_id IS NOT NULL OR ac.entity_id IS NOT NULL)`,
    )
    .get(monsterId) as {
      entity_name: Monsters;
      monster_max_hp: number;
      hits_received: number;
      total_damage_received: number;
      min_damage_per_hit: number | null;
      max_damage_per_hit: number | null;
      kill_count: number;
      last_updated_at: number;
    } | undefined;
  if (!row) return null;
  return {
    monsterId: row.entity_name,
    monsterMaxHp: row.monster_max_hp,
    killCount: row.kill_count,
    hitsReceived: row.hits_received,
    totalDamageReceived: row.total_damage_received,
    avgDamagePerHit: row.hits_received > 0 ? row.total_damage_received / row.hits_received : 0,
    minDamagePerHit: row.min_damage_per_hit,
    maxDamagePerHit: row.max_damage_per_hit,
    lastUpdatedAt: row.last_updated_at,
  };
};

// ── Loot tables ──────────────────────────────────────────────────────────
// Shared by monster-kill drops and harvest yields — both are just "loot events"
// against an entity (monster or resource), the SDK's own 'loot' event being the
// sole source for either. See action_counts above for the denominator.

export type LootRate = {
  item: Items;
  totalQuantity: number;
  lootEvents: number;
  minQuantity: number | null;
  maxQuantity: number | null;
  /** Fraction of kills/harvests that yielded this item at all (lootEvents / actionCount). */
  dropChance: number;
  /** Average quantity received on the events that did yield this item (totalQuantity / lootEvents). */
  avgQuantityPerEvent: number;
};

/**
 * Records a loot event against an already-resolved entity (the monster killed or the
 * resource harvested) — `items` is the SDK's own `loot` event shape. Takes a resolved
 * entity id rather than a typed name since the caller may be attributing this to either
 * a monster or a resource entity.
 */
export const recordLoot = (
  db: Database.Database,
  entityId: number,
  items: Partial<Record<Items, number>>,
  now: number,
): void => {
  const upsert = db.prepare(
    `INSERT INTO loot_counts (entity_id, item, total_quantity, loot_events, min_quantity, max_quantity, last_seen_at)
     VALUES (@entityId, @item, @quantity, 1, @quantity, @quantity, @now)
     ON CONFLICT(entity_id, item) DO UPDATE SET
       total_quantity = total_quantity + excluded.total_quantity,
       loot_events = loot_events + 1,
       min_quantity = MIN(min_quantity, excluded.min_quantity),
       max_quantity = MAX(max_quantity, excluded.max_quantity),
       last_seen_at = excluded.last_seen_at`,
  );
  for (const [item, quantity] of Object.entries(items)) {
    if (typeof quantity !== 'number' || quantity <= 0) continue;
    upsert.run({ entityId, item, quantity, now });
  }
};

/** Loot rates for a given entity (monster or resource), computed at query time — see issue #6. */
export const getLootRates = (db: Database.Database, entityType: EntityType, entityName: string): LootRate[] => {
  const entity = getEntity(db, entityType, entityName);
  if (!entity) return [];
  const actions = db
    .prepare('SELECT total_count FROM action_counts WHERE entity_id = ?')
    .get(entity.id) as { total_count: number } | undefined;
  if (!actions || actions.total_count <= 0) return [];
  return (db
    .prepare(
      'SELECT item, total_quantity, loot_events, min_quantity, max_quantity FROM loot_counts WHERE entity_id = ? ORDER BY item',
    )
    .all(entity.id) as { item: Items; total_quantity: number; loot_events: number; min_quantity: number | null; max_quantity: number | null }[])
    .map((row) => ({
      item: row.item,
      totalQuantity: row.total_quantity,
      lootEvents: row.loot_events,
      minQuantity: row.min_quantity,
      maxQuantity: row.max_quantity,
      dropChance: row.loot_events / actions.total_count,
      avgQuantityPerEvent: row.loot_events > 0 ? row.total_quantity / row.loot_events : 0,
    }));
};

// ── Quests ───────────────────────────────────────────────────────────────
// Keyed by giving NPC entity rather than a position — quests aren't a
// geographic fact. Normalized into columns/child tables rather than a JSON
// blob (queryability, type safety, and consistency with every other table
// here), but only the fixed requirements are persisted — never the mutable
// per-step progress (killed/completed counters).
//
// Only `AvailableQuest` sightings feed the requirement/reward child tables.
// `ActiveQuest` is deliberately not recorded here at all: the live heartbeat
// already carries the currently-active quest's steps in real time, so
// mirroring it into memory would just be a second, laggier copy of the same
// data — and, worse, `ActiveQuest`'s step list can legitimately shrink as
// steps complete, so treating it as authoritative would let a satisfied
// step silently erase a real, still-true requirement fact (e.g. wiping a
// kill requirement from memory the moment its progress counter is
// complete). `AvailableQuest`'s steps are the quest's fixed pre-acceptance
// definition, not a progress view, so they don't have this problem — a
// requirement missing from a fresh AvailableQuest snapshot really is gone
// (see `recordQuestSighting` below). If the quest is abandoned, whatever the
// heartbeat knew about its progress becomes moot anyway; memory's job is
// only "can this quest even be completed for its reward" (a feasibility
// question), not resuming progress (a live-state question the heartbeat
// already answers). See ADR-0006.
//
// The one useful fact only `ActiveQuest` carries — `end_npc`, the turn-in
// NPC — is captured separately by `recordQuestEndNpc`, without touching
// anything else about the quest.

export type AvailableQuest = ClientSideNPC['availableQuests'][string];

export type QuestSightingStatus = 'available' | 'completed';

export type QuestRecord = {
  questId: string;
  name: string;
  startNpcId: number;
  /** Null until an ActiveQuest sighting supplies it via recordQuestEndNpc — AvailableQuest carries no end_npc. */
  endNpcId: number | null;
  repeatable: boolean;
  status: QuestSightingStatus;
  rewardItems: Partial<Record<Items, number>>;
  killRequirements: { monsterEntityId: number; required: number }[];
  requiredItems: Partial<Record<Items, number>>;
  lastSeenAt: number;
};

/**
 * Deletes rows for (startNpcId, questId) in `table` whose `keyColumn` value
 * isn't in `currentKeys`, keeping a quest's child rows in sync with the
 * latest known AvailableQuest definition. An empty `currentKeys` deletes
 * every existing row for that quest in that table — a fresh AvailableQuest
 * snapshot naming zero items/monsters for this table is itself the fact
 * (e.g. a quest with no kill step really has no kill requirements), not an
 * incomplete read, so there's nothing to preserve.
 */
const deleteStaleQuestRows = (
  db: Database.Database,
  table: 'quest_reward_items' | 'quest_kill_requirements' | 'quest_required_items',
  keyColumn: 'item' | 'monster_entity_id',
  startNpcId: number,
  questId: string,
  currentKeys: (string | number)[],
): void => {
  const notIn = currentKeys.length > 0 ? `AND ${keyColumn} NOT IN (${currentKeys.map(() => '?').join(',')})` : '';
  db.prepare(`DELETE FROM ${table} WHERE start_npc_id = ? AND quest_id = ? ${notIn}`).run(
    startNpcId,
    questId,
    ...currentKeys,
  );
};

/** Records an AvailableQuest sighting — the quest's fixed, pre-acceptance definition. Always sets status to 'available' (a repeatable quest reappearing after completion legitimately flips back). */
export const recordQuestSighting = (
  db: Database.Database,
  npcName: string,
  quest: AvailableQuest,
  now: number,
): void => {
  const startNpcId = getOrCreateEntity(db, 'npc', npcName);
  const repeatable = quest.repeatable ? 1 : 0;

  db.prepare(
    `INSERT INTO quests (start_npc_id, quest_id, end_npc_id, name, repeatable, status, last_seen_at)
     VALUES (@startNpcId, @questId, NULL, @name, @repeatable, 'available', @now)
     ON CONFLICT(start_npc_id, quest_id) DO UPDATE SET
       name = excluded.name,
       repeatable = excluded.repeatable,
       status = 'available',
       last_seen_at = excluded.last_seen_at`,
  ).run({ startNpcId, questId: quest.id, name: quest.name, repeatable, now });

  const rewardItems = Object.entries(quest.rewards.items).filter(
    (entry): entry is [string, number] => typeof entry[1] === 'number',
  );
  deleteStaleQuestRows(
    db,
    'quest_reward_items',
    'item',
    startNpcId,
    quest.id,
    rewardItems.map(([item]) => item),
  );
  const upsertReward = db.prepare(
    `INSERT INTO quest_reward_items (start_npc_id, quest_id, item, quantity)
     VALUES (@startNpcId, @questId, @item, @quantity)
     ON CONFLICT(start_npc_id, quest_id, item) DO UPDATE SET quantity = excluded.quantity`,
  );
  for (const [item, quantity] of rewardItems) {
    upsertReward.run({ startNpcId, questId: quest.id, item, quantity });
  }

  const killRequirements = new Map<number, number>();
  const requiredItems = new Map<string, number>();
  for (const step of quest.steps) {
    if (step.type === 'kill') {
      for (const [monsterId, required] of Object.entries(step.targets)) {
        if (typeof required !== 'number') continue;
        killRequirements.set(getOrCreateEntity(db, 'monster', monsterId), required);
      }
    } else if (step.type === 'turn_in') {
      for (const [item, quantity] of Object.entries(step.requiredItems ?? {})) {
        if (typeof quantity === 'number') requiredItems.set(item, quantity);
      }
    } else if (step.type === 'gather') {
      for (const [item, quantity] of Object.entries(step.targets)) {
        if (typeof quantity === 'number') requiredItems.set(item, quantity);
      }
    }
  }

  deleteStaleQuestRows(
    db,
    'quest_kill_requirements',
    'monster_entity_id',
    startNpcId,
    quest.id,
    Array.from(killRequirements.keys()),
  );
  const upsertKillRequirement = db.prepare(
    `INSERT INTO quest_kill_requirements (start_npc_id, quest_id, monster_entity_id, required)
     VALUES (@startNpcId, @questId, @monsterEntityId, @required)
     ON CONFLICT(start_npc_id, quest_id, monster_entity_id) DO UPDATE SET required = excluded.required`,
  );
  for (const [monsterEntityId, required] of Array.from(killRequirements)) {
    upsertKillRequirement.run({ startNpcId, questId: quest.id, monsterEntityId, required });
  }

  deleteStaleQuestRows(
    db,
    'quest_required_items',
    'item',
    startNpcId,
    quest.id,
    Array.from(requiredItems.keys()),
  );
  const upsertRequiredItem = db.prepare(
    `INSERT INTO quest_required_items (start_npc_id, quest_id, item, quantity)
     VALUES (@startNpcId, @questId, @item, @quantity)
     ON CONFLICT(start_npc_id, quest_id, item) DO UPDATE SET quantity = excluded.quantity`,
  );
  for (const [item, quantity] of Array.from(requiredItems)) {
    upsertRequiredItem.run({ startNpcId, questId: quest.id, item, quantity });
  }
};

/**
 * Records the turn-in NPC from an ActiveQuest sighting — the one fact only
 * ActiveQuest carries that AvailableQuest can't. Update-only: if the quest
 * has no existing row (never seen as an AvailableQuest), this is a no-op
 * rather than fabricating a placeholder quest record just to hang an
 * end_npc_id on.
 */
export const recordQuestEndNpc = (
  db: Database.Database,
  quest: ActiveQuest,
  endNpcName: string | null,
  now: number,
): void => {
  const existing = db
    .prepare('SELECT start_npc_id FROM quests WHERE quest_id = ?')
    .get(quest.id) as { start_npc_id: number } | undefined;
  if (!existing) return;
  const endNpcId = endNpcName ? getOrCreateEntity(db, 'npc', endNpcName) : null;
  db.prepare(
    `UPDATE quests SET end_npc_id = COALESCE(@endNpcId, end_npc_id), last_seen_at = @now
     WHERE start_npc_id = @startNpcId AND quest_id = @questId`,
  ).run({ startNpcId: existing.start_npc_id, endNpcId, questId: quest.id, now });
};

/** Marks a quest completed. Neither ActiveQuest nor AvailableQuest carries a "done" flag themselves — the caller must call this explicitly when a turn-in succeeds. */
export const recordQuestCompleted = (
  db: Database.Database,
  questId: string,
  now: number,
): void => {
  const existing = db
    .prepare('SELECT start_npc_id FROM quests WHERE quest_id = ?')
    .get(questId) as { start_npc_id: number } | undefined;
  if (!existing) return;
  db.prepare(
    `UPDATE quests SET status = 'completed', last_seen_at = @now
     WHERE start_npc_id = @startNpcId AND quest_id = @questId`,
  ).run({ startNpcId: existing.start_npc_id, questId, now });
};

type QuestRow = {
  start_npc_id: number;
  quest_id: string;
  end_npc_id: number | null;
  name: string;
  repeatable: number;
  status: QuestSightingStatus;
  last_seen_at: number;
};

const buildQuestRecord = (db: Database.Database, row: QuestRow): QuestRecord => {
  const rewardItems: Partial<Record<Items, number>> = {};
  for (const r of db
    .prepare('SELECT item, quantity FROM quest_reward_items WHERE start_npc_id = ? AND quest_id = ?')
    .all(row.start_npc_id, row.quest_id) as { item: Items; quantity: number }[]) {
    rewardItems[r.item] = r.quantity;
  }

  const killRequirements = (db
    .prepare('SELECT monster_entity_id, required FROM quest_kill_requirements WHERE start_npc_id = ? AND quest_id = ?')
    .all(row.start_npc_id, row.quest_id) as { monster_entity_id: number; required: number }[])
    .map((r) => ({ monsterEntityId: r.monster_entity_id, required: r.required }));

  const requiredItems: Partial<Record<Items, number>> = {};
  for (const r of db
    .prepare('SELECT item, quantity FROM quest_required_items WHERE start_npc_id = ? AND quest_id = ?')
    .all(row.start_npc_id, row.quest_id) as { item: Items; quantity: number }[]) {
    requiredItems[r.item] = r.quantity;
  }

  return {
    questId: row.quest_id,
    name: row.name,
    startNpcId: row.start_npc_id,
    endNpcId: row.end_npc_id,
    repeatable: Boolean(row.repeatable),
    status: row.status,
    rewardItems,
    killRequirements,
    requiredItems,
    lastSeenAt: row.last_seen_at,
  };
};

export const getQuestSighting = (
  db: Database.Database,
  npcName: string,
  questId: string,
): QuestRecord | null => {
  const entity = getEntity(db, 'npc', npcName);
  if (!entity) return null;
  const row = db
    .prepare('SELECT * FROM quests WHERE start_npc_id = ? AND quest_id = ?')
    .get(entity.id, questId) as QuestRow | undefined;
  return row ? buildQuestRecord(db, row) : null;
};

export const getKnownQuestsForNpc = (db: Database.Database, npcName: string): QuestRecord[] => {
  const entity = getEntity(db, 'npc', npcName);
  if (!entity) return [];
  return (db
    .prepare('SELECT * FROM quests WHERE start_npc_id = ?')
    .all(entity.id) as QuestRow[])
    .map((row) => buildQuestRecord(db, row));
};
