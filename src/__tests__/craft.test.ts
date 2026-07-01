import { describe, it, expect } from 'vitest';
import { findCraftableTarget, findNextCraftTarget, findCraftableSubStep } from '../craft';
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

  it('returns null when sub-recipe requires a station', () => {
    const recipes: RecipeList = [
      { id: 'r2', input: { copperOre: 2 }, output: { copperIngot: 1 }, required: [], station: 'furnace' },
    ];
    const recipe = { id: 'r1', input: { copperIngot: 3 }, required: ['hammer'] };
    const result = findCraftableSubStep(recipe, { copperOre: 6, hammer: 1 }, recipes, new Set());
    expect(result).toBeNull();
  });

  it('returns null when sub-recipe is missing from recipe list', () => {
    const recipe = { id: 'r1', input: { copperIngot: 3 }, required: ['hammer'] };
    const result = findCraftableSubStep(recipe, { copperOre: 6, hammer: 1 }, [], new Set());
    expect(result).toBeNull();
  });
});
