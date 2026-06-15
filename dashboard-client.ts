const tabButtons = Array.from(document.querySelectorAll<HTMLElement>("[data-tab]"));
const tabPanels = Array.from(document.querySelectorAll<HTMLElement>("[data-panel]"));
const outputRaw = document.getElementById("outputRaw");
const outputSnapshot = document.getElementById("outputSnapshot");
const snapshotTimeEl = document.getElementById("snapshotTime");
const snapshotBtnEl = document.getElementById("snapshotBtn");
const upgradePlansListEl = document.getElementById("upgradePlansList");
  const npcsListEl = document.getElementById("npcsList");
  const mobsListEl = document.getElementById("mobsList");
  const objectsListEl = document.getElementById("objectsList");
  const eventsListEl = document.getElementById("eventsList");
const connectionBannerEl = document.getElementById("connectionBanner");
const connectionMsgEl = document.getElementById("connectionMsg");
const receivedAtEl = document.getElementById("receivedAt");
const unitCountEl = document.getElementById("unitCount");
const monsterCountEl = document.getElementById("monsterCount");
const recoveryModeEl = document.getElementById("recoveryMode");
const recoveryHintEl = document.getElementById("recoveryHint");
const playerNameEl = document.getElementById("playerName");
const positionStatEl = document.getElementById("positionStat");
const hpTextEl = document.getElementById("hpText");
const mpTextEl = document.getElementById("mpText");
const tpTextEl = document.getElementById("tpText");
const caloriesTextEl = document.getElementById("caloriesText");
const weightTextEl = document.getElementById("weightText");
const hpFillEl = document.getElementById("hpFill");
const mpFillEl = document.getElementById("mpFill");
const tpFillEl = document.getElementById("tpFill");
const caloriesFillEl = document.getElementById("caloriesFill");
const weightFillEl = document.getElementById("weightFill");
const carryWeightEl = document.getElementById("carryWeight");
const moveSpeedEl = document.getElementById("moveSpeed");
const storageFeeCoverageEl = document.getElementById("storageFeeCoverage");
const nearbyCountsEl = document.getElementById("nearbyCounts");
const equipmentGridEl = document.getElementById("equipmentGrid");

const combatSkillsListEl = document.getElementById("combatSkillsList");
const spellbookListEl = document.getElementById("spellbookList");
const inventoryListEl = document.getElementById("inventoryList");
const storageListEl = document.getElementById("storageList");
const thresholdRangeEl = document.getElementById("thresholdRange") as HTMLInputElement | null;
const thresholdInputEl = document.getElementById("thresholdInput") as HTMLInputElement | null;
const thresholdSaveEl = document.getElementById("thresholdSave") as HTMLButtonElement | null;
const thresholdStatusEl = document.getElementById("thresholdStatus");
const idleAtHomeToggleEl = document.getElementById("idleAtHomeToggle") as HTMLButtonElement | null;
const idleAtHomeStateEl = document.getElementById("idleAtHomeState");
const idleAtHomeStatusEl = document.getElementById("idleAtHomeStatus");
let isThresholdDirty = false;
let latestThresholdPercent = 25;
const THRESHOLD_LS_KEY = "lowHpThresholdPercent";

const equipmentSlots = [
  { key: "helm", label: "Helm", icon: "⛨" },
  { key: "chest", label: "Body Armor", icon: "◫" },
  { key: "legs", label: "Legs", icon: "▥" },
  { key: "feet", label: "Boots", icon: "◡" },
  { key: "hands", label: "Gloves", icon: "✋" },
  { key: "weapon", label: "Main Hand", icon: "⚔" },
  { key: "offhand", label: "Off Hand", icon: "🛡" },
  { key: "amulet", label: "Necklace", icon: "◌" },
  { key: "ring1", label: "Ring 1", icon: "◉" },
  { key: "ring2", label: "Ring 2", icon: "◉" },
];

