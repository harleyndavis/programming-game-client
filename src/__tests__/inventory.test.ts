import { describe, it, expect } from 'vitest';
import {
  getInventoryWeight,
  findHeaviestInventoryItem,
  findCheapestFood,
  computeFoodToKeep,
  computeItemsToSell,
} from '../inventory';
import type { ItemMap, QuestMap } from '../../bot-types';

describe('getInventoryWeight', () => {
  const items: Record<string, { weight?: number }> = {
    copperCoin: { weight: 0.01 },
    ratMeat: { weight: 0.5 },
    copperSword: { weight: 3 },
    woodenShield: { weight: 2 },
  };

  it('returns 0 for empty inventory', () => {
    expect(getInventoryWeight({}, items)).toBe(0);
  });

  it('sums item quantities x weight', () => {
    expect(getInventoryWeight({ copperCoin: 100, ratMeat: 5 }, items)).toBe(100 * 0.01 + 5 * 0.5);
  });

  it('includes equipped item weight', () => {
    const equipment = { weapon: 'copperSword', offhand: 'woodenShield' };
    const result = getInventoryWeight({ copperCoin: 50 }, items, equipment);
    expect(result).toBe(50 * 0.01 + 3 + 2);
  });

  it('skips items with no weight field', () => {
    const sparseItems = { mysteryItem: {} };
    expect(getInventoryWeight({ mysteryItem: 5 }, sparseItems)).toBe(0);
  });

  it('skips items with zero or negative quantity', () => {
    expect(getInventoryWeight({ copperCoin: 0, ratMeat: -1 }, items)).toBe(0);
  });

  it('handles null/undefined equipment slots', () => {
    const equipment = { weapon: 'copperSword', offhand: null, helm: undefined };
    const result = getInventoryWeight({}, items, equipment);
    expect(result).toBe(3);
  });
});

describe('findHeaviestInventoryItem', () => {
  const items: Record<string, { weight?: number }> = {
    copperCoin: { weight: 0.01 },
    ratMeat: { weight: 0.5 },
    copperSword: { weight: 3 },
  };

  it('returns null for empty inventory', () => {
    expect(findHeaviestInventoryItem({}, items)).toBeNull();
  });

  it('returns the item with highest total weight', () => {
    const result = findHeaviestInventoryItem({ copperCoin: 100, copperSword: 1, ratMeat: 2 }, items);
    expect(result).toEqual({ item: 'copperSword', amount: 1 });
  });

  it('skips zero-quantity items', () => {
    const result = findHeaviestInventoryItem({ copperCoin: 0, copperSword: 1 }, items);
    expect(result).toEqual({ item: 'copperSword', amount: 1 });
  });
});

describe('findCheapestFood', () => {
  const items: Record<string, { calories?: number }> = {
    ratMeat: { calories: 30 },
    chickenMeat: { calories: 50 },
    copperCoin: {},
    berry: { calories: 10 },
  };

  it('returns null for empty inventory', () => {
    expect(findCheapestFood({}, items)).toBeNull();
  });

  it('returns null when no food items exist', () => {
    expect(findCheapestFood({ copperCoin: 100 }, items)).toBeNull();
  });

  it('returns the item with lowest calories per unit', () => {
    const result = findCheapestFood({ ratMeat: 5, chickenMeat: 3, berry: 10 }, items);
    expect(result).toEqual({ item: 'berry', calories: 10 });
  });

  it('skips zero-quantity items', () => {
    expect(findCheapestFood({ ratMeat: 0, chickenMeat: 3 }, items)).toEqual({
      item: 'chickenMeat',
      calories: 50,
    });
  });
});

describe('computeFoodToKeep', () => {
  const items: ItemMap = {
    ratMeat: { calories: 30 },
    chickenMeat: { calories: 50 },
    berry: { calories: 10 },
  };

  it('returns empty object for empty inventory', () => {
    expect(computeFoodToKeep({}, items, 100)).toEqual({});
  });

  it('prefers highest-calorie items first', () => {
    const result = computeFoodToKeep({ ratMeat: 5, chickenMeat: 3, berry: 10 }, items, 60);
    expect(result.chickenMeat).toBe(2);
    expect(result).not.toHaveProperty('ratMeat');
    expect(result).not.toHaveProperty('berry');
  });

  it('returns partial coverage when not enough food', () => {
    const result = computeFoodToKeep({ berry: 3 }, items, 100);
    expect(result.berry).toBe(3);
  });

  it('returns empty when no food items exist', () => {
    expect(computeFoodToKeep({ copperCoin: 100 }, items, 100)).toEqual({});
  });
});

