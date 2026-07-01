import { UNIT_TYPE } from "programming-game/types";
import { DashboardSnapshot, Position } from "./dashboard";

type SnapshotUnit = {
    type?: string;
    hp?: number;
    position?: Position;
};

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
    name?: string;
    hp?: number;
    mp?: number;
    tp?: number;
    calories?: number;
    inventory?: Record<string, number>;
    storage?: Record<string, number>;
    equipment?: SnapshotEquipment;
    spellbook?: string[];
    combatSkills?: Record<string, number>;
    stats?: {
        maxHp?: number;
        attack?: number;
        defense?: number;
        movementSpeed?: number;
    };
    position?: Position;
    action?: string;
    actionTarget?: string;
    actionDuration?: number;
    actionStart?: number;
    intent?: { type?: string };
    statusEffects?: Record<string, unknown>;
};

type SnapshotHeartbeat = {
    player: SnapshotPlayer;
    units: Record<string, SnapshotUnit>;
    items: Record<string, { weight?: number }>;
    constants?: {
        maxCarryWeight?: number;
    };
};

type SnapshotMeta = {
    recoveringAtHome: boolean;
    idlingAtHome: boolean;
    lowHpThresholdPercent: number;
    lowHpThreshold: number;
    depositItem: string | null;
    depositMessage: string;
    nearbyBankers: number;
    nearbyMerchants: number;
    questRewards: Record<string, { items: Record<string, number> }>;
};

const toPosition = (position?: Position): Position | null => {
    if (!position || typeof position.x !== "number" || typeof position.y !== "number") {
        return null;
    }

    return {
        x: position.x,
        y: position.y,
    };
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
    const units = Object.keys(heartbeat.units).map((unitId) => {
        const unit = heartbeat.units[unitId];

        return {
            id: unitId,
            type: unit.type ?? "unknown",
            hp: typeof unit.hp === "number" ? unit.hp : null,
            position: toPosition(unit.position),
        };
    });

    return {
        receivedAt: new Date().toISOString(),
        bot: {
            recoveringAtHome: meta.recoveringAtHome,
            idleAtHome: meta.idlingAtHome,
            lowHpThresholdPercent: meta.lowHpThresholdPercent,
            lowHpThreshold: meta.lowHpThreshold,
            depositItem: meta.depositItem,
            depositMessage: meta.depositMessage,
            nearbyBankers: meta.nearbyBankers,
            nearbyMerchants: meta.nearbyMerchants,
        },
        serverState: {
            action: typeof heartbeat.player.action === "string" ? heartbeat.player.action : null,
            actionTarget: typeof heartbeat.player.actionTarget === "string" ? heartbeat.player.actionTarget : null,
            actionDuration: typeof heartbeat.player.actionDuration === "number" ? heartbeat.player.actionDuration : null,
            actionStart: typeof heartbeat.player.actionStart === "number" ? heartbeat.player.actionStart : null,
            intentType: typeof heartbeat.player.intent?.type === "string" ? heartbeat.player.intent.type : null,
            statusEffects: Object.keys(heartbeat.player.statusEffects ?? {}),
        },
        player: {
            name: typeof heartbeat.player.name === "string" ? heartbeat.player.name : null,
            hp: typeof heartbeat.player.hp === "number" ? heartbeat.player.hp : null,
            maxHp: typeof heartbeat.player.stats?.maxHp === "number" ? heartbeat.player.stats.maxHp : null,
            movementSpeed: typeof heartbeat.player.stats?.movementSpeed === "number" ? heartbeat.player.stats.movementSpeed : null,
            mp: typeof heartbeat.player.mp === "number" ? heartbeat.player.mp : null,
            tp: typeof heartbeat.player.tp === "number" ? heartbeat.player.tp : null,
            calories: typeof heartbeat.player.calories === "number" ? heartbeat.player.calories : null,
            attack: typeof heartbeat.player.stats?.attack === "number" ? heartbeat.player.stats.attack : null,
            defense: typeof heartbeat.player.stats?.defense === "number" ? heartbeat.player.stats.defense : null,
            weight: getCarryWeight(heartbeat),
            maxCarryWeight:
                typeof heartbeat.constants?.maxCarryWeight === "number" ? heartbeat.constants.maxCarryWeight : 70_000,
            position: toPosition(heartbeat.player.position),
            equipment: {
                helm: heartbeat.player.equipment?.helm ?? null,
                chest: heartbeat.player.equipment?.chest ?? null,
                legs: heartbeat.player.equipment?.legs ?? null,
                feet: heartbeat.player.equipment?.feet ?? null,
                hands: heartbeat.player.equipment?.hands ?? null,
                weapon: heartbeat.player.equipment?.weapon ?? null,
                offhand: heartbeat.player.equipment?.offhand ?? null,
                amulet: heartbeat.player.equipment?.amulet ?? null,
                ring1: heartbeat.player.equipment?.ring1 ?? null,
                ring2: heartbeat.player.equipment?.ring2 ?? null,
            },
            combatSkills: { ...(heartbeat.player.combatSkills ?? {}) },
            spellbook: Array.isArray(heartbeat.player.spellbook) ? [...heartbeat.player.spellbook] : [],
            inventory: { ...(heartbeat.player.inventory ?? {}) },
            storage: { ...(heartbeat.player.storage ?? {}) },
        },
        unitCount: units.length,
        monstersVisible: units.filter((u) => u.type === UNIT_TYPE.monster).length,
        units,
        questRewards: meta.questRewards,
        // Pass the raw heartbeat through unmodified so the dashboard can show
        // exactly what the server sent, rather than our processed version.
        raw: heartbeat as unknown as Record<string, unknown>,
    };
};
