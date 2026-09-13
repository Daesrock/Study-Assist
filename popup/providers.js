/**
 * Study Assist — Providers page
 * Configure per-provider API keys, models, thinking and vision, including
 * user-defined providers (OpenAI-compatible or Anthropic-compatible).
 *
 * Models are only shown after a valid API key is saved; saving a key triggers
 * an automatic /models fetch. Prices/vision come from the bundled LiteLLM
 * snapshot and can be refreshed live.
 */

// ============================================
// Debug
// ============================================
let DEBUG = false;

function debug(...args) {
  if (DEBUG) console.log("[Study Assist][providers]", ...args);
}

// ============================================
// i18n
// ============================================
function t(key, subs) {
  return chrome.i18n.getMessage(key, subs) || key;
}

function applyTranslations() {
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const msg = chrome.i18n.getMessage(el.getAttribute("data-i18n"));
    if (msg) el.textContent = msg;
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    const msg = chrome.i18n.getMessage(el.getAttribute("data-i18n-placeholder"));
    if (msg) el.placeholder = msg;
  });
  document.title = t("providersTitle");
}

// ============================================
// Utilities
// ============================================
function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = value == null ? "" : String(value);
  return div.innerHTML;
}

function escapeAttr(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function eyeIcon() {
  return '<svg viewBox="0 0 24 24"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>';
}

function eyeOffIcon() {
  return '<svg viewBox="0 0 24 24"><path d="M17.94 17.94A10 10 0 0 1 12 20c-7 0-11-8-11-8a18.5 18.5 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9 9 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><path d="M1 1l22 22"/></svg>';
}

function formatPrice(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return "$" + String(Math.round(value * 1000) / 1000);
}

function formatContext(tokens) {
  if (typeof tokens !== "number" || tokens <= 0) return "";
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens);
}

async function send(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (error) {
    debug("sendMessage failed", message.type, error);
    return null;
  }
}

// ============================================
// State
// ============================================
let STATE = { presets: [], profiles: [], roles: { primary: null, validator: null } };

const VIEW_KEY = "providersView";
/** Per-provider model-list view: { search, mode: "all" | "selected" }. */
let VIEW = {};
const scrollPositions = {};

async function loadView() {
  try {
    const res = await chrome.storage.local.get(VIEW_KEY);
    VIEW = (res && res[VIEW_KEY]) || {};
  } catch {
    VIEW = {};
  }
}

function viewOf(id) {
  if (!VIEW[id]) VIEW[id] = { search: "", mode: "all" };
  return VIEW[id];
}

function persistView() {
  try {
    chrome.storage.local.set({ [VIEW_KEY]: VIEW });
  } catch {
    // ignore
  }
}

/** Apply a fresh state from any provider response, falling back to a GET. */
async function applyState(res) {
  if (res && res.success && res.state) {
    STATE = res.state;
    render();
    return true;
  }
  return false;
}

async function loadState() {
  const res = await send({ type: "GET_PROVIDER_STATE" });
  if (res && res.success && res.state) {
    STATE = res.state;
    render();
    setError("");
    debug("state loaded", STATE.profiles.map((p) => `${p.id}:${p.hasKey}`).join(", "));
    return;
  }
  const message = (res && res.error) || t("providerStateError");
  debug("state load failed", message);
  setError(message);
}

function setError(text) {
  const el = document.getElementById("providers-error");
  if (!el) return;
  el.textContent = text || "";
  el.style.display = text ? "block" : "none";
}

function setStatus(text, kind) {
  const el = document.getElementById("providers-status");
  if (!el) return;
  el.textContent = text || "";
  el.className = "providers-status" + (kind ? " " + kind : "");
}

function profileOf(id) {
  return (
    STATE.profiles.find((p) => p.id === id) || {
      id,
      hasKey: false,
      thinking: false,
      models: [],
      customModels: [],
      visionModels: [],
      selectedModels: [],
      selectionMode: "auto",
      lastSync: null,
      modelInfo: {},
    }
  );
}

