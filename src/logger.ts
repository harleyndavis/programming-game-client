import { appendFileSync, closeSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';

export type LogCtx = 'overworld' | 'arena';
export type LogLevel = 'info' | 'warn';

export type TickEntry = {
  ts: string;
  level: LogLevel;
  ctx: LogCtx;
  pos: { x: number; y: number };
  hp: number;
  maxHp: number;
  calories: number;
  weight: number;
  decision: string;
  [key: string]: unknown;
};

export type DeathSnapshot = {
  ts: string;
  ctx: LogCtx;
  hp: number;
  pos: { x: number; y: number };
  calories: number;
  weight: number;
  equipment: Record<string, string | null | undefined>;
  inventory: Partial<Record<string, number>>;
  statusEffects: string[];
  lastDecision: string | null;
  nearbyMonsters: Array<{ id: string; hp?: number; distance: number }>;
  nearbyNpcs: Array<{ id: string; distance: number }>;
  causeOfDeath: 'combat' | 'starvation' | 'unknown';
  recentTicks: TickEntry[];
};

const LOG_DIR = process.env.LOG_DIR ?? process.cwd();
const OVERWORLD_LOG = join(LOG_DIR, 'overworld.log');
const ARENA_LOG = join(LOG_DIR, 'arena.log');
const DEATHS_DIR = join(LOG_DIR, 'deaths');

export const TICK_BUFFER_SIZE = 60;
const overworldTickBuffer: TickEntry[] = [];
const arenaTickBuffer: TickEntry[] = [];

const warmBuffer = (buffer: TickEntry[], logPath: string): void => {
  try {
    const stats = statSync(logPath);
    const chunkSize = Math.min(stats.size, 65536);
    const buf = Buffer.alloc(chunkSize);
    const fd = openSync(logPath, 'r');
    readSync(fd, buf, 0, chunkSize, stats.size - chunkSize);
    closeSync(fd);
    for (const line of buf.toString('utf8').split('\n').slice(-TICK_BUFFER_SIZE)) {
      try {
        const entry = JSON.parse(line) as TickEntry;
        if (entry.ts && entry.ctx && entry.decision) buffer.push(entry);
      } catch { /* skip partial/malformed lines at chunk boundary */ }
    }
  } catch { /* log doesn't exist yet on first run */ }
};

warmBuffer(overworldTickBuffer, OVERWORLD_LOG);
warmBuffer(arenaTickBuffer, ARENA_LOG);

// Extras queued outside the tick (e.g. config changes) are flushed into the next tick entry.
let pendingExtras: Record<string, unknown> = {};

export const addExtra = (key: string, value: unknown): void => {
  pendingExtras[key] = value;
};

const formatNumbers = (value: unknown): unknown => {
  if (typeof value === 'number') return value.toFixed(2);
  if (Array.isArray(value)) return value.map(formatNumbers);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>))
      out[k] = formatNumbers(v);
    return out;
  }
  return value;
};

const append = (path: string, entry: Record<string, unknown>): void => {
  try {
    appendFileSync(path, JSON.stringify(formatNumbers(entry)) + '\n', 'utf8');
  } catch { /* don't crash bot on log write failure */ }
};

type TickInput = {
  ctx: LogCtx;
  pos: { x: number; y: number };
  hp: number;
  maxHp: number;
  calories: number;
  weight: number;
  decision: string;
  level?: LogLevel;
};

export const tick = (entry: TickInput & Record<string, unknown>): TickEntry => {
  const typed = entry as TickInput;
  const record: TickEntry = {
    ts: new Date().toISOString(),
    level: typed.level ?? 'info',
    ctx: typed.ctx,
    pos: typed.pos,
    hp: typed.hp,
    maxHp: typed.maxHp,
    calories: typed.calories,
    weight: typed.weight,
    decision: typed.decision,
  };
  for (const [k, v] of Object.entries(entry)) {
    if (!(k in record)) (record as Record<string, unknown>)[k] = v;
  }
  const extras = pendingExtras;
  pendingExtras = {};
  Object.assign(record, extras);

  const buffer = record.ctx === 'arena' ? arenaTickBuffer : overworldTickBuffer;
  if (buffer.length >= TICK_BUFFER_SIZE) buffer.shift();
  buffer.push(record);

  append(record.ctx === 'arena' ? ARENA_LOG : OVERWORLD_LOG, record as Record<string, unknown>);
  return record;
};

export const writeDeathSnapshot = (snapshot: Omit<DeathSnapshot, 'ts' | 'recentTicks'>): void => {
  try {
    mkdirSync(DEATHS_DIR, { recursive: true });
    const now = new Date();
    // YYYY-MM-DD_HH-MM-SS
    const name = now.toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-');
    const buffer = snapshot.ctx === 'arena' ? arenaTickBuffer : overworldTickBuffer;
    const full: DeathSnapshot = {
      ts: now.toISOString(),
      ...snapshot,
      recentTicks: [...buffer],
    };
    writeFileSync(join(DEATHS_DIR, `${name}.json`), JSON.stringify(formatNumbers(full), null, 2), 'utf8');
    buffer.length = 0;
  } catch { /* don't crash bot on snapshot write failure */ }
};