const escapeHtml = (value: unknown) =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const colorizeJson = (jsonStr: string) => {
  const parts: string[] = [];
  let lastIndex = 0;
  const regex = /("(?:\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(?:\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g;
  let match;
  while ((match = regex.exec(jsonStr)) !== null) {
    parts.push(escapeHtml(jsonStr.slice(lastIndex, match.index)));
    const token = match[0];
    let cls;
    if (token.startsWith('"')) {
      cls = token.trimEnd().endsWith(':') ? 'json-key' : 'json-str';
    } else if (token === 'true' || token === 'false') {
      cls = 'json-bool';
    } else if (token === 'null') {
      cls = 'json-null';
    } else {
      cls = 'json-num';
    }
    parts.push('<span class="' + cls + '">' + escapeHtml(token) + '</span>');
    lastIndex = match.index + token.length;
  }
  parts.push(escapeHtml(jsonStr.slice(lastIndex)));
  return parts.join('');
};

const formatItemName = (itemId: unknown) => {
  if (!itemId) {
    return "-";
  }

  return String(itemId)
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .replace(/([0-9]+)/g, " $1")
    .replace(/\s+/g, " ")
    .trim();
};

let itemCatalog: Record<string, Record<string, unknown>> = {};

const lookupItemName = (itemId: unknown): string => {
  if (!itemId) return "-";
  const id = String(itemId);
  const name = itemCatalog[id]?.["name"];
  return typeof name === "string" ? name : formatItemName(id);
};

const setActiveTab = (tabName: string) => {
  tabButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset["tab"] === tabName);
  });

  tabPanels.forEach((panel) => {
    panel.classList.toggle("active", panel.dataset["panel"] === tabName);
  });
};

tabButtons.forEach((button) => {
  button.addEventListener("click", () => {
    setActiveTab(button.dataset["tab"] || "status");
  });
});

setActiveTab("status");

const worldTabButtons = Array.from(document.querySelectorAll<HTMLElement>("[data-world-tab]"));
const worldTabPanels = Array.from(document.querySelectorAll<HTMLElement>("[data-world-panel]"));

const setActiveWorldTab = (tabName: string) => {
  worldTabButtons.forEach((btn) => {
    btn.classList.toggle("active", btn.dataset["worldTab"] === tabName);
  });
  worldTabPanels.forEach((panel) => {
    panel.classList.toggle("active", panel.dataset["worldPanel"] === tabName);
  });
};

worldTabButtons.forEach((btn) => {
  btn.addEventListener("click", () => setActiveWorldTab(btn.dataset["worldTab"] || "upgrade-plans"));
});

setActiveWorldTab("upgrade-plans");

// Request notification permission early so it's ready when we need it.
if ("Notification" in window && Notification.permission === "default") {
  Notification.requestPermission();
}

// Connection staleness: banner after 15 s, system notification after 2 min.
let bannerTimer: ReturnType<typeof setTimeout> | null = null;
let notifyTimer: ReturnType<typeof setTimeout> | null = null;
const BANNER_MS = 15_000;
const NOTIFY_MS = 60_000;

const showConnectionBanner = (msg: string) => {
  if (connectionBannerEl) {
    connectionBannerEl.style.display = "";
    if (connectionMsgEl) connectionMsgEl.textContent = msg;
  }
};

const fireNotification = (msg: string) => {
  if ("Notification" in window && Notification.permission === "granted") {
    new Notification("Bot Dashboard", { body: msg });
  }
};

const hideConnectionBanner = () => {
  if (connectionBannerEl) connectionBannerEl.style.display = "none";
};

const resetStaleTimer = () => {
  if (bannerTimer) clearTimeout(bannerTimer);
  if (notifyTimer) clearTimeout(notifyTimer);
  hideConnectionBanner();
  bannerTimer = setTimeout(() => {
    showConnectionBanner("No updates received — bot may be offline.");
  }, BANNER_MS);
  notifyTimer = setTimeout(() => {
    fireNotification("No updates received for 2 minutes — bot may be offline.");
  }, NOTIFY_MS);
};

resetStaleTimer();

const toPercent = (value: number, max: number) => {
  if (typeof value !== "number" || typeof max !== "number" || max <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(100, (value / max) * 100));
};