function roleModelsFor(providerId) {
  const models = [];
  for (const role of [STATE.roles.primary, STATE.roles.validator]) {
    if (role && role.provider === providerId && role.model) models.push(role.model);
  }
  return models;
}

/** Visible models = detected + custom + role selection (no shipped baseline). */
function modelUnion(profile) {
  return [
    ...new Set([
      ...profile.models,
      ...profile.customModels,
      ...roleModelsFor(profile.id),
    ]),
  ];
}

function findCard(provider) {
  return document.querySelector(
    `.provider-card[data-provider="${CSS.escape(provider)}"]`,
  );
}

function captureScroll() {
  document.querySelectorAll(".provider-card").forEach((card) => {
    const models = card.querySelector(".provider-models");
    if (models) scrollPositions[card.dataset.provider] = models.scrollTop;
  });
}

function restoreScroll() {
  document.querySelectorAll(".provider-card").forEach((card) => {
    const models = card.querySelector(".provider-models");
    const pos = scrollPositions[card.dataset.provider];
    if (models && typeof pos === "number") models.scrollTop = pos;
  });
}

// ============================================
// Render
// ============================================
function render() {
  captureScroll();
  const list = document.getElementById("providers-list");
  list.innerHTML = "";
  for (const preset of STATE.presets) {
    list.appendChild(renderCard(preset));
  }
  applyTranslations();
  restoreScroll();
}

function renderModelRow(profile, model) {
  const info = profile.modelInfo ? profile.modelInfo[model] : null;
  const vision = profile.visionModels.includes(model);
  const included = (profile.selectedModels || []).includes(model);
  const hasPrice =
    info && (typeof info.inputPer1M === "number" || typeof info.outputPer1M === "number");
  const priceText = hasPrice
    ? `${formatPrice(info.inputPer1M)} / ${formatPrice(info.outputPer1M)} ${escapeHtml(t("providerPricePerM"))}`
    : escapeHtml(t("providerPriceUnavailable"));
  const ctxText = info && info.maxInput ? formatContext(info.maxInput) : "";

  return `
    <div class="model-row" data-model="${escapeAttr(model)}" data-selected="${included ? "1" : "0"}">
      <input type="checkbox" class="model-include" ${included ? "checked" : ""} title="${escapeAttr(t("providerIncludeTitle"))}" />
      <div class="model-main">
        <span class="model-id">${escapeHtml(model)}</span>
        <span class="model-meta">
          <span class="model-price">${priceText}</span>
          ${ctxText ? `<span class="model-ctx">ctx ${escapeHtml(ctxText)}</span>` : ""}
        </span>
      </div>
      <label class="model-vision-toggle" title="${escapeAttr(t("providerVisionTitle"))}">
        <input type="checkbox" class="model-vision" ${vision ? "checked" : ""} />
        <span class="model-vision-badge">${escapeHtml(t("providerVisionBadge"))}</span>
      </label>
    </div>`;
}

function renderSelectionMode(profile) {
  const mode = profile.selectionMode === "manual" ? "manual" : "auto";
  const label =
    mode === "manual"
      ? t("providerSelectionManual")
      : t("providerSelectionAuto");
  const button =
    mode === "manual"
      ? `<button class="btn btn-outline auto-select">${escapeHtml(t("providerAutoButton"))}</button>`
      : "";
  return `<div class="provider-selection-mode"><span class="selection-mode-label">${escapeHtml(label)}</span>${button}</div>`;
}

