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

  it('treats a station-gated recipe as unobtainable when the station type has never been seen', () => {
    expect(canObtainChain('magicSword', { goldIngot: 3 }, {}, recipes)).toBe(false);
  });

  it('treats a station-gated recipe as obtainable once that station type is known, regardless of current visibility', () => {
    expect(canObtainChain('magicSword', { goldIngot: 3 }, {}, recipes, undefined, 1, new Set(['anvil']))).toBe(true);
  });

  it('returns false when inventory has some of an ingredient but not enough (owning 1 coin does not satisfy a 1000-coin recipe)', () => {
    const meltRecipes: RecipeList = [
      makeRecipe({ id: 'chunk', output: { chunkOfCopper: 1 }, input: { copperCoin: 1000 }, station: 'smelting' }),
      makeRecipe({ id: 'ingot', output: { copperIngot: 1 }, input: { chunkOfCopper: 3 }, station: 'smelting' }),
    ];
    expect(canObtainChain('copperIngot', { copperCoin: 1 }, {}, meltRecipes)).toBe(false);
  });

  it('returns true once inventory has enough of the ingredient for the full chain, given the station type is known', () => {
    const meltRecipes: RecipeList = [
      makeRecipe({ id: 'chunk', output: { chunkOfCopper: 1 }, input: { copperCoin: 1000 }, station: 'smelting' }),
      makeRecipe({ id: 'ingot', output: { copperIngot: 1 }, input: { chunkOfCopper: 3 }, station: 'smelting' }),
    ];
    expect(canObtainChain('copperIngot', { copperCoin: 3000 }, {}, meltRecipes, undefined, 1, new Set(['smelting']))).toBe(true);
  });

  it('returns false for a full-chain-satisfied recipe when its station type is not known', () => {
    const meltRecipes: RecipeList = [
      makeRecipe({ id: 'chunk', output: { chunkOfCopper: 1 }, input: { copperCoin: 1000 }, station: 'smelting' }),
      makeRecipe({ id: 'ingot', output: { copperIngot: 1 }, input: { chunkOfCopper: 3 }, station: 'smelting' }),
    ];
    expect(canObtainChain('copperIngot', { copperCoin: 3000 }, {}, meltRecipes)).toBe(false);
  });

  it('scales ingredient needs by how many crafts are required when neededQty exceeds one craft\'s output', () => {
    const recipes: RecipeList = [
      makeRecipe({ id: 'r1', output: { arrow: 2 }, input: { stick: 1 } }),
    ];
    // 5 arrows needs ceil(5/2)=3 crafts, so 3 sticks — 2 sticks isn't enough.
    expect(canObtainChain('arrow', { stick: 2 }, {}, recipes, undefined, 5)).toBe(false);
    expect(canObtainChain('arrow', { stick: 3 }, {}, recipes, undefined, 5)).toBe(true);
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

  it('returns true when the item is a known loot drop/harvest yield, with no recipe and no merchant', () => {
    expect(canObtainChain('pinewoodLog', {}, {}, recipes, undefined, 1, new Set(), new Set(['pinewoodLog']))).toBe(true);
  });

  it('returns true when the item is a known quest reward, with no recipe and no merchant', () => {
    expect(canObtainChain('rareGem', {}, {}, recipes, undefined, 1, new Set(), new Set(), new Set(['rareGem']))).toBe(true);
  });

  it('treats a recipe ingredient as obtainable via a known loot source, satisfying the whole chain', () => {
    const withRawIngredient: RecipeList = [
      makeRecipe({ id: 'r1', output: { copperSword: 1 }, input: { pinewoodLog: 1 }, station: null }),
    ];
    expect(canObtainChain('copperSword', {}, {}, withRawIngredient, undefined, 1, new Set(), new Set(['pinewoodLog']))).toBe(true);
    expect(canObtainChain('copperSword', {}, {}, withRawIngredient)).toBe(false);
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

  it('returns tier 5 (not 4) when a chain ingredient requires a station type that has never been seen', () => {
    const stationRecipes: RecipeList = [
      makeRecipe({ id: 'ingot', output: { ironIngot: 1 }, input: { ironOre: 2 }, station: 'smelting' }),
    ];
    const tier = computeDifficultyTier({
      itemId: 'ironSword',
      recipe: { id: 'r1', input: { ironIngot: 3 }, required: [] },
      allMerchantSelling: {},
      inventory: { ironOre: 6 },
      playerCoins: 0,
      recipes: stationRecipes,
    });
    expect(tier).toBe(5);
  });

  it('returns tier 4 for the same chain once the required station type is known', () => {
    const stationRecipes: RecipeList = [
      makeRecipe({ id: 'ingot', output: { ironIngot: 1 }, input: { ironOre: 2 }, station: 'smelting' }),
    ];
    const tier = computeDifficultyTier({
      itemId: 'ironSword',
      recipe: { id: 'r1', input: { ironIngot: 3 }, required: [] },
      allMerchantSelling: {},
      inventory: { ironOre: 6 },
      playerCoins: 0,
      recipes: stationRecipes,
      knownStationTypes: new Set(['smelting']),
    });
    expect(tier).toBe(4);
  });

  it('returns tier 5 (not 4) when a chain ingredient is short on quantity, even though some is on hand', () => {
    const meltRecipes: RecipeList = [
      makeRecipe({ id: 'chunk', output: { chunkOfCopper: 1 }, input: { copperCoin: 1000 } }),
      makeRecipe({ id: 'ingot', output: { copperIngot: 1 }, input: { chunkOfCopper: 3 } }),
    ];
    const tier = computeDifficultyTier({
      itemId: 'copperMailBoots',
      recipe: { id: 'r1', input: { copperIngot: 3 }, required: [] },
      allMerchantSelling: {},
      // Only 1 copper coin on hand — nowhere near the 3000 a full ingot chain needs.
      inventory: { copperCoin: 1 },
      playerCoins: 0,
      recipes: meltRecipes,
    });
    expect(tier).toBe(5);
  });

  it('returns tier 4 (not 5) for a no-recipe item that is a known loot drop', () => {
    const tier = computeDifficultyTier({
      itemId: 'pinewoodLog',
      recipe: null,
      allMerchantSelling: {},
      inventory: {},
      playerCoins: 0,
      recipes,
      knownLootItems: new Set(['pinewoodLog']),
    });
    expect(tier).toBe(4);
  });

  it('returns tier 4 (not 5) for a no-recipe item that is a known quest reward', () => {
    const tier = computeDifficultyTier({
      itemId: 'rareGem',
      recipe: null,
      allMerchantSelling: {},
      inventory: {},
      playerCoins: 0,
      recipes,
      knownQuestRewardItems: new Set(['rareGem']),
    });
    expect(tier).toBe(4);
  });

  it('a known loot/quest-reward source does not override a better tier already reachable via merchant', () => {
    const tier = computeDifficultyTier({
      itemId: 'copperSword',
      recipe: null,
      allMerchantSelling: { copperSword: { price: 100, quantity: 1 } },
      inventory: {},
      playerCoins: 200,
      recipes,
      knownLootItems: new Set(['copperSword']),
    });
    expect(tier).toBe(1);
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
    expect(result[0]).toEqual({ itemId: 'copperIngot', reason: 'Not in inventory, no recipe, not sold, not a known loot drop, and not a known quest reward' });
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

  it('does not flag an input that is a known loot drop, even with no recipe/merchant', () => {
    const result = findBlockingItems(
      'copperSword',
      { hammer: 1 },
      { stick: { price: 5, quantity: 1 } },
      recipes,
      new Set(),
      new Set(['copperIngot']),
    );
    expect(result).toEqual([]);
  });

  it('does not flag an input that is a known quest reward, even with no recipe/merchant', () => {
    const result = findBlockingItems(
      'copperSword',
      { hammer: 1 },
      { stick: { price: 5, quantity: 1 } },
      recipes,
      new Set(),
      new Set(),
      new Set(['copperIngot']),
    );
    expect(result).toEqual([]);
  });

  it('flags an input where inventory has some but not enough of the required quantity', () => {
    const chained: RecipeList = [
      ...recipes,
      makeRecipe({ id: 'r2', output: { copperIngot: 1 }, input: { copperOre: 2 }, station: null }),
    ];
    // copperSword needs 3 copperIngot; only 1 copperOre on hand (needs 6 for 3 ingots).
    const result = findBlockingItems('copperSword', { hammer: 1, copperOre: 1 }, { stick: { price: 5, quantity: 1 } }, chained);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ itemId: 'copperIngot', reason: 'Has a recipe but its ingredients are also not obtainable' });
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

  it('flags a station-gated ingredient as blocked when its station type has never been seen', () => {
    const chained: RecipeList = [
      ...recipes,
      makeRecipe({ id: 'r2', output: { copperIngot: 1 }, input: { copperOre: 2 }, station: 'smelting' }),
    ];
    const result = findBlockingItems('copperSword', { hammer: 1, copperOre: 6 }, { stick: { price: 5, quantity: 1 } }, chained);
    expect(result).toHaveLength(1);
    expect(result[0].itemId).toBe('copperIngot');
  });

  it('a station-gated ingredient is not flagged as blocked once its station type is known', () => {
    const chained: RecipeList = [
      ...recipes,
      makeRecipe({ id: 'r2', output: { copperIngot: 1 }, input: { copperOre: 2 }, station: 'smelting' }),
    ];
    const result = findBlockingItems(
      // copperSword needs 3 copperIngot; each craft of copperIngot needs 2 copperOre, so 6 total.
      'copperSword',
      { hammer: 1, copperOre: 6 },
      { stick: { price: 5, quantity: 1 } },
      chained,
      new Set(['smelting']),
    );
    expect(result).toEqual([]);
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

  it('caps required-tool quantity at 1 regardless of how many targets share it', () => {
    const sharedToolRecipes: RecipeList = [
      { id: 'axe', input: { wood: 2 }, output: { fellingAxe: 1 }, required: ['stoneCarvingKnife'], station: null },
      { id: 'pick', input: { stone: 2 }, output: { pickaxe: 1 }, required: ['stoneCarvingKnife'], station: null },
      { id: 'hoe', input: { iron: 2 }, output: { hoe: 1 }, required: ['stoneCarvingKnife'], station: null },
      { id: 'knife', input: { copper: 1 }, output: { stoneCarvingKnife: 1 }, required: [], station: null },
    ];
    const needs = computeChainNeeds(['fellingAxe', 'pickaxe', 'hoe'], sharedToolRecipes);
    // stoneCarvingKnife required by all three — one is enough regardless
    expect(needs.stoneCarvingKnife).toBe(1);
    // copper: only 1 craft of knife needed, not 3
    expect(needs.copper).toBe(1);
  });

  it('protects an intermediate item already in inventory but does not recurse into its sub-ingredients', () => {
    // Already own the handle — keep it, but no need to keep its logs
    const needs = computeChainNeeds(['stoneFellingAxe'], recipes, { pinewoodAxeHandle: 1 });
    expect(needs.stoneFellingAxe).toBe(1);
    expect(needs.pinewoodAxeHandle).toBe(1);
    expect(needs.pinewoodLog).toBeUndefined();
    // 2 stone for the axe body, 1 for crafting the required knife (knife not in inventory)
    expect(needs.stone).toBe(3);
    expect(needs.stoneCarvingKnife).toBe(1);
  });

  it('stops recursing into required-tool sub-ingredients when the tool is already in inventory', () => {
    // Already own handle and knife — only the raw stone for the axe body is needed
    const needs = computeChainNeeds(['stoneFellingAxe'], recipes, { pinewoodAxeHandle: 1, stoneCarvingKnife: 1 });
    expect(needs.stoneFellingAxe).toBe(1);
    expect(needs.pinewoodAxeHandle).toBe(1);
    expect(needs.stoneCarvingKnife).toBe(1);
    expect(needs.pinewoodLog).toBeUndefined();
    // Only 2 stone for the axe body — no stone for the knife since it's already owned
    expect(needs.stone).toBe(2);
  });
});
