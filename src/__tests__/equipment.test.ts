import { describe, it, expect } from 'vitest';
import {
  computeUpgradeTargets,
  getTargetItemsToKeep,
  getEquippedRecipeInputs,
  computeTargetsToBuyFromMerchant,
  findGearToEquip,
} from '../equipment';
import type { ItemMap, RecipeList, UpgradeTarget } from '../../bot-types';

const makeRecipe = (overrides: Partial<RecipeList[number]> = {}): RecipeList[number] => ({
  id: 'testRecipe',
  input: {},
  output: {},
  required: [],
  station: null,
  ...overrides,
});

describe('computeUpgradeTargets', () => {
  const items: ItemMap = {
    copperHelm: { type: 'helm', stats: { defense: 3 } },
    ironHelm: { type: 'helm', stats: { defense: 5 } },
    copperSword: { type: 'oneHandedSword', damage: 5, attacksPerSecond: 1.2 },
  };
  const recipes: RecipeList = [];

  it('returns empty when no upgrades found', () => {
    const targets = computeUpgradeTargets({
      equipment: { helm: 'ironHelm', weapon: 'copperSword' },
      inventory: {},
      items,
      recipes,
      allMerchantSelling: {},
      playerCoins: 0,
    });
    expect(targets.length).toBe(0);
  });

  it('finds upgrade target when better item exists at merchant', () => {
    const targets = computeUpgradeTargets({
      equipment: { helm: 'copperHelm' },
      inventory: {},
      items,
      recipes,
      allMerchantSelling: { ironHelm: { price: 200, quantity: 1 } },
      playerCoins: 200,
    });
    expect(targets.length).toBeGreaterThanOrEqual(1);
    const helmTarget = targets.find(t => t.slot === 'helm');
    expect(helmTarget).toBeDefined();
    expect(helmTarget!.itemId).toBe('ironHelm');
  });

  it('skips items already in inventory', () => {
    const targets = computeUpgradeTargets({
      equipment: { helm: 'copperHelm' },
      inventory: { ironHelm: 1 },
      items,
      recipes,
      allMerchantSelling: { ironHelm: { price: 200, quantity: 1 } },
      playerCoins: 200,
    });
    const helmTarget = targets.find(t => t.slot === 'helm');
    expect(helmTarget).toBeUndefined();
  });

  it('sorts reachable targets before blocked', () => {
    const targets = computeUpgradeTargets({
      equipment: { helm: 'copperHelm' },
      inventory: {},
      items,
      recipes,
      allMerchantSelling: { ironHelm: { price: 200, quantity: 1 } },
      playerCoins: 200,
    });
    if (targets.length > 0) {
      expect(targets[0].reachable).toBe(true);
    }
  });
});

describe('getTargetItemsToKeep', () => {
  it('returns empty set for no targets', () => {
    expect(getTargetItemsToKeep([], []).size).toBe(0);
  });

  it('returns empty set for buy-only targets', () => {
    const targets: UpgradeTarget[] = [
      { itemId: 'copperSword', slot: 'weapon', tier: 1, gain: 5, reachable: true, recipe: null },
    ];
    expect(getTargetItemsToKeep(targets, []).size).toBe(0);
  });

  it('returns ingredients for craftable targets', () => {
    const recipes: RecipeList = [
      makeRecipe({ id: 'r1', output: { copperSword: 1 }, input: { copperIngot: 3 }, station: null }),
    ];
    const targets: UpgradeTarget[] = [
      { itemId: 'copperSword', slot: 'weapon', tier: 2, gain: 5, reachable: true, recipe: { id: 'r1', input: { copperIngot: 3 }, required: [] } },
    ];
    const result = getTargetItemsToKeep(targets, recipes);
    expect(result.has('copperIngot')).toBe(true);
  });
});