function renderCard(preset) {
  const profile = profileOf(preset.id);
  const card = document.createElement("section");
  card.className = "provider-card";
  card.dataset.provider = preset.id;
  const isCustom = !!preset.custom;
  const view = viewOf(preset.id);

  const statusText = profile.hasKey ? t("providerConfigured") : t("providerNoKey");
  const statusClass = profile.hasKey ? "ok" : "none";

  const selectedSet = new Set(profile.selectedModels || []);
  const models = modelUnion(profile).sort(
    (a, b) =>
      (selectedSet.has(b) ? 1 : 0) - (selectedSet.has(a) ? 1 : 0) ||
      a.localeCompare(b),
  );
  const rows = models.map((model) => renderModelRow(profile, model)).join("");

  const modelsArea = profile.hasKey
    ? `
    <div class="provider-models-head">
      <span>${escapeHtml(t("providerModelsTitle"))}</span>
      <div class="provider-models-actions">
        <button class="btn btn-outline test-connection">${escapeHtml(t("providerTestConnection"))}</button>
        <button class="btn btn-secondary detect-models">${escapeHtml(t("providerDetectModels"))}</button>
      </div>
    </div>
    <div class="provider-models-legend">${escapeHtml(t("providerModelsLegend"))}</div>
    ${renderSelectionMode(profile)}
    <div class="provider-models-toolbar">
      <input type="search" class="model-search" placeholder="${escapeAttr(
        t("providerSearchModels"),
      )}" value="${escapeAttr(view.search)}" autocomplete="off" />
      <label class="model-only-selected">
        <input type="checkbox" class="model-filter-selected" ${view.mode === "selected" ? "checked" : ""} />
        ${escapeHtml(t("providerOnlySelected"))}
      </label>
      <span class="model-count"></span>
      <button class="btn btn-outline select-all-filtered">${escapeHtml(t("providerSelectAll"))}</button>
      <button class="btn btn-outline select-none">${escapeHtml(t("providerSelectNone"))}</button>
    </div>
    <div class="provider-summary"></div>
    <div class="provider-models">${
      rows || `<div class="empty">${escapeHtml(t("providerNoModels"))}</div>`
    }</div>
    <div class="provider-manual">
      <input type="text" class="manual-model" placeholder="${escapeAttr(
        t("providerManualPlaceholder"),
      )}" autocomplete="off" />
      <button class="btn btn-outline add-model">${escapeHtml(t("providerAdd"))}</button>
    </div>`
    : `<div class="provider-hint">${escapeHtml(t("providerNoKeyHint"))}</div>`;

  card.innerHTML = `
    <div class="provider-head">
      <span class="provider-name">${escapeHtml(preset.label)}${
        isCustom
          ? `<span class="provider-badge-custom">${escapeHtml(t("providerCustomBadge"))}</span>`
          : ""
      }</span>
      <span class="provider-status ${statusClass}">${escapeHtml(statusText)}</span>
    </div>
    <div class="provider-row">
      <input type="password" class="provider-key" placeholder="${escapeAttr(
        profile.hasKey ? t("providerKeyStored") : t("providerKeyPlaceholder"),
      )}" autocomplete="off" />
      <button class="icon-btn toggle-visibility" title="${escapeAttr(t("providerToggleVisibility"))}">${eyeIcon()}</button>
      <button class="btn btn-primary save-key">${escapeHtml(t("providerSaveTest"))}</button>
    </div>
    <div class="provider-msg"></div>
    <label class="provider-thinking">
      <input type="checkbox" class="thinking" ${profile.thinking ? "checked" : ""} />
      ${escapeHtml(t("providerThinking"))}
    </label>
    ${modelsArea}
    ${
      profile.hasKey
        ? `<div class="provider-danger"><button class="btn btn-danger delete-key">${escapeHtml(
            t("providerDeleteKey"),
          )}</button></div>`
        : ""
    }
    ${
      isCustom
        ? `<div class="provider-card-actions"><button class="btn btn-danger delete-provider">${escapeHtml(
            t("providerDeleteProvider"),
          )}</button></div>`
        : ""
    }
  `;

  bindCard(card, preset, profile);
  applyModelFilter(card, profile);
  return card;
}

function setMsg(card, text, kind) {
  const el = card.querySelector(".provider-msg");
  if (!el) return;
  el.textContent = text || "";
  el.className = "provider-msg" + (kind ? " " + kind : "");
}

function setSummary(card, text, kind) {
  const el = card && card.querySelector(".provider-summary");
  if (!el) return;
  el.textContent = text || "";
  el.className = "provider-summary" + (kind ? " " + kind : "");
}

