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
  apiKeyInput: document.getElementById("api-key-input"),
  toggleVisibility: document.getElementById("toggle-visibility"),
  saveApiKey: document.getElementById("save-api-key"),
  apiStatus: document.getElementById("api-status"),
  analyzePage: document.getElementById("analyze-page"),
  responseMode: document.getElementById("response-mode"),
  autoDetect: document.getElementById("auto-detect"),
  highlightQuestions: document.getElementById("highlight-questions"),
  quickMode: document.getElementById("quick-mode"),
  claudeModel: document.getElementById("claude-model"),
  // Domain management
  domainsList: document.getElementById("domains-list"),
  newDomainInput: document.getElementById("new-domain-input"),
  addDomainBtn: document.getElementById("add-domain-btn"),
  // Image option
  sendImages: document.getElementById("send-images"),
  // DeepSeek
  useDeepSeek: document.getElementById("use-deepseek"),
  deepseekConfig: document.getElementById("deepseek-config"),
  deepseekOnly: document.getElementById("deepseek-only"),
  deepseekOnlyWarnings: document.getElementById("deepseek-only-warnings"),
  deepseekApiKeyInput: document.getElementById("deepseek-api-key-input"),
  toggleDeepseekVisibility: document.getElementById(
    "toggle-deepseek-visibility",
  ),
  saveDeepseekKey: document.getElementById("save-deepseek-key"),
  deepseekStatus: document.getElementById("deepseek-status"),
  // Disguise mode
  disguiseMode: document.getElementById("disguise-mode"),
  // New elements
  openDashboard: document.getElementById("open-dashboard"),
  openHowTo: document.getElementById("open-howto"),
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
  API_KEY: "claudeApiKey",
  RESPONSE_MODE: "responseMode",
  AUTO_DETECT: "autoDetect",
  HIGHLIGHT_QUESTIONS: "highlightQuestions",
  QUICK_MODE: "quickMode",
  CLAUDE_MODEL: "claudeModel",
  ALLOWED_DOMAINS: "allowedDomains",
  SEND_IMAGES: "sendImages",
  // DeepSeek
  USE_DEEPSEEK: "useDeepSeek",
  DEEPSEEK_API_KEY: "deepseekApiKey",
  DEEPSEEK_ONLY: "deepseekOnly",
  // Disguise mode
  DISGUISE_MODE: "disguiseMode",
  // New settings
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
      STORAGE_KEYS.API_KEY,
      STORAGE_KEYS.RESPONSE_MODE,
      STORAGE_KEYS.AUTO_DETECT,
      STORAGE_KEYS.HIGHLIGHT_QUESTIONS,
      STORAGE_KEYS.QUICK_MODE,
      STORAGE_KEYS.CLAUDE_MODEL,
      STORAGE_KEYS.ALLOWED_DOMAINS,
      STORAGE_KEYS.SEND_IMAGES,
      STORAGE_KEYS.USE_DEEPSEEK,
      STORAGE_KEYS.DEEPSEEK_API_KEY,
      STORAGE_KEYS.DEEPSEEK_ONLY,
      STORAGE_KEYS.DISGUISE_MODE,
    ]);

    // Set toggle state
    elements.extensionToggle.checked =
      result[STORAGE_KEYS.EXTENSION_ACTIVE] ?? false;

    // Set API key (if exists)
    if (result[STORAGE_KEYS.API_KEY]) {
      elements.apiKeyInput.value = result[STORAGE_KEYS.API_KEY];
    }

    // Set response mode
    elements.responseMode.value =
      result[STORAGE_KEYS.RESPONSE_MODE] ?? "guided";

    // Set Claude model
    elements.claudeModel.value =
      result[STORAGE_KEYS.CLAUDE_MODEL] ?? "claude-haiku-4-5-20251001";

    // Set checkboxes
    elements.autoDetect.checked = result[STORAGE_KEYS.AUTO_DETECT] ?? true;
    elements.highlightQuestions.checked =
      result[STORAGE_KEYS.HIGHLIGHT_QUESTIONS] ?? true;
    elements.quickMode.checked = result[STORAGE_KEYS.QUICK_MODE] ?? false;

    // Set send images checkbox (default: false)
    elements.sendImages.checked = result[STORAGE_KEYS.SEND_IMAGES] ?? false;

    // DeepSeek settings
    const useDeepSeek = result[STORAGE_KEYS.USE_DEEPSEEK] ?? false;
    const deepseekOnly = result[STORAGE_KEYS.DEEPSEEK_ONLY] ?? false;
    elements.useDeepSeek.checked = useDeepSeek;
    elements.deepseekConfig.style.display = useDeepSeek ? "block" : "none";
    elements.deepseekOnly.checked = deepseekOnly;
    elements.deepseekOnlyWarnings.style.display = deepseekOnly
      ? "block"
      : "none";
    if (result[STORAGE_KEYS.DEEPSEEK_API_KEY]) {
      elements.deepseekApiKeyInput.value =
        result[STORAGE_KEYS.DEEPSEEK_API_KEY];
    }

    // Load domains list
    const domains = result[STORAGE_KEYS.ALLOWED_DOMAINS] ?? DEFAULT_DOMAINS;
    renderDomainsList(domains);

    // Disguise mode
    elements.disguiseMode.checked = result[STORAGE_KEYS.DISGUISE_MODE] ?? false;
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

  // API key management
  elements.toggleVisibility.addEventListener("click", toggleApiKeyVisibility);
  elements.saveApiKey.addEventListener("click", saveApiKey);
  elements.apiKeyInput.addEventListener("keypress", (e) => {
    if (e.key === "Enter") saveApiKey();
  });

  // Action buttons
  elements.analyzePage.addEventListener("click", analyzePage);

  // Settings changes
  elements.responseMode.addEventListener("change", saveSettings);
  elements.autoDetect.addEventListener("change", saveSettings);
  elements.highlightQuestions.addEventListener("change", saveSettings);
  elements.quickMode.addEventListener("change", saveSettings);
  elements.claudeModel.addEventListener("change", saveSettings);
  elements.sendImages.addEventListener("change", saveSettings);
  elements.useDeepSeek.addEventListener("change", handleDeepSeekToggle);
  elements.deepseekOnly.addEventListener("change", handleDeepSeekOnlyToggle);
  elements.disguiseMode.addEventListener("change", handleDisguiseModeToggle);

  // Dashboard button
  if (elements.openDashboard) {
    elements.openDashboard.addEventListener("click", openDashboard);
  }
  if (elements.openHowTo) {
    elements.openHowTo.addEventListener("click", openHowToPanel);
  }

  // DeepSeek API key management
  elements.toggleDeepseekVisibility.addEventListener(
    "click",
    toggleDeepSeekKeyVisibility,
  );
  elements.saveDeepseekKey.addEventListener("click", saveDeepSeekKey);
  elements.deepseekApiKeyInput.addEventListener("keypress", (e) => {
    if (e.key === "Enter") saveDeepSeekKey();
  });

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
  const hasApiKey = elements.apiKeyInput.value.trim().length > 0;

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
// Toggle API Key Visibility
// ============================================
function toggleApiKeyVisibility() {
  const input = elements.apiKeyInput;
  const isPassword = input.type === "password";
  input.type = isPassword ? "text" : "password";
  elements.toggleVisibility.textContent = isPassword ? "🔒" : "👁️";
}