const setMeter = (fillEl: HTMLElement | null, textEl: HTMLElement | null, value: number | undefined, max: number | undefined) => {
  if (typeof value !== "number" || typeof max !== "number") {
    if (fillEl) fillEl.style.width = "0%";
    if (textEl) textEl.textContent = "-";
    return;
  }
  if (fillEl) fillEl.style.width = toPercent(value, max).toFixed(1) + "%";
  if (textEl) textEl.textContent = value + " / " + max;
};

const clampThresholdPercent = (value: unknown) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 25;
  }
  return Math.min(95, Math.max(1, Math.round(numeric)));
};

const syncThresholdInputs = (value: unknown) => {
  const clamped = clampThresholdPercent(value);
  if (thresholdRangeEl) thresholdRangeEl.value = String(clamped);
  if (thresholdInputEl) thresholdInputEl.value = String(clamped);
};

const saveThreshold = async () => {
  const nextPercent = clampThresholdPercent(thresholdInputEl?.value);
  syncThresholdInputs(nextPercent);
  if (thresholdSaveEl) thresholdSaveEl.disabled = true;
  if (thresholdStatusEl) thresholdStatusEl.textContent = "Applying threshold...";
  try {
    const response = await fetch("/config/threshold", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ percent: nextPercent }),
    });

    if (!response.ok) {
      throw new Error("HTTP " + response.status);
    }

    const payload = await response.json();
    latestThresholdPercent = clampThresholdPercent(payload.lowHpThresholdPercent);
    localStorage.setItem(THRESHOLD_LS_KEY, String(latestThresholdPercent));
    if (thresholdStatusEl) thresholdStatusEl.textContent = "Updated to " + latestThresholdPercent + "%";
  } catch (err) {
    if (thresholdStatusEl) thresholdStatusEl.textContent = "Failed to update threshold: " + String(err);
  } finally {
    if (thresholdSaveEl) thresholdSaveEl.disabled = false;
  }
};

thresholdRangeEl?.addEventListener("input", () => {
  if (thresholdInputEl && thresholdRangeEl) thresholdInputEl.value = thresholdRangeEl.value;
  isThresholdDirty = true;
  if (thresholdStatusEl) thresholdStatusEl.textContent = "Unsaved threshold: " + (thresholdInputEl?.value ?? "") + "%";
});

thresholdInputEl?.addEventListener("input", () => {
  if (thresholdRangeEl && thresholdInputEl) thresholdRangeEl.value = String(clampThresholdPercent(thresholdInputEl.value));
  isThresholdDirty = true;
  if (thresholdStatusEl) thresholdStatusEl.textContent = "Unsaved threshold: " + (thresholdInputEl?.value ?? "") + "%";
});

thresholdSaveEl?.addEventListener("click", () => {
  void saveThreshold();
});

idleAtHomeToggleEl?.addEventListener("click", () => {
  if (idleAtHomeToggleEl) idleAtHomeToggleEl.disabled = true;
  if (idleAtHomeStatusEl) idleAtHomeStatusEl.textContent = "Updating...";
  fetch("/config/idle-at-home", { method: "POST" })
    .then((res) => res.json())
    .then((payload) => {
      const active = Boolean(payload.idleAtHome);
      if (idleAtHomeStateEl) {
        idleAtHomeStateEl.textContent = active ? "ACTIVE" : "INACTIVE";
        idleAtHomeStateEl.className = "control-state " + (active ? "status-warn" : "status-ok");
      }
      if (idleAtHomeToggleEl) {
        idleAtHomeToggleEl.textContent = active ? "Resume Bot" : "Return to Home";
        idleAtHomeToggleEl.classList.toggle("active", active);
      }
      if (idleAtHomeStatusEl) idleAtHomeStatusEl.textContent = active ? "Bot is idling at home." : "Bot resumed normal operation.";
    })
    .catch((err) => {
      if (idleAtHomeStatusEl) idleAtHomeStatusEl.textContent = "Failed: " + String(err);
    })
    .finally(() => {
      if (idleAtHomeToggleEl) idleAtHomeToggleEl.disabled = false;
    });
});

snapshotBtnEl?.addEventListener("click", () => {
  if (outputRaw && outputSnapshot) {
    outputSnapshot.textContent = outputRaw.textContent;
    if (snapshotTimeEl) {
      snapshotTimeEl.textContent = new Date().toLocaleTimeString();
    }
  }
});