/** Show/hide rows according to the search box and the "selected only" filter. */
function applyModelFilter(card, profile) {
  const view = viewOf(card.dataset.provider);
  const query = (view.search || "").trim().toLowerCase();
  let visible = 0;
  card.querySelectorAll(".model-row").forEach((row) => {
    const model = (row.dataset.model || "").toLowerCase();
    const selected = row.dataset.selected === "1";
    const matches = !query || model.includes(query);
    const passesMode = view.mode !== "selected" || selected;
    const show = matches && passesMode;
    row.style.display = show ? "" : "none";
    if (show) visible++;
  });
  const count = card.querySelector(".model-count");
  if (count) {
    const total = card.querySelectorAll(".model-row").length;
    const selected = (profile.selectedModels || []).length;
    count.textContent = `${t("providerSelectedCount")}: ${selected} / ${total}${
      visible !== total ? ` · ${t("providerShownCount")}: ${visible}` : ""
    }`;
  }
}

/** Fetch /models, refresh state and return a summary (or an error). */
async function runDetection(provider) {
  const before = profileOf(provider).models.slice();
  debug("detecting models", provider);
  const res = await send({ type: "FETCH_PROVIDER_MODELS", provider });

  if (!res || !res.success) {
    await applyState(res);
    debug("detection failed", provider, res && res.error);
    return { error: (res && res.error) || t("providerDetectError") };
  }

  const after = (res.models || []).map((m) => m.id);
  // First detection: show the full catalog so the user sees what exists.
  if (before.length === 0) viewOf(provider).mode = "all";
  await applyState(res);

  const added = after.filter((m) => !before.includes(m));
  const removed = before.filter((m) => !after.includes(m));
  debug("detection ok", { provider, total: after.length, added: added.length, removed: removed.length });

  return {
    text: `${t("providerNewLabel")}: ${added.length} · ${t("providerObsoleteLabel")}: ${removed.length} · ${t("providerTotalLabel")}: ${after.length}`,
  };
}

/** Select/deselect every currently visible (filtered) model. */
async function setVisibleSelection(card, provider, selected) {
  const rows = [...card.querySelectorAll(".model-row")].filter(
    (row) => row.style.display !== "none",
  );
  for (const row of rows) {
    const isSelected = row.dataset.selected === "1";
    if (isSelected !== selected) {
      await send({ type: "SET_MODEL_SELECTED", provider, model: row.dataset.model, selected });
    }
  }
  const res = await send({ type: "GET_PROVIDER_STATE" });
  if (!(await applyState(res))) await loadState();
}

