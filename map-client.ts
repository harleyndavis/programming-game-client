const ASSUMED_SIGHT_RANGE = 20;

const TREE_NAMES = new Set([
  'pine', 'oak', 'mesquite', 'hemlock', 'cypress',
  'bloodwood', 'rosewood', 'ebony',
]);
const ORE_NAMES = new Set([
  'copper', 'tin', 'bronze', 'iron', 'steel', 'gold',
  'cobalt', 'titanium', 'mythril', 'adamantite', 'coal', 'stone',
]);

const RESOURCE_COLORS: Record<string, string> = {
  pine: '#c8a96e',
  oak: '#a0784c',
  mesquite: '#6b4226',
  hemlock: '#a0845c',
  cypress: '#6b7b3a',
  bloodwood: '#8b0000',
  rosewood: '#65000b',
  ebony: '#3b3b3b',
  copper: '#c95f3a',
  tin: '#c0c0c0',
  bronze: '#cd7f32',
  iron: '#808080',
  steel: '#b0b0b0',
  gold: '#ffd700',
  cobalt: '#0050b3',
  titanium: '#878681',
  mythril: '#6a9b8a',
  adamantite: '#5a5a8a',
  coal: '#3a3a3a',
  stone: '#808080',
};

const ICON_DEFS = [
  { url: '/images/npc.svg', label: 'NPCs', test: function (t: string, _n: string) { return t === 'npc'; } },
  { url: '/images/anvil.svg', label: 'Stations', getIconUrl: function (n: string) { return n === 'campfire' ? '/images/campfire.svg' : '/images/anvil.svg'; }, test: function (t: string, _n: string) { return t === 'station'; } },
  { url: '/images/tree.svg', label: 'Trees', test: function (t: string, n: string) { return t === 'resource' && TREE_NAMES.has(n); } },
  { url: '/images/ore.svg', label: 'Ore', test: function (t: string, n: string) { return t === 'resource' && ORE_NAMES.has(n); } },
  { url: '/images/monster.svg', label: 'Monsters', test: function (t: string, _n: string) { return t === 'monster'; } },
];

const CELL_PX = 67;
const ICON_SIZE = 29;
const ICON_GAP = 5;
const ICON_PAD = Math.floor((CELL_PX - ICON_SIZE * 2 - ICON_GAP) / 2);
const VIEWPORT_COLS = 15;
const VIEWPORT_ROWS = 11;
const CANVAS_W = VIEWPORT_COLS * CELL_PX;
const CANVAS_H = VIEWPORT_ROWS * CELL_PX;

const escapeHtml = function (value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
};

const formatItemName = function (itemId: unknown): string {
  if (!itemId) return "-";
  return String(itemId)
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .replace(/([0-9]+)/g, " $1")
    .replace(/\s+/g, " ")
    .trim();
};

type MapCellSlot = {
  iconUrl: string;
  entities: Array<{ entityName: string; observationCount: number }>;
  tintColor: string | null;
};

type MapCellData = {
  cellX: number;
  cellY: number;
  slots: Array<MapCellSlot | null>;
};

type MapResponse = {
  generatedAt: string;
  exploredCells: Array<{ cellX: number; cellY: number }>;
  heatMap: Array<{ cellX: number; cellY: number; entityType: string; entityName: string; observationCount: number }>;
  botPosition: { x: number; y: number } | null;
};

// SVG icon cache — base (white) icons + tinted (colored) icons
var iconImages: Array<HTMLImageElement | null> = [];
var iconImagesByUrl: Record<string, HTMLImageElement | null> = {};
var svgTextCache: Record<string, string> = {};
var tintedIcons: Record<string, HTMLImageElement | null> = {};
var tintedIconsLoading: Record<string, boolean> = {};
var pendingRerender = false;