inventoryListEl?.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest(".deposit-btn");
  if (!btn) return;
  const item = btn.getAttribute("data-item");
  if (!item) return;
  const statusEl = document.getElementById("depositStatus");
  statusEl && (statusEl.textContent = "Depositing " + item + " + 100¢...");
  fetch("/deposit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ item }),
  })
    .then((res) => res.json())
    .then(() => { if (statusEl) statusEl.textContent = "Deposit request sent for " + item; })
    .catch((err) => { if (statusEl) statusEl.textContent = "Deposit failed: " + String(err); });
});

const formatPosition = (position: unknown) => {
  if (!position || typeof (position as Record<string, unknown>).x !== "number" || typeof (position as Record<string, unknown>).y !== "number") return "—";
  const pos = position as { x: number; y: number };
  return "(" + Math.round(pos.x) + ", " + Math.round(pos.y) + ")";
};

const renderUpgradePlans = (plans: unknown) => {
  if (!upgradePlansListEl) return;
  const items = Array.isArray(plans) ? [...plans] : [];
  if (items.length === 0) {
    upgradePlansListEl.innerHTML = '<div class="list-row"><span class="list-title" style="opacity:0.5;">No upgrade plans — bot will populate this when it has targets.</span></div>';
    return;
  }
  items.sort((a, b) => {
    if (a.completed !== b.completed) return a.completed ? 1 : -1;
    return (a.priority || 0) - (b.priority || 0);
  });
  upgradePlansListEl.innerHTML = items.map((plan) => {
    const acqParts = [];
    if (plan.recipeId) acqParts.push("Craftable");
    if (plan.canBuy) acqParts.push("Buyable");
    const acq = acqParts.length > 0 ? acqParts.join(" · ") : "No known acquisition path";
    const statusClass = plan.completed ? "done" : (plan.recipeId || plan.canBuy) ? "pending" : "blocked";
    const statusLabel = plan.completed ? "DONE" : (plan.recipeId || plan.canBuy) ? "PENDING" : "BLOCKED";
    const reqs = (plan.requirements || []).map((req: Record<string, unknown>) => {
      const quantity = Number(req["quantity"]) || 0;
      const have = Number(req["have"]) || 0;
      const pct = quantity > 0 ? Math.min(100, (have / quantity) * 100) : 0;
      const done = have >= quantity;
      return (
        '<div class="req-row">' +
        '<span class="req-name">' + escapeHtml(lookupItemName(req["item"])) + '</span>' +
        '<div class="req-meter"><div class="req-fill' + (done ? " complete" : "") + '" style="width:' + pct.toFixed(1) + '%"></div></div>' +
        '<span class="req-qty">' + escapeHtml(String(have)) + " / " + escapeHtml(String(quantity)) + '</span>' +
        '</div>'
      );
    }).join("");
    return (
      '<div class="upgrade-entry' + (plan.completed ? " completed" : "") + '">' +
      '<div class="upgrade-header">' +
      '<span class="upgrade-priority">#' + escapeHtml(String(plan.priority)) + '</span>' +
      '<span class="upgrade-name">' + escapeHtml(plan.name || lookupItemName(plan.targetItem)) + '</span>' +
      '<span class="upgrade-badge">' + escapeHtml(plan.slot || "") + '</span>' +
      '<span class="upgrade-status ' + statusClass + '">' + statusLabel + '</span>' +
      '</div>' +
      '<div class="upgrade-acq">' + escapeHtml(acq) + '</div>' +
      (reqs ? '<div class="upgrade-reqs">' + reqs + '</div>' : '') +
      '</div>'
    );
  }).join("");
};

const renderWorldList = (containerEl: HTMLElement | null, items: unknown[] | null | undefined, renderRow: (item: any) => string, emptyText: string) => {
  if (!containerEl) return;
  if (!items || items.length === 0) {
    containerEl.innerHTML = '<div class="list-row"><span class="list-title" style="opacity:0.5;">' + escapeHtml(emptyText) + '</span></div>';
    return;
  }
  containerEl.innerHTML = items.map(renderRow).join("");
};