function bindCard(card, preset, profile) {
  const provider = preset.id;

  const keyInput = card.querySelector(".provider-key");
  const visBtn = card.querySelector(".toggle-visibility");
  visBtn.addEventListener("click", () => {
    const isPassword = keyInput.type === "password";
    keyInput.type = isPassword ? "text" : "password";
    visBtn.innerHTML = isPassword ? eyeOffIcon() : eyeIcon();
  });

  card.querySelector(".save-key").addEventListener("click", async () => {
    const rawKey = keyInput.value.trim();
    if (!rawKey) {
      setMsg(card, t("providerEnterKey"), "err");
      return;
    }

    const before = profileOf(provider).models.slice();
    setMsg(card, t("providerValidating"), "");
    debug("saving key", provider);
    // The background validates + detects in a single /models request.
    const res = await send({ type: "SAVE_PROVIDER_KEY", provider, rawKey, test: true });

    if (!res || !res.success) {
      debug("save failed", provider, res && res.error);
      setMsg(card, (res && res.error) || t("providerError"), "err");
      return;
    }

    keyInput.value = "";
    const successMsg = res.warning || t("providerSaved");
    if (before.length === 0) viewOf(provider).mode = "all";
    await applyState(res);
    if (!res.state) await loadState();

    const current = findCard(provider);
    if (current) {
      const summary = current.querySelector(".provider-summary");
      if (summary && res.models) {
        const after = res.models.map((m) => m.id);
        const added = after.filter((m) => !before.includes(m));
        const removed = before.filter((m) => !after.includes(m));
        summary.textContent = `${t("providerNewLabel")}: ${added.length} · ${t("providerObsoleteLabel")}: ${removed.length} · ${t("providerTotalLabel")}: ${after.length}`;
      }
      setMsg(current, successMsg, "ok");
    }
  });

  card.querySelector(".thinking").addEventListener("change", async (event) => {
    const res = await send({
      type: "SET_PROVIDER_THINKING",
      provider,
      thinking: event.target.checked,
    });
    if (!(await applyState(res))) await loadState();
  });

  const detectBtn = card.querySelector(".detect-models");
  if (detectBtn) {
    detectBtn.addEventListener("click", async () => {
      const summary = card.querySelector(".provider-summary");
      if (summary) summary.textContent = t("providerDetecting");
      const detection = await runDetection(provider);
      const current = findCard(provider);
      const newSummary = current && current.querySelector(".provider-summary");
      if (newSummary) newSummary.textContent = detection.error || detection.text || "";
    });
  }

  const testBtn = card.querySelector(".test-connection");
  if (testBtn) {
    testBtn.addEventListener("click", async () => {
      setSummary(card, t("providerTesting"), "");
      testBtn.disabled = true;
      const res = await send({ type: "TEST_PROVIDER_CONNECTION", provider });
      testBtn.disabled = false;
      const current = findCard(provider) || card;
      if (res && res.success) {
        const tokens = (res.inputTokens || 0) + (res.outputTokens || 0);
        const costText =
          typeof res.costUsd === "number"
            ? `$${res.costUsd.toFixed(6)}`
            : t("providerTestNoPrice");
        const detail = res.text ? `: ${res.text}` : "";
        setSummary(
          current,
          `${t("providerTestOk")} (${res.model || ""}) · ${tokens} tok · ${costText}${detail}`,
          "ok",
        );
      } else {
        const detail = (res && res.error) || t("providerError");
        setSummary(current, `${t("providerTestError")}: ${detail}`, "err");
      }
    });
  }

  const autoBtn = card.querySelector(".auto-select");
  if (autoBtn) {
    autoBtn.addEventListener("click", async () => {
      autoBtn.disabled = true;
      const res = await send({
        type: "SET_SELECTION_MODE",
        provider,
        selectionMode: "auto",
      });
      if (!(await applyState(res))) await loadState();
    });
  }

  const searchInput = card.querySelector(".model-search");
  if (searchInput) {
    searchInput.addEventListener("input", () => {
      viewOf(provider).search = searchInput.value;
      persistView();
      applyModelFilter(card, profileOf(provider));
    });
  }

  const filterSelected = card.querySelector(".model-filter-selected");
  if (filterSelected) {
    filterSelected.addEventListener("change", () => {
      viewOf(provider).mode = filterSelected.checked ? "selected" : "all";
      persistView();
      applyModelFilter(card, profileOf(provider));
    });
  }

  const selectAllBtn = card.querySelector(".select-all-filtered");
  if (selectAllBtn) {
    selectAllBtn.addEventListener("click", () => setVisibleSelection(card, provider, true));
  }

  const selectNoneBtn = card.querySelector(".select-none");
  if (selectNoneBtn) {
    selectNoneBtn.addEventListener("click", () => setVisibleSelection(card, provider, false));
  }

  const addBtn = card.querySelector(".add-model");
  if (addBtn) {
    addBtn.addEventListener("click", async () => {
      const input = card.querySelector(".manual-model");
      const model = input.value.trim();
      if (!model) return;
      const res = await send({ type: "ADD_PROVIDER_MODEL", provider, model });
      input.value = "";
      if (!(await applyState(res))) await loadState();
    });
  }

  const deleteBtn = card.querySelector(".delete-key");
  if (deleteBtn) {
    deleteBtn.addEventListener("click", async () => {
      if (!confirm(t("providerDeleteConfirm"))) return;
      const res = await send({ type: "DELETE_PROVIDER_KEY", provider });
      if (!(await applyState(res))) await loadState();
    });
  }

  const deleteProviderBtn = card.querySelector(".delete-provider");
  if (deleteProviderBtn) {
    deleteProviderBtn.addEventListener("click", async () => {
      if (!confirm(t("providerDeleteProviderConfirm"))) return;
      const res = await send({ type: "DELETE_CUSTOM_PROVIDER", provider });
      if (!(await applyState(res))) await loadState();
    });
  }

  card.querySelectorAll(".model-vision").forEach((checkbox) => {
    checkbox.addEventListener("change", async (event) => {
      const model = event.target.closest(".model-row").dataset.model;
      const res = await send({
        type: "SET_MODEL_VISION",
        provider,
        model,
        vision: event.target.checked,
      });
      if (!(await applyState(res))) await loadState();
    });
  });

  card.querySelectorAll(".model-include").forEach((checkbox) => {
    checkbox.addEventListener("change", async (event) => {
      const model = event.target.closest(".model-row").dataset.model;
      const res = await send({
        type: "SET_MODEL_SELECTED",
        provider,
        model,
        selected: event.target.checked,
      });
      if (!(await applyState(res))) await loadState();
    });
  });
}

