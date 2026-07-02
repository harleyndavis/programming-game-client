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

CREATE TABLE IF NOT EXISTS merchants (
  name          TEXT    PRIMARY KEY,
  x             REAL    NOT NULL,
  y             REAL    NOT NULL,
  last_seen_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS merchant_prices (
  merchant_name  TEXT    NOT NULL REFERENCES merchants(name),
  item           TEXT    NOT NULL,
  buy_price      INTEGER,
  buy_qty        INTEGER,
  sell_price     INTEGER,
  sell_qty       INTEGER,
  last_seen_at   INTEGER NOT NULL,
  PRIMARY KEY (merchant_name, item)
);

CREATE TABLE IF NOT EXISTS explored_cells (
  cell_x         INTEGER NOT NULL,
  cell_y         INTEGER NOT NULL,
  sight_range    REAL    NOT NULL,
  last_seen_at   INTEGER NOT NULL,
  PRIMARY KEY (cell_x, cell_y)
);

CREATE TABLE IF NOT EXISTS heat_map (
  entity_type        TEXT    NOT NULL,
  entity_name        TEXT    NOT NULL,
  x                  INTEGER NOT NULL,
  y                  INTEGER NOT NULL,
  observation_count  INTEGER NOT NULL DEFAULT 1,
  last_seen_at       INTEGER NOT NULL,
  PRIMARY KEY (entity_type, entity_name, x, y)
);

CREATE TABLE IF NOT EXISTS combat_history (
  monster_id             TEXT    PRIMARY KEY,
  monster_hp             INTEGER NOT NULL DEFAULT 0,
  kill_count             INTEGER NOT NULL DEFAULT 0,
  hits_received          INTEGER NOT NULL DEFAULT 0,
  total_damage_received  INTEGER NOT NULL DEFAULT 0,
  last_updated_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS monster_kills (
  monster_id       TEXT    PRIMARY KEY,
  total_kills      INTEGER NOT NULL DEFAULT 0,
  last_updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS drop_counts (
  monster_id     TEXT    NOT NULL REFERENCES monster_kills(monster_id),
  item           TEXT    NOT NULL,
  count          INTEGER NOT NULL DEFAULT 0,
  last_seen_at   INTEGER NOT NULL,
  PRIMARY KEY (monster_id, item)
);

CREATE TABLE IF NOT EXISTS quests (
  npc_name      TEXT    NOT NULL,
  quest_id      TEXT    NOT NULL,
  status        TEXT    NOT NULL,
  quest_json    TEXT    NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  PRIMARY KEY (npc_name, quest_id)
);
`;

const migrate = (db: Database.Database): void => {
  db.exec(SCHEMA_SQL);
  const row = db.prepare('SELECT version FROM schema_version').get();
  if (!row) {
    db.prepare('INSERT INTO schema_version (version) VALUES (1)').run();
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

const toSafeLocation = (row: any): SafeLocation => ({
  name: row.name,
  type: row.type,
  position: { x: row.x, y: row.y },
  firstSeenAt: row.first_seen_at,
  lastSeenAt: row.last_seen_at,
});

export const getSafeLocations = (db: Database.Database): SafeLocation[] =>
  db.prepare('SELECT * FROM safe_locations').all().map(toSafeLocation);

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

// ── Merchant knowledge ───────────────────────────────────────────────────

export type MerchantPriceOffer = {
  merchantName: string;
  position: Position;
  buying: { price: number; quantity: number } | undefined;
  selling: { price: number; quantity: number } | undefined;
};

/** Records a merchant's position and every item it's currently seen buying/selling. */
export const recordMerchant = (db: Database.Database, npc: ClientSideNPC, now: number): void => {
  db.prepare(
    `INSERT INTO merchants (name, x, y, last_seen_at)
     VALUES (@name, @x, @y, @now)
     ON CONFLICT(name) DO UPDATE SET x = excluded.x, y = excluded.y, last_seen_at = excluded.last_seen_at`,
  ).run({ name: npc.name, x: npc.position.x, y: npc.position.y, now });

  const buying = npc.trades?.buying ?? {};
  const selling = npc.trades?.selling ?? {};
  const items = new Set<string>([...Object.keys(buying), ...Object.keys(selling)]);

  const upsertPrice = db.prepare(
    `INSERT INTO merchant_prices (merchant_name, item, buy_price, buy_qty, sell_price, sell_qty, last_seen_at)
     VALUES (@merchantName, @item, @buyPrice, @buyQty, @sellPrice, @sellQty, @now)
     ON CONFLICT(merchant_name, item) DO UPDATE SET
       buy_price = COALESCE(excluded.buy_price, merchant_prices.buy_price),
       buy_qty = COALESCE(excluded.buy_qty, merchant_prices.buy_qty),
       sell_price = COALESCE(excluded.sell_price, merchant_prices.sell_price),
       sell_qty = COALESCE(excluded.sell_qty, merchant_prices.sell_qty),
       last_seen_at = excluded.last_seen_at`,
  );

  for (const item of Array.from(items)) {
    const buyOffer = (buying as Record<string, { price: number; quantity: number } | undefined>)[item];
    const sellOffer = (selling as Record<string, { price: number; quantity: number } | undefined>)[item];
    upsertPrice.run({
      merchantName: npc.name,
      item,
      buyPrice: buyOffer?.price ?? null,
      buyQty: buyOffer?.quantity ?? null,
      sellPrice: sellOffer?.price ?? null,
      sellQty: sellOffer?.quantity ?? null,
      now,
    });
  }
};

export const getMerchantPrices = (db: Database.Database, item: Items): MerchantPriceOffer[] =>
  db
    .prepare(
      `SELECT mp.merchant_name, mp.buy_price, mp.buy_qty, mp.sell_price, mp.sell_qty, m.x, m.y
       FROM merchant_prices mp
       JOIN merchants m ON m.name = mp.merchant_name
       WHERE mp.item = ?`,
    )
    .all(item)
    .map((row: any) => ({
      merchantName: row.merchant_name,
      position: { x: row.x, y: row.y },
      buying: row.buy_price != null ? { price: row.buy_price, quantity: row.buy_qty } : undefined,
      selling: row.sell_price != null ? { price: row.sell_price, quantity: row.sell_qty } : undefined,
    }));

// ── Explored cells ───────────────────────────────────────────────────────

export type ExploredCell = {
  cellX: number;
  cellY: number;
  sightRange: number;
  lastSeenAt: number;
};

const cellCoordsFor = (position: Position, cellSize: number): { cellX: number; cellY: number } => ({
  cellX: Math.floor(position.x / cellSize),
  cellY: Math.floor(position.y / cellSize),
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
  db
    .prepare('SELECT * FROM explored_cells')
    .all()
    .map((row: any) => ({
      cellX: row.cell_x,
      cellY: row.cell_y,
      sightRange: row.sight_range,
      lastSeenAt: row.last_seen_at,
    }));

// ── World heat map ───────────────────────────────────────────────────────
// Every sighting starts as an expiring observation and earns confidence
// through re-confirmation — there's no separate "permanent fixture" table,
// since whether resources/stations relocate on respawn isn't confirmed yet.

export type HeatMapEntityType = 'monster' | 'npc' | 'resource' | 'station';

export type HeatMapSighting = {
  entityType: HeatMapEntityType;
  entityName: string;
  position: Position;
  observationCount: number;
  lastSeenAt: number;
};

const recordSighting = (
  db: Database.Database,
  entityType: HeatMapEntityType,
  entityName: string,
  position: Position,
  now: number,
): void => {
  const x = Math.floor(position.x);
  const y = Math.floor(position.y);
  db.prepare(
    `INSERT INTO heat_map (entity_type, entity_name, x, y, observation_count, last_seen_at)
     VALUES (@entityType, @entityName, @x, @y, 1, @now)
     ON CONFLICT(entity_type, entity_name, x, y) DO UPDATE SET
       observation_count = observation_count + 1,
       last_seen_at = excluded.last_seen_at`,
  ).run({ entityType, entityName, x, y, now });
};

/** Records a monster sighting, keyed by the SDK's `monsterId` — never a bot-invented label. */
export const recordMonsterSighting = (db: Database.Database, monster: ClientSideMonster, now: number): void =>
  recordSighting(db, 'monster', monster.monsterId, monster.position, now);

/** Records an NPC sighting, keyed by its `npcType` (e.g. 'healer', 'merchant'). */
export const recordNpcSighting = (db: Database.Database, npc: ClientSideNPC, now: number): void =>
  recordSighting(db, 'npc', npc.npcType, npc.position, now);

const resourceSightingParts = (
  object: GameObject,
): { entityType: HeatMapEntityType; entityName: string } => {
  switch (object.type) {
    case 'tree':
      return { entityType: 'resource', entityName: object.treeType };
    case 'miningNode':
      return { entityType: 'resource', entityName: object.oreType };
    case 'station':
      return { entityType: 'station', entityName: object.stationSubtype };
    default:
      return { entityType: 'resource', entityName: object.type };
  }
};

/** Records a resource/station sighting from a raw `GameObject` — tree, mining node, or crafting station. */
export const recordResourceSighting = (db: Database.Database, object: GameObject, now: number): void => {
  const { entityType, entityName } = resourceSightingParts(object);
  recordSighting(db, entityType, entityName, object.position, now);
};

export const getHeatMapSightings = (
  db: Database.Database,
  filter: { entityType?: HeatMapEntityType; entityName?: string } = {},
): HeatMapSighting[] => {
  const clauses: string[] = [];
  const params: Record<string, string> = {};
  if (filter.entityType) {
    clauses.push('entity_type = @entityType');
    params.entityType = filter.entityType;
  }
  if (filter.entityName) {
    clauses.push('entity_name = @entityName');
    params.entityName = filter.entityName;
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  return db
    .prepare(`SELECT * FROM heat_map ${where}`)
    .all(params)
    .map((row: any) => ({
      entityType: row.entity_type,
      entityName: row.entity_name,
      position: { x: row.x, y: row.y },
      observationCount: row.observation_count,
      lastSeenAt: row.last_seen_at,
    }));
};

// ── Combat history ───────────────────────────────────────────────────────

export type CombatStats = {
  monsterId: Monsters;
  monsterHp: number;
  killCount: number;
  hitsReceived: number;
  totalDamageReceived: number;
  /** Computed at query time, not stored — see issue #6. */
  avgDamagePerHit: number;
  lastUpdatedAt: number;
};

/** Records one hit the player took from `monsterId`, and the monster's latest known HP. */
export const recordCombatHit = (
  db: Database.Database,
  monsterId: Monsters,
  monsterHp: number,
  damageToPlayer: number,
  now: number,
): void => {
  db.prepare(
    `INSERT INTO combat_history (monster_id, monster_hp, kill_count, hits_received, total_damage_received, last_updated_at)
     VALUES (@monsterId, @monsterHp, 0, 1, @damageToPlayer, @now)
     ON CONFLICT(monster_id) DO UPDATE SET
       monster_hp = excluded.monster_hp,
       hits_received = hits_received + 1,
       total_damage_received = total_damage_received + excluded.total_damage_received,
       last_updated_at = excluded.last_updated_at`,
  ).run({ monsterId, monsterHp, damageToPlayer, now });
};

/** Records a kill, bumping both survivability tracking (combat_history) and the drop-rate denominator (monster_kills). */
export const recordMonsterKill = (db: Database.Database, monsterId: Monsters, now: number): void => {
  db.prepare(
    `INSERT INTO combat_history (monster_id, monster_hp, kill_count, hits_received, total_damage_received, last_updated_at)
     VALUES (@monsterId, 0, 1, 0, 0, @now)
     ON CONFLICT(monster_id) DO UPDATE SET
       kill_count = kill_count + 1,
       last_updated_at = excluded.last_updated_at`,
  ).run({ monsterId, now });

  db.prepare(
    `INSERT INTO monster_kills (monster_id, total_kills, last_updated_at)
     VALUES (@monsterId, 1, @now)
     ON CONFLICT(monster_id) DO UPDATE SET
       total_kills = total_kills + 1,
       last_updated_at = excluded.last_updated_at`,
  ).run({ monsterId, now });
};

export const getCombatHistory = (db: Database.Database, monsterId: Monsters): CombatStats | null => {
  const row = db.prepare('SELECT * FROM combat_history WHERE monster_id = ?').get(monsterId) as any;
  if (!row) return null;
  return {
    monsterId: row.monster_id,
    monsterHp: row.monster_hp,
    killCount: row.kill_count,
    hitsReceived: row.hits_received,
    totalDamageReceived: row.total_damage_received,
    avgDamagePerHit: row.hits_received > 0 ? row.total_damage_received / row.hits_received : 0,
    lastUpdatedAt: row.last_updated_at,
  };
};

// ── Drop tables ──────────────────────────────────────────────────────────

export type DropRate = {
  item: Items;
  count: number;
  dropRate: number;
};

/** Records loot drops from a kill — `items` is the SDK's own `loot` event shape. */
export const recordDrop = (
  db: Database.Database,
  monsterId: Monsters,
  items: Partial<Record<Items, number>>,
  now: number,
): void => {
  const upsert = db.prepare(
    `INSERT INTO drop_counts (monster_id, item, count, last_seen_at)
     VALUES (@monsterId, @item, @count, @now)
     ON CONFLICT(monster_id, item) DO UPDATE SET
       count = count + excluded.count,
       last_seen_at = excluded.last_seen_at`,
  );
  for (const [item, count] of Object.entries(items)) {
    if (typeof count !== 'number' || count <= 0) continue;
    upsert.run({ monsterId, item, count, now });
  }
};

/** Drop rate per item = accumulated count / total kills, computed at query time — see issue #6. */
export const getDropRates = (db: Database.Database, monsterId: Monsters): DropRate[] => {
  const kills = db
    .prepare('SELECT total_kills FROM monster_kills WHERE monster_id = ?')
    .get(monsterId) as { total_kills: number } | undefined;
  if (!kills || kills.total_kills <= 0) return [];
  return db
    .prepare('SELECT item, count FROM drop_counts WHERE monster_id = ? ORDER BY item')
    .all(monsterId)
    .map((row: any) => ({
      item: row.item,
      count: row.count,
      dropRate: row.count / kills.total_kills,
    }));
};

// ── Quests ───────────────────────────────────────────────────────────────
// Keyed by giving NPC rather than a position — quests aren't a geographic
// fact. The SDK quest object is persisted verbatim (as JSON) and rehydrated
// on read, rather than re-derived into a bespoke requirements/reward schema.

export type AvailableQuest = ClientSideNPC['availableQuests'][string];

export type QuestSightingStatus = 'available' | 'active';

export type QuestSighting = {
  npcName: string;
  questId: string;
  status: QuestSightingStatus;
  quest: ActiveQuest | AvailableQuest;
  lastSeenAt: number;
};

export const recordQuestSighting = (
  db: Database.Database,
  npcName: string,
  quest: ActiveQuest | AvailableQuest,
  status: QuestSightingStatus,
  now: number,
): void => {
  db.prepare(
    `INSERT INTO quests (npc_name, quest_id, status, quest_json, last_seen_at)
     VALUES (@npcName, @questId, @status, @questJson, @now)
     ON CONFLICT(npc_name, quest_id) DO UPDATE SET
       status = excluded.status,
       quest_json = excluded.quest_json,
       last_seen_at = excluded.last_seen_at`,
  ).run({ npcName, questId: quest.id, status, questJson: JSON.stringify(quest), now });
};

const toQuestSighting = (row: any): QuestSighting => ({
  npcName: row.npc_name,
  questId: row.quest_id,
  status: row.status,
  quest: JSON.parse(row.quest_json),
  lastSeenAt: row.last_seen_at,
});

export const getQuestSighting = (
  db: Database.Database,
  npcName: string,
  questId: string,
): QuestSighting | null => {
  const row = db
    .prepare('SELECT * FROM quests WHERE npc_name = ? AND quest_id = ?')
    .get(npcName, questId);
  return row ? toQuestSighting(row) : null;
};

export const getKnownQuestsForNpc = (db: Database.Database, npcName: string): QuestSighting[] =>
  db.prepare('SELECT * FROM quests WHERE npc_name = ?').all(npcName).map(toQuestSighting);
