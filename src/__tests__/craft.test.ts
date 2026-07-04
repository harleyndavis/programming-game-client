import { describe, it, expect } from 'vitest';
import {
  findCraftableTarget,
  findNextCraftTarget,
  findCraftableSubStep,
  findCraftableFromList,
  computeCraftIngredientsToBuyFromMerchant,
  isFullyAchievableFromInventory,
  collectVisibleStations,
  getAvailableStationTypes,
  findStationForType,
} from '../craft';
import type { RecipeList, UpgradeTarget } from '../../bot-types';

describe('findCraftableTarget', () => {
  it('returns null for empty targets', () => {
    expect(findCraftableTarget([], {}, [])).toBeNull();
  });

  it('returns null for buy-only targets with no recipe', () => {
    const targets: UpgradeTarget[] = [
      { itemId: 'copperSword', slot: 'weapon', tier: 1, gain: 5, reachable: true, recipe: null },
    ];
    expect(findCraftableTarget(targets, {}, [])).toBeNull();
  });

  it('returns target when all ingredients and tools are in inventory', () => {
    const targets: UpgradeTarget[] = [
      {
        itemId: 'copperSword', slot: 'weapon', tier: 2, gain: 5, reachable: true,
        recipe: { id: 'r1', input: { copperIngot: 3 }, required: ['hammer'] },
      },
    ];
    const result = findCraftableTarget(targets, { copperIngot: 3, hammer: 1 }, []);
    expect(result).not.toBeNull();
    expect(result!.itemId).toBe('copperSword');
  });

  it('returns sub-step when direct target is not craftable but sub-recipe is', () => {
    const recipes: RecipeList = [
      { id: 'r1', input: { copperIngot: 3 }, output: { copperSword: 1 }, required: ['hammer'], station: null },
      { id: 'r2', input: { copperOre: 2 }, output: { copperIngot: 1 }, required: [], station: null },
    ];
    const targets: UpgradeTarget[] = [
      {
        itemId: 'copperSword', slot: 'weapon', tier: 4, gain: 5, reachable: true,
        recipe: { id: 'r1', input: { copperIngot: 3 }, required: ['hammer'] },
      },
    ];
    const result = findCraftableTarget(targets, { copperOre: 6, hammer: 1 }, recipes);
    expect(result).not.toBeNull();
    expect(result!.itemId).toBe('r2');
    expect(result!.recipe!.id).toBe('r2');
  });

  it('returns null when nothing is craftable', () => {
    const targets: UpgradeTarget[] = [
      {
        itemId: 'copperSword', slot: 'weapon', tier: 5, gain: 5, reachable: true,
        recipe: { id: 'r1', input: { copperIngot: 3 }, required: ['hammer'] },
      },
    ];
    expect(findCraftableTarget(targets, {}, [])).toBeNull();
  });
});

describe('findNextCraftTarget', () => {
  it('returns null for empty targets', () => {
    expect(findNextCraftTarget([])).toBeNull();
  });

  it('returns the first reachable target', () => {
    const targets: UpgradeTarget[] = [
      { itemId: 'a', slot: 'weapon', tier: 5, gain: 0, reachable: false, recipe: null },
      { itemId: 'b', slot: 'weapon', tier: 4, gain: 2, reachable: true, recipe: null },
    ];
    const result = findNextCraftTarget(targets);
    expect(result!.itemId).toBe('b');
  });

  it('falls back to first target when none are reachable', () => {
    const targets: UpgradeTarget[] = [
      { itemId: 'a', slot: 'weapon', tier: 5, gain: 0, reachable: false, recipe: null },
      { itemId: 'b', slot: 'weapon', tier: 5, gain: 0, reachable: false, recipe: null },
    ];
    const result = findNextCraftTarget(targets);
    expect(result!.itemId).toBe('a');
  });
});

