/**
 * Study Assist - Popup Script
 * Handles all popup UI interactions and settings management
 */

// ============================================
// Internationalization (i18n)
// ============================================
function applyTranslations() {
  // Translate elements with data-i18n attribute (textContent)
  document.querySelectorAll("[data-i18n]").forEach((element) => {
    const key = element.getAttribute("data-i18n");
    const message = chrome.i18n.getMessage(key);
    if (message) {
      element.textContent = message;
    }
  });

  // Translate elements with data-i18n-placeholder attribute
  document.querySelectorAll("[data-i18n-placeholder]").forEach((element) => {
    const key = element.getAttribute("data-i18n-placeholder");
    const message = chrome.i18n.getMessage(key);
    if (message) {
      element.placeholder = message;
    }
  });

  // Translate elements with data-i18n-title attribute
  document.querySelectorAll("[data-i18n-title]").forEach((element) => {
    const key = element.getAttribute("data-i18n-title");
    const message = chrome.i18n.getMessage(key);
    if (message) {
      element.title = message;
    }
  });
}

// Apply translations on load
document.addEventListener("DOMContentLoaded", applyTranslations);

// ============================================
// DOM Elements
// ============================================
const elements = {
  extensionToggle: document.getElementById("extension-toggle"),
  statusText: document.getElementById("status-text"),
  analyzePage: document.getElementById("analyze-page"),
  responseMode: document.getElementById("response-mode"),
  autoDetect: document.getElementById("auto-detect"),
  highlightQuestions: document.getElementById("highlight-questions"),
  quickMode: document.getElementById("quick-mode"),
  // Roles
  primaryProvider: document.getElementById("primary-provider"),
  primaryModel: document.getElementById("primary-model"),
  primaryModelManual: document.getElementById("primary-model-manual"),
  primaryWarning: document.getElementById("primary-warning"),
  validatorProvider: document.getElementById("validator-provider"),
  validatorModel: document.getElementById("validator-model"),
  validatorModelManual: document.getElementById("validator-model-manual"),
  openProviders: document.getElementById("open-providers"),
  rolesStatus: document.getElementById("roles-status"),
  // Domain management
  domainsList: document.getElementById("domains-list"),
  newDomainInput: document.getElementById("new-domain-input"),
  addDomainBtn: document.getElementById("add-domain-btn"),
  // Image option
  sendImages: document.getElementById("send-images"),
  useMultiBank: document.getElementById("use-multibank"),
  // Disguise mode
  disguiseMode: document.getElementById("disguise-mode"),
  // New elements
  openDashboard: document.getElementById("open-dashboard"),
  recentHistory: document.getElementById("recent-history"),
  todayRequests: document.getElementById("today-requests"),
  todayTokens: document.getElementById("today-tokens"),
  todayCost: document.getElementById("today-cost"),
};

// ============================================
// Storage Keys
// ============================================
const STORAGE_KEYS = {
  EXTENSION_ACTIVE: "extensionActive",
  RESPONSE_MODE: "responseMode",
  AUTO_DETECT: "autoDetect",
  HIGHLIGHT_QUESTIONS: "highlightQuestions",
  QUICK_MODE: "quickMode",
  ALLOWED_DOMAINS: "allowedDomains",
  SEND_IMAGES: "sendImages",
  USE_MULTI_BANK: "useMultiBank",
  DISGUISE_MODE: "disguiseMode",
};

// Default allowed domains (empty for public release - users add their own)
const DEFAULT_DOMAINS = [];

// ============================================
// Initialize Popup
// ============================================
async function initializePopup() {
  await loadSettings();
  setupEventListeners();
  await updateUIState();
  await loadRecentHistory();
  await loadTodayStats();
  checkStorageWarning();
}

