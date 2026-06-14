# CLAUDE.md

## Codebase map

### Root source files

These are the files we own and actively change. Bot logic lives at the root; cross-cutting infrastructure lives in `src/`. As the codebase grows, expect further modules to be extracted into `src/` (e.g. `src/memory/`, `src/decisions/`). Update this map when that happens.

| File | Role |
|---|---|
| `index.ts` | Bot entry point. Connects to the game server, drives the tick loop, and makes all decisions. Start here for any bot logic work. |
| `bot-types.ts` | TypeScript types used only by the bot (e.g. `UpgradePlanItem`, `UpgradeRequirement`). No runtime logic. |
| `snapshot.ts` | Converts raw heartbeat data into the `DashboardSnapshot` shape consumed by the dashboard. |
| `dashboard.ts` | HTTP server that serves the dashboard UI and exposes bot state to the browser. |
| `dashboard-client.ts` | Browser-side script bundled into the dashboard HTML page. |
| `dashboard.html` | Dashboard page markup. |
| `dashboard.css` | Dashboard styles. |

### src/ — cross-cutting infrastructure

Modules here are shared across the bot, future `src/memory/`, `src/decisions/`, and any other modules. Promote a file to its own folder (e.g. `src/logger/`) if it grows beyond a single file.

| File | Role |
|---|---|
| `src/logger.ts` | Structured per-tick JSON logging to `overworld.log` / `arena.log`, death snapshots to `deaths/`, and a 60-tick circular buffer copied (not cleared) into each death file. All bot modules should import this for observability. |

### Game client SDK (`node_modules/programming-game`)

This is a **read-only** package — the official client library shipped with the game. Do **not** search or read other `node_modules/` packages; they are standard dependencies with no project-specific logic.

Key files inside `node_modules/programming-game/src/`:

| File | Contents |
|---|---|
| `types.ts` | All server-side types: `ClientSideUnit`, `ClientSideNPC`, `ClientSideMonster`, `GameObject`, `PlayerEquipment`, heartbeat shape, etc. |
| `base-client.ts` | WebSocket client class and `connect()` function. |
| `constants.ts` | Game constants (e.g. `globalCooldown`). Prefer `heartbeat.constants` at runtime over the deprecated `constants.ts` values. |
| `items.ts` | `Items` enum — every item name in the game. |
| `recipes.ts` | `RECIPE` map — crafting recipes. |
| `monsters.ts` | Monster definitions. |
| `unit-stats.ts` | Base stat tables per unit type. |
| `weapon-skills.ts` | Weapon skill definitions. |
| `spells.ts` | Spell definitions. |
| `utils.ts` | Shared utility helpers. |

When searching src files, only search the root src files and node_modules/programming-game/src/. 
 -Never search other node_modules/ directories.
 -Never pass a search path or glob that would match files outside the root or node_modules/programming-game/src.

## Agent skills

### Issue tracker

GitHub Issues on `harleyndavis/programming-game-client`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default label vocabulary (needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context repo — one `CONTEXT.md` + `docs/adr/` at the root. See `docs/agents/domain.md`.