describe('findCraftableSubStep', () => {
  it('returns null when all inputs are already in inventory', () => {
    const recipe = { id: 'r1', input: { copperIngot: 3 }, required: ['hammer'] };
    const result = findCraftableSubStep(recipe, { copperIngot: 5, hammer: 1 }, [], new Set());
    expect(result).toBeNull();
  });

  it('returns craftable sub-recipe when input can be crafted', () => {
    const recipes: RecipeList = [
      { id: 'r2', input: { copperOre: 2 }, output: { copperIngot: 1 }, required: [], station: null },
    ];
    const recipe = { id: 'r1', input: { copperIngot: 3 }, required: ['hammer'] };
    const result = findCraftableSubStep(recipe, { copperOre: 6, hammer: 1 }, recipes, new Set());
    expect(result).not.toBeNull();
    expect(result!.recipeId).toBe('r2');
  });

  it('returns null when sub-recipe requires a station that is not visible', () => {
    const recipes: RecipeList = [
      { id: 'r2', input: { copperOre: 2 }, output: { copperIngot: 1 }, required: [], station: 'furnace' },
    ];
    const recipe = { id: 'r1', input: { copperIngot: 3 }, required: ['hammer'] };
    const result = findCraftableSubStep(recipe, { copperOre: 6, hammer: 1 }, recipes, new Set());
    expect(result).toBeNull();
  });

  it('returns the sub-recipe once its station is available', () => {
    const recipes: RecipeList = [
      { id: 'r2', input: { copperOre: 2 }, output: { copperIngot: 1 }, required: [], station: 'furnace' },
    ];
    const recipe = { id: 'r1', input: { copperIngot: 3 }, required: ['hammer'] };
    const result = findCraftableSubStep(recipe, { copperOre: 6, hammer: 1 }, recipes, new Set(), new Set(['furnace']));
    expect(result).not.toBeNull();
    expect(result!.recipeId).toBe('r2');
  });

  it('returns null when sub-recipe is missing from recipe list', () => {
    const recipe = { id: 'r1', input: { copperIngot: 3 }, required: ['hammer'] };
    const result = findCraftableSubStep(recipe, { copperOre: 6, hammer: 1 }, [], new Set());
    expect(result).toBeNull();
  });
});

describe('findCraftableFromList', () => {
  it('returns null for empty list', () => {
    expect(findCraftableFromList([], {}, [])).toBeNull();
  });

  it('returns null when no recipes match the item IDs', () => {
    const items = ['stoneCutterTools', 'copperNeedle'];
    expect(findCraftableFromList(items, {}, [])).toBeNull();
  });

  it('returns item when recipe is directly craftable', () => {
    const recipes: RecipeList = [
      { id: 'r1', input: { stone: 1, pinewoodBits: 1 }, output: { stoneCarvingKnife: 1 }, required: ['stoneCutterTools'], station: null },
    ];
    const result = findCraftableFromList(['stoneCarvingKnife'], { stone: 1, pinewoodBits: 1, stoneCutterTools: 1 }, recipes);
    expect(result).not.toBeNull();
    expect(result!.itemId).toBe('stoneCarvingKnife');
    expect(result!.recipe.id).toBe('r1');
  });

  it('returns null when tool requirement is missing', () => {
    const recipes: RecipeList = [
      { id: 'r1', input: { stone: 1, pinewoodBits: 1 }, output: { stoneCarvingKnife: 1 }, required: ['stoneCutterTools'], station: null },
    ];
    const result = findCraftableFromList(['stoneCarvingKnife'], { stone: 1, pinewoodBits: 1 }, recipes);
    expect(result).toBeNull();
  });

  it('returns sub-step when direct craft is not possible but sub-recipe is', () => {
    const recipes: RecipeList = [
      { id: 'r1', input: { pinewoodBits: 1, leatherStrips: 2, pinewoodAxeHandle: 1, stone: 3 }, output: { stoneFellingAxe: 1 }, required: ['stoneCutterTools'], station: null },
      { id: 'r2', input: { pinewoodLog: 1 }, output: { pinewoodAxeHandle: 1 }, required: ['stoneCarvingKnife'], station: null },
    ];
    const result = findCraftableFromList(
      ['stoneFellingAxe'],
      { pinewoodBits: 1, leatherStrips: 2, stone: 3, stoneCutterTools: 1, pinewoodLog: 1, stoneCarvingKnife: 1 },
      recipes,
    );
    expect(result).not.toBeNull();
    expect(result!.itemId).toBe('r2');
    expect(result!.recipe.id).toBe('r2');
  });

  it('skips recipes that require a station that is not visible', () => {
    const recipes: RecipeList = [
      { id: 'r1', input: { copperIngot: 3, pinewoodAxeHandle: 1, leatherStrips: 2, pinewoodBits: 1 }, output: { copperFellingAxe: 1 }, required: [], station: 'smithing' },
    ];
    const result = findCraftableFromList(['copperFellingAxe'], { copperIngot: 3, pinewoodAxeHandle: 1, leatherStrips: 2, pinewoodBits: 1 }, recipes);
    expect(result).toBeNull();
  });

  it('returns the recipe once its station is available', () => {
    const recipes: RecipeList = [
      { id: 'r1', input: { copperIngot: 3, pinewoodAxeHandle: 1, leatherStrips: 2, pinewoodBits: 1 }, output: { copperFellingAxe: 1 }, required: [], station: 'smithing' },
    ];
    const result = findCraftableFromList(
      ['copperFellingAxe'],
      { copperIngot: 3, pinewoodAxeHandle: 1, leatherStrips: 2, pinewoodBits: 1 },
      recipes,
      new Set(['smithing']),
    );
    expect(result).not.toBeNull();
    expect(result!.itemId).toBe('copperFellingAxe');
  });

  it('prioritizes earlier items in the list', () => {
    const recipes: RecipeList = [
      { id: 'r1', input: { stone: 3, pinewoodBits: 1 }, output: { stonePickaxe: 1 }, required: ['stoneCutterTools'], station: null },
      { id: 'r2', input: { stone: 3, pinewoodBits: 1 }, output: { stoneFellingAxe: 1 }, required: ['stoneCutterTools'], station: null },
    ];
    const inventory = { stone: 3, pinewoodBits: 1, stoneCutterTools: 1 };
    const result = findCraftableFromList(['stoneFellingAxe', 'stonePickaxe'], inventory, recipes);
    expect(result).not.toBeNull();
    expect(result!.itemId).toBe('stoneFellingAxe');
  });

  it('returns null when ingredients are insufficient', () => {
    const recipes: RecipeList = [
      { id: 'r1', input: { stone: 3, pinewoodBits: 1 }, output: { stoneFellingAxe: 1 }, required: ['stoneCutterTools'], station: null },
    ];
    const result = findCraftableFromList(['stoneFellingAxe'], { stone: 1, stoneCutterTools: 1 }, recipes);
    expect(result).toBeNull();
  });
});