describe('getEquippedRecipeInputs', () => {
  it('returns empty set for no equipment', () => {
    expect(getEquippedRecipeInputs({}, []).size).toBe(0);
  });

  it('returns chained inputs for equipped craftable items', () => {
    const recipes: RecipeList = [
      makeRecipe({ id: 'r1', output: { copperSword: 1 }, input: { copperIngot: 3 }, station: null }),
    ];
    const result = getEquippedRecipeInputs({ weapon: 'copperSword' }, recipes);
    expect(result.has('copperIngot')).toBe(true);
  });

  it('returns nothing for non-craftable equipped items', () => {
    expect(getEquippedRecipeInputs({ weapon: 'ironSword' }, []).size).toBe(0);
  });
});

describe('computeTargetsToBuyFromMerchant', () => {
  it('buys gear when target has no recipe', () => {
    const targets: UpgradeTarget[] = [
      { itemId: 'copperSword', slot: 'weapon', tier: 1, gain: 5, reachable: true, recipe: null },
    ];
    const result = computeTargetsToBuyFromMerchant({
      targets,
      merchantSelling: { copperSword: { price: 100, quantity: 1 } },
      playerCoins: 200,
      inventory: {},
    });
    expect(result.copperSword).toBe(1);
  });

  it('skips gear when player already has it in inventory', () => {
    const targets: UpgradeTarget[] = [
      { itemId: 'copperSword', slot: 'weapon', tier: 1, gain: 5, reachable: true, recipe: null },
    ];
    const result = computeTargetsToBuyFromMerchant({
      targets,
      merchantSelling: { copperSword: { price: 100, quantity: 1 } },
      playerCoins: 200,
      inventory: { copperSword: 1 },
    });
    expect(result).not.toHaveProperty('copperSword');
  });

  it('skips gear when not enough coins', () => {
    const targets: UpgradeTarget[] = [
      { itemId: 'copperSword', slot: 'weapon', tier: 1, gain: 5, reachable: true, recipe: null },
    ];
    const result = computeTargetsToBuyFromMerchant({
      targets,
      merchantSelling: { copperSword: { price: 100, quantity: 1 } },
      playerCoins: 50,
      inventory: {},
    });
    expect(result).not.toHaveProperty('copperSword');
  });

  it('buys tools when missing from inventory', () => {
    const targets: UpgradeTarget[] = [
      { itemId: 'copperSword', slot: 'weapon', tier: 2, gain: 5, reachable: true, recipe: { id: 'r1', input: { copperIngot: 3 }, required: ['hammer'] } },
    ];
    const result = computeTargetsToBuyFromMerchant({
      targets,
      merchantSelling: { copperSword: { price: 100, quantity: 1 }, hammer: { price: 50, quantity: 1 } },
      playerCoins: 200,
      inventory: { copperIngot: 3 },
    });
    expect(result.hammer).toBe(1);
  });
});

describe('findGearToEquip', () => {
  const items: ItemMap = {
    copperHelm: { type: 'helm', stats: { defense: 3 } },
    ironHelm: { type: 'helm', stats: { defense: 5 } },
    copperSword: { type: 'oneHandedSword', damage: 5, attacksPerSecond: 1.2 },
    bread: { type: 'food', calories: 50 },
  };

  it('returns null when no upgrade in inventory', () => {
    const result = findGearToEquip({
      inventory: { copperHelm: 1, bread: 5 },
      equipment: { helm: 'copperHelm', weapon: 'copperSword' },
      items,
    });
    expect(result).toBeNull();
  });

  it('returns upgrade when better item is in inventory', () => {
    const result = findGearToEquip({
      inventory: { ironHelm: 1 },
      equipment: { helm: 'copperHelm' },
      items,
    });
    expect(result).toEqual({ item: 'ironHelm', slot: 'helm' });
  });

  it('returns item for empty slot', () => {
    const result = findGearToEquip({
      inventory: { copperHelm: 1 },
      equipment: {},
      items,
    });
    expect(result).toEqual({ item: 'copperHelm', slot: 'helm' });
  });

  it('ignores non-equipment items like food', () => {
    const result = findGearToEquip({
      inventory: { bread: 5 },
      equipment: {},
      items,
    });
    expect(result).toBeNull();
  });
});