// ============================================
// Load Settings from Storage
// ============================================
async function loadSettings() {
  try {
    const result = await chrome.storage.local.get([
      STORAGE_KEYS.EXTENSION_ACTIVE,
      STORAGE_KEYS.RESPONSE_MODE,
      STORAGE_KEYS.AUTO_DETECT,
      STORAGE_KEYS.HIGHLIGHT_QUESTIONS,
      STORAGE_KEYS.QUICK_MODE,
      STORAGE_KEYS.ALLOWED_DOMAINS,
      STORAGE_KEYS.SEND_IMAGES,
      STORAGE_KEYS.USE_MULTI_BANK,
      STORAGE_KEYS.DISGUISE_MODE,
    ]);

    // Set toggle state
    elements.extensionToggle.checked =
      result[STORAGE_KEYS.EXTENSION_ACTIVE] ?? false;

    // Set response mode
    elements.responseMode.value =
      result[STORAGE_KEYS.RESPONSE_MODE] ?? "guided";

    // Set checkboxes
    elements.autoDetect.checked = result[STORAGE_KEYS.AUTO_DETECT] ?? true;
    elements.highlightQuestions.checked =
      result[STORAGE_KEYS.HIGHLIGHT_QUESTIONS] ?? true;
    elements.quickMode.checked = result[STORAGE_KEYS.QUICK_MODE] ?? false;

    // Set send images checkbox (default: false)
    elements.sendImages.checked = result[STORAGE_KEYS.SEND_IMAGES] ?? false;
    elements.useMultiBank.checked = result[STORAGE_KEYS.USE_MULTI_BANK] ?? true;

    // Load domains list
    const domains = result[STORAGE_KEYS.ALLOWED_DOMAINS] ?? DEFAULT_DOMAINS;
    renderDomainsList(domains);

    // Disguise mode
    elements.disguiseMode.checked = result[STORAGE_KEYS.DISGUISE_MODE] ?? false;

    // Roles + providers
    await loadProviderState();
  } catch (error) {
    console.error("Error loading settings:", error);
  }
}

// ============================================
// Setup Event Listeners
// ============================================
function setupEventListeners() {
  // Extension toggle
  elements.extensionToggle.addEventListener("change", handleToggleChange);

  // Action buttons
  elements.analyzePage.addEventListener("click", analyzePage);

  // Settings changes
  elements.responseMode.addEventListener("change", saveSettings);
  elements.autoDetect.addEventListener("change", saveSettings);
  elements.highlightQuestions.addEventListener("change", saveSettings);
  elements.quickMode.addEventListener("change", saveSettings);
  elements.sendImages.addEventListener("change", saveSettings);
  elements.useMultiBank.addEventListener("change", saveSettings);
  elements.disguiseMode.addEventListener("change", handleDisguiseModeToggle);

  // Roles
  elements.primaryProvider.addEventListener("change", () => onRoleChange("primary"));
  elements.primaryModel.addEventListener("change", () => onRoleModelChange("primary"));
  elements.primaryModelManual.addEventListener("change", () => onRoleModelChange("primary"));
  elements.validatorProvider.addEventListener("change", () => onRoleChange("validator"));
  elements.validatorModel.addEventListener("change", () => onRoleModelChange("validator"));
  elements.validatorModelManual.addEventListener("change", () => onRoleModelChange("validator"));
  if (elements.openProviders) {
    elements.openProviders.addEventListener("click", openProviders);
  }

  // Dashboard button
  if (elements.openDashboard) {
    elements.openDashboard.addEventListener("click", openDashboard);
  }

  // Domain management
  elements.addDomainBtn.addEventListener("click", addDomain);
  elements.newDomainInput.addEventListener("keypress", (e) => {
    if (e.key === "Enter") addDomain();
  });
}