describe('computeCraftIngredientsToBuyFromMerchant', () => {
  it('buys a directly-sold missing ingredient', () => {
    const recipes: RecipeList = [
      { id: 'axe', input: { pinewoodLog: 2 }, output: { stoneFellingAxe: 1 }, required: [], station: null },
    ];
    const basket = computeCraftIngredientsToBuyFromMerchant(
      ['stoneFellingAxe'], {}, recipes, { pinewoodLog: { price: 5, quantity: 10 } }, 100,
    );
    expect(basket).toEqual({ pinewoodLog: 2 });
  });

  it('recurses into a craftable sub-ingredient the merchant does not sell', () => {
    const recipes: RecipeList = [
      { id: 'axe', input: { pinewoodAxeHandle: 1 }, output: { stoneFellingAxe: 1 }, required: [], station: null },
      { id: 'handle', input: { pinewoodLog: 2 }, output: { pinewoodAxeHandle: 1 }, required: [], station: null },
    ];
    const basket = computeCraftIngredientsToBuyFromMerchant(
      ['stoneFellingAxe'], {}, recipes, { pinewoodLog: { price: 5, quantity: 10 } }, 100,
    );
    expect(basket).toEqual({ pinewoodLog: 2 });
  });

  it('caps purchases at the available coins', () => {
    const recipes: RecipeList = [
      { id: 'axe', input: { pinewoodLog: 2 }, output: { stoneFellingAxe: 1 }, required: [], station: null },
    ];
    const basket = computeCraftIngredientsToBuyFromMerchant(
      ['stoneFellingAxe'], {}, recipes, { pinewoodLog: { price: 10, quantity: 10 } }, 15,
    );
    expect(basket).toEqual({ pinewoodLog: 1 });
  });

  it('includes required tools alongside recipe inputs', () => {
    const recipes: RecipeList = [
      { id: 'axe', input: { pinewoodLog: 2 }, output: { stoneFellingAxe: 1 }, required: ['stoneCarvingKnife'], station: null },
    ];
    const basket = computeCraftIngredientsToBuyFromMerchant(
      ['stoneFellingAxe'], {}, recipes,
      { pinewoodLog: { price: 5, quantity: 10 }, stoneCarvingKnife: { price: 20, quantity: 1 } },
      100,
    );
    expect(basket).toEqual({ pinewoodLog: 2, stoneCarvingKnife: 1 });
  });

  it('skips ingredients already covered by inventory', () => {
    const recipes: RecipeList = [
      { id: 'axe', input: { pinewoodLog: 2 }, output: { stoneFellingAxe: 1 }, required: [], station: null },
    ];
    const basket = computeCraftIngredientsToBuyFromMerchant(
      ['stoneFellingAxe'], { pinewoodLog: 2 }, recipes, { pinewoodLog: { price: 5, quantity: 10 } }, 100,
    );
    expect(basket).toEqual({});
  });

  it('leaves the basket empty for an ingredient with no seller and no recipe', () => {
    const recipes: RecipeList = [
      { id: 'axe', input: { mysteryOre: 1 }, output: { stoneFellingAxe: 1 }, required: [], station: null },
    ];
    const basket = computeCraftIngredientsToBuyFromMerchant(['stoneFellingAxe'], {}, recipes, {}, 100);
    expect(basket).toEqual({});
  });
});