var processSvgText = function (svg: string, color: string | null): string {
  svg = svg.replace(/<path\s+d="M0\s*0h512v512H0z"[^>]*>(?:\s*<\/path>)?/g, "");
  var fill = color || '#ffffff';
  svg = svg.replace(/fill="#000000"/g, 'fill="' + fill + '"');
  svg = svg.replace(/fill="#000"/g, 'fill="' + fill + '"');
  return svg;
};

var loadIconUrl = function (url: string): Promise<void> {
  if (iconImagesByUrl[url] !== undefined) return Promise.resolve();
  return fetch(url)
    .then(function (r) { return r.text(); })
    .then(function (svg) {
      svgTextCache[url] = svg;
      svg = processSvgText(svg, null);
      var blob = new Blob([svg], { type: "image/svg+xml" as string });
      var blobUrl = URL.createObjectURL(blob);
      return new Promise<void>(function (resolve) {
        var img = new Image();
        img.onload = function () {
          iconImagesByUrl[url] = img;
          URL.revokeObjectURL(blobUrl);
          resolve();
        };
        img.onerror = function () {
          iconImagesByUrl[url] = null;
          URL.revokeObjectURL(blobUrl);
          resolve();
        };
        img.src = blobUrl;
      });
    })
    .catch(function () {
      iconImagesByUrl[url] = null;
    });
};

var ensureTintedIcon = function (url: string, color: string): void {
  var key = url + "|" + color;
  if (key in tintedIcons || tintedIconsLoading[key]) return;
  tintedIconsLoading[key] = true;
  var svg = svgTextCache[url];
  if (!svg) {
    tintedIcons[key] = null;
    return;
  }
  svg = processSvgText(svg, color);
  var blob = new Blob([svg], { type: "image/svg+xml" as string });
  var blobUrl = URL.createObjectURL(blob);
  var img = new Image();
  img.onload = function () {
    tintedIcons[key] = img;
    URL.revokeObjectURL(blobUrl);
    if (latestData && !pendingRerender) {
      pendingRerender = true;
      setTimeout(function () { pendingRerender = false; render(latestData!); }, 0);
    }
  };
  img.onerror = function () {
    tintedIcons[key] = null;
    URL.revokeObjectURL(blobUrl);
  };
  img.src = blobUrl;
};

var iconsReady: Promise<void>;

var processedIconUrls: Record<string, string> = {};

var getProcessedIconUrl = function (url: string): string {
  if (processedIconUrls[url]) return processedIconUrls[url];
  var svg = svgTextCache[url];
  if (!svg) return url;
  svg = processSvgText(svg, null);
  var blob = new Blob([svg], { type: "image/svg+xml" as string });
  processedIconUrls[url] = URL.createObjectURL(blob);
  return processedIconUrls[url];
};

var initIcons = function (): Promise<void> {
  if (iconsReady) return iconsReady;
  var promises: Array<Promise<void>> = [];
  var seen = new Set<string>();
  ICON_DEFS.forEach(function (def) {
    var urls = [def.url];
    if (def.getIconUrl) {
      // stations have dynamic icon selection, collect all possible URLs
      urls.push(def.getIconUrl('campfire'));
    }
    urls.forEach(function (url) {
      if (!seen.has(url)) {
        seen.add(url);
        promises.push(loadIconUrl(url));
      }
    });
  });
  iconsReady = Promise.all(promises).then(function () { return; });
  return iconsReady;
};

var latestData: MapResponse | null = null;
var hoverCellX: number | null = null;
var hoverCellY: number | null = null;
var lastMouseX = 0;
var lastMouseY = 0;
var autoRefreshTimer: ReturnType<typeof setTimeout> | null = null;
var AUTO_REFRESH_MS = 3000;

var updatedAtEl = document.getElementById("mapUpdatedAt");
var refreshBtnEl = document.getElementById("mapRefreshBtn") as HTMLButtonElement | null;
var canvas = document.getElementById("mapCanvas") as HTMLCanvasElement | null;
var legendEl = document.getElementById("mapLegend");
var tooltipEl = document.getElementById("mapTooltip");
var autoRefreshNoteEl = document.getElementById("mapAutoRefreshNote");

