import { createServer, IncomingMessage, ServerResponse } from "http";
import { UpgradePlanItem, ToolPlanItem } from "./bot-types";
import { readFileSync } from "fs";
import { join } from "path";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import type Database from "better-sqlite3";
import type { Monsters } from "programming-game/monsters";
import {
    Entity,
    HeatMapSighting,
    MerchantTradeRow,
    CombatStats,
    QuestRecord,
    getKnownEntities,
    getHeatMapSightings,
    getAllMerchantTrades,
    getCombatHistory,
    getLootRates,
    getKnownQuestsForNpc,
} from "./src/memory";

export type Position = {
    x: number;
    y: number;
};

export type RawEvent = { ts: string; name: string; data: unknown };

export type StorageFeeInfo = {
    coinsInStorage: number;
    perCharge: number;
    buffer: number;
    coverage: number;
    availableWithdrawal: number;
};

export type DashboardSnapshot = {
    receivedAt: string;
    bot: {
        recoveringAtHome: boolean;
        idleAtHome: boolean;
        pursueQuests: boolean;
        lowHpThresholdPercent: number;
        lowHpThreshold: number;
        /** Item the dashboard user requested to deposit, shown until processed. */
        depositItem: string | null;
        /** Human-readable deposit status message. */
        depositMessage: string;
        nearbyBankers: number;
        nearbyMerchants: number;
    };
    // Carry weight requires per-item weight lookups (`items`), which is
    // intentionally stripped from `raw` to avoid sending the full item
    // catalog — these two numbers are the exception, computed server-side
    // while `items` is still available. Everything else about the player
    // (name, hp, position, equipment, inventory, etc.) is already in `raw`
    // and is derived client-side instead of being duplicated here.
    weight: number | null;
    maxCarryWeight: number | null;
    /** The heartbeat as received from the game server, minus `recipes`/`items` (sent once, cached client-side). */
    raw: Record<string, unknown>;
    /** Storage fee breakdown — computed by the bot tick. */
    storageFee?: StorageFeeInfo;
    /** Bot equipment upgrade plans. */
    upgradePlans?: UpgradePlanItem[];
    /** Bot tool crafting plans — managed alongside upgradePlans. */
    toolPlans?: ToolPlanItem[];
    /** Quest rewards captured at acceptance time (server doesn't include them on active quests). */
    questRewards?: Record<string, { items: Record<string, number> }>;
    /** Quantity of each ingredient the bot's active crafting chains need to keep — used to cap storage hoarding. */
    chainKeepNeeds?: Record<string, number>;
    /** Recent raw server events captured by onEvent, kept in separate per-category buffers. */
    storageEvents?: RawEvent[];
    harvestEvents?: RawEvent[];
    combatEvents?: RawEvent[];
    arenaEvents?: RawEvent[];
};

export type MemoryLootRateRow = {
    entityType: string;
    entityName: string;
    item: string;
    dropChance: number;
    avgQuantityPerEvent: number;
    minQuantity: number | null;
    maxQuantity: number | null;
};

export type MemoryQuestEntry = QuestRecord & { npcName: string };

export type MemorySnapshot = {
    generatedAt: string;
    entities: Entity[];
    heatMap: HeatMapSighting[];
    merchantTrades: MerchantTradeRow[];
    combatHistory: CombatStats[];
    lootRates: MemoryLootRateRow[];
    quests: MemoryQuestEntry[];
};

/**
 * Composes several single-domain memory reads into one dashboard-shaped view. This is
 * presentation logic, not a store concern — memory.ts stays a dumb store, this is the
 * one consumer that needs "everything known" fanned out per entity.
 */
