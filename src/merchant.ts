import type { ClientSideUnit } from 'programming-game/types';

export const findBestSellMerchant = (
  merchants: Array<{ unit: ClientSideUnit; buying: Record<string, { price: number; quantity: number } | undefined> }>,
  toSell: Partial<Record<string, number>>,
): { merchant: ClientSideUnit; items: Partial<Record<string, number>> } | null => {
  if (merchants.length === 0 || Object.keys(toSell).length === 0) return null;
  // Rank by estimated payout from buying data; fall back to first merchant when
  // buying data is absent (server will filter to what the merchant accepts).
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