// ============================================
// Handle Extension Toggle
// ============================================
async function handleToggleChange() {
  const isActive = elements.extensionToggle.checked;

  try {
    // Save state to storage
    await chrome.storage.local.set({
      [STORAGE_KEYS.EXTENSION_ACTIVE]: isActive,
    });

    // Update UI
    await updateUIState();

    // Notify background script
    await chrome.runtime.sendMessage({
      type: "TOGGLE_EXTENSION",
      active: isActive,
    });

    // Notify content script in active tab
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (tab?.id) {
      try {
        await chrome.tabs.sendMessage(tab.id, {
          type: "EXTENSION_STATE_CHANGED",
          active: isActive,
        });
      } catch (e) {
        // Content script might not be loaded on this page
        console.log("Could not reach content script");
      }
    }
  } catch (error) {
    console.error("Error toggling extension:", error);
  }
}

// ============================================
// Update UI State
// ============================================
async function updateUIState() {
  const isActive = elements.extensionToggle.checked;
  const hasApiKey = !!(PROVIDER_STATE.roles && PROVIDER_STATE.roles.primary);

  // Check if disguise mode is enabled
  const result = await chrome.storage.local.get([STORAGE_KEYS.DISGUISE_MODE]);
  const isDisguised = result[STORAGE_KEYS.DISGUISE_MODE] ?? false;

  // Update status text with i18n (only show when NOT disguised)
  if (!isDisguised) {
    const statusKey = isActive ? "statusOn" : "statusOff";
    const statusMessage = chrome.i18n.getMessage(statusKey);
    elements.statusText.textContent =
      statusMessage || (isActive ? "ACTIVADO" : "DESACTIVADO");
    elements.statusText.className = `status-text ${isActive ? "status-on" : "status-off"}`;
  } else {
    // When disguised, hide the status text
    elements.statusText.textContent = "";
    elements.statusText.className = "status-text";
  }

  // Enable/disable analyze button
  elements.analyzePage.disabled = !isActive || !hasApiKey;
}

// ============================================
// Roles (primary / validator)
// ============================================
let PROVIDER_STATE = {
  presets: [],
  profiles: [],
  roles: { primary: null, validator: null },
};

function t(key, fallback) {
  return chrome.i18n.getMessage(key) || fallback || key;
}

async function loadProviderState() {
  const res = await chrome.runtime
    .sendMessage({ type: "GET_PROVIDER_STATE" })
    .catch(() => null);
  if (!res || !res.success || !res.state) return;
  PROVIDER_STATE = res.state;
  renderRoleSelectors();
}

function configuredProviders() {
  return PROVIDER_STATE.profiles.filter((p) => p.hasKey);
}

function providerLabelOf(id) {
  const preset = PROVIDER_STATE.presets.find((p) => p.id === id);
  return preset ? preset.label : id;
}

function modelsForProvider(providerId) {
  const profile = PROVIDER_STATE.profiles.find((p) => p.id === providerId);
  const assigned = [];
  for (const role of [PROVIDER_STATE.roles.primary, PROVIDER_STATE.roles.validator]) {
    if (role && role.provider === providerId && role.model) assigned.push(role.model);
  }
  if (!profile) return [...new Set(assigned)];

  // Only models explicitly selected in the Providers page are offered, plus
  // the model already assigned to a role (so it is never silently dropped).
  const selected =
    profile.selectedModels ??
    [...(profile.models || []), ...(profile.customModels || [])];
  return [...new Set([...selected, ...assigned])];
}

function setOptions(select, options, selectedValue) {
  select.innerHTML = "";
  for (const opt of options) {
    const o = document.createElement("option");
    o.value = opt.value;
    o.textContent = opt.label;
    select.appendChild(o);
  }
  if (selectedValue != null) select.value = selectedValue;
}

function roleEls(role) {
  return role === "primary"
    ? {
        provider: elements.primaryProvider,
        model: elements.primaryModel,
        manual: elements.primaryModelManual,
      }
    : {
        provider: elements.validatorProvider,
        model: elements.validatorModel,
        manual: elements.validatorModelManual,
      };
}