const renderNpcs = (npcs: unknown[] | null | undefined) => {
  renderWorldList(npcsListEl, npcs, (npc) => {
    const buying = (npc.trades?.buying || {}) as Record<string, { price: number; quantity: number } | undefined>;
    const buyingEntries = Object.entries(buying).filter(([, v]) => v && v.price > 0);
    const buyingHtml = buyingEntries.length > 0
      ? '<div class="npc-buying">' +
        buyingEntries.map(([itemId, offer]) =>
          '<span class="npc-buy-item">' + escapeHtml(lookupItemName(itemId)) + ' <span class="npc-buy-price">' + escapeHtml(String(offer!.price)) + '¢</span></span>'
        ).join('') +
        '</div>'
      : '';
    const selling = (npc.trades?.selling || {}) as Record<string, { price: number; quantity: number } | undefined>;
    const sellingEntries = Object.entries(selling).filter(([, v]) => v && v.price > 0);
    const sellingHtml = sellingEntries.length > 0
      ? '<div class="npc-selling">' +
        sellingEntries.map(([itemId, offer]) =>
          '<span class="npc-sell-item">' + escapeHtml(lookupItemName(itemId)) + ' <span class="npc-sell-price">' + escapeHtml(String(offer!.price)) + '¢</span>' + (offer!.quantity > 0 ? ' <span class="npc-sell-qty">×' + escapeHtml(String(offer!.quantity)) + '</span>' : '') + '</span>'
        ).join('') +
        '</div>'
      : '';
    return (
      '<div class="list-row">' +
      '<div style="flex:1"><div class="list-title">' + escapeHtml(formatItemName(npc.name || npc.id)) + '</div>' +
      '<div class="list-meta">' + escapeHtml(npc.npcType || "npc") + " · " + escapeHtml(npc.id) + '</div>' +
      buyingHtml +
      sellingHtml +
      '</div>' +
      '<div class="list-value">' + escapeHtml(formatPosition(npc.position)) + '</div>' +
      '</div>'
    );
  }, "No NPCs recorded yet.");
};

const renderMobs = (mobs: unknown[] | null | undefined) => {
  renderWorldList(mobsListEl, mobs, (mob) => {
    const label = formatItemName(mob.monsterId || mob.name || mob.id);
    const hp = typeof mob.hp === "number" ? " · " + mob.hp + " HP" : "";
    return (
      '<div class="list-row">' +
      '<div><div class="list-title">' + escapeHtml(label) + '</div>' +
      '<div class="list-meta">' + escapeHtml(mob.id) + escapeHtml(hp) + '</div></div>' +
      '<div class="list-value">' + escapeHtml(formatPosition(mob.position)) + '</div>' +
      '</div>'
    );
  }, "No mobs recorded yet.");
};

const renderObjects = (objects: unknown[] | null | undefined) => {
  renderWorldList(objectsListEl, objects, (obj) => {
    const subType = obj.treeType || obj.oreType || obj.stationType || "";
    const label = obj.label || formatItemName(obj.type);
    return (
      '<div class="list-row">' +
      '<div><div class="list-title">' + escapeHtml(label) + '</div>' +
      '<div class="list-meta">' + escapeHtml(obj.type) + (subType ? " · " + escapeHtml(subType) : "") + '</div></div>' +
      '<div class="list-value">' + escapeHtml(formatPosition(obj.position)) + '</div>' +
      '</div>'
    );
  }, "No world objects recorded yet.");
};

const renderWorld = (world: unknown, upgradePlans: unknown) => {
  const w = (world || {}) as Record<string, unknown>;
  renderUpgradePlans(upgradePlans);
  renderNpcs(w["npcs"] as unknown[] | null);
  renderMobs(w["mobs"] as unknown[] | null);
  renderObjects(w["objects"] as unknown[] | null);
};

const compareKeys = (left: string, right: string) => left.localeCompare(right);

