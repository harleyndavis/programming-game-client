const tabButtons = Array.from(document.querySelectorAll("[data-tab]"));
const tabPanels = Array.from(document.querySelectorAll("[data-panel]"));
const outputRaw = document.getElementById("outputRaw");
const outputSnapshot = document.getElementById("outputSnapshot");
const snapshotTimeEl = document.getElementById("snapshotTime");
const snapshotBtnEl = document.getElementById("snapshotBtn");
const upgradePlansListEl = document.getElementById("upgradePlansList");
const npcsListEl = document.getElementById("npcsList");
const mobsListEl = document.getElementById("mobsList");
const objectsListEl = document.getElementById("objectsList");
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
const equipmentGridEl = document.getElementById("equipmentGrid");

const combatSkillsListEl = document.getElementById("combatSkillsList");
const spellbookListEl = document.getElementById("spellbookList");
const inventoryListEl = document.getElementById("inventoryList");
const storageListEl = document.getElementById("storageList");
const thresholdRangeEl = document.getElementById("thresholdRange");
const thresholdInputEl = document.getElementById("thresholdInput");
const thresholdSaveEl = document.getElementById("thresholdSave");
const thresholdStatusEl = document.getElementById("thresholdStatus");
const idleAtHomeToggleEl = document.getElementById("idleAtHomeToggle");
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

const escapeHtml = (value) =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const colorizeJson = (jsonStr) => {
  const parts = [];
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

const formatItemName = (itemId) => {
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

const setActiveTab = (tabName) => {
  tabButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === tabName);
  });

  tabPanels.forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.panel === tabName);
  });
};

tabButtons.forEach((button) => {
  button.addEventListener("click", () => {
    setActiveTab(button.dataset.tab || "status");
  });
});

setActiveTab("status");

const worldTabButtons = Array.from(document.querySelectorAll("[data-world-tab]"));
const worldTabPanels = Array.from(document.querySelectorAll("[data-world-panel]"));

const setActiveWorldTab = (tabName) => {
  worldTabButtons.forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.worldTab === tabName);
  });
  worldTabPanels.forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.worldPanel === tabName);
  });
};

worldTabButtons.forEach((btn) => {
  btn.addEventListener("click", () => setActiveWorldTab(btn.dataset.worldTab || "upgrade-plans"));
});

setActiveWorldTab("upgrade-plans");

// Request notification permission early so it's ready when we need it.
if ("Notification" in window && Notification.permission === "default") {
  Notification.requestPermission();
}

// Connection staleness: banner after 15 s, system notification after 2 min.
let bannerTimer = null;
let notifyTimer = null;
const BANNER_MS = 15_000;
const NOTIFY_MS = 60_000;

const showConnectionBanner = (msg) => {
  if (connectionBannerEl) {
    connectionBannerEl.style.display = "";
    if (connectionMsgEl) connectionMsgEl.textContent = msg;
  }
};

const fireNotification = (msg) => {
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

const toPercent = (value, max) => {
  if (typeof value !== "number" || typeof max !== "number" || max <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(100, (value / max) * 100));
};

const setMeter = (fillEl, textEl, value, max) => {
  if (typeof value !== "number" || typeof max !== "number") {
    fillEl.style.width = "0%";
    textEl.textContent = "-";
    return;
  }
  fillEl.style.width = toPercent(value, max).toFixed(1) + "%";
  textEl.textContent = value + " / " + max;
};

const clampThresholdPercent = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 25;
  }
  return Math.min(95, Math.max(1, Math.round(numeric)));
};

const syncThresholdInputs = (value) => {
  const clamped = clampThresholdPercent(value);
  thresholdRangeEl.value = String(clamped);
  thresholdInputEl.value = String(clamped);
};

const saveThreshold = async () => {
  const nextPercent = clampThresholdPercent(thresholdInputEl.value);
  syncThresholdInputs(nextPercent);
  thresholdSaveEl.disabled = true;
  thresholdStatusEl.textContent = "Applying threshold...";
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
    thresholdStatusEl.textContent = "Updated to " + latestThresholdPercent + "%";
  } catch (err) {
    thresholdStatusEl.textContent = "Failed to update threshold: " + String(err);
  } finally {
    thresholdSaveEl.disabled = false;
  }
};

thresholdRangeEl.addEventListener("input", () => {
  thresholdInputEl.value = thresholdRangeEl.value;
  isThresholdDirty = true;
  thresholdStatusEl.textContent = "Unsaved threshold: " + thresholdInputEl.value + "%";
});

thresholdInputEl.addEventListener("input", () => {
  thresholdRangeEl.value = String(clampThresholdPercent(thresholdInputEl.value));
  isThresholdDirty = true;
  thresholdStatusEl.textContent = "Unsaved threshold: " + thresholdInputEl.value + "%";
});