// ============================================
// Save API Key
// ============================================
async function saveApiKey() {
  const apiKey = elements.apiKeyInput.value.trim();

  if (!apiKey) {
    showApiStatus("Por favor ingresa una clave API", "error");
    return;
  }

  // Basic validation - Claude API keys typically start with "sk-ant-"
  if (!apiKey.startsWith("sk-ant-") || apiKey.length < 40) {
    showApiStatus(
      'Formato de clave inválido. Las claves de Claude empiezan con "sk-ant-"',
      "error",
    );
    return;
  }

  try {
    // Test the API key
    showApiStatus("Validando clave API...", "success");

    const result = await testApiKey(apiKey);

    if (result.success) {
      await chrome.storage.local.set({ [STORAGE_KEYS.API_KEY]: apiKey });
      if (result.warning) {
        showApiStatus("✓ " + result.warning, "success");
      } else {
        showApiStatus("✓ Clave API guardada y validada!", "success");
      }
      await updateUIState();
    } else {
      showApiStatus(
        result.error ||
          "Clave API inválida. Por favor verifica e intenta de nuevo.",
        "error",
      );
    }
  } catch (error) {
    showApiStatus(`Error: ${error.message}`, "error");
  }
}

// ============================================
// Test API Key with Claude
// ============================================
async function testApiKey(apiKey) {
  try {
    const response = await chrome.runtime.sendMessage({
      type: "TEST_API_KEY",
      apiKey: apiKey,
    });

    return response;
  } catch (error) {
    console.error("Error testing API key:", error);
    return { success: false, error: error.message };
  }
}