const renderEquipment = (equipment: unknown, items: unknown) => {
  if (!equipmentGridEl) return;
  const eq = (equipment || {}) as Record<string, string | null>;
  const catalog = (items || {}) as Record<string, Record<string, unknown>>;
  const slots = ["weapon", "ring1", "helm", "ring2", "offhand", "chest", "amulet", "hands", "legs", "feet"];
  equipmentGridEl.innerHTML = slots.map((key) => {
    const slot = equipmentSlots.find((s) => s.key === key);
    const itemId = eq[key] || null;
    const itemData = itemId ? (catalog[itemId] || {}) : null;
    const lines = [slot?.label || key];
    if (itemId) {
      lines.push(lookupItemName(itemId));
      if (itemData) {
        Object.entries(itemData)
          .filter(([, v]) => typeof v === "number")
          .forEach(([k, v]) => lines.push(formatItemName(k) + ": " + v));
      }
    } else {
      lines.push("Empty");
    }
    const tooltip = lines.join("\n");
    const slotHtml = (
      '<div class="slot-item eq-' + key + '" title="' + escapeHtml(tooltip) + '">' +
      '<div class="slot-icon">' + (itemId ? escapeHtml(slot?.icon || "") : "") + '</div>' +
      '</div>'
    );
    if (key === "hands" || key === "feet") {
      return '<div class="eq-' + key + '-wrap">' + slotHtml + '</div>';
    }
    return slotHtml;
  }).join("");
};

const renderRecordList = (containerEl: HTMLElement | null, record: unknown, emptyText: string, renderExtra?: (key: string, value: number) => string) => {
  const entries = Object.entries(record as Record<string, unknown> || {})
    .filter(([, value]) => typeof value === "number" && value > 0)
    .sort(([left], [right]) => compareKeys(left, right));

  if (!containerEl) return;

  if (entries.length === 0) {
    containerEl.innerHTML = '<div class="list-row"><span class="list-title">' + escapeHtml(emptyText) + '</span><span class="list-meta">-</span></div>';
    return;
  }

  containerEl.innerHTML = entries
    .map(([key, value]) => {
      const extraHtml = renderExtra ? renderExtra(key, value as number) : '';
      return (
        '<div class="list-row"><div><div class="list-title">' +
        escapeHtml(lookupItemName(key)) +
        '</div><div class="list-meta">' +
        escapeHtml(key) +
        '</div></div><div class="list-value">' +
        escapeHtml(String(value)) +
        '</div>' +
        extraHtml +
        '</div>'
      );
    })
    .join("");
};

const renderCombatSkills = (skills: unknown) => {
  const entries = Object.entries(skills as Record<string, unknown> || {})
    .sort(([left], [right]) => compareKeys(left, right));

  if (entries.length === 0) {
    if (combatSkillsListEl) combatSkillsListEl.innerHTML = '<div class="list-row"><span class="list-title">No combat skills</span><span class="list-meta">-</span></div>';
    return;
  }

  if (combatSkillsListEl) combatSkillsListEl.innerHTML = entries
    .map(([key, value]) => {
      return (
        '<div class="list-row"><div><div class="list-title">' +
        escapeHtml(formatItemName(key)) +
        '</div><div class="list-meta">' +
        escapeHtml(key) +
        '</div></div><div class="list-value">' +
        escapeHtml(String(value)) +
        '</div></div>'
      );
    })
    .join("");
};

const renderSpellbook = (spellbook: unknown) => {
  const entries = Array.isArray(spellbook) ? spellbook : [];

  if (entries.length === 0) {
    if (spellbookListEl) spellbookListEl.innerHTML = '<div class="list-row"><span class="list-title">Empty</span><span class="list-meta">No spells equipped</span></div>';
    return;
  }

  if (spellbookListEl) spellbookListEl.innerHTML = entries
    .map((spell, index) => {
      return (
        '<div class="list-row"><div><div class="list-title">Slot ' +
        escapeHtml(String(index + 1)) +
        '</div><div class="list-meta">' +
        escapeHtml(spell) +
        '</div></div><div class="list-value">' +
        escapeHtml(formatItemName(spell)) +
        '</div></div>'
      );
    })
    .join("");
};