thresholdSaveEl.addEventListener("click", () => {
  void saveThreshold();
});

idleAtHomeToggleEl.addEventListener("click", () => {
  idleAtHomeToggleEl.disabled = true;
  idleAtHomeStatusEl.textContent = "Updating...";
  fetch("/config/idle-at-home", { method: "POST" })
    .then((res) => res.json())
    .then((payload) => {
      const active = Boolean(payload.idleAtHome);
      idleAtHomeStateEl.textContent = active ? "ACTIVE" : "INACTIVE";
      idleAtHomeStateEl.className = "control-state " + (active ? "status-warn" : "status-ok");
      idleAtHomeToggleEl.textContent = active ? "Resume Bot" : "Return to Home";
      idleAtHomeToggleEl.classList.toggle("active", active);
      idleAtHomeStatusEl.textContent = active ? "Bot is idling at home." : "Bot resumed normal operation.";
    })
    .catch((err) => {
      idleAtHomeStatusEl.textContent = "Failed: " + String(err);
    })
    .finally(() => {
      idleAtHomeToggleEl.disabled = false;
    });
});

snapshotBtnEl.addEventListener("click", () => {
  if (outputRaw && outputSnapshot) {
    outputSnapshot.textContent = outputRaw.textContent;
    if (snapshotTimeEl) {
      snapshotTimeEl.textContent = new Date().toLocaleTimeString();
    }
  }
});

const formatPosition = (position) => {
  if (!position || typeof position.x !== "number" || typeof position.y !== "number") return "—";
  return "(" + Math.round(position.x) + ", " + Math.round(position.y) + ")";
};

const renderUpgradePlans = (plans) => {
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
    const reqs = (plan.requirements || []).map((req) => {
      const pct = req.quantity > 0 ? Math.min(100, (req.have / req.quantity) * 100) : 0;
      const done = req.have >= req.quantity;
      return (
        '<div class="req-row">' +
        '<span class="req-name">' + escapeHtml(formatItemName(req.item)) + '</span>' +
        '<div class="req-meter"><div class="req-fill' + (done ? " complete" : "") + '" style="width:' + pct.toFixed(1) + '%"></div></div>' +
        '<span class="req-qty">' + escapeHtml(String(req.have)) + " / " + escapeHtml(String(req.quantity)) + '</span>' +
        '</div>'
      );
    }).join("");
    return (
      '<div class="upgrade-entry' + (plan.completed ? " completed" : "") + '">' +
      '<div class="upgrade-header">' +
      '<span class="upgrade-priority">#' + escapeHtml(String(plan.priority)) + '</span>' +
      '<span class="upgrade-name">' + escapeHtml(plan.name || formatItemName(plan.targetItem)) + '</span>' +
      '<span class="upgrade-badge">' + escapeHtml(plan.slot || "") + '</span>' +
      '<span class="upgrade-status ' + statusClass + '">' + statusLabel + '</span>' +
      '</div>' +
      '<div class="upgrade-acq">' + escapeHtml(acq) + '</div>' +
      (reqs ? '<div class="upgrade-reqs">' + reqs + '</div>' : '') +
      '</div>'
    );
  }).join("");
};

const renderWorldList = (containerEl, items, renderRow, emptyText) => {
  if (!containerEl) return;
  if (!items || items.length === 0) {
    containerEl.innerHTML = '<div class="list-row"><span class="list-title" style="opacity:0.5;">' + escapeHtml(emptyText) + '</span></div>';
    return;
  }
  containerEl.innerHTML = items.map(renderRow).join("");
};

const renderNpcs = (npcs) => {
  renderWorldList(npcsListEl, npcs, (npc) => (
    '<div class="list-row">' +
    '<div><div class="list-title">' + escapeHtml(formatItemName(npc.name || npc.id)) + '</div>' +
    '<div class="list-meta">' + escapeHtml(npc.npcType || "npc") + " · " + escapeHtml(npc.id) + '</div></div>' +
    '<div class="list-value">' + escapeHtml(formatPosition(npc.position)) + '</div>' +
    '</div>'
  ), "No NPCs recorded yet.");
};