// ============================================
// Add custom provider
// ============================================
function val(id) {
  const el = document.getElementById(id);
  return el ? String(el.value || "").trim() : "";
}

function setVal(id, value) {
  const el = document.getElementById(id);
  if (el) el.value = value == null ? "" : String(value);
}

function setChecked(id, value) {
  const el = document.getElementById(id);
  if (el) el.checked = !!value;
}

function parseHeaders(text) {
  const out = {};
  for (const line of String(text || "").split("\n")) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const name = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (name) out[name] = value;
  }
  return out;
}

let selectedTemplate = null;

function populateTemplates() {
  const select = document.getElementById("ap-template");
  if (!select) return;
  const options = [`<option value="">${escapeHtml(t("providerTemplateCustom"))}</option>`];
  for (const template of STATE.templates || []) {
    options.push(`<option value="${escapeAttr(template.id)}">${escapeHtml(template.label)}</option>`);
  }
  select.innerHTML = options.join("");
}

function applyTemplateToForm(template) {
  const note = document.getElementById("ap-endpoints-note");
  if (!template) {
    setVal("ap-label", "");
    setVal("ap-baseurl", "");
    setVal("ap-dialect", "openai-compatible");
    setVal("ap-maxtokens", "max_tokens");
    setVal("ap-prefixes", "");
    setChecked("ap-thinking", false);
    setChecked("ap-images", false);
    setChecked("ap-matching", true);
    if (note) note.style.display = "none";
    return;
  }

  setVal("ap-label", template.label);
  setVal("ap-baseurl", template.baseUrl);
  setVal("ap-dialect", template.dialect);
  setVal("ap-maxtokens", template.maxTokensParam || "max_tokens");
  setChecked("ap-thinking", !!template.defaultThinking);
  setChecked("ap-images", !!template.capabilities?.images);
  setChecked("ap-matching", template.capabilities?.matching !== false);

  if (note) {
    if (template.endpoints?.length) {
      const ids = template.endpoints.map((ep) => ep.id).join(", ");
      note.textContent = `${t("providerMultiEndpointNote")}: ${ids}`;
      note.style.display = "block";
    } else {
      note.style.display = "none";
    }
  }
}

function resetAddProviderForm() {
  ["ap-label", "ap-baseurl", "ap-headers"].forEach((id) => setVal(id, ""));
  setVal("ap-template", "");
  setVal("ap-maxtokens", "max_tokens");
  setChecked("ap-thinking", false);
  setChecked("ap-images", false);
  setChecked("ap-matching", true);
  selectedTemplate = null;
  const note = document.getElementById("ap-endpoints-note");
  if (note) note.style.display = "none";
}

