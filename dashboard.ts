import { createServer, IncomingMessage, ServerResponse } from "http";
import { ClientSideNPC, ClientSideMonster, GameObject } from "programming-game/types";
import { UpgradePlanItem } from "./bot-types";
import { readFileSync } from "fs";
import { join } from "path";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

export type Position = {
    x: number;
    y: number;
};

export type UnitSnapshot = {
    id: string;
    type: string;
    hp: number | null;
    position: Position | null;
};

export type CombatSkillsSnapshot = Record<string, number>;

export type InventorySnapshot = Record<string, number>;

export type SpellbookSnapshot = string[];

export type EquipmentSnapshot = {
    helm: string | null;
    chest: string | null;
    legs: string | null;
    feet: string | null;
    hands: string | null;
    weapon: string | null;
    offhand: string | null;
    amulet: string | null;
    ring1: string | null;
    ring2: string | null;
};

export type WorldState = {
    npcs: ClientSideNPC[];
    mobs: ClientSideMonster[];
    objects: GameObject[];
};

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
        lowHpThresholdPercent: number;
        lowHpThreshold: number;
        /** Item the dashboard user requested to deposit, shown until processed. */
        depositItem: string | null;
        /** Human-readable deposit status message. */
        depositMessage: string;
        nearbyBankers: number;
        nearbyMerchants: number;
    };
    serverState: {
        action: string | null;
        actionTarget: string | null;
        actionDuration: number | null;
        actionStart: number | null;
        intentType: string | null;
        statusEffects: string[];
    };
    player: {
        hp: number | null;
        maxHp: number | null;
        mp: number | null;
        tp: number | null;
        calories: number | null;
        attack: number | null;
        defense: number | null;
        movementSpeed: number | null;
        weight: number | null;
        maxCarryWeight: number | null;
        name: string | null;
        position: Position | null;
        equipment: EquipmentSnapshot;
        combatSkills: CombatSkillsSnapshot;
        spellbook: SpellbookSnapshot;
        inventory: InventorySnapshot;
        storage: InventorySnapshot;
    };
    unitCount: number;
    monstersVisible: number;
    units: UnitSnapshot[];
    /** The unmodified heartbeat object as received from the game server. */
    raw: Record<string, unknown>;
    /** Storage fee breakdown — computed by the bot tick. */
    storageFee?: StorageFeeInfo;
    /** Accumulated world knowledge — managed separately via updateWorld(). */
    world?: WorldState;
    /** Bot upgrade plans — managed separately via updateUpgradePlans(). */
    upgradePlans?: UpgradePlanItem[];
    /** Recent raw server events captured by onEvent. */
    events?: Array<{ ts: string; name: string; data: unknown }>;
};

const DEFAULT_EQUIPMENT: EquipmentSnapshot = {
    helm: null,
    chest: null,
    legs: null,
    feet: null,
    hands: null,
    weapon: null,
    offhand: null,
    amulet: null,
    ring1: null,
    ring2: null,
};

type DashboardThresholdConfig = {
    getThresholdPercent: () => number;
    setThresholdPercent: (nextPercent: number) => number;
};

type DashboardIdleAtHomeConfig = {
    getIdleAtHome: () => boolean;
    setIdleAtHome: (value: boolean) => boolean;
};

type DashboardDepositRequestConfig = {
    getPendingItem: () => string | null;
    setPendingItem: (item: string | null) => void;
};

export const createDashboard = (port: number) => {
    let latestSnapshot: DashboardSnapshot = {
        receivedAt: new Date().toISOString(),
        bot: {
            recoveringAtHome: false,
            idleAtHome: false,
            lowHpThresholdPercent: 25,
            lowHpThreshold: 0,
            depositItem: null,
            depositMessage: '',
            nearbyBankers: 0,
            nearbyMerchants: 0,
        },
        serverState: {
            action: null,
            actionTarget: null,
            actionDuration: null,
            actionStart: null,
            intentType: null,
            statusEffects: [],
        },
        player: {
            name: null,
            hp: null,
            maxHp: null,
            mp: null,
            tp: null,
            calories: null,
            attack: null,
            defense: null,
            movementSpeed: null,
            weight: null,
            maxCarryWeight: null,
            position: null,
            equipment: DEFAULT_EQUIPMENT,
            combatSkills: {},
            spellbook: [],
            inventory: {},
            storage: {},
        },
        unitCount: 0,
        monstersVisible: 0,
        units: [],
        raw: {},
        world: { npcs: [], mobs: [], objects: [] },
        upgradePlans: [],
    };

    /**
     * Merge next snapshot into prev, keeping any non-null value from prev when
     * next supplies null for that field. This prevents processed nulls from
     * erasing values that were valid on an earlier tick.
     */
    const mergeNonNull = <T extends Record<string, unknown>>(prev: T, next: T): T => {
        const result: Record<string, unknown> = { ...next };
        for (const key of Object.keys(prev)) {
            if ((result[key] === null || result[key] === undefined) && prev[key] != null) {
                result[key] = prev[key];
            }
        }
        return result as T;
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

    const sseClients = new Set<ServerResponse>();

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

    const broadcastSnapshot = (snapshot: DashboardSnapshot) => {
        const message = `data: ${JSON.stringify(snapshot)}\n\n`;
        sseClients.forEach((client) => {
            client.write(message);
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
        stop() {
            if (server) {
                sseClients.forEach((client) => {
                    try { client.socket?.destroy(); } catch { /* ignore */ }
                });
                sseClients.clear();
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

                if (url === "/config" && req.method === "GET") {
                    writeJson(res, {
                        lowHpThresholdPercent: thresholdConfig.getThresholdPercent(),
                    });
                    return;
                }

                if (url === "/config/idle-at-home" && req.method === "POST") {
                    const next = !idleAtHomeConfig.getIdleAtHome();
                    const applied = idleAtHomeConfig.setIdleAtHome(next);
                    broadcastSnapshot(latestSnapshot);
                    writeJson(res, { idleAtHome: applied });
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

                if (url === "/events") {
                    res.statusCode = 200;
                    res.setHeader("Content-Type", "text/event-stream");
                    res.setHeader("Cache-Control", "no-cache");
                    res.setHeader("Connection", "keep-alive");
                    res.write(`data: ${JSON.stringify(latestSnapshot)}\n\n`);
                    sseClients.add(res);
                    req.on("close", () => {
                        sseClients.delete(res);
                        res.end();
                    });
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
                player: mergeNonNull(latestSnapshot.player, snapshot.player),
                serverState: mergeNonNull(latestSnapshot.serverState, snapshot.serverState),
                world: snapshot.world ?? latestSnapshot.world,
                upgradePlans: snapshot.upgradePlans ?? latestSnapshot.upgradePlans,
            };
            broadcastSnapshot(latestSnapshot);
        },
    };
};

