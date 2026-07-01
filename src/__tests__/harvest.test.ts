import { describe, it, expect } from 'vitest';
import {
  isHarvestWeaponType,
  collectHarvestToolItemIds,
  getHarvestableTarget,
  getMissingHarvestToolIds,
} from '../harvest';

describe('isHarvestWeaponType', () => {
  it('returns true for fellingAxe', () => {
    expect(isHarvestWeaponType('fellingAxe')).toBe(true);
  });

  it('returns true for pickaxe', () => {
    expect(isHarvestWeaponType('pickaxe')).toBe(true);
  });

  it('returns false for other weapon types', () => {
    expect(isHarvestWeaponType('oneHandedSword')).toBe(false);
    expect(isHarvestWeaponType('bow')).toBe(false);
    expect(isHarvestWeaponType('staff')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isHarvestWeaponType('')).toBe(false);
  });
});

describe('collectHarvestToolItemIds', () => {
  it('returns item IDs with fellingAxe type', () => {
    const result = collectHarvestToolItemIds({
      stoneFellingAxe: { type: 'fellingAxe' },
    });
    expect(result.has('stoneFellingAxe')).toBe(true);
  });

  it('returns item IDs with pickaxe type', () => {
    const result = collectHarvestToolItemIds({
      stonePickaxe: { type: 'pickaxe' },
    });
    expect(result.has('stonePickaxe')).toBe(true);
  });

  it('returns both fellingAxe and pickaxe items', () => {
    const result = collectHarvestToolItemIds({
      stoneFellingAxe: { type: 'fellingAxe' },
      copperFellingAxe: { type: 'fellingAxe' },
      stonePickaxe: { type: 'pickaxe' },
      copperPickaxe: { type: 'pickaxe' },
      copperSword: { type: 'oneHandedSword' },
    });
    expect(result.size).toBe(4);
    expect(result.has('stoneFellingAxe')).toBe(true);
    expect(result.has('copperFellingAxe')).toBe(true);
    expect(result.has('stonePickaxe')).toBe(true);
    expect(result.has('copperPickaxe')).toBe(true);
    expect(result.has('copperSword')).toBe(false);
  });

  it('returns empty set for empty items', () => {
    expect(collectHarvestToolItemIds({}).size).toBe(0);
  });

  it('skips items without a type field', () => {
    const result = collectHarvestToolItemIds({
      stoneFellingAxe: {},
    });
    expect(result.size).toBe(0);
  });
});