function renderRoleSelectors() {
  const providers = configuredProviders();
  const providerOptions = providers.map((p) => ({
    value: p.id,
    label: providerLabelOf(p.id),
  }));

  const primaryRole = PROVIDER_STATE.roles.primary;
  setOptions(
    elements.primaryProvider,
    providerOptions,
    primaryRole ? primaryRole.provider : providerOptions[0]?.value,
  );
  renderModels("primary");

  const validatorRole = PROVIDER_STATE.roles.validator;
  setOptions(
    elements.validatorProvider,
    [{ value: "", label: t("noneOption", "None") }, ...providerOptions],
    validatorRole ? validatorRole.provider : "",
  );
  renderModels("validator");

  if (providers.length === 0) {
    showRolesStatus(t("noProviderConfigured", "Configure a provider first."), "error");
  } else {
    showRolesStatus("", "");
  }
}

function renderModels(role) {
  const els = roleEls(role);
  const providerId = els.provider.value;

  if (!providerId) {
    setOptions(els.model, [], "");
    els.model.style.display = "none";
    els.manual.style.display = "none";
    if (role === "primary") elements.primaryWarning.style.display = "none";
    return;
  }

  els.model.style.display = "";
  const assigned = PROVIDER_STATE.roles[role];
  const assignedModel =
    assigned && assigned.provider === providerId ? assigned.model : "";
  const models = modelsForProvider(providerId);
  const options = [
    ...models.map((m) => ({ value: m, label: m })),
    { value: "__other__", label: t("otherOption", "Other...") },
  ];
  const selected = models.includes(assignedModel)
    ? assignedModel
    : assignedModel
      ? "__other__"
      : models[0] || "__other__";
  setOptions(els.model, options, selected);

  const isOther = els.model.value === "__other__";
  els.manual.style.display = isOther ? "" : "none";
  if (isOther) els.manual.value = assignedModel || "";

  if (role === "primary") {
    updatePrimaryWarning(providerId, isOther ? els.manual.value : els.model.value);
  }
}

function updatePrimaryWarning(providerId, model) {
  const profile = PROVIDER_STATE.profiles.find((p) => p.id === providerId);
  const vision =
    profile && model ? (profile.visionModels || []).includes(model) : false;
  if (!profile || !model || vision) {
    elements.primaryWarning.style.display = "none";
    return;
  }
  elements.primaryWarning.textContent = t(
    "providerVisionWarning",
    "This model cannot handle image questions.",
  );
  elements.primaryWarning.style.display = "block";
}

function readRole(role) {
  const els = roleEls(role);
  const providerId = els.provider.value;
  if (!providerId) return null;
  let model = els.model.value;
  if (model === "__other__") model = els.manual.value.trim();
  if (!model) return null;
  return { provider: providerId, model };
}

async function persistRoles() {
  const roles = { primary: readRole("primary"), validator: readRole("validator") };
  const res = await chrome.runtime
    .sendMessage({ type: "SAVE_ROLES", roles })
    .catch(() => null);
  if (res && res.success) {
    PROVIDER_STATE.roles = roles;
    await updateUIState();
    showRolesStatus(t("rolesSaved", "Saved."), "success");
  } else {
    showRolesStatus((res && res.error) || t("providerError", "Could not save."), "error");
  }
}

async function onRoleChange(role) {
  renderModels(role);
  await persistRoles();
}

async function onRoleModelChange(role) {
  const els = roleEls(role);
  els.manual.style.display = els.model.value === "__other__" ? "" : "none";
  await persistRoles();
}

function showRolesStatus(message, type) {
  elements.rolesStatus.textContent = message || "";
  elements.rolesStatus.className = "api-status" + (type ? " " + type : "");
}

function openProviders() {
  chrome.tabs.create({ url: chrome.runtime.getURL("popup/providers.html") });
}

// ============================================
// Disguise mode
// ============================================
async function handleDisguiseModeToggle() {
  const isEnabled = elements.disguiseMode.checked;

  // Save setting
  await chrome.storage.local.set({
    [STORAGE_KEYS.DISGUISE_MODE]: isEnabled,
  });

  // Update UI to show/hide status text
  await updateUIState();

  // Notify background to change icon and tooltip
  try {
    await chrome.runtime.sendMessage({
      type: "TOGGLE_DISGUISE_MODE",
      enabled: isEnabled,
    });
  } catch (error) {
    console.error("[Study Assist] Disguise mode error:", error);
  }
}

