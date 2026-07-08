const tabButtons = Array.from(document.querySelectorAll<HTMLElement>("[data-tab]"));
const tabPanels = Array.from(document.querySelectorAll<HTMLElement>("[data-panel]"));
const outputRaw = document.getElementById("outputRaw");
const outputSnapshot = document.getElementById("outputSnapshot");
const snapshotTimeEl = document.getElementById("snapshotTime");
const snapshotBtnEl = document.getElementById("snapshotBtn");
const upgradePlansListEl = document.getElementById("upgradePlansList");
const toolPlansListEl = document.getElementById("toolPlansList");
const chainKeepNeedsListEl = document.getElementById("chainKeepNeedsList");
const npcsListEl = document.getElementById("npcsList");
const questsListEl = document.getElementById("questsList");
const mobsListEl = document.getElementById("mobsList");
const objectsListEl = document.getElementById("objectsList");
const storageEventsListEl = document.getElementById("storageEventsList");
const harvestEventsListEl = document.getElementById("harvestEventsList");
const combatEventsListEl = document.getElementById("combatEventsList");
const arenaEventsListEl = document.getElementById("arenaEventsList");
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
const pursueQuestsToggleEl = document.getElementById("pursueQuestsToggle") as HTMLButtonElement | null;
const pursueQuestsStateEl = document.getElementById("pursueQuestsState");
const pursueQuestsStatusEl = document.getElementById("pursueQuestsStatus");
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

const SLOT_SVG: Record<string, string> = {
  weapon: '/images/weapons/relic-blade.svg',
  offhand: '/images/gear/bordered-shield.svg',
  helm: '/images/gear/closed-barbute.svg',
  hands: '/images/gear/gloves.svg',
  legs: '/images/gear/greaves.svg',
  feet: '/images/gear/leg-armor.svg',
  chest: '/images/gear/leather-vest.svg',
  amulet: '/images/gear/gem-chain.svg',
  ring1: '/images/gear/big-diamond-ring.svg',
  ring2: '/images/gear/big-diamond-ring.svg',
};

const WEAPON_TYPE_SVG: Record<string, string> = {
  dagger: '/images/weapons/dagger.svg',
  oneHandedAxe: '/images/weapons/oneHandedAxe.svg',
  oneHandedMace: '/images/weapons/mace.svg',
  oneHandedSword: '/images/weapons/relic-blade.svg',
  bow: '/images/weapons/bow-arrow.svg',
  staff: '/images/weapons/staff.svg',
  twoHandedAxe: '/images/weapons/twoHandedAxe.svg',
  twoHandedMace: '/images/weapons/mace.svg',
  twoHandedSword: '/images/weapons/relic-blade.svg',
  fellingAxe: '/images/weapons/fellingAxe.svg',
  pickaxe: '/images/weapons/pickaxe.svg',
  handToHand: '/images/weapons/relic-blade.svg',
};

const MATERIAL_COLORS: Record<string, string> = {
  // leather
  lightLeather: '#8B6914',
  snakeSkin: '#4c7a3e',
  // metals
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
  // wood
  pinewood: '#c8a96e',
  oak: '#a0784c',
  mesquite: '#6b4226',
  hemlock: '#a0845c',
  cypress: '#6b7b3a',
  bloodwood: '#8b0000',
  rosewood: '#65000b',
  ebony: '#3b3b3b',
  // cloth
  cotton: '#f5f5dc',
  linen: '#dcc8a0',
  wool: '#b8a888',
  // other
  stone: '#808080',
  basic: '#ffffff',
};

const KNOWN_MATERIALS = Object.keys(MATERIAL_COLORS).sort((a, b) => b.length - a.length);

const extractMaterial = (itemId: string): string => {
  for (const mat of KNOWN_MATERIALS) {
    if (itemId.startsWith(mat)) return mat;
  }
  return 'basic';
};

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

const eventSubtabBtns = Array.from(document.querySelectorAll<HTMLElement>("[data-event-tab]"));
const eventSubtabPanels = Array.from(document.querySelectorAll<HTMLElement>("[data-event-panel]"));

const setActiveEventSubtab = (tabName: string) => {
  eventSubtabBtns.forEach((btn) => {
    btn.classList.toggle("active", btn.dataset["eventTab"] === tabName);
  });
  eventSubtabPanels.forEach((panel) => {
    panel.classList.toggle("active", panel.dataset["eventPanel"] === tabName);
  });
};

