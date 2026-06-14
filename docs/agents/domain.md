# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root
- **`docs/adr/`** — read ADRs that touch the area you're about to work in

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The producer skill (`/grill-with-docs`) creates them lazily when terms or decisions actually get resolved.

## File structure

**Current state** — all source files live at the root (no `src/` yet):

```
/
├── CONTEXT.md           ← domain model and glossary
├── CLAUDE.md            ← codebase map and agent instructions
├── docs/adr/            ← architecture decision records
├── index.ts             ← bot entry point (start here for logic work)
├── bot-types.ts         ← bot-specific TypeScript types
├── snapshot.ts          ← heartbeat → DashboardSnapshot adapter
├── dashboard.ts         ← HTTP server for the dashboard UI
├── dashboard-client.ts  ← browser-side dashboard script
├── dashboard.html / .css
└── node_modules/programming-game/   ← READ-ONLY game client SDK
    └── src/
        ├── types.ts         ← all server-side types (heartbeat, units, etc.)
        ├── base-client.ts   ← connect() and WebSocket client
        ├── constants.ts     ← game constants
        ├── items.ts         ← Items enum
        ├── recipes.ts       ← RECIPE map
        └── monsters.ts, unit-stats.ts, weapon-skills.ts, spells.ts, utils.ts
```

**Planned expansion** — as the bot grows, modules will be extracted into `src/`. Likely candidates discussed so far:

- `src/memory/` — SQLite-backed persistent world knowledge (safe locations, heat map, combat history, drop tables, merchant knowledge)
- `src/decisions/` — utility scoring engine, action candidates, hysteresis/commitment logic

When a `src/` folder exists, treat it as the primary location for bot logic alongside `index.ts`. Update this file map when modules are actually extracted.

When exploring code, **only look inside `node_modules/programming-game/`** for game SDK types and constants. Ignore all other `node_modules/` packages.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/grill-with-docs`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (example decision) — but worth reopening because…_