// ============================================
// Save Settings
// ============================================
async function saveSettings() {
  try {
    const settingsData = {
      [STORAGE_KEYS.RESPONSE_MODE]: elements.responseMode.value,
      [STORAGE_KEYS.AUTO_DETECT]: elements.autoDetect.checked,
      [STORAGE_KEYS.HIGHLIGHT_QUESTIONS]: elements.highlightQuestions.checked,
      [STORAGE_KEYS.QUICK_MODE]: elements.quickMode.checked,
      [STORAGE_KEYS.SEND_IMAGES]: elements.sendImages.checked,
      [STORAGE_KEYS.USE_MULTI_BANK]: elements.useMultiBank.checked,
    };

    await chrome.storage.local.set(settingsData);

    // Notify content script of settings change
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (tab?.id) {
      try {
        await chrome.tabs.sendMessage(tab.id, {
          type: "SETTINGS_CHANGED",
          settings: {
            responseMode: elements.responseMode.value,
            autoDetect: elements.autoDetect.checked,
            highlightQuestions: elements.highlightQuestions.checked,
            quickMode: elements.quickMode.checked,
            sendImages: elements.sendImages.checked,
          },
        });
      } catch (e) {
        console.log("Could not reach content script");
      }
    }
  } catch (error) {
    console.error("Error saving settings:", error);
  }
}

// ============================================
// Analyze Page
// ============================================
async function analyzePage() {
  try {
    elements.analyzePage.disabled = true;
    elements.analyzePage.textContent = "⏳ Analizando...";

    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });

    if (tab?.id) {
      await chrome.tabs.sendMessage(tab.id, {
        type: "ANALYZE_PAGE",
      });
    }
  } catch (error) {
    console.error("Error analyzing page:", error);
    alert(
      "No se pudo analizar esta página. Asegúrate de estar en una página web normal.",
    );
  } finally {
    elements.analyzePage.disabled = false;
    elements.analyzePage.textContent = "🔍 Analizar Página Actual";
  }
}

// ============================================
// Domain Management
// ============================================
function renderDomainsList(domains) {
  elements.domainsList.innerHTML = "";

  domains.forEach((domain, index) => {
    const domainItem = document.createElement("div");
    domainItem.className = "domain-item";
    domainItem.innerHTML = `
      <span class="domain-text">${domain}</span>
      <button class="domain-remove-btn" data-index="${index}" title="Eliminar dominio">✕</button>
    `;
    elements.domainsList.appendChild(domainItem);
  });

  // Add event listeners to remove buttons
  elements.domainsList.querySelectorAll(".domain-remove-btn").forEach((btn) => {
    btn.addEventListener("click", () =>
      removeDomain(parseInt(btn.dataset.index)),
    );
  });
}

async function addDomain() {
  let domain = elements.newDomainInput.value.trim().toLowerCase();

  if (!domain) return;

  // Clean domain (remove protocol, www, trailing slashes)
  domain = domain.replace(/^(https?:\/\/)?(www\.)?/, "").replace(/\/.*$/, "");

  // Basic validation
  if (!domain.includes(".")) {
    alert("Por favor ingresa un dominio válido (ej. example.com)");
    return;
  }

  const result = await chrome.storage.local.get([STORAGE_KEYS.ALLOWED_DOMAINS]);
  const domains = result[STORAGE_KEYS.ALLOWED_DOMAINS] ?? DEFAULT_DOMAINS;

  // Check if already exists
  if (domains.includes(domain)) {
    alert("Este dominio ya está en la lista");
    return;
  }

  domains.push(domain);
  await chrome.storage.local.set({ [STORAGE_KEYS.ALLOWED_DOMAINS]: domains });

  elements.newDomainInput.value = "";
  renderDomainsList(domains);
}

