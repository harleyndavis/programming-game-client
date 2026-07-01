import type { ClientSideUnit } from "programming-game/types";
import type { ItemMap } from "../bot-types";
import { isFinitePosition } from "./utils";

export type MerchantInfo = {
  unit: ClientSideUnit;
  selling: Record<string, { price: number; quantity: number } | undefined>;
  buying: Record<string, { price: number; quantity: number } | undefined>;
};

export const isMerchant = (
  unit: ClientSideUnit,
): unit is ClientSideUnit & { npcType: string; trades: { selling: unknown; buying: unknown } } =>
  (unit as any).type === 'npc' &&
  (unit as any).npcType === 'merchant' &&
  isFinitePosition(unit.position);

export const isBanker = (
  unit: ClientSideUnit,
): unit is ClientSideUnit & { npcType: string } =>
  (unit as any).type === 'npc' &&
  (unit as any).npcType === 'banker' &&
  isFinitePosition(unit.position);

export const collectVisibleMerchants = (
  units: Record<string, ClientSideUnit>,
): MerchantInfo[] => {
  const visible: MerchantInfo[] = [];
  for (const unit of Object.values(units)) {
    if (!isMerchant(unit)) continue;
    const selling = ((unit as any).trades?.selling ?? {}) as Record<string, { price: number; quantity: number } | undefined>;
    const buying = ((unit as any).trades?.buying ?? {}) as Record<string, { price: number; quantity: number } | undefined>;
    visible.push({ unit, selling, buying });
  }
  return visible;
};

export const collectAllMerchantSelling = (
  merchants: MerchantInfo[],
): Record<string, { price: number; quantity: number } | undefined> => {
  const all: Record<string, { price: number; quantity: number } | undefined> = {};
  for (const m of merchants) {
    Object.assign(all, m.selling);
  }
  return all;
};

export const findBestSellMerchant = (
  merchants: MerchantInfo[],
  toSell: Partial<Record<string, number>>,
): { merchant: ClientSideUnit; items: Partial<Record<string, number>> } | null => {
  if (merchants.length === 0 || Object.keys(toSell).length === 0) return null;
  let bestMerchant = merchants[0].unit;
  let bestPayout = -1;
  for (const { unit, buying } of merchants) {
    let payout = 0;
    for (const [itemId, qty] of Object.entries(toSell)) {
      if (typeof qty !== 'number' || qty <= 0) continue;
      const offer = buying[itemId];
      if (offer && offer.price > 0 && offer.quantity > 0) {
        payout += offer.price * Math.min(qty, offer.quantity);
      }
    }
    if (payout > bestPayout) { bestPayout = payout; bestMerchant = unit; }
  }
  return { merchant: bestMerchant, items: toSell };
};

export const getStorageFeeInfo = (
  storage: Record<string, number>,
  items: ItemMap,
  feeBuffer: number,
): { storageWeight: number; feePerCharge: number; minCoins: number; availableWithdrawal: number } => {
  const storageRecord = storage ?? {};
  const storageCoins = typeof storageRecord.copperCoin === 'number' ? storageRecord.copperCoin : 0;
  const storageItemsWeight = Object.entries(storageRecord)
    .filter(([id]) => id !== 'copperCoin')
    .reduce((sum, [id, qty]) => {
      const defW = (items as Record<string, { weight?: number }> | undefined)?.[id]?.weight ?? 0;
      return sum + defW * (typeof qty === 'number' ? qty : 1);
    }, 0);
  const storageWeight = storageItemsWeight + storageCoins;
  const feePerCharge = Math.ceil(storageWeight * 0.0025);
  const minCoins = feePerCharge * feeBuffer;
  const availableWithdrawal = Math.max(0, storageCoins - minCoins);
  return { storageWeight, feePerCharge, minCoins, availableWithdrawal };
};
