import type { UnitStats } from "programming-game/types";
import { DashboardSnapshot, EquipmentItemInfo } from "./dashboard";

type SnapshotEquipment = {
    helm?: string | null;
    chest?: string | null;
    legs?: string | null;
    feet?: string | null;
    hands?: string | null;
    weapon?: string | null;
    offhand?: string | null;
    amulet?: string | null;
    ring1?: string | null;
    ring2?: string | null;
};

type SnapshotPlayer = {
    inventory?: Record<string, number>;
    equipment?: SnapshotEquipment;
};

type SnapshotItemDefinition = {
    name?: string;
    type?: string;
    weight?: number;
    buyFromVendorPrice?: number;
    sellToVendorPrice?: number;
    damage?: number;
    attacksPerSecond?: number;
    stats?: Partial<UnitStats>;
};

type SnapshotHeartbeat = {
    player: SnapshotPlayer;
    items: Record<string, SnapshotItemDefinition>;
    constants?: {
        maxCarryWeight?: number;
    };
};

type SnapshotMeta = {
    recoveringAtHome: boolean;
    idlingAtHome: boolean;
    pursueQuestsEnabled: boolean;
    lowHpThresholdPercent: number;
    lowHpThreshold: number;
    depositItem: string | null;
    depositMessage: string;
    nearbyBankers: number;
    nearbyMerchants: number;
    questRewards: Record<string, { items: Record<string, number> }>;
};

const EQUIPMENT_SLOTS: Array<keyof Required<SnapshotEquipment>> = [
    "helm",
    "chest",
    "legs",
    "feet",
    "hands",
    "weapon",
    "offhand",
    "amulet",
    "ring1",
    "ring2",
];

const getItemWeight = (items: SnapshotHeartbeat["items"], itemId: string | null | undefined) => {
    if (!itemId) {
        return 0;
    }

    const weight = items[itemId]?.weight;
    return typeof weight === "number" ? weight : 0;
};

const getEquipmentItems = (heartbeat: SnapshotHeartbeat): Record<string, EquipmentItemInfo> => {
    const result: Record<string, EquipmentItemInfo> = {};

    for (const slot of EQUIPMENT_SLOTS) {
        const itemId = heartbeat.player.equipment?.[slot];
        if (!itemId || result[itemId]) {
            continue;
        }

        const def = heartbeat.items[itemId];
        if (!def) {
            continue;
        }

        result[itemId] = {
            name: def.name,
            type: def.type,
            weight: def.weight,
            buyFromVendorPrice: def.buyFromVendorPrice,
            sellToVendorPrice: def.sellToVendorPrice,
            damage: def.damage,
            attacksPerSecond: def.attacksPerSecond,
            stats: def.stats,
        };
    }

    return result;
};

const getCarryWeight = (heartbeat: SnapshotHeartbeat) => {
    let totalWeight = 0;

    for (const [itemId, quantity] of Object.entries(heartbeat.player.inventory ?? {})) {
        if (typeof quantity !== "number" || quantity <= 0) {
            continue;
        }

        totalWeight += getItemWeight(heartbeat.items, itemId) * quantity;
    }

    for (const slot of EQUIPMENT_SLOTS) {
        totalWeight += getItemWeight(heartbeat.items, heartbeat.player.equipment?.[slot] ?? null);
    }

    return totalWeight;
};

export const toDashboardSnapshot = (heartbeat: SnapshotHeartbeat, meta: SnapshotMeta): DashboardSnapshot => {
    // `raw` already carries player/units/gameObjects — the dashboard client
    // derives its own player/unit-count/world display data from `raw`
    // instead of us reconstructing (and re-sending) the same data here.
    // weight/maxCarryWeight/equipmentItems are exceptions: they depend on
    // `items` (the full item catalog), which is intentionally stripped from
    // `raw` to avoid sending it wholesale every tick, so they're computed
    // here — while full `items` is still in scope — as plain numbers or, for
    // equipmentItems, a lean per-equipped-item slice of it.
    const { items: _items, ...rawWithoutItems } = heartbeat as unknown as Record<string, unknown>;

    return {
        receivedAt: new Date().toISOString(),
        bot: {
            recoveringAtHome: meta.recoveringAtHome,
            idleAtHome: meta.idlingAtHome,
            pursueQuests: meta.pursueQuestsEnabled,
            lowHpThresholdPercent: meta.lowHpThresholdPercent,
            lowHpThreshold: meta.lowHpThreshold,
            depositItem: meta.depositItem,
            depositMessage: meta.depositMessage,
            nearbyBankers: meta.nearbyBankers,
            nearbyMerchants: meta.nearbyMerchants,
        },
        weight: getCarryWeight(heartbeat),
        maxCarryWeight:
            typeof heartbeat.constants?.maxCarryWeight === "number" ? heartbeat.constants.maxCarryWeight : 70_000,
        questRewards: meta.questRewards,
        equipmentItems: getEquipmentItems(heartbeat),
        raw: rawWithoutItems,
    };
};
