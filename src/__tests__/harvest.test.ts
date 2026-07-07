import { describe, it, expect } from 'vitest';
import {
  isHarvestWeaponType,
  collectHarvestToolItemIds,
  getHarvestableTarget,
  getMissingHarvestToolIds,
  collectHarvestCraftingChainToolIds,
  collectCraftableInputIngredients,
  findHarvestToolToEquip,
  findHarvestToolToWithdraw,
  TREE_TYPE_LOG_ITEM,
  ORE_TYPE_ITEM,
  KNOWN_HARVESTABLE_ITEMS,
} from '../harvest';
import type { RecipeList } from '../../bot-types';

describe('KNOWN_HARVESTABLE_ITEMS', () => {
  it('covers every tree/ore type guess', () => {
    expect(TREE_TYPE_LOG_ITEM.pine).toBe('pinewoodLog');
    expect(ORE_TYPE_ITEM.copper).toBe('copperOre');
    expect(ORE_TYPE_ITEM.coal).toBe('coalChunk');
    expect(KNOWN_HARVESTABLE_ITEMS.has('copperOre')).toBe(true);
    expect(KNOWN_HARVESTABLE_ITEMS.has('pinewoodLog')).toBe(true);
    expect(KNOWN_HARVESTABLE_ITEMS.has('ratPelt')).toBe(false);
  });
});

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

  it('prefers a farther node yielding a needed item over a nearer node that yields nothing needed', () => {
    const objects = {
      node1: { id: 'node1', type: 'miningNode', oreType: 'iron', position: { x: 3, y: 0 }, label: 'iron', radius: 1 },
      node2: { id: 'node2', type: 'miningNode', oreType: 'copper', position: { x: 10, y: 0 }, label: 'copper', radius: 1 },
    };
    const equipment = { weapon: 'stonePickaxe' };
    const result = getHarvestableTarget(objects as any, equipment, items, pos, new Set(['copperOre']));
    expect(result!.target.id).toBe('node2');
  });

  it('returns null (not the nearest irrelevant node) when there is an active need but nothing visible yields it', () => {
    // Regression: previously fell back to "nearest of any type," which meant
    // the bot would harvest resources it doesn't need just because they're
    // closer than the one it does — e.g. keep chopping unneeded logs while
    // actually short on ore, running itself encumbered on the wrong item.
    const objects = {
      node1: { id: 'node1', type: 'miningNode', oreType: 'iron', position: { x: 3, y: 0 }, label: 'iron', radius: 1 },
      node2: { id: 'node2', type: 'miningNode', oreType: 'tin', position: { x: 10, y: 0 }, label: 'tin', radius: 1 },
    };
    const equipment = { weapon: 'stonePickaxe' };
    const result = getHarvestableTarget(objects as any, equipment, items, pos, new Set(['copperOre']));
    expect(result).toBeNull();
  });

  it('behaves exactly as before when neededItems is omitted', () => {
    const objects = {
      tree1: { id: 'tree1', type: 'tree', treeType: 'pine', position: { x: 5, y: 0 }, label: 'pine', radius: 1 },
      node1: { id: 'node1', type: 'miningNode', oreType: 'copper', position: { x: 10, y: 0 }, label: 'copper', radius: 1 },
    };
    const equipment = { weapon: 'stoneFellingAxe' };
    const result = getHarvestableTarget(objects as any, equipment, items, pos);
    expect(result!.target.id).toBe('tree1');
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

describe('collectHarvestCraftingChainToolIds', () => {
  it('returns empty array when the tool has no recipe', () => {
    expect(collectHarvestCraftingChainToolIds(['unknownItem'], [])).toEqual([]);
  });

  it('collects a directly required tool', () => {
    const recipes: RecipeList = [
      { id: 'axe', input: { pinewoodAxeHandle: 1 }, output: { stoneFellingAxe: 1 }, required: ['stoneCarvingKnife'], station: null },
    ];
    const result = collectHarvestCraftingChainToolIds(['stoneFellingAxe'], recipes);
    expect(result).toContain('stoneCarvingKnife');
    expect(result).not.toContain('stoneFellingAxe');
  });

  it('recurses into a required tool\'s own required tool', () => {
    const recipes: RecipeList = [
      { id: 'axe', input: {}, output: { stoneFellingAxe: 1 }, required: ['stoneCarvingKnife'], station: null },
      { id: 'knife', input: { stone: 1 }, output: { stoneCarvingKnife: 1 }, required: ['stoneCutterTools'], station: null },
    ];
    const result = collectHarvestCraftingChainToolIds(['stoneFellingAxe'], recipes);
    expect(result).toContain('stoneCarvingKnife');
    expect(result).toContain('stoneCutterTools');
  });

  it('does not collect plain recipe.input ingredients, only recipe.required tools', () => {
    const recipes: RecipeList = [
      { id: 'axe', input: { pinewoodAxeHandle: 1 }, output: { stoneFellingAxe: 1 }, required: [], station: null },
      { id: 'handle', input: { pinewoodLog: 2 }, output: { pinewoodAxeHandle: 1 }, required: ['carvingTool'], station: null },
    ];
    const result = collectHarvestCraftingChainToolIds(['stoneFellingAxe'], recipes);
    expect(result).toEqual(['carvingTool']);
    expect(result).not.toContain('pinewoodAxeHandle');
    expect(result).not.toContain('pinewoodLog');
  });

  it('dedupes a shared required tool across multiple missing harvest tools', () => {
    const recipes: RecipeList = [
      { id: 'axe', input: {}, output: { stoneFellingAxe: 1 }, required: ['stoneCarvingKnife'], station: null },
      { id: 'pick', input: {}, output: { stonePickaxe: 1 }, required: ['stoneCarvingKnife'], station: null },
    ];
    const result = collectHarvestCraftingChainToolIds(['stoneFellingAxe', 'stonePickaxe'], recipes);
    expect(result.filter(id => id === 'stoneCarvingKnife')).toHaveLength(1);
  });

  it('ignores a station-gated tool recipe by default, but walks it once that station type is known', () => {
    const recipes: RecipeList = [
      { id: 'axe', input: {}, output: { stoneFellingAxe: 1 }, required: ['ironCarvingKnife'], station: null },
      { id: 'knife', input: { stone: 1 }, output: { ironCarvingKnife: 1 }, required: ['ironCutterTools'], station: 'smithing' },
    ];
    const without = collectHarvestCraftingChainToolIds(['stoneFellingAxe'], recipes);
    expect(without).toEqual(['ironCarvingKnife']);
    expect(without).not.toContain('ironCutterTools');

    const withKnowledge = collectHarvestCraftingChainToolIds(['stoneFellingAxe'], recipes, new Set(['smithing']));
    expect(withKnowledge).toContain('ironCarvingKnife');
    expect(withKnowledge).toContain('ironCutterTools');
  });
});

describe('collectCraftableInputIngredients', () => {
  it('returns empty for no target items', () => {
    expect(collectCraftableInputIngredients([], {}, [])).toEqual([]);
  });

  it('includes a craftable ingredient we are short on', () => {
    const recipes: RecipeList = [
      { id: 'axe', input: { pinewoodAxeHandle: 1, stone: 2 }, output: { stoneFellingAxe: 1 }, required: [], station: null },
      { id: 'handle', input: { pinewoodLog: 2 }, output: { pinewoodAxeHandle: 1 }, required: [], station: null },
    ];
    const result = collectCraftableInputIngredients(['stoneFellingAxe'], {}, recipes);
    // stone has no recipe (not craftable) so it's excluded; only the craftable shortfall is returned
    expect(result).toEqual(['pinewoodAxeHandle']);
  });

  it('excludes an ingredient already covered by inventory', () => {
    const recipes: RecipeList = [
      { id: 'axe', input: { pinewoodAxeHandle: 1 }, output: { stoneFellingAxe: 1 }, required: [], station: null },
      { id: 'handle', input: { pinewoodLog: 2 }, output: { pinewoodAxeHandle: 1 }, required: [], station: null },
    ];
    const result = collectCraftableInputIngredients(['stoneFellingAxe'], { pinewoodAxeHandle: 1 }, recipes);
    expect(result).toEqual([]);
  });

  it('orders deepest dependency before the item that needs it', () => {
    const recipes: RecipeList = [
      { id: 'top', input: { mid: 1 }, output: { top: 1 }, required: [], station: null },
      { id: 'midR', input: { deep: 1 }, output: { mid: 1 }, required: [], station: null },
      { id: 'deepR', input: { rawMaterial: 1 }, output: { deep: 1 }, required: [], station: null },
    ];
    const result = collectCraftableInputIngredients(['top'], {}, recipes);
    expect(result).toEqual(['deep', 'mid']);
  });

  it('includes a craftable ingredient reached through a required tool\'s own chain', () => {
    const recipes: RecipeList = [
      { id: 'top', input: {}, output: { top: 1 }, required: ['toolX'], station: null },
      { id: 'toolXR', input: { toolIngredient: 1 }, output: { toolX: 1 }, required: [], station: null },
      { id: 'ingredientR', input: {}, output: { toolIngredient: 1 }, required: [], station: null },
    ];
    const result = collectCraftableInputIngredients(['top'], {}, recipes);
    expect(result).toContain('toolIngredient');
  });

  it('dedupes an ingredient shared by multiple targets', () => {
    const recipes: RecipeList = [
      { id: 'axe', input: { pinewoodAxeHandle: 1 }, output: { stoneFellingAxe: 1 }, required: [], station: null },
      { id: 'pick', input: { pinewoodAxeHandle: 1 }, output: { stonePickaxe: 1 }, required: [], station: null },
      { id: 'handle', input: { pinewoodLog: 2 }, output: { pinewoodAxeHandle: 1 }, required: [], station: null },
    ];
    const result = collectCraftableInputIngredients(['stoneFellingAxe', 'stonePickaxe'], {}, recipes);
    expect(result).toEqual(['pinewoodAxeHandle']);
  });

  it('excludes a station-gated ingredient by default, but includes it once that station type is known', () => {
    const recipes: RecipeList = [
      { id: 'sword', input: { ironIngot: 1 }, output: { ironSword: 1 }, required: [], station: null },
      { id: 'ingotR', input: { ironOre: 2 }, output: { ironIngot: 1 }, required: [], station: 'smelting' },
    ];
    expect(collectCraftableInputIngredients(['ironSword'], {}, recipes)).toEqual([]);
    expect(collectCraftableInputIngredients(['ironSword'], {}, recipes, new Set(['smelting']))).toEqual(['ironIngot']);
  });
});

describe('findHarvestToolToEquip', () => {
  const items = {
    stoneFellingAxe: { type: 'fellingAxe' },
    copperFellingAxe: { type: 'fellingAxe' },
    stonePickaxe: { type: 'pickaxe' },
    copperSword: { type: 'oneHandedSword' },
  };

  it('returns null when nothing is needed', () => {
    expect(findHarvestToolToEquip(new Set(), { stonePickaxe: 1 }, {}, items)).toBeNull();
  });

  it('returns the owned pickaxe when ore is needed', () => {
    const result = findHarvestToolToEquip(new Set(['copperOre']), { stonePickaxe: 1 }, {}, items);
    expect(result).toEqual({ item: 'stonePickaxe', slot: 'weapon' });
  });

  it('returns the owned fellingAxe when a log is needed', () => {
    const result = findHarvestToolToEquip(new Set(['pinewoodLog']), { stoneFellingAxe: 1 }, {}, items);
    expect(result).toEqual({ item: 'stoneFellingAxe', slot: 'weapon' });
  });

  it('returns null when the equipped weapon already matches the need', () => {
    const equipment = { weapon: 'stonePickaxe' };
    const result = findHarvestToolToEquip(new Set(['copperOre']), { stonePickaxe: 1 }, equipment, items);
    expect(result).toBeNull();
  });

  it('returns null when no matching tool is owned', () => {
    const result = findHarvestToolToEquip(new Set(['copperOre']), {}, {}, items);
    expect(result).toBeNull();
  });

  it('prefers the higher-tier owned tool of the needed type', () => {
    const result = findHarvestToolToEquip(
      new Set(['pinewoodLog']), { stoneFellingAxe: 1, copperFellingAxe: 1 }, {}, items,
    );
    expect(result).toEqual({ item: 'copperFellingAxe', slot: 'weapon' });
  });

  it('does not switch away from a combat weapon when nothing is needed', () => {
    const equipment = { weapon: 'copperSword' };
    expect(findHarvestToolToEquip(new Set(), { stonePickaxe: 1 }, equipment, items)).toBeNull();
  });
});

describe('findHarvestToolToWithdraw', () => {
  const items = {
    stoneFellingAxe: { type: 'fellingAxe' },
    copperFellingAxe: { type: 'fellingAxe' },
    stonePickaxe: { type: 'pickaxe' },
    copperPickaxe: { type: 'pickaxe' },
    copperSword: { type: 'oneHandedSword' },
  };

  it('returns null when nothing is needed', () => {
    expect(findHarvestToolToWithdraw(new Set(), { stonePickaxe: 1 }, {}, {}, items)).toBeNull();
  });

  it('returns the pickaxe sitting in storage when ore is needed and none is owned in pocket', () => {
    const result = findHarvestToolToWithdraw(new Set(['copperOre']), { stonePickaxe: 1 }, {}, {}, items);
    expect(result).toEqual({ item: 'stonePickaxe' });
  });

  it('returns null when a matching tool is already owned in pocket (equip handles it, not withdraw)', () => {
    const result = findHarvestToolToWithdraw(
      new Set(['copperOre']), { stonePickaxe: 1 }, { stonePickaxe: 1 }, {}, items,
    );
    expect(result).toBeNull();
  });

  it('returns null when the equipped weapon already matches the need', () => {
    const equipment = { weapon: 'stonePickaxe' };
    const result = findHarvestToolToWithdraw(new Set(['copperOre']), { stonePickaxe: 1 }, {}, equipment, items);
    expect(result).toBeNull();
  });

  it('returns null when nothing matching is owned anywhere', () => {
    expect(findHarvestToolToWithdraw(new Set(['copperOre']), {}, {}, {}, items)).toBeNull();
  });

  it('prefers the higher-tier tool in storage', () => {
    const result = findHarvestToolToWithdraw(
      new Set(['pinewoodLog']), { stoneFellingAxe: 1, copperFellingAxe: 1 }, {}, {}, items,
    );
    expect(result).toEqual({ item: 'copperFellingAxe' });
  });

  it('does not fire for a combat weapon when nothing is needed', () => {
    const equipment = { weapon: 'copperSword' };
    expect(findHarvestToolToWithdraw(new Set(), { stonePickaxe: 1 }, {}, equipment, items)).toBeNull();
  });
});