const render = (payload: any) => {
  const player = payload.player || {};
  const bot = payload.bot || {};
  const equipment = player.equipment || {};

  if (receivedAtEl) receivedAtEl.textContent = payload.receivedAt || "-";
  if (unitCountEl) unitCountEl.textContent = String(payload.unitCount || 0);
  if (monsterCountEl) monsterCountEl.textContent = String(payload.monstersVisible || 0);
  if (playerNameEl) playerNameEl.textContent = player.name || "-";
  if (recoveryModeEl) {
    recoveryModeEl.textContent = bot.recoveringAtHome ? "ACTIVE" : "INACTIVE";
    recoveryModeEl.className = "control-state " + (bot.recoveringAtHome ? "status-warn" : "status-ok");
  }
  if (recoveryHintEl) recoveryHintEl.textContent = "Low HP threshold: " + String(bot.lowHpThresholdPercent ?? 0) + "% (" + String(bot.lowHpThreshold ?? 0) + " HP)";
  const idleActive = Boolean(bot.idleAtHome);
  if (idleAtHomeStateEl) {
    idleAtHomeStateEl.textContent = idleActive ? "ACTIVE" : "INACTIVE";
    idleAtHomeStateEl.className = "control-state " + (idleActive ? "status-warn" : "status-ok");
  }
  if (idleAtHomeToggleEl) {
    idleAtHomeToggleEl.textContent = idleActive ? "Resume Bot" : "Return to Home";
    idleAtHomeToggleEl.classList.toggle("active", idleActive);
  }
  const serverThresholdPercent = clampThresholdPercent(bot.lowHpThresholdPercent ?? 25);
  latestThresholdPercent = serverThresholdPercent;
  if (!isThresholdDirty) {
    syncThresholdInputs(serverThresholdPercent);
    if (thresholdStatusEl) thresholdStatusEl.textContent = "Threshold applies immediately.";
  }
  if (player.position && typeof player.position.x === "number" && typeof player.position.y === "number") {
    if (positionStatEl) positionStatEl.textContent = "(" + player.position.x.toFixed(2) + ", " + player.position.y.toFixed(2) + ")";
  } else {
    if (positionStatEl) positionStatEl.textContent = "-";
  }

  setMeter(hpFillEl, hpTextEl, player.hp, player.maxHp);
  setMeter(mpFillEl, mpTextEl, player.mp, 100);
  setMeter(tpFillEl, tpTextEl, player.tp, 100);
  setMeter(caloriesFillEl, caloriesTextEl, player.calories, 3000);
  setMeter(weightFillEl, weightTextEl, player.weight, player.maxCarryWeight);

  if (carryWeightEl) {
    if (typeof player.weight === "number" && typeof player.maxCarryWeight === "number" && player.maxCarryWeight > 0) {
      const pct = (player.weight / player.maxCarryWeight) * 100;
      carryWeightEl.textContent = pct.toFixed(1) + "%";
    } else {
      carryWeightEl.textContent = "-";
    }
  }
  if (moveSpeedEl) {
    moveSpeedEl.textContent = typeof player.movementSpeed === "number" ? player.movementSpeed.toFixed(1) + " m/s" : "-";
  }
  if (storageFeeCoverageEl) {
    const sf = payload.storageFee || null;
    if (sf && typeof sf.coverage === "number" && typeof sf.perCharge === "number") {
      storageFeeCoverageEl.textContent = sf.coverage.toFixed(1) + "x (" + sf.perCharge + "¢/charge)";
    } else {
      storageFeeCoverageEl.textContent = "-";
    }
  }
  if (nearbyCountsEl) {
    nearbyCountsEl.textContent = String(payload.bot?.nearbyBankers ?? 0) + " / " + String(payload.bot?.nearbyMerchants ?? 0);
  }

  itemCatalog = (payload.raw?.items || {}) as Record<string, Record<string, unknown>>;
  renderEquipment(equipment, payload.raw?.items);
  renderCombatSkills(player.combatSkills);
  renderSpellbook(player.spellbook);
  renderRecordList(inventoryListEl, player.inventory, "Inventory empty", (key) =>
    '<button class="deposit-btn" data-item="' + key.replace(/"/g, "&quot;") + '">Deposit 1 + 100¢</button>'
  );
  renderRecordList(storageListEl, player.storage, "Storage empty");
  const depositStatusEl = document.getElementById("depositStatus");
  if (depositStatusEl && payload.bot.depositMessage) {
    depositStatusEl.textContent = payload.bot.depositMessage;
  }
  if (outputRaw) {
    // items is a static catalogue of every item definition — strip it to reduce noise.
    const { items: _items, ...rawWithoutItems } = payload.raw ?? {};
    outputRaw.textContent = JSON.stringify(rawWithoutItems, null, 2);
  }

  renderWorld(payload.world, payload.upgradePlans);

  // ── Events ──────────────────────────────────────────────────────────────────
  const events: Array<{ ts: string; name: string; data: unknown }> = payload.events ?? [];
  if (eventsListEl) {
    const storageEvents = events.filter(e =>
      e.name === 'storageCharged' || e.name === 'storageEmptied' ||
      e.name === 'deposited' || e.name === 'withdrew'
    );
    if (storageEvents.length === 0) {
      eventsListEl.innerHTML = '<div class="list-row"><span class="list-title">No storage events</span><span class="list-meta">Deposit something to see events here</span></div>';
    } else {
      eventsListEl.innerHTML = storageEvents.toReversed().map((evt) => {
        const dataStr = typeof evt.data === 'object' && evt.data !== null
          ? JSON.stringify(evt.data, null, 1)
          : String(evt.data ?? '');
        const localTime = new Date(evt.ts).toLocaleTimeString();
        return '<div class="list-row event-row"><div><div class="list-title event-name">' +
          escapeHtml(evt.name) +
          '</div><div class="list-meta">' +
          escapeHtml(localTime) +
          '</div></div><div class="list-value event-data">' +
          escapeHtml(dataStr) +
          '</div></div>';
      }).join("");
    }
  }
};

fetch("/state")
  .then((res) => res.json())
  .then(render)
  .catch((err) => {
    if (outputSnapshot) outputSnapshot.textContent = "Initial fetch failed: " + String(err);
  });

// Restore the saved threshold from localStorage and push it to the server so
// it survives server restarts without the user having to re-enter it.
const storedThreshold = localStorage.getItem(THRESHOLD_LS_KEY);

fetch("/config")
  .then((res) => res.json())
  .then((payload) => {
    // Only use the server value as the initial state if we have nothing saved locally.
    if (storedThreshold === null) {
      const serverThresholdPercent = clampThresholdPercent(payload.lowHpThresholdPercent);
      latestThresholdPercent = serverThresholdPercent;
      if (!isThresholdDirty) {
        syncThresholdInputs(serverThresholdPercent);
        if (thresholdStatusEl) thresholdStatusEl.textContent = "Threshold applies immediately.";
      }
    }
  })
  .catch(() => {
    if (storedThreshold === null) {
      if (thresholdStatusEl) thresholdStatusEl.textContent = "Unable to load threshold config.";
    }
  });

const source = new EventSource("/events");
// On the first snapshot after page load or after a server restart (reconnect),
// push any saved threshold from localStorage to the server. By the time the
// first snapshot arrives the server is definitely up, so there is no race.
let pendingThresholdSync = localStorage.getItem(THRESHOLD_LS_KEY) !== null;
source.onmessage = (event) => {
  try {
    const payload = JSON.parse(event.data);
    if (pendingThresholdSync) {
      pendingThresholdSync = false;
      const stored = localStorage.getItem(THRESHOLD_LS_KEY);
      if (stored !== null) {
        syncThresholdInputs(clampThresholdPercent(stored));
        void saveThreshold();
      }
    }
    render(payload);
    resetStaleTimer();
  } catch (err) {
    console.error("Failed to parse event payload", err);
  }
};
source.onerror = () => {
  pendingThresholdSync = localStorage.getItem(THRESHOLD_LS_KEY) !== null;
  showConnectionBanner("Connection lost — waiting to reconnect...");
  console.error("Dashboard stream disconnected. Waiting to reconnect...");
  // notifyTimer is already running from resetStaleTimer; no need to start another
};
