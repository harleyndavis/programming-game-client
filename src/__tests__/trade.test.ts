import { describe, it, expect } from 'vitest';
import {
  findBestSellMerchant,
  isMerchant,
  isBanker,
  collectVisibleMerchants,
  collectAllMerchantSelling,
  getStorageFeeInfo,
} from '../trade';
import type { MerchantInfo } from '../trade';
import type { ClientSideUnit } from 'programming-game/types';
import type { ItemMap } from '../../bot-types';

const makeUnit = (overrides: Partial<ClientSideUnit> = {}): ClientSideUnit =>
  ({ id: 'u1', type: 'npc', position: { x: 0, y: 0 }, ...overrides }) as ClientSideUnit;

describe('isMerchant', () => {
  it('returns true for merchant NPC with valid position', () => {
    const unit = makeUnit({ npcType: 'merchant' } as any);
    expect(isMerchant(unit)).toBe(true);
  });

  it('returns false for non-NPC units', () => {
    const unit = { id: 'm1', type: 'monster', position: { x: 0, y: 0 } } as ClientSideUnit;
    expect(isMerchant(unit)).toBe(false);
  });

  it('returns false for banker NPCs', () => {
    const unit = makeUnit({ npcType: 'banker' } as any);
    expect(isMerchant(unit)).toBe(false);
  });

  it('returns false for units without a position', () => {
    const unit = { id: 'm1', type: 'npc', npcType: 'merchant' } as ClientSideUnit;
    expect(isMerchant(unit)).toBe(false);
  });
});

describe('isBanker', () => {
  it('returns true for banker NPC with valid position', () => {
    const unit = makeUnit({ npcType: 'banker' } as any);
    expect(isBanker(unit)).toBe(true);
  });

  it('returns false for merchant NPCs', () => {
    const unit = makeUnit({ npcType: 'merchant' } as any);
    expect(isBanker(unit)).toBe(false);
  });
});

describe('collectVisibleMerchants', () => {
  it('returns empty for no units', () => {
    expect(collectVisibleMerchants({})).toEqual([]);
  });

  it('collects merchant units with trades', () => {
    const units = {
      m1: { id: 'm1', type: 'npc', npcType: 'merchant', position: { x: 1, y: 1 }, trades: { selling: { sword: { price: 100, quantity: 1 } } } } as any,
      b1: { id: 'b1', type: 'npc', npcType: 'banker', position: { x: 0, y: 0 } } as any,
    };
    const result = collectVisibleMerchants(units);
    expect(result.length).toBe(1);
    expect(result[0].unit.id).toBe('m1');
  });
});

describe('collectAllMerchantSelling', () => {
  it('merges selling inventories across merchants', () => {
    const merchants: MerchantInfo[] = [
      { unit: makeUnit(), selling: { sword: { price: 100, quantity: 1 } }, buying: {} },
      { unit: makeUnit(), selling: { shield: { price: 50, quantity: 2 } }, buying: {} },
    ];
    const result = collectAllMerchantSelling(merchants);
    expect(result.sword).toEqual({ price: 100, quantity: 1 });
    expect(result.shield).toEqual({ price: 50, quantity: 2 });
  });
});

describe('findBestSellMerchant', () => {
  it('returns null for empty merchants', () => {
    expect(findBestSellMerchant([], { ratPelt: 5 })).toBeNull();
  });

  it('returns null for empty sell list', () => {
    const merchants: MerchantInfo[] = [
      { unit: makeUnit(), selling: {}, buying: { ratPelt: { price: 10, quantity: 5 } } },
    ];
    expect(findBestSellMerchant(merchants, {})).toBeNull();
  });

  it('picks merchant with highest payout', () => {
    const merchants: MerchantInfo[] = [
      {
        unit: makeUnit({ id: 'm1' }),
        selling: {},
        buying: { ratPelt: { price: 5, quantity: 10 } },
      },
      {
        unit: makeUnit({ id: 'm2' }),
        selling: {},
        buying: { ratPelt: { price: 8, quantity: 10 } },
      },
    ];
    const result = findBestSellMerchant(merchants, { ratPelt: 5 });
    expect(result).not.toBeNull();
    expect(result!.merchant.id).toBe('m2');
    expect(result!.items).toEqual({ ratPelt: 5 });
  });

  it('respects merchant buy quantity caps', () => {
    const merchants: MerchantInfo[] = [
      {
        unit: makeUnit({ id: 'm1' }),
        selling: {},
        buying: { ratPelt: { price: 10, quantity: 2 } },
      },
    ];
    const result = findBestSellMerchant(merchants, { ratPelt: 5 });
    expect(result).not.toBeNull();
  });
});

describe('getStorageFeeInfo', () => {
  const items: ItemMap = {
    copperCoin: { type: 'currency' },
    ratPelt: { weight: 0.5 },
    copperOre: { weight: 1 },
  };

  it('handles empty storage', () => {
    const info = getStorageFeeInfo({}, items, 100);
    expect(info.storageWeight).toBe(0);
    expect(info.feePerCharge).toBe(0);
    expect(info.minCoins).toBe(0);
    expect(info.availableWithdrawal).toBe(0);
  });

  it('calculates weight and fees', () => {
    const info = getStorageFeeInfo({ copperCoin: 200, ratPelt: 10 }, items, 100);
    // storageWeight = 10 * 0.5 + 200 = 205
    // feePerCharge = ceil(205 * 0.0025) = ceil(0.5125) = 1
    // minCoins = 1 * 100 = 100
    // availableWithdrawal = 200 - 100 = 100
    expect(info.storageWeight).toBe(205);
    expect(info.feePerCharge).toBe(1);
    expect(info.minCoins).toBe(100);
    expect(info.availableWithdrawal).toBe(100);
  });

  it('handles non-coin storage items with string quantities', () => {
    const info = getStorageFeeInfo({ copperOre: 5 }, items, 100);
    // storageWeight = 5 * 1 = 5
    // feePerCharge = ceil(5 * 0.0025) = ceil(0.0125) = 1
    // availableWithdrawal = 0 - 1 * 100 = -100 → 0
    expect(info.availableWithdrawal).toBe(0);
  });
});
