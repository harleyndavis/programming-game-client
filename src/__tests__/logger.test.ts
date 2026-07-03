import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pruneDirectory } from '../logger';

const makeTempDir = (): string => mkdtempSync(join(tmpdir(), 'logger-test-'));

const touch = (dir: string, name: string, ageMs: number): void => {
  const path = join(dir, name);
  writeFileSync(path, '');
  const mtime = new Date(Date.now() - ageMs);
  utimesSync(path, mtime, mtime);
};

describe('pruneDirectory', () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });
  const track = (dir: string): string => { dirs.push(dir); return dir; };

  it('keeps all files when under both limits', () => {
    const dir = track(makeTempDir());
    touch(dir, 'a.log', 1000);
    touch(dir, 'b.log', 2000);
    pruneDirectory(dir, 10, 60_000);
    expect(readdirSync(dir).sort()).toEqual(['a.log', 'b.log']);
  });

  it('deletes the oldest files beyond maxFiles', () => {
    const dir = track(makeTempDir());
    touch(dir, 'newest.log', 1000);
    touch(dir, 'middle.log', 2000);
    touch(dir, 'oldest.log', 3000);
    pruneDirectory(dir, 2, Number.POSITIVE_INFINITY);
    expect(readdirSync(dir).sort()).toEqual(['middle.log', 'newest.log']);
  });

  it('deletes files older than maxAgeMs regardless of count', () => {
    const dir = track(makeTempDir());
    touch(dir, 'fresh.log', 1000);
    touch(dir, 'stale.log', 10 * 24 * 60 * 60 * 1000);
    pruneDirectory(dir, Number.POSITIVE_INFINITY, 7 * 24 * 60 * 60 * 1000);
    expect(readdirSync(dir).sort()).toEqual(['fresh.log']);
  });

  it('applies whichever limit is stricter', () => {
    const dir = track(makeTempDir());
    touch(dir, 'a.log', 1000);
    touch(dir, 'b.log', 2000);
    touch(dir, 'c.log', 10 * 24 * 60 * 60 * 1000);
    pruneDirectory(dir, 2, 7 * 24 * 60 * 60 * 1000);
    expect(readdirSync(dir).sort()).toEqual(['a.log', 'b.log']);
  });

  it('does not throw when the directory does not exist', () => {
    expect(() => pruneDirectory(join(tmpdir(), 'does-not-exist-xyz'), 5, 1000)).not.toThrow();
  });
});