var slotOffsets: Array<{ ox: number; oy: number }> = [
  { ox: ICON_PAD, oy: ICON_PAD },
  { ox: ICON_PAD + ICON_SIZE + ICON_GAP, oy: ICON_PAD },
  { ox: ICON_PAD, oy: ICON_PAD + ICON_SIZE + ICON_GAP },
  { ox: ICON_PAD + ICON_SIZE + ICON_GAP, oy: ICON_PAD + ICON_SIZE + ICON_GAP },
];

var getIconUrlForEntity = function (type: string, name: string): string | null {
  for (var si = 0; si < ICON_DEFS.length; si++) {
    if (ICON_DEFS[si].test(type, name)) {
      if (ICON_DEFS[si].getIconUrl) {
        return ICON_DEFS[si].getIconUrl!(name);
      }
      return ICON_DEFS[si].url;
    }
  }
  return null;
};

var TYPE_PRIORITY: Record<string, number> = { 'npc': 0, 'station': 1, 'monster': 2, 'resource': 3 };

var buildCellMap = function (data: MapResponse): [Map<string, MapCellData>, Set<string>] {
  var cellMap = new Map<string, MapCellData>();
  var seenKeys = new Set<string>();

  data.exploredCells.forEach(function (cell) {
    var key = cell.cellX + "," + cell.cellY;
    seenKeys.add(key);
    cellMap.set(key, { cellX: cell.cellX, cellY: cell.cellY, slots: [null, null, null, null] });
  });

  // Group heat map entries by cell, then process in priority order
  var cellEntries = new Map<string, Array<{ type: string; name: string; obsCount: number }>>();
  data.heatMap.forEach(function (h) {
    var key = h.cellX + "," + h.cellY;
    seenKeys.add(key);
    if (!cellEntries.has(key)) cellEntries.set(key, []);
    cellEntries.get(key)!.push({ type: h.entityType, name: h.entityName, obsCount: h.observationCount });
  });

  cellEntries.forEach(function (entries, key) {
    if (!cellMap.has(key)) {
      var parts = key.split(",");
      cellMap.set(key, { cellX: parseInt(parts[0]), cellY: parseInt(parts[1]), slots: [null, null, null, null] });
    }
    var cellData = cellMap.get(key)!;

    // Sort by priority (npc > station > monster > resource), then by obs count desc
    entries.sort(function (a, b) {
      var pa = TYPE_PRIORITY[a.type] ?? 99;
      var pb = TYPE_PRIORITY[b.type] ?? 99;
      if (pa !== pb) return pa - pb;
      return b.obsCount - a.obsCount;
    });

    // Deduplicate: track which iconUrls already have a slot
    var slotByUrl = new Map<string, number>();

    entries.forEach(function (e) {
      var iconUrl = getIconUrlForEntity(e.type, e.name);
      if (!iconUrl) return;

      if (slotByUrl.has(iconUrl)) {
        var idx = slotByUrl.get(iconUrl)!;
        cellData.slots[idx]!.entities.push({ entityName: e.name, observationCount: e.obsCount });
        return;
      }

      // Find first empty slot
      for (var i = 0; i < cellData.slots.length; i++) {
        if (!cellData.slots[i]) {
          cellData.slots[i] = { iconUrl: iconUrl, entities: [], tintColor: null };
          cellData.slots[i]!.entities.push({ entityName: e.name, observationCount: e.obsCount });
          slotByUrl.set(iconUrl, i);
          return;
        }
      }
      // No room — skip
    });
  });

  // Compute dominant tint color per slot (for resource icons)
  Array.from(cellMap).forEach(function (entry) {
    var cd = entry[1];
    cd.slots.forEach(function (slot) {
      if (!slot || slot.entities.length === 0) return;
      slot.entities.sort(function (a, b) { return b.observationCount - a.observationCount; });
      if (slot.iconUrl === '/images/tree.svg' || slot.iconUrl === '/images/ore.svg') {
        slot.tintColor = RESOURCE_COLORS[slot.entities[0].entityName] ?? '#ffffff';
      }
    });
  });

  return [cellMap, seenKeys];
};