async function removeDomain(index) {
  const result = await chrome.storage.local.get([STORAGE_KEYS.ALLOWED_DOMAINS]);
  const domains = result[STORAGE_KEYS.ALLOWED_DOMAINS] ?? DEFAULT_DOMAINS;

  if (domains.length <= 0) {
    return;
  }

  domains.splice(index, 1);
  await chrome.storage.local.set({ [STORAGE_KEYS.ALLOWED_DOMAINS]: domains });

  renderDomainsList(domains);
}

// ============================================
// Storage Warning Banner
// ============================================
async function checkStorageWarning() {
  try {
    const res = await chrome.runtime
      .sendMessage({ type: "GET_STORAGE_INFO" })
      .catch(() => null);
    if (!res?.success || !res.storageInfo) return;

    const info = res.storageInfo;
    if (info.level === "ok") return;

    const banner = document.getElementById("storage-warning");
    if (!banner) return;

    const pct = Math.round(info.percent * 100);
    const usedMb = (info.bytesUsed / 1024 / 1024).toFixed(1);

    if (info.level === "critical") {
      banner.className = "storage-warning critical";
      banner.textContent = `🔴 Almacenamiento al ${pct}% (${usedMb} MB) — ¡Crítico! Abrir dashboard para gestionar →`;
    } else {
      banner.className = "storage-warning";
      banner.textContent = `⚠️ Almacenamiento al ${pct}% (${usedMb} MB) — Abrir dashboard para gestionar →`;
    }

    banner.style.display = "block";
    banner.addEventListener("click", openDashboard, { once: true });
  } catch (_) {
    // silent fail
  }
}

// ============================================
// Open Dashboard
// ============================================
function openDashboard() {
  chrome.tabs.create({ url: chrome.runtime.getURL("popup/dashboard.html") });
}

// ============================================
// Load Recent History
// ============================================
async function loadRecentHistory() {
  if (!elements.recentHistory) return;

  try {
    const response = await chrome.runtime.sendMessage({
      type: "GET_USAGE_HISTORY",
      limit: 2,
    });

    if (!response || !response.history || response.history.length === 0) {
      elements.recentHistory.innerHTML =
        '<p class="history-empty">Sin actividad reciente</p>';
      return;
    }

    elements.recentHistory.innerHTML = response.history
      .map((record) => {
        const time = new Date(record.timestamp).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        });
        const model = record.model || "unknown";
        const tokens = (record.inputTokens || 0) + (record.outputTokens || 0);
        const statusIcon = record.success ? "✅" : "❌";

        return `<div class="history-item">
          <span class="history-icon">${statusIcon}</span>
          <div class="history-details">
            <span class="history-model">${model}</span>
            <span class="history-meta">${tokens} tokens · ${time}</span>
          </div>
        </div>`;
      })
      .join("");
  } catch (error) {
    console.error("Error loading history:", error);
    elements.recentHistory.innerHTML =
      '<p class="history-empty">No se pudo cargar el historial</p>';
  }
}

// ============================================
// Load Today's Stats
// ============================================
async function loadTodayStats() {
  if (!elements.todayRequests) return;

  try {
    const response = await chrome.runtime.sendMessage({
      type: "GET_USAGE_STATS",
    });

    if (!response || !response.stats) return;

    const stats = response.stats;
    elements.todayRequests.textContent = stats.todayRequests ?? 0;
    elements.todayTokens.textContent = formatNumber(stats.todayTokens ?? 0);
    elements.todayCost.textContent = "$" + (stats.todayCost ?? 0).toFixed(4);
  } catch (error) {
    console.error("Error loading today stats:", error);
  }
}

function formatNumber(num) {
  if (num >= 1000000) return (num / 1000000).toFixed(1) + "M";
  if (num >= 1000) return (num / 1000).toFixed(1) + "K";
  return num.toString();
}

// ============================================
// Initialize on DOM Load
// ============================================
document.addEventListener("DOMContentLoaded", initializePopup);
