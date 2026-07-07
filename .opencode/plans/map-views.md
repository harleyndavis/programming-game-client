# Map Views

Two views on the same data: a navigable heatmap of past sightings and a real-time live view of what the bot sees right now.

---

## View 1 — Heatmap View (`/map`) — Enhancements

The current cell-based heatmap, with navigation controls.

### Stateful viewport

Replace the single `getViewport(data)` call with state:

- `viewCenterX`, `viewCenterY` — the cell the viewport is centered on
- `followBot` flag (default `true`) — when on, `viewCenter` tracks `botPosition` each render; when off, user controls it
- `getViewport` returns `{ minX: viewCenterX - cols/2, minY: viewCenterY - rows/2, ... }` using current zoom level

### Follow toggle

Checkbox in sidebar. When on, the viewport follows the bot. When off, the viewport stays wherever the user left it. Clicking "Follow" snaps back to the bot.

### Arrow key pan

`keydown` listener on the page — arrow keys adjust `viewCenterX/Y` by ±1 when follow is off.

### Click-to-center

Canvas click sets `viewCenter` to that cell and turns off follow (so the user stays where they clicked).

### Zoom slider

Integer zoom level 1–4, adjusting `VIEWPORT_COLS`/`VIEWPORT_ROWS` proportionally:

| Zoom | Cells (W×H) | Cell px |
|------|-------------|---------|
| 1    | 15 × 11     | 67      |
| 2    | 23 × 17     | 43      |
| 3    | 31 × 23     | 33      |
| 4    | 39 × 29     | 25      |

Default is zoom 1. Changing zoom re-renders immediately.

### Drag-to-pan (future)

`mousedown` + `mousemove` + `mouseup` — shift `viewCenter` opposite to drag delta while follow is off.

### Sidebar controls

New column left of the canvas in `map.html`:

- **Follow** checkbox + label
- **Zoom** — / + buttons with current level
- **Coordinates** — current center cell display

### Server

No changes. `/map/data` already has everything.

---

## View 2 — Live View (`/map/live`)

A zoomed-in, real-time view of what the bot currently sees, using the heartbeat snapshot.

### Server — new endpoint `GET /map/live-data`

Pulls from `latestSnapshot.raw` (same source the dashboard uses). Returns:

```ts
{
  playerPosition: { x: number; y: number } | null;
  units: Array<{
    id: string;
    type: string;        // 'npc' | 'monster'
    name: string;
    position: { x: number; y: number };
    radius: number;
    monsterId?: string;  // e.g. 'rat', 'goblin'
    isAlive?: boolean;
  }>;
  gameObjects: Array<{
    id: string;
    type: string;        // 'tree' | 'miningNode' | 'station'
    position: { x: number; y: number };
    radius: number;
    treeType?: string;
    oreType?: string;
    stationType?: string;
    stationSubtype?: string;
  }>;
  generatedAt: string;
}
```

Same auth/cache pattern as `/map/data`.

### New files

| File | Role |
|---|---|
| `map-live.html` | Page markup, sidebar with follow-toggle, canvas, legend |
| `map-live-client.ts` | Rendering logic, polling, interaction |

### Rendering

- Canvas, dark background (`#0b1220`), matching heatmap style
- **Viewport**: ~20×20 game-unit area centered on bot (or user's chosen center)
- **Scale**: TBD by experimentation — player radius 0.3 might map to ~15px, giving ~50px per game unit
- **Objects drawn** at exact game coordinates relative to viewport center
- **Icons scaled** by object radius (larger objects = bigger icons)
- **Grid**: optional coordinate lines (not cell-based)
- **Monster icons**: lookup by `monsterId` → specific SVG, fallback to `/images/monster.svg`
- **Reuse from heatmap**: `iconImagesByUrl`, `loadIconUrl`, `processSvgText`, `getProcessedIconUrl`, `ensureTintedIcon`, `tintedIcons`

### Data flow

1. Poll `/map/live-data` every 2–3 seconds
2. Parse units and game objects
3. Render all visible entities at their real positions

### Interaction

- Follow toggle (default on)
- Drag to pan
- Arrow keys when follow is off
- Tooltip on hover showing entity name / type

### Per-monster icons

A `MONSTER_ICONS` map from `monsterId` to icon URL, with a catch-all `'/images/monster.svg'` fallback. Add entries as icons are sourced:

```ts
const MONSTER_ICONS: Record<string, string> = {
  rat: '/images/monster-rat.svg',
  goblin: '/images/monster-goblin.svg',
  // ... added over time
};
```

Icon SVGs live in `data/images/` and follow the same `#000000` fill convention as existing icons.

---

## Implementation order

1. **Heatmap nav** — viewport state, follow toggle, arrow keys, click-to-center, zoom
2. **`/map/live-data`** endpoint in `dashboard.ts`
3. **`map-live.html` + `map-live-client.ts`** — basic rendering with generic icons
4. **Per-monster icons** — add as we source SVGs
5. **Polish** — drag-to-pan, tooltip positioning, zoom tuning for live view
