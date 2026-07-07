import { describe, it, expect } from 'vitest';
import {
  computeUpgradeTargets,
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

  it('a station-gated recipe is unreachable by default but reachable once the station type is known — stays stable regardless of current location', () => {
    const stationRecipes: RecipeList = [
      makeRecipe({ id: 'r1', output: { ironHelm: 1 }, input: { ironIngot: 3 }, station: 'smithing' }),
    ];
    const withoutKnowledge = computeUpgradeTargets({
      equipment: { helm: 'copperHelm' },
      inventory: {},
      items,
      recipes: stationRecipes,
      allMerchantSelling: {},
      playerCoins: 0,
    });
    const helmWithout = withoutKnowledge.find(t => t.slot === 'helm');
    expect(helmWithout?.reachable).toBe(false);

    const withKnowledge = computeUpgradeTargets({
      equipment: { helm: 'copperHelm' },
      inventory: {},
      items,
      recipes: stationRecipes,
      allMerchantSelling: {},
      playerCoins: 0,
      knownStationTypes: new Set(['smithing']),
    });
    const helmWith = withKnowledge.find(t => t.slot === 'helm');
    expect(helmWith?.reachable).toBe(true);
    expect(helmWith?.recipe?.station).toBe('smithing');
  });

  it('a craftable target blocked on a raw ingredient becomes tier 4 (not 5) once that ingredient is a known loot drop', () => {
    const rawIngredientRecipes: RecipeList = [
      makeRecipe({ id: 'r1', output: { ironHelm: 1 }, input: { pinewoodLog: 3 }, station: null }),
    ];
    const withoutKnowledge = computeUpgradeTargets({
      equipment: { helm: 'copperHelm' },
      inventory: {},
      items,
      recipes: rawIngredientRecipes,
      allMerchantSelling: {},
      playerCoins: 0,
    });
    expect(withoutKnowledge.find(t => t.slot === 'helm')?.tier).toBe(5);

    const withKnowledge = computeUpgradeTargets({
      equipment: { helm: 'copperHelm' },
      inventory: {},
      items,
      recipes: rawIngredientRecipes,
      allMerchantSelling: {},
      playerCoins: 0,
      knownLootItems: new Set(['pinewoodLog']),
    });
    expect(withKnowledge.find(t => t.slot === 'helm')?.tier).toBe(4);
  });

  it('a craftable target blocked on a raw ingredient becomes tier 4 (not 5) once that ingredient is a known quest reward', () => {
    const rawIngredientRecipes: RecipeList = [
      makeRecipe({ id: 'r1', output: { ironHelm: 1 }, input: { rareGem: 1 }, station: null }),
    ];
    const withKnowledge = computeUpgradeTargets({
      equipment: { helm: 'copperHelm' },
      inventory: {},
      items,
      recipes: rawIngredientRecipes,
      allMerchantSelling: {},
      playerCoins: 0,
      knownQuestRewardItems: new Set(['rareGem']),
    });
    expect(withKnowledge.find(t => t.slot === 'helm')?.tier).toBe(4);
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

  it('still buys gear with all ingredients in hand when its recipe needs a station that is not nearby', () => {
    const targets: UpgradeTarget[] = [
      {
        itemId: 'ironSword', slot: 'weapon', tier: 4, gain: 5, reachable: true,
        recipe: { id: 'r1', input: { ironIngot: 3 }, required: [], station: 'smithing' },
      },
    ];
    const result = computeTargetsToBuyFromMerchant({
      targets,
      merchantSelling: { ironSword: { price: 100, quantity: 1 } },
      playerCoins: 200,
      inventory: { ironIngot: 3 },
    });
    expect(result.ironSword).toBe(1);
  });

  it('skips buying gear once a matching station is nearby, since it can be crafted this instant instead', () => {
    const targets: UpgradeTarget[] = [
      {
        itemId: 'ironSword', slot: 'weapon', tier: 2, gain: 5, reachable: true,
        recipe: { id: 'r1', input: { ironIngot: 3 }, required: [], station: 'smithing' },
      },
    ];
    const result = computeTargetsToBuyFromMerchant({
      targets,
      merchantSelling: { ironSword: { price: 100, quantity: 1 } },
      playerCoins: 200,
      inventory: { ironIngot: 3 },
      availableStationTypes: new Set(['smithing']),
    });
    expect(result).not.toHaveProperty('ironSword');
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