eventSubtabBtns.forEach((btn) => {
  btn.addEventListener("click", () => setActiveEventSubtab(btn.dataset["eventTab"] || "storage"));
});

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

pursueQuestsToggleEl?.addEventListener("click", () => {
  if (pursueQuestsToggleEl) pursueQuestsToggleEl.disabled = true;
  if (pursueQuestsStatusEl) pursueQuestsStatusEl.textContent = "Updating...";
  fetch("/config/pursue-quests", { method: "POST" })
    .then((res) => res.json())
    .then((payload) => {
      const active = Boolean(payload.pursueQuests);
      if (pursueQuestsStateEl) {
        pursueQuestsStateEl.textContent = active ? "ACTIVE" : "STOPPED";
        pursueQuestsStateEl.className = "control-state " + (active ? "status-ok" : "status-warn");
      }
      if (pursueQuestsToggleEl) {
        pursueQuestsToggleEl.textContent = active ? "Stop Questing" : "Resume Questing";
        pursueQuestsToggleEl.classList.toggle("active", !active);
      }
      if (pursueQuestsStatusEl) pursueQuestsStatusEl.textContent = active ? "Bot is pursuing quests normally." : "Bot will abandon active quests and stop accepting new ones.";
    })
    .catch((err) => {
      if (pursueQuestsStatusEl) pursueQuestsStatusEl.textContent = "Failed: " + String(err);
    })
    .finally(() => {
      if (pursueQuestsToggleEl) pursueQuestsToggleEl.disabled = false;
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

const TIER_LABELS: Record<number, string> = {
  1: "Buy now",
  2: "Craft now",
  3: "Need gold",
  4: "Obtainable",
  5: "Blocked",
};

const renderPlanItemHtml = (plan: Record<string, unknown>) => {
  const tier = typeof plan.tier === 'number' ? plan.tier : null;
  const isBlocked = typeof plan.blocked === 'boolean' ? plan.blocked : !(plan.recipeId || plan.canBuy);
  const acqParts: string[] = [];
  if (tier !== null) {
    acqParts.push(TIER_LABELS[tier] ?? `Tier ${tier}`);
  } else {
    if (plan.recipeId) acqParts.push("Craftable");
    if (plan.canBuy) acqParts.push("Buyable");
  }
  const acq = acqParts.length > 0 ? acqParts.join(" · ") : "No known acquisition path";
  const statusClass = plan.completed ? "done"
    : isBlocked ? "blocked"
      : tier === 1 ? "status-buy"
        : tier === 2 ? "status-craft"
          : tier === 3 ? "status-saving"
            : "pending";
  const statusLabel = plan.completed ? "DONE"
    : isBlocked ? "BLOCKED"
      : tier === 1 ? "BUY"
        : tier === 2 ? "CRAFT"
          : tier === 3 ? "SAVING"
            : "WAITING";
  const reqs = ((plan.requirements || []) as unknown[]).map((req) => {
    const r = req as Record<string, unknown>;
    const quantity = Number(r["quantity"]) || 0;
    const have = Number(r["have"]) || 0;
    const pct = quantity > 0 ? Math.min(100, (have / quantity) * 100) : 0;
    const done = have >= quantity;
    return (
      '<div class="req-row">' +
      '<span class="req-name">' + escapeHtml(lookupItemName(r["item"])) + '</span>' +
      '<div class="req-meter"><div class="req-fill' + (done ? " complete" : "") + '" style="width:' + pct.toFixed(1) + '%"></div></div>' +
      '<span class="req-qty">' + escapeHtml(String(have)) + " / " + escapeHtml(String(quantity)) + '</span>' +
      '</div>'
    );
  }).join("");

  const blockedByItems = Array.isArray(plan.blockedBy) ? plan.blockedBy as Array<{ itemId: string; reason: string }> : [];
  let blockedByHtml = '';
  if (isBlocked) {
    if (blockedByItems.length > 0) {
      const chips = blockedByItems.map(b =>
        '<details class="blocker-chip">' +
        '<summary title="' + escapeHtml(b.reason) + '">' + escapeHtml(lookupItemName(b.itemId)) + '</summary>' +
        '<div class="blocker-reason">' + escapeHtml(b.reason) + '</div>' +
        '</details>'
      ).join('');
      blockedByHtml = '<div class="blocked-by">Needs: ' + chips + '</div>';
    } else {
      blockedByHtml = '<div class="blocked-by blocked-by-unknown">No recipe, not sold at any merchant</div>';
    }
  }

  const craftingStep = typeof plan.craftingStep === 'string' ? plan.craftingStep : null;
  const extraClasses = (plan.completed ? " completed" : "") + (plan.isNextCraft ? " next-craft" : "");
  return (
    '<div class="upgrade-entry' + extraClasses + '">' +
    '<div class="upgrade-header">' +
    '<span class="upgrade-priority">#' + escapeHtml(String(plan.priority)) + '</span>' +
    (plan.isNextCraft
      ? '<span class="next-craft-badge">' + (craftingStep ? "CRAFTING " + escapeHtml(lookupItemName(craftingStep)) : "NEXT") + '</span>'
      : '') +
    '<span class="upgrade-name">' + escapeHtml(plan.name || lookupItemName(plan.targetItem)) + '</span>' +
    '<span class="upgrade-badge">' + escapeHtml(plan.slot || "") + '</span>' +
    '<span class="upgrade-status ' + statusClass + '">' + statusLabel + '</span>' +
    '</div>' +
    '<div class="upgrade-acq">' + escapeHtml(acq) + '</div>' +
    blockedByHtml +
    (reqs ? '<div class="upgrade-reqs">' + reqs + '</div>' : '') +
    '</div>'
  );
};

const renderPlanList = (containerEl: HTMLElement | null, plans: unknown, emptyText: string) => {
  if (!containerEl) return;
  const items = Array.isArray(plans) ? [...plans] : [];
  if (items.length === 0) {
    containerEl.innerHTML = '<div class="list-row"><span class="list-title" style="opacity:0.5;">' + escapeHtml(emptyText) + '</span></div>';
    return;
  }
  items.sort((a, b) => {
    if (a.completed !== b.completed) return a.completed ? 1 : -1;
    return (a.priority || 0) - (b.priority || 0);
  });
  containerEl.innerHTML = items.map(renderPlanItemHtml).join("");
};

const renderUpgradePlans = (plans: unknown) => {
  renderPlanList(upgradePlansListEl, plans, 'No upgrade plans — bot will populate this when it has targets.');
};

const renderToolPlans = (plans: unknown) => {
  renderPlanList(toolPlansListEl, plans, 'All tools acquired — upgrade plans will show when the bot identifies missing tools.');
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

interface NpcQuestStepGather {
  type: "gather";
  targets: Record<string, number>;
}
interface NpcQuestStepKill {
  type: "kill";
  targets: Record<string, number>;
}
interface NpcQuestStepTurnIn {
  type: "turn_in";
  requiredItems?: Record<string, number>;
}
type NpcQuestStep = NpcQuestStepGather | NpcQuestStepKill | NpcQuestStepTurnIn | { type: string };

interface AvailableQuest {
  id: string;
  name: string;
  repeatable: boolean;
  steps: NpcQuestStep[];
  rewards: { items: Record<string, number> };
}

interface WorldNpc {
  name?: string;
  id: string;
  availableQuests: Record<string, AvailableQuest>;
}

type ActiveQuestStep = {
  type?: string;
  targets?: Record<string, { required?: number; killed?: number }>;
  requiredItems?: Record<string, number>;
  position?: { x?: number; y?: number };
  completed?: boolean;
  target?: string;
};

type ActiveQuestData = {
  id?: string;
  name?: string;
  start_npc?: string;
  end_npc?: string;
  steps?: ActiveQuestStep[];
  rewards?: {
    items?: Record<string, number>;
  };
};

const renderActiveQuests = (
  rawQuests: Record<string, ActiveQuestData> | null | undefined,
  questRewards: Record<string, { items: Record<string, number> }>,
): string => {
  if (!rawQuests || Object.keys(rawQuests).length === 0) {
    return '';
  }
  const html = Object.values(rawQuests).map((quest) => {
    const steps = quest.steps || [];
    const killProgress: string[] = [];
    const turnInItems: Record<string, number> = {};
    for (const step of steps) {
      if (step.type === 'kill' && step.targets) {
        for (const [monster, info] of Object.entries(step.targets)) {
          const req = typeof info === 'object' && info !== null ? (info.required ?? 0) : 0;
          const killed = typeof info === 'object' && info !== null ? (info.killed ?? 0) : 0;
          killProgress.push(escapeHtml(formatItemName(monster)) + ' <span class="quest-req-count">' + String(killed) + '/' + String(req) + '</span>');
        }
      }
      if (step.type === 'turn_in' && step.requiredItems) {
        for (const [item, count] of Object.entries(step.requiredItems)) {
          if (typeof count === 'number') turnInItems[item] = count;
        }
      }
    }
    const turnInHtml = Object.keys(turnInItems).length > 0
      ? '<div class="quest-reqs">Turn in: ' + Object.entries(turnInItems).map(([item, count]) =>
        '<span class="quest-req-item">' + escapeHtml(lookupItemName(item)) + ' <span class="quest-req-count">×' + escapeHtml(String(count)) + '</span></span>'
      ).join('') + '</div>'
      : '';
    const rewards = questRewards[quest.id || '']?.items || {};
    const rewardsHtml = Object.keys(rewards).length > 0
      ? '<div class="quest-rewards">Rewards: ' + Object.entries(rewards).map(([item, count]) =>
        '<span class="quest-reward-item">' + escapeHtml(lookupItemName(item)) + ' <span class="quest-reward-count">×' + escapeHtml(String(count)) + '</span></span>'
      ).join('') + '</div>'
      : '';
    return (
      '<div class="list-row quest-entry quest-active">' +
      '<div style="flex:1">' +
      '<div class="list-title">' + escapeHtml(quest.name || formatItemName(quest.id || '')) + ' <span class="quest-active-badge">ACTIVE</span></div>' +
      '<div class="list-meta">Turn in at: ' + escapeHtml(quest.end_npc || '?') + '</div>' +
      (killProgress.length > 0 ? '<div class="quest-kills">' + killProgress.join(', ') + '</div>' : '') +
      turnInHtml +
      rewardsHtml +
      '</div>' +
      '</div>'
    );
  }).join("");
  return '<div class="quest-section-header">Active Quests</div>' + html;
};

const renderQuests = (npcs: WorldNpc[] | null | undefined, activeHtml: string) => {
  if (!questsListEl) return;
  const availableHtml = (() => {
    if (!npcs || npcs.length === 0) {
      return '';
    }
    const questRows: Array<{ npcName: string; quest: AvailableQuest }> = [];
    for (const npc of npcs) {
      const aq = npc.availableQuests || {};
      const npcName = formatItemName(npc.name || npc.id);
      for (const questId of Object.keys(aq)) {
        questRows.push({ npcName, quest: aq[questId] });
      }
    }
    if (questRows.length === 0) return '';
    return questRows.map(({ npcName, quest }) => {
      const gatherReqs: Record<string, number> = {};
      const killReqs: Record<string, number> = {};
      let turnInItems: Record<string, number> = {};
      const steps: NpcQuestStep[] = quest.steps || [];
      for (const step of steps) {
        if (step.type === 'gather' && 'targets' in step) {
          for (const [item, count] of Object.entries(step.targets)) {
            if (typeof count === 'number') gatherReqs[item] = (gatherReqs[item] || 0) + count;
          }
        }
        if (step.type === 'kill' && 'targets' in step) {
          for (const [monster, count] of Object.entries(step.targets)) {
            if (typeof count === 'number') killReqs[monster] = (killReqs[monster] || 0) + count;
          }
        }
        if (step.type === 'turn_in' && 'requiredItems' in step && step.requiredItems) {
          for (const [item, count] of Object.entries(step.requiredItems)) {
            if (typeof count === 'number') turnInItems[item] = (turnInItems[item] || 0) + count;
          }
        }
      }
      const allReqs = { ...gatherReqs };
      for (const [item, count] of Object.entries(turnInItems)) {
        if (count) allReqs[item] = (allReqs[item] || 0) + count;
      }
      const rewards = quest.rewards?.items || {};
      const reqsHtml = Object.keys(allReqs).length > 0
        ? '<div class="quest-reqs">' + Object.entries(allReqs).map(([item, count]) =>
          '<span class="quest-req-item">' + escapeHtml(lookupItemName(item)) + ' <span class="quest-req-count">×' + escapeHtml(String(count)) + '</span></span>'
        ).join('') + '</div>'
        : '';
      const killHtml = Object.keys(killReqs).length > 0
        ? '<div class="quest-kills">' + Object.entries(killReqs).map(([monster, count]) =>
          '<span class="quest-kill-item">Kill ' + escapeHtml(formatItemName(monster)) + ' <span class="quest-req-count">×' + escapeHtml(String(count)) + '</span></span>'
        ).join('') + '</div>'
        : '';
      const rewardsHtml = Object.keys(rewards).length > 0
        ? '<div class="quest-rewards">Rewards: ' + Object.entries(rewards).map(([item, count]) =>
          '<span class="quest-reward-item">' + escapeHtml(lookupItemName(item)) + ' <span class="quest-reward-count">×' + escapeHtml(String(count)) + '</span></span>'
        ).join('') + '</div>'
        : '';
      return (
        '<div class="list-row quest-entry">' +
        '<div style="flex:1">' +
        '<div class="list-title">' + escapeHtml(quest.name || formatItemName(quest.id)) + '</div>' +
        '<div class="list-meta">' + escapeHtml(npcName) + (quest.repeatable ? ' · Repeatable' : '') + '</div>' +
        reqsHtml +
        killHtml +
        rewardsHtml +
        '</div>' +
        '</div>'
      );
    }).join("");
  })();
  if (!npcs || npcs.length === 0) {
    if (!activeHtml) {
      questsListEl.innerHTML = '<div class="list-row"><span class="list-title" style="opacity:0.5;">No NPCs nearby.</span></div>';
      return;
    }
    questsListEl.innerHTML = activeHtml;
    return;
  }
  const sep = activeHtml && availableHtml ? '<div class="quest-section-header" style="margin-top:12px;">Available Quests</div>' : '';
  questsListEl.innerHTML = activeHtml + sep + (availableHtml || '<div class="list-row"><span class="list-title" style="opacity:0.5;">None of the nearby NPCs offer quests.</span></div>');
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

const renderWorld = (world: unknown, upgradePlans: unknown, toolPlans: unknown, rawQuests: Record<string, ActiveQuestData> | null | undefined, questRewards: Record<string, { items: Record<string, number> }>) => {
  const w = (world || {}) as Record<string, unknown>;
  renderUpgradePlans(upgradePlans);
  renderToolPlans(toolPlans);
  renderNpcs(w["npcs"] as unknown[] | null);
  const activeHtml = renderActiveQuests(rawQuests, questRewards);
  renderQuests(w["npcs"] as WorldNpc[] | null, activeHtml);
  renderMobs(w["mobs"] as unknown[] | null);
  renderObjects(w["objects"] as unknown[] | null);
};

const compareKeys = (left: string, right: string) => left.localeCompare(right);

type EquipmentItemInfo = {
  name?: string;
  type?: string;
  weight?: number;
  buyFromVendorPrice?: number;
  sellToVendorPrice?: number;
  damage?: number;
  attacksPerSecond?: number;
  stats?: Record<string, number>;
};

const STAT_LABELS: Record<string, string> = {
  defense: "Defense",
  attack: "Attack",
  maxHp: "Max HP",
  maxMp: "Max MP",
  maxTp: "Max TP",
  movementSpeed: "Move Speed",
  mpRegen: "MP Regen",
  sightRange: "Sight Range",
  radius: "Radius",
};

const renderEquipment = (equipment: unknown, equipmentItems: unknown) => {
  if (!equipmentGridEl) return;
  const eq = (equipment || {}) as Record<string, string | null>;
  const catalog = (equipmentItems || {}) as Record<string, EquipmentItemInfo>;
  const slots = ["weapon", "ring1", "helm", "ring2", "offhand", "chest", "amulet", "hands", "legs", "feet"];
  equipmentGridEl.innerHTML = slots.map((key) => {
    const slot = equipmentSlots.find((s) => s.key === key);
    const itemId = eq[key] || null;
    const itemData = itemId ? catalog[itemId] : null;
    const lines = [slot?.label || key];
    if (itemId) {
      lines.push(lookupItemName(itemId));
      if (itemData) {
        if (typeof itemData.damage === "number" && typeof itemData.attacksPerSecond === "number") {
          lines.push("Damage: " + itemData.damage);
          lines.push("Attacks/Sec: " + itemData.attacksPerSecond);
          lines.push("DPS: " + (itemData.damage * itemData.attacksPerSecond).toFixed(2));
        }
        if (itemData.stats) {
          Object.entries(itemData.stats)
            .filter(([, v]) => typeof v === "number" && v !== 0)
            .forEach(([k, v]) => lines.push((STAT_LABELS[k] || formatItemName(k)) + ": " + v));
        }
        if (typeof itemData.weight === "number") {
          lines.push("Weight: " + itemData.weight);
        }
      }
    } else {
      lines.push("Empty");
    }
    const tooltip = lines.join("\n");

    let iconHtml = "";
    if (itemId) {
      const svgUrl = key === "weapon"
        ? WEAPON_TYPE_SVG[itemData?.type as string] || SLOT_SVG[key]
        : SLOT_SVG[key];
      if (svgUrl) {
        const material = extractMaterial(itemId);
        const color = MATERIAL_COLORS[material] || '#ffffff';
        iconHtml = '<div class="equipped-icon" style="--icon-src: url(' + svgUrl + '); background-color: ' + color + ';"></div>';
      } else {
        iconHtml = escapeHtml(slot?.icon || "");
      }
    }

    const slotHtml = (
      '<div class="slot-item eq-' + key + '" title="' + escapeHtml(tooltip) + '">' +
      '<div class="slot-icon">' + iconHtml + '</div>' +
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

// The server sends the raw heartbeat (`payload.raw`) once, unduplicated —
// player/unit-count/world are all derived from it here instead of the server
// reconstructing and re-sending the same data as separate top-level fields.
const derivePlayerFromRaw = (raw: any): Record<string, unknown> => {
  const rawPlayer = raw?.player || {};
  const stats = rawPlayer.stats || {};
  return {
    name: typeof rawPlayer.name === "string" ? rawPlayer.name : null,
    hp: typeof rawPlayer.hp === "number" ? rawPlayer.hp : null,
    maxHp: typeof stats.maxHp === "number" ? stats.maxHp : null,
    mp: typeof rawPlayer.mp === "number" ? rawPlayer.mp : null,
    tp: typeof rawPlayer.tp === "number" ? rawPlayer.tp : null,
    calories: typeof rawPlayer.calories === "number" ? rawPlayer.calories : null,
    attack: typeof stats.attack === "number" ? stats.attack : null,
    defense: typeof stats.defense === "number" ? stats.defense : null,
    movementSpeed: typeof stats.movementSpeed === "number" ? stats.movementSpeed : null,
    position: rawPlayer.position || null,
    equipment: rawPlayer.equipment || {},
    combatSkills: rawPlayer.combatSkills || {},
    spellbook: Array.isArray(rawPlayer.spellbook) ? rawPlayer.spellbook : [],
    inventory: rawPlayer.inventory || {},
    storage: rawPlayer.storage || {},
  };
};

const deriveWorldFromRaw = (raw: any): { npcs: unknown[]; mobs: unknown[]; objects: unknown[] } => {
  const units: unknown[] = Object.values(raw?.units || {});
  return {
    npcs: units.filter((u: any) => u?.type === "npc"),
    mobs: units.filter((u: any) => u?.type === "monster"),
    objects: Object.values(raw?.gameObjects || {}),
  };
};

const render = (payload: any) => {
  const player = derivePlayerFromRaw(payload.raw) as any;
  const world = deriveWorldFromRaw(payload.raw);
  const bot = payload.bot || {};
  const equipment = player.equipment || {};
  const unitCount = Object.keys(payload.raw?.units || {}).length;

  if (receivedAtEl) receivedAtEl.textContent = payload.receivedAt || "-";
  if (unitCountEl) unitCountEl.textContent = String(unitCount);
  if (monsterCountEl) monsterCountEl.textContent = String(world.mobs.length);
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
  const pursueQuestsActive = bot.pursueQuests !== false;
  if (pursueQuestsStateEl) {
    pursueQuestsStateEl.textContent = pursueQuestsActive ? "ACTIVE" : "STOPPED";
    pursueQuestsStateEl.className = "control-state " + (pursueQuestsActive ? "status-ok" : "status-warn");
  }
  if (pursueQuestsToggleEl) {
    pursueQuestsToggleEl.textContent = pursueQuestsActive ? "Stop Questing" : "Resume Questing";
    pursueQuestsToggleEl.classList.toggle("active", !pursueQuestsActive);
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
  setMeter(weightFillEl, weightTextEl, payload.weight, payload.maxCarryWeight);

  if (carryWeightEl) {
    if (typeof payload.weight === "number" && typeof payload.maxCarryWeight === "number" && payload.maxCarryWeight > 0) {
      const pct = (payload.weight / payload.maxCarryWeight) * 100;
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
  renderEquipment(equipment, payload.equipmentItems);
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
    outputRaw.textContent = JSON.stringify(payload.raw ?? {}, null, 2);
  }

  renderWorld(world, payload.upgradePlans, payload.toolPlans, (payload.raw?.player as Record<string, unknown> | undefined)?.quests as Record<string, ActiveQuestData> | undefined, payload.questRewards || {});
  renderRecordList(chainKeepNeedsListEl, payload.chainKeepNeeds, "No chain keep needs computed yet.");

  // ── Events ──────────────────────────────────────────────────────────────────
  // Each category arrives from the server as its own buffer. renderEvents() just
  // renders each into its subtab. To add a new category: add a subtab in
  // dashboard.html (see comment there), then add a renderEventList() call below.
  type RawEvent = { ts: string; name: string; data: unknown };
  const renderEvents = (
    storageEvents: RawEvent[],
    harvestEvents: RawEvent[],
    combatEvents: RawEvent[],
    arenaEvents: RawEvent[],
  ) => {
    const renderEventList = (containerEl: HTMLElement | null, events: RawEvent[], emptyText: string) => {
      if (!containerEl) return;
      if (events.length === 0) {
        containerEl.innerHTML = '<div class="list-row"><span class="list-title" style="opacity:0.5;">' + escapeHtml(emptyText) + '</span></div>';
        return;
      }
      containerEl.innerHTML = events.toReversed().map((evt) => {
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
    };

    renderEventList(storageEventsListEl, storageEvents, "No storage events yet.");
    renderEventList(harvestEventsListEl, harvestEvents, "No harvest events yet.");
    renderEventList(combatEventsListEl, combatEvents, "No combat events yet.");
    renderEventList(arenaEventsListEl, arenaEvents, "No arena events yet.");
  };

  renderEvents(
    payload.storageEvents ?? [],
    payload.harvestEvents ?? [],
    payload.combatEvents ?? [],
    payload.arenaEvents ?? [],
  );
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

// Polling instead of SSE: Node's plain GET/response handling copes with this
// payload size far better than a long-lived chunked stream does — each poll
// is a bounded, complete response instead of an ever-open write target that
// can fall behind a slow-draining client.
const POLL_INTERVAL_MS = 1000;

// On the first snapshot after page load or after a server restart, push any
// saved threshold from localStorage to the server. By the time the first
// poll succeeds the server is definitely up, so there is no race.
let pendingThresholdSync = localStorage.getItem(THRESHOLD_LS_KEY) !== null;

// Guards against a slow/recovering server piling up multiple overlapping
// requests — skip starting a new poll while one is still in flight rather
// than queuing more on top of it.
let pollInFlight = false;

// A slow-but-not-erroring response (server up but sluggish) would otherwise
// sit pending indefinitely without ever hitting .catch() — abort and treat
// it as a failure so it counts as "disconnected" and releases pollInFlight.
const POLL_TIMEOUT_MS = 5_000;

const pollState = () => {
  if (pollInFlight) return;
  pollInFlight = true;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), POLL_TIMEOUT_MS);
  fetch("/state", { signal: controller.signal })
    .then((res) => {
      if (!res.ok) throw new Error("Bad response: " + res.status);
      return res.json();
    })
    .then((payload) => {
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
    })
    .catch((err) => {
      pendingThresholdSync = localStorage.getItem(THRESHOLD_LS_KEY) !== null;
      showConnectionBanner("Connection lost — retrying...");
      console.error("Dashboard poll failed:", err);
    })
    .finally(() => {
      clearTimeout(timeoutId);
      pollInFlight = false;
    });
};

pollState();
setInterval(pollState, POLL_INTERVAL_MS);
