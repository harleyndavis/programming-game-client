import type { RecipeList, UpgradeTarget } from "../bot-types";

export const findCraftableTarget = (
  targets: UpgradeTarget[],
  inventory: Partial<Record<string, number>>,
  recipes: RecipeList,
): UpgradeTarget | null => {
  for (const target of targets) {
    if (!target.recipe) continue;
    let canCraft = true;
    for (const [inputId, qty] of Object.entries(target.recipe.input)) {
      if ((inventory[inputId] ?? 0) < (qty ?? 0)) { canCraft = false; break; }
    }
    if (canCraft) {
      for (const toolId of target.recipe.required) {
        if ((inventory[toolId as string] ?? 0) < 1) { canCraft = false; break; }
      }
      if (canCraft) return target;
    }
    const subStep = findCraftableSubStep(target.recipe, inventory, recipes, new Set<string>());
    if (subStep) {
      return {
        itemId: subStep.recipeId,
        slot: target.slot,
        tier: 0,
        gain: 0,
        reachable: true,
        recipe: subStep.recipe,
      };
    }
  }
  return null;
};

export const findNextCraftTarget = (targets: UpgradeTarget[]): UpgradeTarget | null => {
  for (const target of targets) {
    if (target.reachable) return target;
  }
  return targets[0] ?? null;
};

export const findCraftableSubStep = (
  recipe: NonNullable<UpgradeTarget['recipe']>,
  inventory: Partial<Record<string, number>>,
  recipes: RecipeList,
  visited: Set<string>,
): { recipeId: string; recipe: UpgradeTarget['recipe'] } | null => {
  for (const [inputId, neededQty] of Object.entries(recipe.input)) {
    const have = inventory[inputId] ?? 0;
    if (have >= (neededQty ?? 0)) continue;
    if (visited.has(inputId)) continue;
    visited.add(inputId);
    const inputRecipe = recipes.find(r => inputId in r.output && r.station == null);
    if (!inputRecipe || !inputRecipe.id) continue;
    let canCraft = true;
    for (const [subId, subQty] of Object.entries(inputRecipe.input)) {
      if ((inventory[subId] ?? 0) < (subQty ?? 0)) { canCraft = false; break; }
    }
    if (canCraft) {
      for (const toolId of inputRecipe.required ?? []) {
        if ((inventory[toolId as string] ?? 0) < 1) { canCraft = false; break; }
      }
    }
    if (canCraft) {
      return {
        recipeId: inputRecipe.id,
        recipe: {
          id: inputRecipe.id,
          input: inputRecipe.input as Partial<Record<string, number>>,
          required: inputRecipe.required ?? [],
        },
      };
    }
    const subRecipe: UpgradeTarget['recipe'] = {
      id: inputRecipe.id,
      input: inputRecipe.input as Partial<Record<string, number>>,
      required: inputRecipe.required ?? [],
    };
    const deeper = findCraftableSubStep(subRecipe, inventory, recipes, visited);
    if (deeper) return deeper;
  }
  return null;
};