async function saveCustomProviderFromForm() {
  const label = val("ap-label");
  const baseUrl = val("ap-baseurl").replace(/\/+$/, "");
  const dialect = val("ap-dialect") || "openai-compatible";

  if (!label || !baseUrl) {
    setStatus(t("providerMissingFields"), "err");
    return;
  }

  let origin;
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("scheme");
    origin = url.origin;
  } catch {
    setStatus(t("providerInvalidUrl"), "err");
    return;
  }

  // Request the host permission (must run inside the click's user gesture).
  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
  } catch {
    granted = false;
  }
  if (!granted) {
    setStatus(t("providerHostPermissionError"), "err");
    return;
  }

  const headers = parseHeaders(val("ap-headers"));
  const customProvider = {
    id: `custom-${Date.now().toString(36)}`,
    label,
    baseUrl,
    dialect,
    maxTokensParam: val("ap-maxtokens") === "max_completion_tokens"
      ? "max_completion_tokens"
      : "max_tokens",
    defaultThinking: !!document.getElementById("ap-thinking")?.checked,
    capabilities: {
      images: !!document.getElementById("ap-images")?.checked,
      matching: !!document.getElementById("ap-matching")?.checked,
      reasoning: true,
    },
  };
  if (Object.keys(headers).length) customProvider.headers = headers;

  // Multi-endpoint template: carry over its endpoints and routing.
  if (selectedTemplate?.endpoints?.length) {
    customProvider.endpoints = selectedTemplate.endpoints;
    customProvider.defaultEndpoint = selectedTemplate.defaultEndpoint;
    customProvider.routeRules = selectedTemplate.routeRules;
    customProvider.modelRoutes = selectedTemplate.modelRoutes;
  }

  const res = await send({ type: "SAVE_CUSTOM_PROVIDER", customProvider });
  if (!res || !res.success) {
    setStatus((res && res.error) || t("providerError"), "err");
    return;
  }

  resetAddProviderForm();
  const form = document.getElementById("add-provider-form");
  if (form) form.style.display = "none";
  await applyState(res);
  setStatus(t("providerSaved"), "ok");
}

// ============================================
// Price refresh (global)
// ============================================
async function refreshPrices() {
  setStatus(t("providerPricesUpdating"), "");
  const res = await send({ type: "UPDATE_MODEL_PRICES" });
  if (!res || !res.success) {
    const detail = res && res.error ? `: ${res.error}` : "";
    debug("price refresh failed", res && res.error);
    setStatus(`${t("providerPricesError")}${detail}`, "err");
    return;
  }
  if (res.state) {
    STATE = res.state;
    render();
  }
  setStatus(`${t("providerPricesUpdated")} (${res.count})`, "ok");
}

// ============================================
// Boot
// ============================================
document.addEventListener("DOMContentLoaded", async () => {
  applyTranslations();
  try {
    const { debugMode } = await chrome.storage.local.get("debugMode");
    DEBUG = debugMode === true;
    debug("providers page ready", { debug: DEBUG });
  } catch {
    DEBUG = false;
  }

  const refreshBtn = document.getElementById("refresh-prices");
  if (refreshBtn) refreshBtn.addEventListener("click", refreshPrices);

  const addBtn = document.getElementById("add-provider");
  const form = document.getElementById("add-provider-form");
  if (addBtn && form) {
    addBtn.addEventListener("click", () => {
      form.style.display = form.style.display === "none" ? "block" : "none";
    });
  }
  const cancelBtn = document.getElementById("ap-cancel");
  if (cancelBtn && form) {
    cancelBtn.addEventListener("click", () => {
      form.style.display = "none";
    });
  }
  const saveBtn = document.getElementById("ap-save");
  if (saveBtn) saveBtn.addEventListener("click", saveCustomProviderFromForm);

  const templateSelect = document.getElementById("ap-template");
  if (templateSelect) {
    templateSelect.addEventListener("change", () => {
      selectedTemplate =
        (STATE.templates || []).find((tp) => tp.id === templateSelect.value) || null;
      applyTemplateToForm(selectedTemplate);
    });
  }

  await loadView();
  await loadState();
  populateTemplates();
});
