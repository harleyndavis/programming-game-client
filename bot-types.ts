import { Items } from 'programming-game/items';
import { RECIPE } from 'programming-game/recipes';
import type { PlayerEquipment, ActiveQuests } from 'programming-game/types';

// ── Shared structural types ──────────────────────────────────────────────────

export type QuestMap = ActiveQuests;

export type RecipeList = ReadonlyArray<{
  id?: string;
  input: Partial<Record<string, number>>;
  output: Partial<Record<string, number>>;
  required?: readonly string[];
  station?: string | null;
}>;

export type ItemMap = Record<string, {
  type?: string;
  weight?: number;
  calories?: number;
  stats?: { defense?: number };
  damage?: number;
  attacksPerSecond?: number;
  ammoType?: string;
}>;

export type UpgradeTarget = {
  itemId: string;
  slot: string;
  tier: number;
  gain: number;
  reachable: boolean;
  recipe: {
    id: string;
    input: Partial<Record<string, number>>;
    required: readonly string[];
  } | null;
};

/**
 * A single ingredient requirement for an upgrade plan, tracking how many the
 * bot currently has vs. how many are needed.
 */
export type UpgradeRequirement = {
    item: Items;
    quantity: number;
    have: number;
};

/**
 * A bot-managed upgrade goal for one equipment slot.  Uses game-native types
 * for items and recipes so any game-side changes surface as compile errors here.
 */
export type UpgradePlanItem = {
    id: string;
    targetItem: Items;
    slot: keyof PlayerEquipment;
    name: string;
    priority: number;
    completed: boolean;
    requirements: UpgradeRequirement[];
    recipeId: RECIPE | null;
    canBuy: boolean;
    /** True when this is the next craft target the bot is actively working toward. */
    isNextCraft: boolean;
};
