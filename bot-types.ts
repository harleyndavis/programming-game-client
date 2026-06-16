import { Items } from 'programming-game/items';
import { RECIPE } from 'programming-game/recipes';
import type { PlayerEquipment } from 'programming-game/types';

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