const buildMemorySnapshot = (memoryDb: Database.Database): MemorySnapshot => {
    const combatHistory = getKnownEntities(memoryDb, { entityType: "monster" })
        .map((e) => getCombatHistory(memoryDb, e.entityName as Monsters))
        .filter((c): c is CombatStats => c !== null);

    const lootRates: MemoryLootRateRow[] = getKnownEntities(memoryDb)
        .filter((e) => e.entityType === "monster" || e.entityType === "resource")
        .flatMap((e) =>
            getLootRates(memoryDb, e.entityType, e.entityName).map((r) => ({
                entityType: e.entityType,
                entityName: e.entityName,
                item: r.item,
                dropChance: r.dropChance,
                avgQuantityPerEvent: r.avgQuantityPerEvent,
                minQuantity: r.minQuantity,
                maxQuantity: r.maxQuantity,
            })),
        );

    const quests = getKnownEntities(memoryDb, { entityType: "npc" }).flatMap((npc) =>
        getKnownQuestsForNpc(memoryDb, npc.entityName).map((q) => ({ ...q, npcName: npc.entityName })),
    );

    return {
        generatedAt: new Date().toISOString(),
        entities: getKnownEntities(memoryDb),
        heatMap: getHeatMapSightings(memoryDb),
        merchantTrades: getAllMerchantTrades(memoryDb),
        combatHistory,
        lootRates,
        quests,
    };
};

type DashboardThresholdConfig = {
    getThresholdPercent: () => number;
    setThresholdPercent: (nextPercent: number) => number;
};

type DashboardIdleAtHomeConfig = {
    getIdleAtHome: () => boolean;
    setIdleAtHome: (value: boolean) => boolean;
};

type DashboardPursueQuestsConfig = {
    getPursueQuests: () => boolean;
    setPursueQuests: (value: boolean) => boolean;
};

type DashboardDepositRequestConfig = {
    getPendingItem: () => string | null;
    setPendingItem: (item: string | null) => void;
};