describe('computeItemsToSell', () => {
  const items: ItemMap = {
    copperCoin: { type: 'currency' },
    ratMeat: { calories: 30 },
    chickenMeat: { calories: 50 },
    ratPelt: {},
    copperOre: {},
  };

  const quests: QuestMap = {
    quest1: { id: 'quest1', start_npc: 'npc1', end_npc: 'npc1', name: 'Quest 1', steps: [{ type: 'turn_in', target: 'npc1', requiredItems: { ratPelt: 3 }, position: {} }] },
  };

  it('returns empty when no surplus', () => {
    const result = computeItemsToSell({
      inventory: { ratMeat: 2 },
      items,
      quests: {},
      keepItems: new Set(),
      maxCalories: 100,
    });
    expect(result).toEqual({});
  });

  it('keeps quest items and food reserve', () => {
    const result = computeItemsToSell({
      inventory: { ratMeat: 10, ratPelt: 5 },
      items,
      quests,
      keepItems: new Set(),
      maxCalories: 100,
    });
    expect(result.ratMeat).toBe(6);
    expect(result.ratPelt).toBe(2);
  });

  it('protects keepItems from being sold', () => {
    const result = computeItemsToSell({
      inventory: { copperOre: 5 },
      items,
      quests: {},
      keepItems: new Set(['copperOre']),
      maxCalories: 0,
    });
    expect(result).not.toHaveProperty('copperOre');
  });

  it('never sells currency items', () => {
    const result = computeItemsToSell({
      inventory: { copperCoin: 100 },
      items,
      quests: {},
      keepItems: new Set(),
      maxCalories: 0,
    });
    expect(result).not.toHaveProperty('copperCoin');
  });

  it('handles complex scenario with all conditions', () => {
    const result = computeItemsToSell({
      inventory: {
        ratMeat: 10,
        chickenMeat: 5,
        ratPelt: 5,
        copperOre: 2,
        berry: 20,
        copperCoin: 50,
      },
      items,
      quests,
      keepItems: new Set(['copperOre']),
      maxCalories: 120,
    });
    expect(result).not.toHaveProperty('copperCoin');
    expect(result).not.toHaveProperty('copperOre');
    expect(result.ratPelt).toBe(2);
  });

  it('sells surplus beyond keepQuantities even for keepItems-protected items', () => {
    const result = computeItemsToSell({
      inventory: { ratPelt: 30 },
      items,
      quests: {},
      keepItems: new Set(['ratPelt']),
      keepQuantities: { ratPelt: 5 },
      maxCalories: 0,
    });
    expect(result.ratPelt).toBe(25);
  });

  it('keeps everything when quantity is within the keepQuantities bound', () => {
    const result = computeItemsToSell({
      inventory: { ratPelt: 5 },
      items,
      quests: {},
      keepItems: new Set(['ratPelt']),
      keepQuantities: { ratPelt: 5 },
      maxCalories: 0,
    });
    expect(result).not.toHaveProperty('ratPelt');
  });

  it('keepQuantities of 0 sells the full stack of a protected item', () => {
    const result = computeItemsToSell({
      inventory: { ratPelt: 8 },
      items,
      quests: {},
      keepItems: new Set(['ratPelt']),
      keepQuantities: { ratPelt: 0 },
      maxCalories: 0,
    });
    expect(result.ratPelt).toBe(8);
  });

  it('quest turn-in quantities still win over a smaller keepQuantities bound', () => {
    const quests: QuestMap = {
      q1: { id: 'q1', steps: [{ type: 'turn_in', requiredItems: { ratPelt: 6 } }] },
    } as unknown as QuestMap;
    const result = computeItemsToSell({
      inventory: { ratPelt: 10 },
      items,
      quests,
      keepItems: new Set(['ratPelt']),
      keepQuantities: { ratPelt: 2 },
      maxCalories: 0,
    });
    expect(result.ratPelt).toBe(4);
  });
});