describe('isFullyAchievableFromInventory', () => {
  it('returns true when inventory directly covers inputs and tools', () => {
    const recipe = { id: 'r1', input: { stone: 2 }, required: ['hammer'] };
    expect(isFullyAchievableFromInventory(recipe, { stone: 2, hammer: 1 }, [])).toBe(true);
  });

  it('returns true when a missing input is craftable from inventory', () => {
    const recipe = { id: 'axe', input: { pinewoodAxeHandle: 1 }, required: [] };
    const recipes: RecipeList = [
      { id: 'handle', input: { pinewoodLog: 2 }, output: { pinewoodAxeHandle: 1 }, required: [], station: null },
    ];
    expect(isFullyAchievableFromInventory(recipe, { pinewoodLog: 2 }, recipes)).toBe(true);
  });

  it('returns false when a missing input has no recipe', () => {
    const recipe = { id: 'axe', input: { copperOre: 2 }, required: [] };
    expect(isFullyAchievableFromInventory(recipe, {}, [])).toBe(false);
  });

  it('returns false when a required tool is missing', () => {
    const recipe = { id: 'axe', input: {}, required: ['hammer'] };
    expect(isFullyAchievableFromInventory(recipe, {}, [])).toBe(false);
  });

  it('returns false when a sub-recipe ingredient is itself unobtainable', () => {
    const recipe = { id: 'chest', input: { leather: 2 }, required: [] };
    const recipes: RecipeList = [
      { id: 'leatherR', input: { ratPelt: 3 }, output: { leather: 1 }, required: [], station: null },
    ];
    expect(isFullyAchievableFromInventory(recipe, {}, recipes)).toBe(false);
  });
});

describe('collectVisibleStations', () => {
  it('returns only station-type game objects', () => {
    const gameObjects = {
      forge1: { id: 'forge1', type: 'station', stationType: 'smithing', stationSubtype: 'forge', position: { x: 1, y: 1 }, label: 'forge', radius: 1, facing: 0 },
      tree1: { id: 'tree1', type: 'tree', treeType: 'pine', position: { x: 5, y: 0 }, label: 'pine', radius: 1 },
    } as any;
    const stations = collectVisibleStations(gameObjects);
    expect(stations).toHaveLength(1);
    expect(stations[0].id).toBe('forge1');
  });

  it('returns an empty array when no stations are visible', () => {
    expect(collectVisibleStations({})).toEqual([]);
  });
});

describe('getAvailableStationTypes', () => {
  it('collects the distinct station types from visible stations', () => {
    const stations = [
      { id: 'forge1', stationType: 'smithing' },
      { id: 'anvil1', stationType: 'smithing' },
      { id: 'table1', stationType: 'alchemy' },
    ] as any;
    const types = getAvailableStationTypes(stations);
    expect(types).toEqual(new Set(['smithing', 'alchemy']));
  });
});

describe('findStationForType', () => {
  const stations = [
    { id: 'forge1', stationType: 'smithing', position: { x: 5, y: 0 } },
    { id: 'forge2', stationType: 'smithing', position: { x: 1, y: 0 } },
    { id: 'table1', stationType: 'alchemy', position: { x: 0, y: 0 } },
  ] as any;

  it('returns null when stationType is null or undefined', () => {
    expect(findStationForType(null, stations, { x: 0, y: 0 })).toBeNull();
    expect(findStationForType(undefined, stations, { x: 0, y: 0 })).toBeNull();
  });

  it('returns null when no station of that type is visible', () => {
    expect(findStationForType('gemCutting', stations, { x: 0, y: 0 })).toBeNull();
  });

  it('returns the nearest visible station of the matching type', () => {
    const result = findStationForType('smithing', stations, { x: 0, y: 0 });
    expect(result?.id).toBe('forge2');
  });
});
