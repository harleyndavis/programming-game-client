const escapeHtml = (value: unknown) =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const formatItemName = (itemId: unknown) => {
  if (!itemId) return "-";
  return String(itemId)
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .replace(/([0-9]+)/g, " $1")
    .replace(/\s+/g, " ")
    .trim();
};

const formatPosition = (position: unknown) => {
  if (!position || typeof (position as Record<string, unknown>).x !== "number" || typeof (position as Record<string, unknown>).y !== "number") return "—";
  const pos = position as { x: number; y: number };
  return "(" + Math.round(pos.x) + ", " + Math.round(pos.y) + ")";
};

const formatTimestamp = (ts: unknown) => (typeof ts === "number" ? new Date(ts).toLocaleString() : "—");

const joinItemMap = (record: unknown) => {
  if (!record || typeof record !== "object") return "—";
  const entries = Object.entries(record as Record<string, number>);
  if (entries.length === 0) return "—";
  return entries.map(([item, qty]) => formatItemName(item) + " ×" + qty).join(", ");
};

type Column<T> = {
  key: string;
  label: string;
  value: (row: T) => string | number;
};

const sortState = new Map<string, { key: string; dir: 1 | -1 }>();

function renderTable<T>(containerId: string, columns: Column<T>[], rows: T[] | null | undefined, emptyText: string) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const data = rows ?? [];
  if (data.length === 0) {
    container.innerHTML = '<p class="empty-note">' + escapeHtml(emptyText) + "</p>";
    return;
  }

  const state = sortState.get(containerId) ?? { key: columns[0].key, dir: 1 as 1 | -1 };
  sortState.set(containerId, state);
  const sortColumn = columns.find((c) => c.key === state.key) ?? columns[0];

  const sorted = [...data].sort((a, b) => {
    const av = sortColumn.value(a);
    const bv = sortColumn.value(b);
    if (av < bv) return -state.dir;
    if (av > bv) return state.dir;
    return 0;
  });

  const thead = columns
    .map((c) => {
      const isSorted = c.key === state.key;
      const arrow = isSorted ? (state.dir === 1 ? " ▲" : " ▼") : "";
      return '<th data-col="' + c.key + '" class="' + (isSorted ? "sorted" : "") + '">' + escapeHtml(c.label) + arrow + "</th>";
    })
    .join("");

  const tbody = sorted
    .map((row) => "<tr>" + columns.map((c) => "<td>" + escapeHtml(c.value(row)) + "</td>").join("") + "</tr>")
    .join("");

  container.innerHTML = '<table class="memory-table"><thead><tr>' + thead + "</tr></thead><tbody>" + tbody + "</tbody></table>";

  container.querySelectorAll<HTMLElement>("th[data-col]").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset["col"]!;
      const prev = sortState.get(containerId)!;
      sortState.set(containerId, { key, dir: prev.key === key ? ((-prev.dir) as 1 | -1) : 1 });
      renderTable(containerId, columns, rows, emptyText);
    });
  });
}

const entityColumns: Column<any>[] = [
  { key: "entityName", label: "Name", value: (e) => formatItemName(e.entityName) },
  { key: "entityType", label: "Type", value: (e) => e.entityType },
];

const heatmapColumns: Column<any>[] = [
  { key: "entityName", label: "Name", value: (h) => formatItemName(h.entityName) },
  { key: "entityType", label: "Type", value: (h) => h.entityType },
  { key: "observationCount", label: "Observations", value: (h) => h.observationCount },
  { key: "lastSeenAt", label: "Last Seen", value: (h) => formatTimestamp(h.lastSeenAt) },
  { key: "position", label: "Position", value: (h) => formatPosition(h.position) },
];

const merchantColumns: Column<any>[] = [
  { key: "merchantName", label: "Merchant", value: (t) => t.merchantName },
  { key: "item", label: "Item", value: (t) => formatItemName(t.item) },
  { key: "buyingPrice", label: "Buy Price", value: (t) => (t.buying ? t.buying.price : "—") },
  { key: "buyingQty", label: "Buy Qty", value: (t) => (t.buying ? t.buying.quantity : "—") },
  { key: "sellingPrice", label: "Sell Price", value: (t) => (t.selling ? t.selling.price : "—") },
  { key: "sellingQty", label: "Sell Qty", value: (t) => (t.selling ? t.selling.quantity : "—") },
  { key: "position", label: "Position", value: (t) => formatPosition(t.position) },
];