var getViewport = function (data: MapResponse) {
  if (data.botPosition) {
    var bcx = Math.floor(data.botPosition.x / ASSUMED_SIGHT_RANGE);
    var bcy = Math.floor(data.botPosition.y / ASSUMED_SIGHT_RANGE);
    return { minX: bcx - 7, minY: bcy - 5, maxX: bcx + 7, maxY: bcy + 5 };
  }
  return { minX: -7, minY: -5, maxX: 7, maxY: 5 };
};

var render = function (data: MapResponse) {
  if (!canvas || !legendEl) return;

  var cellMap: Map<string, MapCellData>;
  var seenKeys: Set<string>;
  try {
    var built = buildCellMap(data);
    cellMap = built[0];
    seenKeys = built[1];
  } catch (_e) {
    return;
  }

  if (seenKeys.size === 0) {
    canvas.style.display = "none";
    legendEl.innerHTML = '<p class="empty-note">No map data collected yet. Explore the world to populate the map.</p>';
    return;
  }
  canvas.style.display = "block";

  var vp = getViewport(data);
  var minX = vp.minX, minY = vp.minY, maxX = vp.maxX, maxY = vp.maxY;
  var width = CANVAS_W;
  var height = CANVAS_H;

  canvas.width = width * devicePixelRatio;
  canvas.height = height * devicePixelRatio;
  canvas.style.width = width + "px";
  canvas.style.height = height + "px";

  var ctx = canvas.getContext("2d");
  if (!ctx) return;

  var c = ctx;
  c.scale(devicePixelRatio, devicePixelRatio);

  // Background
  c.fillStyle = "#0b1220";
  c.fillRect(0, 0, width, height);

  // Explored cells within viewport
  data.exploredCells.forEach(function (cell) {
    if (cell.cellX < minX || cell.cellX > maxX || cell.cellY < minY || cell.cellY > maxY) return;
    var x = (cell.cellX - minX) * CELL_PX;
    var y = (cell.cellY - minY) * CELL_PX;
    c.fillStyle = "rgba(34, 211, 238, 0.12)";
    c.fillRect(x, y, CELL_PX, CELL_PX);
  });

  // Grid lines
  ctx.strokeStyle = "rgba(55, 65, 81, 0.35)";
  ctx.lineWidth = 0.5;
  for (var i = 0; i <= VIEWPORT_COLS; i++) {
    ctx.beginPath();
    ctx.moveTo(i * CELL_PX + 0.5, 0);
    ctx.lineTo(i * CELL_PX + 0.5, height);
    ctx.stroke();
  }
  for (var i = 0; i <= VIEWPORT_ROWS; i++) {
    ctx.beginPath();
    ctx.moveTo(0, i * CELL_PX + 0.5);
    ctx.lineTo(width, i * CELL_PX + 0.5);
    ctx.stroke();
  }

  var drawSlot = function (slot: MapCellSlot, slotIndex: number, cx: number, cy: number, cp: number) {
    var slotDef = slotOffsets[slotIndex];
    var scale = cp / CELL_PX;
    var sx = cx + slotDef.ox * scale;
    var sy = cy + slotDef.oy * scale;
    var sz = ICON_SIZE * scale;

    var drawDot = function (color: string, r: number) {
      c.fillStyle = color;
      c.beginPath();
      c.arc(sx + sz / 2, sy + sz / 2, r, 0, Math.PI * 2);
      c.fill();
    };

    if (slot.tintColor) {
      var key = slot.iconUrl + "|" + slot.tintColor;
      var tintedImg = tintedIcons[key];
      if (tintedImg) {
        c.drawImage(tintedImg, sx, sy, sz, sz);
      } else if (!(key in tintedIcons)) {
        ensureTintedIcon(slot.iconUrl, slot.tintColor);
        drawDot(slot.tintColor, sz / 2);
      } else {
        drawDot(slot.tintColor, sz / 2);
      }
    } else {
      var img = iconImagesByUrl[slot.iconUrl];
      if (img) {
        c.drawImage(img, sx, sy, sz, sz);
      } else {
        drawDot("#6b7280", sz / 2);
      }
    }
  };

  Array.from(cellMap).forEach(function (entry) {
    var cd = entry[1];
    if (cd.cellX < minX || cd.cellX > maxX || cd.cellY < minY || cd.cellY > maxY) return;
    var cx = (cd.cellX - minX) * CELL_PX;
    var cy = (cd.cellY - minY) * CELL_PX;

    cd.slots.forEach(function (slot, si) {
      if (slot) drawSlot(slot, si, cx, cy, CELL_PX);
    });
  });

  // Bot position
  if (data.botPosition) {
    var botCellX = Math.floor(data.botPosition.x / ASSUMED_SIGHT_RANGE);
    var botCellY = Math.floor(data.botPosition.y / ASSUMED_SIGHT_RANGE);
    var bx = (botCellX - minX) * CELL_PX + CELL_PX / 2;
    var by = (botCellY - minY) * CELL_PX + CELL_PX / 2;
    var botR = Math.max(4, CELL_PX * 0.15);

    ctx.strokeStyle = "#000000";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(bx, by, botR, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = "#22c55e";
    ctx.beginPath();
    ctx.arc(bx, by, botR - 0.5, 0, Math.PI * 2);
    ctx.fill();
  }

  // Hover highlight
  if (hoverCellX !== null && hoverCellY !== null) {
    if (hoverCellX >= minX && hoverCellX <= maxX && hoverCellY >= minY && hoverCellY <= maxY) {
      var hx = (hoverCellX - minX) * CELL_PX;
      var hy = (hoverCellY - minY) * CELL_PX;
      ctx.strokeStyle = "rgba(255, 255, 255, 0.4)";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(hx + 0.5, hy + 0.5, CELL_PX - 1, CELL_PX - 1);
      ctx.fillStyle = "rgba(255, 255, 255, 0.06)";
      ctx.fillRect(hx, hy, CELL_PX, CELL_PX);
    }
  }

  // Legend
  var legendTypes = new Set<string>();
  data.heatMap.forEach(function (h) { legendTypes.add(h.entityType); });
  var resourceNames = new Set<string>();
  data.heatMap.forEach(function (h) { if (h.entityType === "resource") resourceNames.add(h.entityName); });

  var legendItems: string[] = [];
  var typeIconMap: Record<string, string> = {
    monster: '/images/monster.svg',
    npc: '/images/npc.svg',
    station: '/images/anvil.svg',
    resource: '/images/tree.svg',
  };
  var typeLabels: Record<string, string> = {
    monster: 'Monsters', npc: 'NPCs', station: 'Stations', resource: 'Resources',
  };

  if (data.botPosition) {
    legendItems.push('<span class="legend-item"><span class="legend-dot" style="background:#22c55e"></span><span class="legend-label">Bot</span></span>');
  }
  legendItems.push('<span class="legend-item"><span class="legend-square" style="background:rgba(34,211,238,0.15);border:1px solid rgba(34,211,238,0.4)"></span><span class="legend-label">Explored</span></span>');
  legendItems.push('<span class="legend-item"><span class="legend-square" style="background:#0b1220;border:1px solid rgba(75,85,99,0.5)"></span><span class="legend-label">Unexplored</span></span>');

  var legendOrder = ["monster", "npc", "station", "resource"];
  legendOrder.forEach(function (t) {
    if (!legendTypes.has(t) && t !== "resource") return;
    if (t === "resource" && !resourceNames) return;

    if (t === "resource") {
      var hasTrees = false, hasOres = false;
      resourceNames.forEach(function (name) {
        if (TREE_NAMES.has(name)) hasTrees = true;
        else hasOres = true;
      });
      if (hasTrees) {
        legendItems.push('<span class="legend-item"><span class="legend-icon-sm" style="background-image:url(' + getProcessedIconUrl('/images/tree.svg') + ')"></span><span class="legend-label">Tree</span></span>');
      }
      if (hasOres) {
        legendItems.push('<span class="legend-item"><span class="legend-icon-sm" style="background-image:url(' + getProcessedIconUrl('/images/ore.svg') + ')"></span><span class="legend-label">Mining Node</span></span>');
      }
    } else {
      var iconUrl = typeIconMap[t];
      if (iconUrl) {
        legendItems.push('<span class="legend-item"><span class="legend-icon-sm" style="background-image:url(' + getProcessedIconUrl(iconUrl) + ')"></span><span class="legend-label">' + (typeLabels[t] ?? t) + '</span></span>');
      } else {
        legendItems.push('<span class="legend-item"><span class="legend-label">' + (typeLabels[t] ?? t) + '</span></span>');
      }
    }
  });

  legendEl.innerHTML = legendItems.join(" ");
};

var updateTooltip = function () {
  if (!tooltipEl || !canvas || !latestData) {
    if (tooltipEl) tooltipEl.style.display = "none";
    return;
  }

  if (hoverCellX === null || hoverCellY === null) {
    tooltipEl.style.display = "none";
    return;
  }

  var cellEntities: Array<{ entityName: string; entityType: string; observationCount: number }> = [];
  latestData.heatMap.forEach(function (h) {
    if (h.cellX === hoverCellX && h.cellY === hoverCellY) {
      cellEntities.push({ entityName: h.entityName, entityType: h.entityType, observationCount: h.observationCount });
    }
  });

  if (cellEntities.length === 0) {
    var hasCell = false;
    latestData.exploredCells.forEach(function (c) {
      if (c.cellX === hoverCellX && c.cellY === hoverCellY) hasCell = true;
    });
    if (hasCell) {
      tooltipEl.innerHTML = "<div class=\"tooltip-group-label\">Cell " + hoverCellX + ", " + hoverCellY + "</div><div class=\"tooltip-group\">No sightings</div>";
      tooltipEl.style.display = "block";
    } else {
      tooltipEl.style.display = "none";
    }
    return;
  }

  var grouped: Array<{ label: string; entities: Array<{ name: string; count: number }> }> = [];
  ICON_DEFS.forEach(function (_def, si) {
    var ents: Array<{ name: string; count: number }> = [];
    cellEntities.forEach(function (ce) {
      if (ICON_DEFS[si].test(ce.entityType, ce.entityName)) {
        ents.push({ name: ce.entityName, count: ce.observationCount });
      }
    });
    if (ents.length > 0) {
      grouped.push({ label: ICON_DEFS[si].label, entities: ents });
    }
  });
  if (grouped.length === 0) {
    tooltipEl.style.display = "none";
    return;
  }

  var html = "<div class=\"tooltip-group-label\">Cell " + hoverCellX + ", " + hoverCellY + "</div>";
  grouped.forEach(function (g) {
    html += "<div class=\"tooltip-group-label\" style=\"margin-top:6px\">" + escapeHtml(g.label) + "</div>";
    g.entities.forEach(function (e) {
      html += "<div class=\"tooltip-entity\">" + escapeHtml(formatItemName(e.name)) + " <span class=\"tooltip-count\">(" + String(e.count) + ")</span></div>";
    });
  });

  tooltipEl.innerHTML = html;
  tooltipEl.style.display = "block";

  var tooltipWidth = tooltipEl.offsetWidth;
  var tooltipHeight = tooltipEl.offsetHeight;
  var maxX = window.innerWidth - tooltipWidth - 8;
  var maxY = window.innerHeight - tooltipHeight - 8;
  tooltipEl.style.left = Math.min(lastMouseX, maxX) + "px";
  tooltipEl.style.top = Math.min(lastMouseY - tooltipHeight - 10, maxY) + "px";
};

var load = function () {
  if (updatedAtEl) updatedAtEl.textContent = "Loading...";
  if (refreshBtnEl) refreshBtnEl.disabled = true;
  fetch("/map/data")
    .then(function (res) { return res.json(); })
    .then(function (data) {
      latestData = data;
      render(data);
      if (updatedAtEl) updatedAtEl.textContent = "Loaded " + new Date(data.generatedAt ?? Date.now()).toLocaleTimeString();
    })
    .catch(function (err) {
      if (updatedAtEl) updatedAtEl.textContent = "Failed: " + String(err);
      if (legendEl) legendEl.innerHTML = '<p class="empty-note">Error loading map data.</p>';
    })
    .then(function () {
      if (refreshBtnEl) refreshBtnEl.disabled = false;
    });
};

var scheduleAutoRefresh = function () {
  if (autoRefreshTimer) clearTimeout(autoRefreshTimer);
  autoRefreshTimer = setTimeout(function () {
    fetch("/map/data")
      .then(function (res) { return res.json(); })
      .then(function (data) {
        latestData = data;
        render(data);
        if (updatedAtEl) updatedAtEl.textContent = "Updated " + new Date(data.generatedAt ?? Date.now()).toLocaleTimeString();
        scheduleAutoRefresh();
      })
      .catch(function () {
        scheduleAutoRefresh();
      });
  }, AUTO_REFRESH_MS);
};

if (canvas) {
  canvas.addEventListener("mousemove", function (e) {
    if (!latestData || !canvas) return;

    var data = latestData;
    var built = buildCellMap(data);
    var cellMap = built[0];
    var seenKeys = built[1];

    if (seenKeys.size === 0) return;

    var vp = getViewport(data);
    var minX = vp.minX, minY = vp.minY;

    var rect = canvas.getBoundingClientRect();
    var mx = (e.clientX - rect.left) * (canvas.width / devicePixelRatio / rect.width);
    var my = (e.clientY - rect.top) * (canvas.height / devicePixelRatio / rect.height);

    var gridX = Math.floor(mx / CELL_PX);
    var gridY = Math.floor(my / CELL_PX);
    var cellX = gridX + minX;
    var cellY = gridY + minY;

    if (cellX !== hoverCellX || cellY !== hoverCellY) {
      hoverCellX = cellX;
      hoverCellY = cellY;
      render(data);
      lastMouseX = e.clientX + 12;
      lastMouseY = e.clientY;
      updateTooltip();
    } else if (tooltipEl) {
      lastMouseX = e.clientX + 12;
      lastMouseY = e.clientY;
      var ttW = tooltipEl.offsetWidth;
      var ttH = tooltipEl.offsetHeight;
      var maxXPos = window.innerWidth - ttW - 8;
      var maxYPos = window.innerHeight - ttH - 8;
      tooltipEl.style.left = Math.min(e.clientX + 12, maxXPos) + "px";
      tooltipEl.style.top = Math.min(e.clientY - ttH - 10, maxYPos) + "px";
    }
  });

  canvas.addEventListener("mouseleave", function () {
    hoverCellX = null;
    hoverCellY = null;
    if (tooltipEl) tooltipEl.style.display = "none";
    if (latestData) render(latestData);
  });
}

initIcons().then(function () {
  load();
  scheduleAutoRefresh();
});

if (refreshBtnEl) {
  refreshBtnEl.addEventListener("click", function () {
    if (autoRefreshTimer) clearTimeout(autoRefreshTimer);
    load();
    scheduleAutoRefresh();
  });
}
