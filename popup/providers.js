/**
 * Study Assist — Providers page
 * Configure per-provider API keys, models, thinking and vision.
 *
 * Models are only shown after a valid API key is saved; saving a key
 * triggers an automatic /models fetch.
 */

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

async function send(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch {
    return null;
  }
}

// ============================================
// State
// ============================================
let STATE = { presets: [], profiles: [], roles: { primary: null, validator: null } };

async function loadState() {
  const res = await send({ type: "GET_PROVIDER_STATE" });
  if (res && res.success && res.state) {
    STATE = res.state;
    render();
  }
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
      lastSync: null,
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

// ============================================
// Render
// ============================================
function render() {
  const list = document.getElementById("providers-list");
  list.innerHTML = "";
  for (const preset of STATE.presets) {
    list.appendChild(renderCard(preset));
  }
  applyTranslations();
}

function renderCard(preset) {
  const profile = profileOf(preset.id);
  const card = document.createElement("section");
  card.className = "provider-card";
  card.dataset.provider = preset.id;

  const statusText = profile.hasKey ? t("providerConfigured") : t("providerNoKey");
  const statusClass = profile.hasKey ? "ok" : "none";

  const models = modelUnion(profile);
  const rows = models
    .map((model) => {
      const isNew =
        profile.models.includes(model) && !preset.defaultModels.includes(model);
      const vision = profile.visionModels.includes(model);
      return `
        <div class="model-row" data-model="${escapeAttr(model)}">
          <input type="checkbox" class="model-vision" ${vision ? "checked" : ""} title="${escapeAttr(t("providerVisionTitle"))}" />
          <span class="model-id">${escapeHtml(model)}</span>
          ${isNew ? `<span class="model-badge">${escapeHtml(t("providerModelNew"))}</span>` : ""}
          ${vision ? "" : `<span class="model-warn">${escapeHtml(t("providerNoVision"))}</span>`}
        </div>`;
    })
    .join("");

  const modelsArea = profile.hasKey
    ? `
    <div class="provider-models-head">
      <span>${escapeHtml(t("providerModelsTitle"))}</span>
      <button class="btn btn-secondary detect-models">${escapeHtml(t("providerDetectModels"))}</button>
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
      <span class="provider-name">${escapeHtml(preset.label)}</span>
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
  `;

  bindCard(card, preset, profile);
  return card;
}

function setMsg(card, text, kind) {
  const el = card.querySelector(".provider-msg");
  if (!el) return;
  el.textContent = text || "";
  el.className = "provider-msg" + (kind ? " " + kind : "");
}

/** Fetch /models, re-render and return a summary (or an error). */
async function runDetection(provider) {
  const before = profileOf(provider).models;
  const res = await send({ type: "FETCH_PROVIDER_MODELS", provider });

  if (!res || !res.success) {
    return { error: (res && res.error) || t("providerDetectError") };
  }

  const after = (res.models || []).map((m) => m.id);
  const added = after.filter((m) => !before.includes(m));
  const removed = before.filter((m) => !after.includes(m));

  await loadState();

  return {
    text: `${t("providerNewLabel")}: ${added.length} · ${t("providerObsoleteLabel")}: ${removed.length} · ${t("providerTotalLabel")}: ${after.length}`,
  };
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

    setMsg(card, t("providerValidating"), "");
    const res = await send({ type: "SAVE_PROVIDER_KEY", provider, rawKey, test: true });

    if (!res || !res.success) {
      setMsg(card, (res && res.error) || t("providerError"), "err");
      return;
    }

    keyInput.value = "";
    const successMsg = res.warning || t("providerSaved");

    // Re-render with the now-configured state, then auto-detect models.
    await loadState();

    let current = findCard(provider);
    if (current) setMsg(current, successMsg, "ok");

    const detection = await runDetection(provider);
    current = findCard(provider);
    if (current) {
      const summary = current.querySelector(".provider-summary");
      if (summary) summary.textContent = detection.error || detection.text || "";
      setMsg(current, successMsg, "ok");
    }
  });

  card.querySelector(".thinking").addEventListener("change", async (event) => {
    await send({ type: "SET_PROVIDER_THINKING", provider, thinking: event.target.checked });
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

  const addBtn = card.querySelector(".add-model");
  if (addBtn) {
    addBtn.addEventListener("click", async () => {
      const input = card.querySelector(".manual-model");
      const model = input.value.trim();
      if (!model) return;
      await send({ type: "ADD_PROVIDER_MODEL", provider, model });
      input.value = "";
      await loadState();
    });
  }

  const deleteBtn = card.querySelector(".delete-key");
  if (deleteBtn) {
    deleteBtn.addEventListener("click", async () => {
      if (!confirm(t("providerDeleteConfirm"))) return;
      await send({ type: "DELETE_PROVIDER_KEY", provider });
      await loadState();
    });
  }

  card.querySelectorAll(".model-vision").forEach((checkbox) => {
    checkbox.addEventListener("change", async (event) => {
      const model = event.target.closest(".model-row").dataset.model;
      await send({
        type: "SET_MODEL_VISION",
        provider,
        model,
        vision: event.target.checked,
      });
      await loadState();
    });
  });
}

// ============================================
// Boot
// ============================================
document.addEventListener("DOMContentLoaded", () => {
  applyTranslations();
  loadState();
});