const combatColumns: Column<any>[] = [
  { key: "monsterId", label: "Monster", value: (c) => formatItemName(c.monsterId) },
  { key: "killCount", label: "Kills", value: (c) => c.killCount },
  { key: "monsterHp", label: "Monster HP", value: (c) => c.monsterHp },
  { key: "hitsReceived", label: "Hits Taken", value: (c) => c.hitsReceived },
  { key: "totalDamageReceived", label: "Total Dmg", value: (c) => c.totalDamageReceived },
  { key: "avgDamagePerHit", label: "Avg Dmg", value: (c) => c.avgDamagePerHit.toFixed(1) },
  { key: "minDamagePerHit", label: "Min Dmg", value: (c) => c.minDamagePerHit ?? "—" },
  { key: "maxDamagePerHit", label: "Max Dmg", value: (c) => c.maxDamagePerHit ?? "—" },
];

const lootColumns: Column<any>[] = [
  { key: "entityName", label: "Entity", value: (r) => formatItemName(r.entityName) },
  { key: "entityType", label: "Type", value: (r) => r.entityType },
  { key: "item", label: "Item", value: (r) => formatItemName(r.item) },
  { key: "dropChance", label: "Drop Chance", value: (r) => (r.dropChance * 100).toFixed(0) + "%" },
  { key: "avgQuantityPerEvent", label: "Avg Qty", value: (r) => r.avgQuantityPerEvent.toFixed(1) },
  { key: "minQuantity", label: "Min", value: (r) => r.minQuantity ?? "—" },
  { key: "maxQuantity", label: "Max", value: (r) => r.maxQuantity ?? "—" },
];

const questColumns: Column<any>[] = [
  { key: "name", label: "Name", value: (q) => q.name },
  { key: "npcName", label: "Given By", value: (q) => q.npcName },
  { key: "status", label: "Status", value: (q) => q.status },
  { key: "repeatable", label: "Repeatable", value: (q) => (q.repeatable ? "Yes" : "No") },
  { key: "requiredItems", label: "Required Items", value: (q) => joinItemMap(q.requiredItems) },
  { key: "rewardItems", label: "Rewards", value: (q) => joinItemMap(q.rewardItems) },
];

const tabButtons = Array.from(document.querySelectorAll<HTMLElement>("[data-memory-tab]"));
const tabPanels = Array.from(document.querySelectorAll<HTMLElement>("[data-memory-panel]"));

const setActiveTab = (name: string) => {
  tabButtons.forEach((b) => b.classList.toggle("active", b.dataset["memoryTab"] === name));
  tabPanels.forEach((p) => p.classList.toggle("active", p.dataset["memoryPanel"] === name));
};

tabButtons.forEach((b) => {
  b.addEventListener("click", () => setActiveTab(b.dataset["memoryTab"] || "entities"));
});

const updatedAtEl = document.getElementById("memoryUpdatedAt");
const refreshBtnEl = document.getElementById("memoryRefreshBtn") as HTMLButtonElement | null;

const load = () => {
  if (updatedAtEl) updatedAtEl.textContent = "Loading...";
  if (refreshBtnEl) refreshBtnEl.disabled = true;
  fetch("/memory/data")
    .then((res) => res.json())
    .then((data) => {
      renderTable("memoryEntitiesTable", entityColumns, data.entities, "No entities recorded yet.");
      renderTable("memoryHeatmapTable", heatmapColumns, data.heatMap, "No sightings recorded yet.");
      renderTable("memoryMerchantsTable", merchantColumns, data.merchantTrades, "No merchant trades recorded yet.");
      renderTable("memoryCombatTable", combatColumns, data.combatHistory, "No combat history recorded yet.");
      renderTable("memoryLootTable", lootColumns, data.lootRates, "No loot data recorded yet.");
      renderTable("memoryQuestsTable", questColumns, data.quests, "No quests recorded yet.");
      if (updatedAtEl) updatedAtEl.textContent = "Loaded " + new Date(data.generatedAt).toLocaleTimeString();
    })
    .catch((err) => {
      if (updatedAtEl) updatedAtEl.textContent = "Failed to load memory: " + String(err);
    })
    .finally(() => {
      if (refreshBtnEl) refreshBtnEl.disabled = false;
    });
};

refreshBtnEl?.addEventListener("click", load);

load();