// ============================================
// Show API Status Message
// ============================================
function showApiStatus(message, type) {
  elements.apiStatus.textContent = message;
  elements.apiStatus.className = `api-status ${type}`;

  // Auto-hide success messages after 3 seconds
  if (type === "success" && !message.includes("Validando")) {
    setTimeout(() => {
      if (elements.apiStatus.textContent === message) {
        elements.apiStatus.className = "api-status";
      }
    }, 3000);
  }
}

// ============================================
// DeepSeek Toggle and API Key Management
// ============================================
function handleDeepSeekToggle() {
  const isEnabled = elements.useDeepSeek.checked;
  elements.deepseekConfig.style.display = isEnabled ? "block" : "none";
  // Reset deepseek-only when disabling DeepSeek
  if (!isEnabled) {
    elements.deepseekOnly.checked = false;
    elements.deepseekOnlyWarnings.style.display = "none";
  }
  saveSettings();
}

function handleDeepSeekOnlyToggle() {
  const isEnabled = elements.deepseekOnly.checked;
  elements.deepseekOnlyWarnings.style.display = isEnabled ? "block" : "none";
  saveSettings();
}

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

function toggleDeepSeekKeyVisibility() {
  const input = elements.deepseekApiKeyInput;
  const isPassword = input.type === "password";
  input.type = isPassword ? "text" : "password";
  elements.toggleDeepseekVisibility.textContent = isPassword ? "🔒" : "👁️";
}

async function saveDeepSeekKey() {
  const apiKey = elements.deepseekApiKeyInput.value.trim();

  if (!apiKey) {
    showDeepSeekStatus("Por favor ingresa una clave API", "error");
    return;
  }

  // DeepSeek keys start with "sk-"
  if (!apiKey.startsWith("sk-") || apiKey.length < 20) {
    showDeepSeekStatus(
      'Formato de clave inválido. Las claves de DeepSeek empiezan con "sk-"',
      "error",
    );
    return;
  }

  try {
    showDeepSeekStatus("Validando clave API...", "success");

    const result = await testDeepSeekKey(apiKey);

    if (result.success) {
      await chrome.storage.local.set({
        [STORAGE_KEYS.DEEPSEEK_API_KEY]: apiKey,
      });
      showDeepSeekStatus("✓ ¡Clave DeepSeek guardada y validada!", "success");
    } else {
      showDeepSeekStatus(result.error || "Clave API inválida.", "error");
    }
  } catch (error) {
    showDeepSeekStatus(`Error: ${error.message}`, "error");
  }
}

async function testDeepSeekKey(apiKey) {
  try {
    const response = await chrome.runtime.sendMessage({
      type: "TEST_DEEPSEEK_API_KEY",
      apiKey: apiKey,
    });
    return response;
  } catch (error) {
    console.error("Error testing DeepSeek API key:", error);
    return { success: false, error: error.message };
  }
}

function showDeepSeekStatus(message, type) {
  elements.deepseekStatus.textContent = message;
  elements.deepseekStatus.className = `api-status ${type}`;

  if (type === "success" && !message.includes("Validando")) {
    setTimeout(() => {
      if (elements.deepseekStatus.textContent === message) {
        elements.deepseekStatus.className = "api-status";
      }
    }, 3000);
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
      [STORAGE_KEYS.CLAUDE_MODEL]: elements.claudeModel.value,
      [STORAGE_KEYS.SEND_IMAGES]: elements.sendImages.checked,
      [STORAGE_KEYS.USE_DEEPSEEK]: elements.useDeepSeek.checked,
      [STORAGE_KEYS.DEEPSEEK_ONLY]: elements.deepseekOnly.checked,
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

function openHowToPanel() {
  chrome.tabs.create({ url: chrome.runtime.getURL("popup/howto.html") });
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