const renderMobs = (mobs) => {
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

const renderObjects = (objects) => {
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

const renderWorld = (world, upgradePlans) => {
  const w = world || {};
  renderUpgradePlans(upgradePlans);
  renderNpcs(w.npcs);
  renderMobs(w.mobs);
  renderObjects(w.objects);
};

const compareKeys = (left, right) => left.localeCompare(right);

const renderEquipment = (equipment, items) => {
  if (!equipmentGridEl) return;
  const eq = equipment || {};
  const catalog = items || {};
  const slots = ["weapon", "ring1", "helm", "ring2", "offhand", "chest", "amulet", "hands", "legs", "feet"];
  equipmentGridEl.innerHTML = slots.map((key) => {
    const slot = equipmentSlots.find((s) => s.key === key);
    const itemId = eq[key] || null;
    const itemData = itemId ? (catalog[itemId] || {}) : null;
    const lines = [slot?.label || key];
    if (itemId) {
      lines.push(formatItemName(itemId));
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

const renderRecordList = (containerEl, record, emptyText) => {
  const entries = Object.entries(record || {})
    .filter(([, value]) => typeof value === "number" && value > 0)
    .sort(([left], [right]) => compareKeys(left, right));

  if (entries.length === 0) {
    containerEl.innerHTML = '<div class="list-row"><span class="list-title">' + escapeHtml(emptyText) + '</span><span class="list-meta">-</span></div>';
    return;
  }

  containerEl.innerHTML = entries
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

const renderCombatSkills = (skills) => {
  const entries = Object.entries(skills || {})
    .sort(([left], [right]) => compareKeys(left, right));

  if (entries.length === 0) {
    combatSkillsListEl.innerHTML = '<div class="list-row"><span class="list-title">No combat skills</span><span class="list-meta">-</span></div>';
    return;
  }

  combatSkillsListEl.innerHTML = entries
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

const renderSpellbook = (spellbook) => {
  const entries = Array.isArray(spellbook) ? spellbook : [];

  if (entries.length === 0) {
    spellbookListEl.innerHTML = '<div class="list-row"><span class="list-title">Empty</span><span class="list-meta">No spells equipped</span></div>';
    return;
  }

  spellbookListEl.innerHTML = entries
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

const render = (payload) => {
  const player = payload.player || {};
  const bot = payload.bot || {};
  const equipment = player.equipment || {};

  receivedAtEl.textContent = payload.receivedAt || "-";
  unitCountEl.textContent = String(payload.unitCount || 0);
  monsterCountEl.textContent = String(payload.monstersVisible || 0);
  playerNameEl.textContent = player.name || "-";
  recoveryModeEl.textContent = bot.recoveringAtHome ? "ACTIVE" : "INACTIVE";
  recoveryModeEl.className = "control-state " + (bot.recoveringAtHome ? "status-warn" : "status-ok");
  recoveryHintEl.textContent = "Low HP threshold: " + String(bot.lowHpThresholdPercent ?? 0) + "% (" + String(bot.lowHpThreshold ?? 0) + " HP)";
  const idleActive = Boolean(bot.idleAtHome);
  idleAtHomeStateEl.textContent = idleActive ? "ACTIVE" : "INACTIVE";
  idleAtHomeStateEl.className = "control-state " + (idleActive ? "status-warn" : "status-ok");
  idleAtHomeToggleEl.textContent = idleActive ? "Resume Bot" : "Return to Home";
  idleAtHomeToggleEl.classList.toggle("active", idleActive);
  const serverThresholdPercent = clampThresholdPercent(bot.lowHpThresholdPercent ?? 25);
  latestThresholdPercent = serverThresholdPercent;
  if (!isThresholdDirty) {
    syncThresholdInputs(serverThresholdPercent);
    thresholdStatusEl.textContent = "Threshold applies immediately.";
  }
  if (player.position && typeof player.position.x === "number" && typeof player.position.y === "number") {
    positionStatEl.textContent = "(" + player.position.x.toFixed(2) + ", " + player.position.y.toFixed(2) + ")";
  } else {
    positionStatEl.textContent = "-";
  }

  setMeter(hpFillEl, hpTextEl, player.hp, player.maxHp);
  setMeter(mpFillEl, mpTextEl, player.mp, 100);
  setMeter(tpFillEl, tpTextEl, player.tp, 100);
  setMeter(caloriesFillEl, caloriesTextEl, player.calories, 3000);
  setMeter(weightFillEl, weightTextEl, player.weight, player.maxCarryWeight);

  renderEquipment(equipment, payload.raw?.items);
  renderCombatSkills(player.combatSkills);
  renderSpellbook(player.spellbook);
  renderRecordList(inventoryListEl, player.inventory, "Inventory empty");
  renderRecordList(storageListEl, player.storage, "Storage empty");

  if (outputRaw) {
    // items is a static catalogue of every item definition — strip it to reduce noise.
    const { items: _items, ...rawWithoutItems } = payload.raw ?? {};
    outputRaw.textContent = JSON.stringify(rawWithoutItems, null, 2);
  }

  renderWorld(payload.world, payload.upgradePlans);
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
        thresholdStatusEl.textContent = "Threshold applies immediately.";
      }
    }
  })
  .catch(() => {
    if (storedThreshold === null) {
      thresholdStatusEl.textContent = "Unable to load threshold config.";
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
