import { describe, it, expect } from 'vitest';
import { computeChainNeeds, getChainedIngredients, canObtainChain, computeDifficultyTier, findBlockingItems } from '../plan';
import type { RecipeList } from '../../bot-types';

const makeRecipe = (overrides: Partial<RecipeList[number]> = {}): RecipeList[number] => ({
  id: 'testRecipe',
  input: {},
  output: {},
  required: [],
  station: null,
  ...overrides,
});

describe('getChainedIngredients', () => {
  it('returns empty set when no recipe exists', () => {
    const result = getChainedIngredients('copperSword', []);
    expect(result.size).toBe(0);
  });

  it('collects direct recipe inputs', () => {
    const recipes: RecipeList = [
      makeRecipe({ id: 'r1', output: { copperSword: 1 }, input: { copperIngot: 3, stick: 1 } }),
    ];
    const result = getChainedIngredients('copperSword', recipes);
    expect(result.has('copperIngot')).toBe(true);
    expect(result.has('stick')).toBe(true);
    expect(result.size).toBe(2);
  });

  it('walks ingredient chains recursively', () => {
    const recipes: RecipeList = [
      makeRecipe({ id: 'r1', output: { copperSword: 1 }, input: { copperIngot: 3, stick: 1 } }),
      makeRecipe({ id: 'r2', output: { copperIngot: 1 }, input: { copperOre: 2 } }),
    ];
    const result = getChainedIngredients('copperSword', recipes);
    expect(result.has('copperIngot')).toBe(true);
    expect(result.has('copperOre')).toBe(true);
    expect(result.has('stick')).toBe(true);
    expect(result.size).toBe(3);
  });

  it('prevents infinite recursion on cycles', () => {
    const recipes: RecipeList = [
      makeRecipe({ id: 'r1', output: { a: 1 }, input: { b: 1 } }),
      makeRecipe({ id: 'r2', output: { b: 1 }, input: { a: 1 } }),
    ];
    const result = getChainedIngredients('a', recipes);
    expect(result.has('b')).toBe(true);
  });
});

describe('canObtainChain', () => {
  const recipes: RecipeList = [
    makeRecipe({ id: 'r1', output: { copperSword: 1 }, input: { copperIngot: 3 }, station: null }),
    makeRecipe({ id: 'r2', output: { copperIngot: 1 }, input: { copperOre: 2 }, station: null }),
    makeRecipe({ id: 'r3', output: { magicSword: 1 }, input: { goldIngot: 3 }, station: 'anvil' }),
  ];

  it('returns true when item is in inventory', () => {
    expect(canObtainChain('copperSword', { copperSword: 1 }, {}, recipes)).toBe(true);
  });

  it('returns true when merchant sells it', () => {
    const merchant = { copperSword: { price: 100, quantity: 1 } };
    expect(canObtainChain('copperSword', {}, merchant, recipes)).toBe(true);
  });

  it('returns true when craftable from obtainable ingredients', () => {
    const inventory = { copperOre: 6 };
    expect(canObtainChain('copperSword', inventory, {}, recipes)).toBe(true);
  });

  it('treats a station-gated recipe as obtainable (station availability is a real-time tier concern, not a chain-reachability one)', () => {
    expect(canObtainChain('magicSword', { goldIngot: 3 }, {}, recipes)).toBe(true);
  });

  it('returns false when ingredients have no known source', () => {
    expect(canObtainChain('copperSword', {}, {}, recipes)).toBe(false);
  });

  it('handles cycles without infinite loop', () => {
    const cyclic: RecipeList = [
      makeRecipe({ id: 'r1', output: { a: 1 }, input: { b: 1 }, station: null }),
      makeRecipe({ id: 'r2', output: { b: 1 }, input: { a: 1 }, station: null }),
    ];
    expect(canObtainChain('a', {}, {}, cyclic)).toBe(false);
  });
});

describe('computeDifficultyTier', () => {
  const recipes: RecipeList = [];

  it('returns tier 1 for buyable and affordable', () => {
    const tier = computeDifficultyTier({
      itemId: 'copperSword',
      recipe: null,
      allMerchantSelling: { copperSword: { price: 100, quantity: 1 } },
      inventory: {},
      playerCoins: 200,
      recipes,
    });
    expect(tier).toBe(1);
  });

  it('returns tier 3 for buyable but not affordable', () => {
    const tier = computeDifficultyTier({
      itemId: 'copperSword',
      recipe: null,
      allMerchantSelling: { copperSword: { price: 100, quantity: 1 } },
      inventory: {},
      playerCoins: 50,
      recipes,
    });
    expect(tier).toBe(3);
  });

  it('returns tier 2 for craftable with all ingredients and tools', () => {
    const tier = computeDifficultyTier({
      itemId: 'copperSword',
      recipe: { id: 'r1', input: { copperIngot: 3 }, required: ['hammer'] },
      allMerchantSelling: {},
      inventory: { copperIngot: 5, hammer: 1 },
      playerCoins: 0,
      recipes,
    });
    expect(tier).toBe(2);
  });

  it('returns tier 5 for blocked item', () => {
    const tier = computeDifficultyTier({
      itemId: 'copperSword',
      recipe: null,
      allMerchantSelling: {},
      inventory: {},
      playerCoins: 0,
      recipes,
    });
    expect(tier).toBe(5);
  });

  it('returns tier 4 (not 2) for a station-gated recipe when the station is not currently visible', () => {
    const tier = computeDifficultyTier({
      itemId: 'copperMailBoots',
      recipe: { id: 'r1', input: { copperIngot: 3 }, required: [], station: 'smithing' },
      allMerchantSelling: {},
      inventory: { copperIngot: 5 },
      playerCoins: 0,
      recipes,
    });
    expect(tier).toBe(4);
  });

  it('returns tier 2 for a station-gated recipe once the matching station is visible', () => {
    const tier = computeDifficultyTier({
      itemId: 'copperMailBoots',
      recipe: { id: 'r1', input: { copperIngot: 3 }, required: [], station: 'smithing' },
      allMerchantSelling: {},
      inventory: { copperIngot: 5 },
      playerCoins: 0,
      recipes,
      availableStationTypes: new Set(['smithing']),
    });
    expect(tier).toBe(2);
  });
});