export const createDashboard = (port: number, memoryDb: Database.Database) => {
    let latestSnapshot: DashboardSnapshot = {
        receivedAt: new Date().toISOString(),
        bot: {
            recoveringAtHome: false,
            idleAtHome: false,
            pursueQuests: true,
            lowHpThresholdPercent: 25,
            lowHpThreshold: 0,
            depositItem: null,
            depositMessage: '',
            nearbyBankers: 0,
            nearbyMerchants: 0,
        },
        weight: null,
        maxCarryWeight: null,
        raw: {},
        upgradePlans: [],
        toolPlans: [],
    };

    let thresholdConfig: DashboardThresholdConfig = {
        getThresholdPercent: () => latestSnapshot.bot.lowHpThresholdPercent,
        setThresholdPercent: (nextPercent) => {
            const clamped = Math.min(95, Math.max(1, nextPercent));
            latestSnapshot = {
                ...latestSnapshot,
                bot: {
                    ...latestSnapshot.bot,
                    lowHpThresholdPercent: clamped,
                },
            };
            return clamped;
        },
    };

    let idleAtHomeConfig: DashboardIdleAtHomeConfig = {
        getIdleAtHome: () => latestSnapshot.bot.idleAtHome,
        setIdleAtHome: (value) => {
            latestSnapshot = {
                ...latestSnapshot,
                bot: { ...latestSnapshot.bot, idleAtHome: value },
            };
            return value;
        },
    };

    let depositRequestConfig: DashboardDepositRequestConfig = {
        getPendingItem: () => null,
        setPendingItem: (_item) => { /* no-op default */ },
    };

    let pursueQuestsConfig: DashboardPursueQuestsConfig = {
        getPursueQuests: () => latestSnapshot.bot.pursueQuests,
        setPursueQuests: (value) => {
            latestSnapshot = {
                ...latestSnapshot,
                bot: { ...latestSnapshot.bot, pursueQuests: value },
            };
            return value;
        },
    };

    const loadDashboardHtml = () => readFileSync(join(__dirname, "dashboard.html"), "utf-8");
    const loadDashboardCss = () => readFileSync(join(__dirname, "dashboard.css"), "utf-8");
    const loadDashboardClientJs = () => {
        const dashboardClientTs = readFileSync(join(__dirname, "dashboard-client.ts"), "utf-8");
        return transpileModule(dashboardClientTs, {
            compilerOptions: {
                target: ScriptTarget.ES2020,
                module: ModuleKind.None,
            },
        }).outputText;
    };
    const loadMemoryHtml = () => readFileSync(join(__dirname, "memory.html"), "utf-8");
    const loadMemoryClientJs = () => {
        const memoryClientTs = readFileSync(join(__dirname, "memory-client.ts"), "utf-8");
        return transpileModule(memoryClientTs, {
            compilerOptions: {
                target: ScriptTarget.ES2020,
                module: ModuleKind.None,
            },
        }).outputText;
    };

    const writeJson = (res: ServerResponse, body: unknown) => {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify(body, null, 2));
    };

    const writeError = (res: ServerResponse, statusCode: number, message: string) => {
        res.statusCode = statusCode;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: message }));
    };

    const readRequestBody = (req: IncomingMessage) => {
        return new Promise<string>((resolve, reject) => {
            let body = "";
            req.on("data", (chunk: Buffer | string) => {
                body += String(chunk);
            });
            req.on("end", () => {
                resolve(body);
            });
            req.on("error", (err: Error) => {
                reject(err);
            });
        });
    };

    let server: ReturnType<typeof createServer> | null = null;

    return {
        configureThreshold(config: DashboardThresholdConfig) {
            thresholdConfig = config;
        },
        configureIdleAtHome(config: DashboardIdleAtHomeConfig) {
            idleAtHomeConfig = config;
        },
        configureDepositRequest(config: DashboardDepositRequestConfig) {
            depositRequestConfig = config;
        },
        configurePursueQuests(config: DashboardPursueQuestsConfig) {
            pursueQuestsConfig = config;
        },
        stop() {
            if (server) {
                try { (server as any).closeAllConnections?.(); } catch { /* ignore */ }
                try { server.close(); } catch { /* ignore */ }
                server = null;
            }
        },
        start() {
            server = createServer(async (req, res) => {
                const url = req.url ?? "/";

                if (url === "/") {
                    try {
                        res.statusCode = 200;
                        res.setHeader("Content-Type", "text/html; charset=utf-8");
                        res.setHeader("Cache-Control", "no-store");
                        res.end(loadDashboardHtml());
                    } catch (err) {
                        writeError(res, 500, `failed to load dashboard html: ${String(err)}`);
                    }
                    return;
                }

                if (url === "/dashboard.css") {
                    try {
                        res.statusCode = 200;
                        res.setHeader("Content-Type", "text/css; charset=utf-8");
                        res.setHeader("Cache-Control", "no-store");
                        res.end(loadDashboardCss());
                    } catch (err) {
                        writeError(res, 500, `failed to load dashboard css: ${String(err)}`);
                    }
                    return;
                }

                if (url === "/dashboard-client.js") {
                    try {
                        res.statusCode = 200;
                        res.setHeader("Content-Type", "application/javascript; charset=utf-8");
                        res.setHeader("Cache-Control", "no-store");
                        res.end(loadDashboardClientJs());
                    } catch (err) {
                        writeError(res, 500, `failed to load dashboard client js: ${String(err)}`);
                    }
                    return;
                }

                if (url === "/state") {
                    writeJson(res, latestSnapshot);
                    return;
                }

                if (url === "/memory") {
                    try {
                        res.statusCode = 200;
                        res.setHeader("Content-Type", "text/html; charset=utf-8");
                        res.setHeader("Cache-Control", "no-store");
                        res.end(loadMemoryHtml());
                    } catch (err) {
                        writeError(res, 500, `failed to load memory html: ${String(err)}`);
                    }
                    return;
                }

                if (url === "/memory-client.js") {
                    try {
                        res.statusCode = 200;
                        res.setHeader("Content-Type", "application/javascript; charset=utf-8");
                        res.setHeader("Cache-Control", "no-store");
                        res.end(loadMemoryClientJs());
                    } catch (err) {
                        writeError(res, 500, `failed to load memory client js: ${String(err)}`);
                    }
                    return;
                }

                if (url === "/memory/data") {
                    try {
                        writeJson(res, buildMemorySnapshot(memoryDb));
                    } catch (err) {
                        writeError(res, 500, `failed to read memory store: ${String(err)}`);
                    }
                    return;
                }

                if (url === "/config" && req.method === "GET") {
                    writeJson(res, {
                        lowHpThresholdPercent: thresholdConfig.getThresholdPercent(),
                    });
                    return;
                }

                if (url === "/config/idle-at-home" && req.method === "POST") {
                    const next = !idleAtHomeConfig.getIdleAtHome();
                    const applied = idleAtHomeConfig.setIdleAtHome(next);
                    writeJson(res, { idleAtHome: applied });
                    return;
                }

                if (url === "/config/pursue-quests" && req.method === "POST") {
                    const next = !pursueQuestsConfig.getPursueQuests();
                    const applied = pursueQuestsConfig.setPursueQuests(next);
                    writeJson(res, { pursueQuests: applied });
                    return;
                }

                if (url === "/config/threshold" && req.method === "POST") {
                    try {
                        const body = await readRequestBody(req);
                        const parsed = body ? JSON.parse(body) : {};
                        const nextPercent = Number(parsed.percent);
                        if (!Number.isFinite(nextPercent)) {
                            writeError(res, 400, "percent must be a finite number");
                            return;
                        }

                        const applied = thresholdConfig.setThresholdPercent(nextPercent);
                        writeJson(res, {
                            lowHpThresholdPercent: applied,
                        });
                    } catch (err) {
                        writeError(res, 400, `invalid request body: ${String(err)}`);
                    }
                    return;
                }

                if (url === "/deposit" && req.method === "POST") {
                    try {
                        const body = await readRequestBody(req);
                        const parsed = body ? JSON.parse(body) : {};
                        const item = typeof parsed.item === "string" ? parsed.item : null;
                        depositRequestConfig.setPendingItem(item);
                        writeJson(res, { pendingItem: item });
                    } catch (err) {
                        writeError(res, 400, `invalid deposit request: ${String(err)}`);
                    }
                    return;
                }

                if (url && url.startsWith("/images/")) {
                    const filename = url.slice("/images/".length);
                    if (filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
                        writeError(res, 400, "Invalid path");
                        return;
                    }
                    const imagePath = join(__dirname, "data/images", filename);
                    try {
                        const content = readFileSync(imagePath);
                        res.statusCode = 200;
                        res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
                        res.setHeader("Cache-Control", "no-store");
                        res.end(content);
                    } catch {
                        writeError(res, 404, "Not Found");
                    }
                    return;
                }

                res.statusCode = 404;
                res.end("Not Found");
            }).listen(port, () => {
                console.log(`Dashboard running at http://localhost:${port}`);
            }).on("error", (err: Error) => {
                const nodeErr = err as NodeJS.ErrnoException;
                if (nodeErr.code === "EADDRINUSE") {
                    console.error(`Dashboard port ${port} is already in use — continuing without dashboard.`);
                } else {
                    console.error(`Dashboard server error: ${err.message}`);
                }
            });
        },
        publish(snapshot: DashboardSnapshot) {
            latestSnapshot = {
                ...snapshot,
                weight: snapshot.weight ?? latestSnapshot.weight,
                maxCarryWeight: snapshot.maxCarryWeight ?? latestSnapshot.maxCarryWeight,
                upgradePlans: snapshot.upgradePlans ?? latestSnapshot.upgradePlans,
                toolPlans: snapshot.toolPlans ?? latestSnapshot.toolPlans,
                chainKeepNeeds: snapshot.chainKeepNeeds ?? latestSnapshot.chainKeepNeeds,
            };
        },
    };
};