describe('getHarvestableTarget', () => {
  const items = {
    stoneFellingAxe: { type: 'fellingAxe' },
    stonePickaxe: { type: 'pickaxe' },
    copperSword: { type: 'oneHandedSword' },
  };

  const pos = { x: 0, y: 0 };

  it('returns null when no game objects exist', () => {
    expect(getHarvestableTarget({}, {}, items, pos)).toBeNull();
  });

  it('returns null when no weapon is equipped', () => {
    const objects = {
      tree1: { id: 'tree1', type: 'tree', treeType: 'pine', position: { x: 5, y: 0 }, label: 'pine', radius: 1 },
    };
    expect(getHarvestableTarget(objects as any, {}, items, pos)).toBeNull();
  });

  it('returns null when wrong weapon type is equipped', () => {
    const objects = {
      tree1: { id: 'tree1', type: 'tree', treeType: 'pine', position: { x: 5, y: 0 }, label: 'pine', radius: 1 },
    };
    const equipment = { weapon: 'copperSword' };
    expect(getHarvestableTarget(objects as any, equipment, items, pos)).toBeNull();
  });

  it('returns nearest tree when fellingAxe equipped', () => {
    const objects = {
      tree1: { id: 'tree1', type: 'tree', treeType: 'pine', position: { x: 5, y: 0 }, label: 'pine', radius: 1 },
      tree2: { id: 'tree2', type: 'tree', treeType: 'oak', position: { x: 10, y: 0 }, label: 'oak', radius: 1 },
    };
    const equipment = { weapon: 'stoneFellingAxe' };
    const result = getHarvestableTarget(objects as any, equipment, items, pos);
    expect(result).not.toBeNull();
    expect(result!.target.id).toBe('tree1');
    expect(result!.distance).toBe(5);
  });

  it('returns nearest mining node when pickaxe equipped', () => {
    const objects = {
      node1: { id: 'node1', type: 'miningNode', oreType: 'copper', position: { x: 3, y: 4 }, label: 'copper', radius: 1 },
      node2: { id: 'node2', type: 'miningNode', oreType: 'iron', position: { x: 8, y: 0 }, label: 'iron', radius: 1 },
    };
    const equipment = { weapon: 'stonePickaxe' };
    const result = getHarvestableTarget(objects as any, equipment, items, pos);
    expect(result).not.toBeNull();
    expect(result!.target.id).toBe('node1');
    expect(result!.distance).toBe(5);
  });

  it('returns the closest harvestable object regardless of type', () => {
    const objects = {
      tree1: { id: 'tree1', type: 'tree', treeType: 'pine', position: { x: 5, y: 0 }, label: 'pine', radius: 1 },
      node1: { id: 'node1', type: 'miningNode', oreType: 'copper', position: { x: 10, y: 0 }, label: 'copper', radius: 1 },
    };
    const equipment = { weapon: 'stoneFellingAxe' };
    const result = getHarvestableTarget(objects as any, equipment, items, pos);
    expect(result).not.toBeNull();
    expect(result!.target.id).toBe('tree1');
  });

  it('skips objects without valid position', () => {
    const objects = {
      tree1: { id: 'tree1', type: 'tree', treeType: 'pine', position: null, label: 'pine', radius: 1 },
    };
    const equipment = { weapon: 'stoneFellingAxe' };
    expect(getHarvestableTarget(objects as any, equipment, items, pos)).toBeNull();
  });
});

describe('getMissingHarvestToolIds', () => {
  const items = {
    stoneFellingAxe: { type: 'fellingAxe' },
    copperFellingAxe: { type: 'fellingAxe' },
    stonePickaxe: { type: 'pickaxe' },
    copperPickaxe: { type: 'pickaxe' },
    copperSword: { type: 'oneHandedSword' },
  };

  it('returns all harvest tool IDs when none owned', () => {
    const result = getMissingHarvestToolIds({}, {}, items);
    expect(result).toContain('stoneFellingAxe');
    expect(result).toContain('stonePickaxe');
    expect(result).toContain('copperFellingAxe');
    expect(result).toContain('copperPickaxe');
    expect(result).not.toContain('copperSword');
  });

  it('does not return equipped items', () => {
    const result = getMissingHarvestToolIds({ weapon: 'stoneFellingAxe' }, {}, items);
    expect(result).not.toContain('stoneFellingAxe');
    expect(result).toContain('stonePickaxe');
  });

  it('does not return items in inventory', () => {
    const result = getMissingHarvestToolIds({}, { stonePickaxe: 1 }, items);
    expect(result).not.toContain('stonePickaxe');
    expect(result).toContain('stoneFellingAxe');
  });

  it('returns empty when all harvest tools are owned', () => {
    const equipment = { weapon: 'stoneFellingAxe' };
    const inventory = { stonePickaxe: 1, copperFellingAxe: 1, copperPickaxe: 1 };
    expect(getMissingHarvestToolIds(equipment, inventory, items)).toEqual([]);
  });

  it('returns empty set when items map is empty', () => {
    expect(getMissingHarvestToolIds({}, {}, {})).toEqual([]);
  });

  it('orders by tier with stone before copper', () => {
    const result = getMissingHarvestToolIds({}, {}, items);
    const stoneAxeIdx = result.indexOf('stoneFellingAxe');
    const stonePickIdx = result.indexOf('stonePickaxe');
    const copperAxeIdx = result.indexOf('copperFellingAxe');
    const copperPickIdx = result.indexOf('copperPickaxe');
    expect(Math.max(stoneAxeIdx, stonePickIdx)).toBeLessThan(Math.min(copperAxeIdx, copperPickIdx));
  });
});