describe('findBlockingItems', () => {
  const recipes: RecipeList = [
    makeRecipe({ id: 'r1', output: { copperSword: 1 }, input: { copperIngot: 3, stick: 1 }, required: ['hammer'], station: null }),
  ];

  it('returns empty array when the item has no craftable recipe', () => {
    expect(findBlockingItems('copperOre', {}, {}, recipes)).toEqual([]);
  });

  it('flags an input with no recipe and no merchant as a dead end', () => {
    const result = findBlockingItems('copperSword', { hammer: 1 }, { stick: { price: 5, quantity: 1 } }, recipes);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ itemId: 'copperIngot', reason: 'Not in inventory, no recipe, and not sold at any merchant' });
  });

  it('flags an input with a recipe whose own ingredients are unobtainable', () => {
    const chained: RecipeList = [
      ...recipes,
      makeRecipe({ id: 'r2', output: { copperIngot: 1 }, input: { copperOre: 2 }, station: null }),
    ];
    const result = findBlockingItems('copperSword', { hammer: 1 }, { stick: { price: 5, quantity: 1 } }, chained);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ itemId: 'copperIngot', reason: 'Has a recipe but its ingredients are also not obtainable' });
  });

  it('does not flag inputs that are obtainable', () => {
    const result = findBlockingItems(
      'copperSword',
      { hammer: 1 },
      { copperIngot: { price: 10, quantity: 1 }, stick: { price: 5, quantity: 1 } },
      recipes,
    );
    expect(result).toEqual([]);
  });

  it('flags a missing required tool', () => {
    const result = findBlockingItems(
      'copperSword',
      {},
      { copperIngot: { price: 10, quantity: 1 }, stick: { price: 5, quantity: 1 } },
      recipes,
    );
    expect(result).toHaveLength(1);
    expect(result[0].itemId).toBe('hammer');
  });
});

describe('computeChainNeeds', () => {
  const recipes: RecipeList = [
    { id: 'axe', input: { pinewoodAxeHandle: 1, stone: 2 }, output: { stoneFellingAxe: 1 }, required: ['stoneCarvingKnife'], station: null },
    { id: 'handle', input: { pinewoodLog: 2 }, output: { pinewoodAxeHandle: 1 }, required: [], station: null },
    { id: 'knife', input: { stone: 1 }, output: { stoneCarvingKnife: 1 }, required: [], station: null },
  ];

  it('returns empty for no targets', () => {
    expect(computeChainNeeds([], recipes)).toEqual({});
  });

  it('counts the target itself plus transitive ingredients and tools', () => {
    const needs = computeChainNeeds(['stoneFellingAxe'], recipes);
    expect(needs.stoneFellingAxe).toBe(1);
    expect(needs.pinewoodAxeHandle).toBe(1);
    expect(needs.pinewoodLog).toBe(2);
    expect(needs.stoneCarvingKnife).toBe(1);
    // 2 for the axe + 1 for crafting the knife
    expect(needs.stone).toBe(3);
  });

  it('accumulates shared ingredients across targets', () => {
    const needs = computeChainNeeds(['stoneFellingAxe', 'stoneCarvingKnife'], recipes);
    // axe chain needs 3 stone (2 + 1 for its knife), knife target adds 1 more
    expect(needs.stone).toBe(4);
  });

  it('dedupes repeated target ids', () => {
    const needs = computeChainNeeds(['stoneCarvingKnife', 'stoneCarvingKnife'], recipes);
    expect(needs.stoneCarvingKnife).toBe(1);
    expect(needs.stone).toBe(1);
  });

  it('accounts for recipe output quantities', () => {
    const batchRecipes: RecipeList = [
      { id: 'strips', input: { lightLeather: 1 }, output: { leatherStrips: 5 }, required: [], station: null },
      { id: 'belt', input: { leatherStrips: 7 }, output: { belt: 1 }, required: [], station: null },
    ];
    const needs = computeChainNeeds(['belt'], batchRecipes);
    expect(needs.leatherStrips).toBe(7);
    // ceil(7 / 5) = 2 crafts → 2 lightLeather
    expect(needs.lightLeather).toBe(2);
  });

  it('terminates on recipe cycles', () => {
    const cyclic: RecipeList = [
      { id: 'a', input: { b: 1 }, output: { a: 1 }, required: [], station: null },
      { id: 'b', input: { a: 1 }, output: { b: 1 }, required: [], station: null },
    ];
    const needs = computeChainNeeds(['a'], cyclic);
    expect(needs.a).toBe(1);
    expect(needs.b).toBe(1);
  });

  it('includes ingredients of a station-gated recipe (the keep-quantity bound applies regardless of station availability)', () => {
    const stationRecipes: RecipeList = [
      { id: 'bar', input: { copperOre: 3 }, output: { copperBar: 1 }, required: [], station: 'forge' as any },
    ];
    const needs = computeChainNeeds(['copperBar'], stationRecipes);
    expect(needs.copperBar).toBe(1);
    expect(needs.copperOre).toBe(3);
  });
});
