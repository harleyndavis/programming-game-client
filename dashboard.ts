import { createServer, IncomingMessage, ServerResponse } from "http";
import { ClientSideNPC, ClientSideMonster, GameObject } from "programming-game/types";
import { UpgradePlanItem, ToolPlanItem } from "./bot-types";
import { readFileSync } from "fs";
import { join } from "path";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

export type Position = {
    x: number;
    y: number;
};

export type RawEvent = { ts: string; name: string; data: unknown };

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
    /** Bot equipment upgrade plans. */
    upgradePlans?: UpgradePlanItem[];
    /** Bot tool crafting plans — managed alongside upgradePlans. */
    toolPlans?: ToolPlanItem[];
    /** Quest rewards captured at acceptance time (server doesn't include them on active quests). */
    questRewards?: Record<string, { items: Record<string, number> }>;
    /** Recent raw server events captured by onEvent, kept in separate per-category buffers. */
    storageEvents?: RawEvent[];
    harvestEvents?: RawEvent[];
    combatEvents?: RawEvent[];
    arenaEvents?: RawEvent[];
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

type DashboardPursueQuestsConfig = {
    getPursueQuests: () => boolean;
    setPursueQuests: (value: boolean) => boolean;
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
            pursueQuests: true,
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
        toolPlans: [],
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
        configurePursueQuests(config: DashboardPursueQuestsConfig) {
            pursueQuestsConfig = config;
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
                // Temporary tracing to pin down a hang where curl completes the TCP
                // handshake but never gets an HTTP response, while the bot's own
                // tick loop keeps running fine. If this line is missing from the
                // logs for a stuck request, the request handler itself never fired
                // for that connection — if it's present but nothing after it, the
                // hang is inside this handler for that specific route.
                console.log(`[dashboard] ${req.method} ${url} received @ ${new Date().toISOString()}`);
                // Handle count is climbing but doesn't track sseClients — logging it
                // right after every request (any route) finishes tells us which route
                // it actually correlates with, instead of only watching /events.
                res.on("close", () => {
                    const handleCount = (process as any)._getActiveHandles?.().length ?? -1;
                    console.log(`[dashboard] ${req.method} ${url} finished, activeHandles=${handleCount}`);
                });

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

                if (url === "/config/pursue-quests" && req.method === "POST") {
                    const next = !pursueQuestsConfig.getPursueQuests();
                    const applied = pursueQuestsConfig.setPursueQuests(next);
                    broadcastSnapshot(latestSnapshot);
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

                if (url === "/events") {
                    res.statusCode = 200;
                    res.setHeader("Content-Type", "text/event-stream");
                    res.setHeader("Cache-Control", "no-cache");
                    res.setHeader("Connection", "keep-alive");
                    res.write(`data: ${JSON.stringify(latestSnapshot)}\n\n`);
                    sseClients.add(res);
                    console.log(`SSE client connected (${sseClients.size} active)`);
                    req.on("close", () => {
                        sseClients.delete(res);
                        res.end();
                        console.log(`SSE client closed (${sseClients.size} active)`);
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
            // Temporary tracing (see the [dashboard] request log above) to catch a
            // resource leak building up over time ahead of a hang, rather than only
            // finding out after the fact. Safe to remove once the hang is diagnosed.
            //
            // Update (2026-07-04): activeHandles turned out to be bounded (oscillating
            // 5-10 with normal connection churn, not climbing) — not a leak after all.
            // Kept for now since the byType breakdown hasn't been observed yet.
            const diagnosticInterval = setInterval(() => {
                const handles: unknown[] = (process as any)._getActiveHandles?.() ?? [];
                const byType: Record<string, number> = {};
                for (const h of handles) {
                    const name = (h as { constructor?: { name?: string } })?.constructor?.name ?? typeof h;
                    byType[name] = (byType[name] ?? 0) + 1;
                }
                console.log(`[dashboard] diagnostic: sseClients=${sseClients.size} activeHandles=${handles.length} byType=${JSON.stringify(byType)}`);
            }, 30_000);
            diagnosticInterval.unref();

            // Direct, unambiguous measurement of event-loop lag: a timer set for
            // LAG_CHECK_INTERVAL_MS can only fire late if the event loop itself is
            // backed up servicing other callbacks first. Confirmed live: a fresh TCP
            // connection completes its handshake immediately, but the '[dashboard] ...
            // received' log for it doesn't appear for *minutes* — i.e. the request
            // handler isn't being invoked at all, not just slow once invoked. This
            // will show directly whether that's because the event loop is saturated
            // (this timer will also fire minutes late, in lockstep) or something
            // specific to the HTTP server's connection handling (this timer stays on
            // schedule while requests still don't get dispatched).
            const LAG_CHECK_INTERVAL_MS = 200;
            let lastLagCheck = Date.now();
            const lagInterval = setInterval(() => {
                const now = Date.now();
                const drift = now - lastLagCheck - LAG_CHECK_INTERVAL_MS;
                lastLagCheck = now;
                if (drift > 200) {
                    console.log(`[dashboard] EVENT LOOP LAG: expected ${LAG_CHECK_INTERVAL_MS}ms tick, actual drift +${drift}ms @ ${new Date(now).toISOString()}`);
                }
            }, LAG_CHECK_INTERVAL_MS);
            lagInterval.unref();
        },
        publish(snapshot: DashboardSnapshot) {
            latestSnapshot = {
                ...snapshot,
                player: mergeNonNull(latestSnapshot.player, snapshot.player),
                serverState: mergeNonNull(latestSnapshot.serverState, snapshot.serverState),
                world: snapshot.world ?? latestSnapshot.world,
                upgradePlans: snapshot.upgradePlans ?? latestSnapshot.upgradePlans,
                toolPlans: snapshot.toolPlans ?? latestSnapshot.toolPlans,
            };
            broadcastSnapshot(latestSnapshot);
        },
    };
};

