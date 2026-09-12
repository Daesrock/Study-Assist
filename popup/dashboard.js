/**
 * Study Assist — Dashboard Script
 * Developer-oriented control panel with routing metrics,
 * token intelligence, last-response inspector, and dev mode.
 */

// ============================================
// Global State
// ============================================

let cachedHistory = [];
let cachedDevMode = false;

// ============================================
// Provider helpers
// ============================================
const PROVIDER_LABELS = {
  anthropic: "Anthropic",
  deepseek: "DeepSeek",
  openai: "OpenAI",
  "question-bank": "Banco de preguntas",
};

function providerIdOf(r) {
  if (r && r.provider) return r.provider;
  if (r && r.source === "claude") return "anthropic";
  return (r && r.source) || "other";
}

function providerLabel(id) {
  return PROVIDER_LABELS[id] || id || "—";
}

function roleLabel(role) {
  if (role === "validator") return "Validador";
  if (role === "primary") return "Principal";
  return "";
}

function badgeClassForProvider(id) {
  if (id === "anthropic") return "badge-claude";
  if (id === "deepseek") return "badge-deepseek";
  if (id === "openai") return "badge-openai";
  return "badge-bank";
}

function fillClassForProvider(id) {
  if (id === "anthropic") return "fill-claude";
  if (id === "deepseek") return "fill-deepseek";
  if (id === "openai") return "fill-openai";
  return "fill-default";
}

// ============================================
// Boot
// ============================================

document.getElementById("refresh-btn").addEventListener("click", loadData);

// Providers page
const providersBtn = document.getElementById("providers-btn");
if (providersBtn) {
  providersBtn.addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("popup/providers.html") });
  });
}

// Clear page results
document
  .getElementById("clear-results-btn")
  .addEventListener("click", async () => {
    try {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (tab?.id)
        await chrome.tabs.sendMessage(tab.id, { type: "CLEAR_RESULTS" });
    } catch (_) {
      /* no content script */
    }
  });

// Error log modal
document.getElementById("error-log-btn").addEventListener("click", async () => {
  try {
    const result = await chrome.storage.local.get(["errorLog"]);
    showModal(
      "🪵 Registro de Errores",
      null,
      result.errorLog || "No se encontraron registros de errores.",
    );
  } catch (e) {
    alert("Error: " + e.message);
  }
});

// Last AI response → opens detail subpage for most recent record
document.getElementById("last-response-btn").addEventListener("click", () => {
  if (cachedHistory.length > 0) {
    openRecordDetail(0);
  } else {
    showModal(
      "🔍 Última Respuesta IA",
      null,
      "No hay historial aún. Analiza una pregunta primero.",
    );
  }
});

// ============================================
// Data Loading
// ============================================

async function loadData() {
  const el = document.getElementById("content");
  el.innerHTML = '<div class="loading-spinner">Cargando datos…</div>';

  try {
    const [statsRes, historyRes, configRes, devModeRes, storageRes] =
      await Promise.all([
        chrome.runtime
          .sendMessage({ type: "GET_USAGE_STATS" })
          .catch(() => ({ success: false, stats: {} })),
        chrome.runtime
          .sendMessage({ type: "GET_USAGE_HISTORY", limit: 50 })
          .catch(() => ({ success: false, history: [] })),
        chrome.storage.local.get(["roles", "providerProfiles"]),
        chrome.storage.local.get(["dashboardDevMode"]),
        chrome.runtime
          .sendMessage({ type: "GET_STORAGE_INFO" })
          .catch(() => ({ success: false })),
      ]);

    const stats = (statsRes && statsRes.stats) || {};
    const history = (historyRes && historyRes.history) || [];
    const config = configRes || {};
    const devMode = devModeRes?.dashboardDevMode ?? false;
    const storageInfo = (storageRes?.success && storageRes.storageInfo) || null;

    cachedHistory = history;
    cachedDevMode = devMode;

    el.innerHTML = renderDashboard(
      stats,
      history,
      config,
      devMode,
      storageInfo,
    );
    bindDynamicEvents(history, devMode);
  } catch (e) {
    el.innerHTML =
      '<div class="loading-spinner">Error: ' + escapeHtml(e.message) + "</div>";
  }
}

// ============================================
// Render
// ============================================

function renderDashboard(stats, history, config, devMode, storageInfo) {
  stats = Object.assign(
    {
      totalRequests: 0,
      questionsAnswered: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCostUsd: 0,
      successRate: 0,
      avgLatencyMs: 0,
      todayRequests: 0,
      todayCost: 0,
      todayTokens: 0,
      bySource: {},
      byModel: {},
      byDay: {},
      deepseek: {
        totalRequests: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCostUsd: 0,
        todayRequests: 0,
        todayInputTokens: 0,
        todayOutputTokens: 0,
        todayCostUsd: 0,
      },
      claude: {
        totalRequests: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCostUsd: 0,
        todayRequests: 0,
        todayInputTokens: 0,
        todayOutputTokens: 0,
        todayCostUsd: 0,
      },
    },
    stats,
  );

  const totalTokens =
    (stats.totalInputTokens || 0) + (stats.totalOutputTokens || 0);

  // — Derive routing metrics from history —
  const today = new Date().toISOString().split("T")[0];
  let claudeValidations = 0,
    fallbacks = 0,
    imageFallbacks = 0;

  for (const r of history) {
    if (r.validated) claudeValidations++;
    if (r.fallbackReason) fallbacks++;
    if (r.fallbackReason === "images") imageFallbacks++;
  }

  // — Cost intelligence —
  const costToday = stats.todayCost || 0;
  const tokensToday = stats.todayTokens || 0;
  const requestsToday = stats.todayRequests || 0;
  const tokensPerReq = stats.totalRequests
    ? Math.round(totalTokens / stats.totalRequests)
    : 0;

  // — Monthly estimate: (cost_last_14_days / active_days) * 30 —
  const byDay = stats.byDay || {};
  const dayKeys = Object.keys(byDay).sort().reverse();
  const now = new Date();
  const cutoff14 = new Date(now);
  cutoff14.setDate(cutoff14.getDate() - 14);
  const cutoff14Str = cutoff14.toISOString().split("T")[0];
  let cost14 = 0,
    activeDays14 = 0;
  let dsCost14 = 0,
    clCost14 = 0;
  for (const r of history) {
    const day = new Date(r.timestamp).toISOString().split("T")[0];
    if (day >= cutoff14Str) {
      if (r.source === "deepseek") dsCost14 += r.costUsd || 0;
      else if (r.source === "claude") clCost14 += r.costUsd || 0;
    }
  }
  for (const d of dayKeys) {
    if (d >= cutoff14Str) {
      cost14 += byDay[d].cost || 0;
      activeDays14++;
    }
  }
  const estMonthlyCost = activeDays14 > 0 ? (cost14 / activeDays14) * 30 : 0;

  // — Platforms —
  const platforms = Object.keys(stats.byPlatform || {}).sort();

  // — Per-provider aggregates —
  const latencyByProvider = {};
  const todayByProvider = {};
  for (const r of history) {
    const id = providerIdOf(r);
    if (!latencyByProvider[id]) latencyByProvider[id] = { sum: 0, n: 0 };
    latencyByProvider[id].sum += r.latencyMs || 0;
    latencyByProvider[id].n++;
    if (new Date(r.timestamp).toISOString().split("T")[0] === today) {
      todayByProvider[id] = (todayByProvider[id] || 0) + 1;
    }
  }
  const providerAgg = Object.entries(stats.byProvider || {}).map(([id, a]) => ({
    id,
    label: providerLabel(id),
    tokens: (a.totalInputTokens || 0) + (a.totalOutputTokens || 0),
    cost: a.totalCostUsd || 0,
    requests: a.totalRequests || 0,
  }));
  const totalProviderRequests = providerAgg.reduce((s, p) => s + p.requests, 0);
  const providerTokenRows = providerAgg
    .map((p) => `<div class="grouped-row"><span class="g-label">${escapeHtml(p.label)}</span><span class="g-value">${formatTokens(p.tokens)}</span></div>`)
    .join("");
  const providerCostRows = providerAgg
    .map((p) => `<div class="grouped-row"><span class="g-label">${escapeHtml(p.label)}</span><span class="g-value">$${p.cost.toFixed(4)}</span></div>`)
    .join("");
  const providerLatencyRows = providerAgg
    .map((p) => {
      const lat = latencyByProvider[p.id];
      const avg = lat && lat.n ? (lat.sum / lat.n / 1000).toFixed(1) + "s" : "—";
      return `<div class="grouped-row"><span class="g-label">${escapeHtml(p.label)}</span><span class="g-value">${avg}</span></div>`;
    })
    .join("");
  const providerTodayRows = providerAgg
    .map((p) => `<div class="grouped-row"><span class="g-label">${escapeHtml(p.label)} hoy</span><span class="g-value">${todayByProvider[p.id] || 0}</span></div>`)
    .join("");
  const ratioLegend = providerAgg
    .map((p) => {
      const pct = totalProviderRequests > 0 ? ((p.requests / totalProviderRequests) * 100).toFixed(0) : "0";
      return `<div class="ratio-legend-item">${escapeHtml(p.label)}: ${p.requests} (${pct}%)</div>`;
    })
    .join("");

  // — System health (image fallbacks are normal behavior, not errors) —
  const oneHourAgo = Date.now() - 3600_000;
  let recentErrors = 0,
    recentErrorFallbacks = 0,
    recentImageFallbacks = 0,
    lastErrorTs = 0;
  for (const r of history) {
    if (r.timestamp >= oneHourAgo) {
      if (!r.success) {
        recentErrors++;
        lastErrorTs = Math.max(lastErrorTs, r.timestamp);
      }
      if (r.fallbackReason && r.fallbackReason !== "images")
        recentErrorFallbacks++;
      if (r.fallbackReason === "images") recentImageFallbacks++;
    }
  }
  let healthStatus, healthColor;
  if (recentErrors >= 3) {
    healthStatus = "Degradado";
    healthColor = "red";
  } else if (recentErrors >= 1 || recentErrorFallbacks >= 2) {
    healthStatus = "Advertencia";
    healthColor = "yellow";
  } else {
    healthStatus = "Saludable";
    healthColor = "green";
  }

  // — Active mode (from roles) —
  const roles = config.roles || { primary: null, validator: null };
  const primaryRole = roles.primary;
  const validatorRole = roles.validator;
  const primaryLabel = primaryRole ? providerLabel(primaryRole.provider) : "—";
  const validatorLabel = validatorRole ? providerLabel(validatorRole.provider) : "—";
  const activeMode = validatorRole
    ? `${primaryLabel} + ${validatorLabel}`
    : `${primaryLabel} (sin validador)`;
  const modeCss = validatorRole ? "hybrid" : "claude";

  const lastModel = history.length ? history[0].model : "—";

  // — Provider bars —
  const byProvider = stats.byProvider || {};
  const providerEntries = Object.entries(byProvider);
  const sourceEntries = providerEntries.length
    ? providerEntries.map(([id, a]) => [providerLabel(id), a.totalRequests || 0, fillClassForProvider(id)])
    : Object.entries(stats.bySource || {}).map(([src, count]) => [providerLabel(src), Number(count), fillClassForProvider(src)]);
  const maxSrc = Math.max(...sourceEntries.map(([, c]) => c), 1);
  const sourceBars = sourceEntries.length
    ? sourceEntries
        .map(
          ([label, count, fill]) => `
        <div class="chart-bar-row">
          <span class="chart-bar-label">${escapeHtml(label)}</span>
          <div class="chart-bar-track">
            <div class="chart-bar-fill ${fill}" style="width:${(count / maxSrc) * 100}%"></div>
          </div>
          <span class="chart-bar-value">${count}</span>
        </div>`,
        )
        .join("")
    : '<div class="no-data-msg">Sin datos aún</div>';

  // — Model bars —
  const modelEntries = Object.entries(stats.byModel || {});
  const maxMdl = Math.max(...modelEntries.map(([, c]) => Number(c)), 1);
  const modelBars = modelEntries.length
    ? modelEntries
        .map(([model, count]) => {
          const fill = model.includes("deepseek")
            ? "fill-deepseek"
            : model.includes("claude")
              ? "fill-claude"
              : "fill-default";
          return `
        <div class="chart-bar-row">
          <span class="chart-bar-label">${shortModel(model)}</span>
          <div class="chart-bar-track">
            <div class="chart-bar-fill ${fill}" style="width:${(count / maxMdl) * 100}%"></div>
          </div>
          <span class="chart-bar-value">${count}</span>
        </div>`;
        })
        .join("")
    : '<div class="no-data-msg">Sin datos aún</div>';

  // — History rows —
  const historyRows = history
    .map((r, i) => {
      const time = new Date(r.timestamp).toLocaleString();
      const pid = providerIdOf(r);
      const srcBadge = badgeClassForProvider(pid);
      const statusBadge = r.success ? "badge-success" : "badge-error";
      const validated = r.validated ? "badge-yes" : "badge-no";
      const trigger = r.trigger || "auto";
      const plat = r.platform || "other";
      const isQA = plat === "qa-manual";
      return `
      <tr data-idx="${i}" data-platform="${escapeAttr(plat)}" data-source="${escapeAttr(pid)}" data-model="${escapeAttr(r.model || "")}" data-validated="${r.validated ? "yes" : "no"}">
        <td>${time}</td>
        <td><span class="text-truncate" title="${escapeAttr(r.questionText)}">${escapeHtml(r.questionText)}</span></td>
        <td><span class="badge ${srcBadge}">${escapeHtml(providerLabel(pid))}</span>${r.role ? ` <span class="role-tag">${escapeHtml(roleLabel(r.role))}</span>` : ""}</td>
        <td>${r.model ? shortModel(r.model) : "—"}</td>
        <td>${isQA ? '<span class="badge badge-qa-manual">QA</span>' : `<span class="badge badge-platform">${plat}</span>`}</td>
        <td>${trigger}</td>
        <td><span class="badge ${validated}">${r.validated ? "sí" : "no"}</span></td>
        <td>${r.inputTokens + r.outputTokens}</td>
        <td>$${r.costUsd.toFixed(6)}</td>
        <td>${(r.latencyMs / 1000).toFixed(1)}s</td>
        <td><span class="badge ${statusBadge}">${r.success ? "OK" : "ERR"}</span></td>
        <td><button class="btn btn-detail-view" data-idx="${i}">🔎 Ver detalles</button></td>
      </tr>`;
    })
    .join("");

  // — Success rate visibility: hide if consistently >98% —
  const showSuccessRate = stats.totalRequests > 0 && stats.successRate < 98;

  // ========== Assemble HTML ==========
  let html = "";

  // — Storage Warning Banner —
  if (storageInfo && storageInfo.level !== "ok") {
    const pct = Math.round(storageInfo.percent * 100);
    const usedMb = (storageInfo.bytesUsed / 1024 / 1024).toFixed(2);
    const totalMb = (storageInfo.bytesTotal / 1024 / 1024).toFixed(1);
    const isCrit = storageInfo.level === "critical";
    html += `
    <div class="storage-warning-banner${isCrit ? " critical" : ""}" id="storage-warning-banner">
      <div class="swb-top">
        <div class="swb-title">
          ${isCrit ? "🔴" : "⚠️"}
          <strong>Almacenamiento chrome.storage.local al ${pct}%</strong>
          ${isCrit ? '<span class="swb-crit-tag">CRÍTICO</span>' : ""}
        </div>
        <button class="btn swb-dismiss-btn" id="swb-dismiss-btn" title="Ocultar aviso">✕</button>
      </div>
      <div class="swb-bar-track"><div class="swb-bar-fill" style="width:${pct}%"></div></div>
      <div class="swb-info">${usedMb} MB usados de ${totalMb} MB — Si el almacenamiento se llena, los nuevos registros no se podrán guardar.</div>
      <div class="swb-actions">
        <span class="swb-act-label">Limpiar historial:</span>
        <button class="btn swb-btn" id="trim-keep-100">Últimas 100</button>
        <button class="btn swb-btn" id="trim-keep-250">Últimas 250</button>
        <button class="btn swb-btn" id="trim-30d">30 días</button>
        <button class="btn swb-btn" id="trim-60d">60 días</button>
        <button class="btn btn-primary swb-btn" id="swb-export-btn">📤 Exportar primero</button>
      </div>
    </div>`;
  }

  // — Mode Banner —
  html += `
    <div class="mode-banner">
      <div class="mode-info">
        <div class="mode-item">
          <span class="label">Modo:</span>
          <span class="mode-tag ${modeCss}">${activeMode}</span>
        </div>
        <div class="mode-item">
          <span class="label">Principal:</span>
          <span class="value">${primaryRole ? `${escapeHtml(primaryLabel)} · ${shortModel(primaryRole.model)}` : "—"}</span>
        </div>
        <div class="mode-item">
          <span class="label">Validador:</span>
          <span class="value">${validatorRole ? `${escapeHtml(validatorLabel)} · ${shortModel(validatorRole.model)}` : "Ninguno"}</span>
        </div>
      </div>
      <div class="banner-right">
        <div class="dev-toggle">
          <span>Dev Mode</span>
          <label class="switch">
            <input type="checkbox" id="dev-mode-toggle" ${devMode ? "checked" : ""} />
            <span class="slider"></span>
          </label>
        </div>
      </div>
    </div>`;

  // — System Health —
  const lastErrStr = lastErrorTs
    ? new Date(lastErrorTs).toLocaleTimeString()
    : "—";
  html += `
    <div class="health-bar">
      <div class="health-dot ${healthColor}"></div>
      <span class="health-label">Sistema: ${healthStatus}</span>
      <div class="health-items">
        <span>Errores (1h): <span class="${recentErrors === 0 ? "tag-ok" : "tag-fail"}">${recentErrors}</span></span>
        <span>Fallbacks API (1h): <span class="${recentErrorFallbacks === 0 ? "tag-ok" : "tag-warn"}">${recentErrorFallbacks}</span></span>
        <span>Image→Validador (1h): <span class="tag-ok">${recentImageFallbacks}</span></span>
        <span>Último error: ${lastErrStr}</span>
      </div>
    </div>`;

  // — Overview Stats (compact) —
  html += `
    <div class="section-title">📈 Resumen</div>
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-value">${stats.totalRequests}</div>
        <div class="stat-label">Total Peticiones</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${requestsToday}</div>
        <div class="stat-label">Peticiones Hoy</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${(stats.avgLatencyMs / 1000).toFixed(1)}s</div>
        <div class="stat-label">Latencia Prom.</div>
      </div>
      ${
        showSuccessRate
          ? `
      <div class="stat-card ${stats.successRate >= 90 ? "success" : "danger"}">
        <div class="stat-value">${stats.successRate.toFixed(1)}%</div>
        <div class="stat-label">Tasa de Éxito</div>
      </div>`
          : ""
      }
    </div>`;

  // — Usage by provider —
  if (providerAgg.length > 0) {
    html += `
    <div class="ratio-card">
      <h3>🔀 Uso por Proveedor</h3>
      <div class="ratio-legend">
        ${ratioLegend}
      </div>
    </div>`;
  }

  // — Tokens + Costs (grouped, de-duplicated) —
  html += `
    <div class="dual-section">
      <div class="grouped-card">
        <h3>📊 Tokens</h3>
        <div class="grouped-row"><span class="g-label">Hoy</span><span class="g-value accent">${formatTokens(tokensToday)}</span></div>
        <div class="grouped-row"><span class="g-label">Total</span><span class="g-value">${formatTokens(totalTokens)}</span></div>
        <div class="grouped-row"><span class="g-label">Prom / petición</span><span class="g-value">${formatTokens(tokensPerReq)}</span></div>
        ${providerTokenRows}
      </div>
      <div class="grouped-card">
        <h3>💰 Costos</h3>
        <div class="grouped-row"><span class="g-label">Hoy</span><span class="g-value accent">$${costToday.toFixed(4)}</span></div>
        <div class="grouped-row"><span class="g-label">Total</span><span class="g-value">$${stats.totalCostUsd.toFixed(4)}</span></div>
        <div class="grouped-row"><span class="g-label">Est. Mensual (14d)</span><span class="g-value">$${estMonthlyCost.toFixed(2)}</span></div>
        ${providerCostRows}
      </div>
    </div>`;

  // — Latency + Routing —
  html += `
    <div class="dual-section">
      <div class="grouped-card">
        <h3>⏱️ Latencia por Proveedor</h3>
        ${providerLatencyRows}
        <div class="grouped-row"><span class="g-label">Global prom.</span><span class="g-value">${stats.totalRequests ? (stats.avgLatencyMs / 1000).toFixed(1) + "s" : "—"}</span></div>
      </div>
      <div class="grouped-card">
        <h3>🔀 Routing y Validación</h3>
        ${providerTodayRows}
        <div class="grouped-row"><span class="g-label">Validaciones</span><span class="g-value">${claudeValidations}</span></div>
        <div class="grouped-row"><span class="g-label">Fallbacks API</span><span class="g-value ${fallbacks > 0 ? "accent" : ""}">${fallbacks}</span></div>
        <div class="grouped-row"><span class="g-label">Fallbacks imagen</span><span class="g-value">${imageFallbacks}</span></div>
      </div>
    </div>`;

  // — Dev Mode Panel —
  html += `<div id="dev-panel-area">${devMode ? '<div class="dev-panel-hint">🛠️ <strong>Dev Mode activo</strong> — Haz clic en <strong>🔎 Ver detalles</strong> en cualquier fila del historial para inspeccionar el trace completo de esa petición.</div>' : ""}</div>`;

  // — Charts (hidden if insufficient data) —
  const hasSourceData = sourceEntries.length > 0;
  const hasModelData = modelEntries.length > 0;

  if (hasSourceData || hasModelData) {
    html += `
    <div class="section-title">📊 Distribución</div>
    <div class="charts-row">
      ${
        hasSourceData
          ? `
      <div class="chart-card">
        <h3>Peticiones por Proveedor</h3>
        <div class="chart-bar-container">${sourceBars}</div>
      </div>`
          : ""
      }
      ${
        hasModelData
          ? `
      <div class="chart-card">
        <h3>Peticiones por Modelo</h3>
        <div class="chart-bar-container">${modelBars}</div>
      </div>`
          : ""
      }
    </div>`;
  }

  // — History Table —
  const platformOptions = platforms.length
    ? platforms
        .map((p) => `<option value="${escapeAttr(p)}">${p}</option>`)
        .join("")
    : "";
  const providerIds = [...new Set(history.map((r) => providerIdOf(r)))].sort();
  const sourceOptions = providerIds.length
    ? providerIds
        .map(
          (id) =>
            `<option value="${escapeAttr(id)}">${escapeHtml(providerLabel(id))}</option>`,
        )
        .join("")
    : "";
  const modelOptions = Object.keys(stats.byModel || {}).sort().length
    ? Object.keys(stats.byModel || {})
        .sort()
        .map(
          (m) =>
            `<option value="${escapeAttr(m)}">${escapeHtml(shortModel(m))}</option>`,
        )
        .join("")
    : "";
  html += `
    <div class="section-title">📋 Historial Reciente</div>
    <div class="history-card">
      <div class="history-toolbar">
        <label for="platform-filter">🌐 Plataforma:</label>
        <select id="platform-filter" class="platform-select">
          <option value="all" selected>Todas</option>
          ${platformOptions}
        </select>
        <label for="source-filter">Proveedor:</label>
        <select id="source-filter" class="platform-select">
          <option value="all" selected>Todas</option>
          ${sourceOptions}
        </select>
        <label for="model-filter">🤖 Modelo:</label>
        <select id="model-filter" class="platform-select">
          <option value="all" selected>Todos</option>
          ${modelOptions}
        </select>
        <label for="valid-filter">✅ Valid.:</label>
        <select id="valid-filter" class="platform-select">
          <option value="all" selected>Todas</option>
          <option value="yes">Sí</option>
          <option value="no">No</option>
        </select>
        <div class="history-pagination">
          <button class="btn-page" id="page-prev" title="Página anterior" disabled>←</button>
          <button class="btn-page" id="page-next" title="Página siguiente">→</button>
          <span class="page-info" id="page-info">1 / 1</span>
          <label class="lines-label">FILAS<br>POR<br>PÁGINA</label>
          <select id="page-size" class="platform-select page-size-select">
            <option value="10" selected>10</option>
            <option value="25">25</option>
            <option value="50">50</option>
            <option value="100">100</option>
          </select>
        </div>
      </div>
      <div class="table-wrap">
        <table class="history-table">
          <thead>
            <tr>
              <th>Hora</th>
              <th>Pregunta</th>
              <th>Proveedor</th>
              <th>Modelo</th>
              <th>Plataforma</th>
              <th>Trigger</th>
              <th>Valid.</th>
              <th>Tokens</th>
              <th>Costo</th>
              <th>Latencia</th>
              <th>Estado</th>
              <th></th>
            </tr>
          </thead>
          <tbody id="history-tbody">${historyRows || '<tr><td colspan="12" style="text-align:center;color:var(--text-secondary);">Sin historial aún</td></tr>'}</tbody>
        </table>
      </div>
    </div>`;

  // — How to Use —
  html += `
    <div class="section-title">📖 Cómo Usar</div>
    <div class="howto-card">
      <div class="howto-columns">

        <div class="howto-col">
          <div class="howto-col-title">⌨️ Atajos de Teclado</div>
          <div class="howto-shortcuts">
            <div class="ks-row"><kbd>SHIFT</kbd><span>Quick Mode — responde con la letra de la opción correcta al instante</span></div>
            <div class="ks-row"><kbd>ALT + W</kbd><span>Re-detectar preguntas en la página actual (útil tras cambiar de pregunta manualmente)</span></div>
            <div class="ks-row"><kbd>ALT + X</kbd><span>Cancelar petición de IA en curso</span></div>
            <div class="ks-row"><kbd>CTRL + SHIFT</kbd><span>Forzar Claude directo, saltándose DeepSeek</span></div>
          </div>
        </div>

        <div class="howto-col">
          <div class="howto-col-title">Configuración</div>
          <ul class="howto-list">
            <li><strong>Proveedores:</strong> Configura tus claves de API en la página Proveedores. Se guardan cifradas.</li>
            <li><strong>Principal:</strong> El modelo que analiza primero.</li>
            <li><strong>Validador:</strong> Modelo opcional que valida o corrige cuando la confianza no es alta.</li>
            <li><strong>Visión:</strong> Activa "Visión" por modelo para preguntas con imágenes.</li>
          </ul>
        </div>

        <div class="howto-col">
          <div class="howto-col-title">Flujo de Análisis</div>
          <ol class="howto-list">
            <li>La extensión detecta la pregunta visible automáticamente.</li>
            <li><strong>Quick Mode (SHIFT):</strong> el principal responde → si confianza alta → respuesta directa. Si no → valida el validador.</li>
            <li><strong>Análisis Completo (clic badge):</strong> genera explicación detallada con streaming.</li>
            <li>Si hay imágenes, se usa un proveedor/modelo con visión.</li>
            <li>El banco de preguntas local (solo netacad) se consulta primero; si hay coincidencia alta responde al instante sin IA.</li>
          </ol>
        </div>

        <div class="howto-col">
          <div class="howto-col-title">🌐 Plataformas Soportadas</div>
          <ul class="howto-list">
            <li><strong>NetAcad / SkillsForAll:</strong> MCQ y Matching (drag-drop y dropdown)</li>
            <li><strong>Moodle:</strong> MCQ, True/False, Match, Short Answer, Numerical, Select Missing Words</li>
            <li>La detección es automática; usa ALT+W si la pregunta no se detecta.</li>
          </ul>
        </div>

      </div>
    </div>`;

  // — Manual QA Menu —
  html += `
    <div class="section-title">🧪 QA Manual</div>
    <div class="qa-card">
      <div class="qa-guide">
        <h3>Validación rápida sin entrar a un quiz real</h3>
        <ul>
          <li>Inyecta un escenario en <strong>example.com</strong>.</li>
          <li>Usa <strong>SHIFT</strong> para quick mode o clic en badge para análisis completo.</li>
          <li>Usa <strong>ALT+W</strong> para re-detectar y repetir pruebas.</li>
        </ul>
        <div class="qa-warning">
          ⚠️ <strong>Aviso:</strong> Estos escenarios utilizan la IA real para verificar el funcionamiento de la extensión. Se selecciona automáticamente el modelo más económico disponible (<strong>Haiku</strong>) para minimizar el costo de las pruebas. Las peticiones aparecerán en el historial marcadas como <span class="badge badge-qa-manual" style="font-size:10px;">QA</span>.
        </div>
      </div>

      <div class="qa-platform-group">
        <div class="qa-platform-header qa-netacad-header">🔵 NetAcad</div>
        <div class="qa-actions">
          <button class="btn" id="qa-netacad-mcq-btn" data-tooltip="Pregunta de opción múltiple en componente NetAcad">MCQ</button>
          <button class="btn" id="qa-netacad-matching-btn" data-tooltip="Pregunta de relación tipo drag/drop en NetAcad">Matching</button>
          <button class="btn btn-accent" id="qa-netacad-quiz-btn" data-tooltip="Quiz completo con navegación">🎯 Quiz Real</button>
        </div>
      </div>

      <div class="qa-platform-group">
        <div class="qa-platform-header qa-moodle-header">🟣 Moodle</div>
        <div class="qa-actions">
          <button class="btn" id="qa-moodle-mcq-btn" data-tooltip="Moodle opción múltiple clásico">MCQ</button>
          <button class="btn" id="qa-moodle-tf-btn" data-tooltip="Moodle verdadero/falso">V/F</button>
          <button class="btn" id="qa-moodle-match-btn" data-tooltip="Moodle tipo relacionar (tabla con dropdowns)">Match</button>
          <button class="btn" id="qa-moodle-shortanswer-btn" data-tooltip="Respuesta corta libre">Short Answer</button>
          <button class="btn" id="qa-moodle-numerical-btn" data-tooltip="Respuesta numérica">Numerical</button>
          <button class="btn" id="qa-moodle-gapselect-btn" data-tooltip="Selecciona palabras faltantes con dropdowns">Gap Select</button>
          <button class="btn" id="qa-moodle-multi-btn" data-tooltip="Varias preguntas visibles a la vez (responde todas con SHIFT)">Multi</button>
          <button class="btn btn-accent" id="qa-moodle-quiz-btn" data-tooltip="Quiz completo con navegación">🎯 Quiz Real</button>
        </div>
      </div>

      <div class="qa-actions" style="margin-top:10px">
        <button class="btn btn-primary" id="qa-guide-btn" data-tooltip="Ver checklist detallado de pasos para validar la extensión">Ver guía completa</button>
      </div>
    </div>`;

  // — Action Buttons —
  html += `
    <div class="section-title">⚙️ Acciones</div>
    <div class="actions-row">
      <button class="btn btn-reset-state" id="force-reset-btn" data-tooltip="Limpia los bloqueos de procesamiento activos (flags de petición en curso). NO borra historial ni estadísticas. Útil si la extensión queda 'colgada'.">⚡ Forzar reinicio de estado IA</button>
      <button class="btn btn-warning" id="reset-session-btn" data-tooltip="Las estadísticas de sesión se recalculan automáticamente del historial. Usa 'Reset Completo' para borrar todo.">🔄 Reset Estadísticas Sesión</button>
      <button class="btn btn-danger" id="full-reset-btn" data-tooltip="⚠️ Borra TODOS los datos: historial, estadísticas, logs y caché. Acción irreversible.">🗑️ Reset Completo</button>
      <button class="btn" id="export-logs-btn" data-tooltip="Descarga un archivo JSON con el historial completo y las estadísticas de uso.">📤 Exportar Logs</button>
    </div>`;

  return html;
}

// ============================================
// Post-render Event Binding
// ============================================

function bindDynamicEvents(history, devMode) {
  // ---- Storage Warning Actions ----
  const swbDismiss = document.getElementById("swb-dismiss-btn");
  if (swbDismiss) {
    swbDismiss.addEventListener("click", () => {
      const banner = document.getElementById("storage-warning-banner");
      if (banner) banner.style.display = "none";
    });
  }

  const doTrim = async (opts, label) => {
    if (
      !confirm(
        `¿${label}? Esta acción eliminará los registros más antiguos. Exporta primero si necesitas conservarlos.`,
      )
    )
      return;
    try {
      const res = await chrome.runtime
        .sendMessage({ type: "TRIM_HISTORY", ...opts })
        .catch(() => null);
      if (res?.success) {
        alert(
          `✅ Se eliminaron ${res.deleted} registro${res.deleted !== 1 ? "s" : ""}. El almacenamiento se ha liberado.`,
        );
        loadData();
      } else {
        alert("Error al limpiar: " + (res?.error || "desconocido"));
      }
    } catch (e) {
      alert("Error: " + e.message);
    }
  };

  const trimKeep100 = document.getElementById("trim-keep-100");
  if (trimKeep100)
    trimKeep100.addEventListener("click", () =>
      doTrim({ keepLast: 100 }, "Conservar solo las últimas 100 entradas"),
    );

  const trimKeep250 = document.getElementById("trim-keep-250");
  if (trimKeep250)
    trimKeep250.addEventListener("click", () =>
      doTrim({ keepLast: 250 }, "Conservar solo las últimas 250 entradas"),
    );

  const trim30d = document.getElementById("trim-30d");
  if (trim30d)
    trim30d.addEventListener("click", () =>
      doTrim(
        { keepDays: 30 },
        "Conservar solo registros de los últimos 30 días",
      ),
    );

  const trim60d = document.getElementById("trim-60d");
  if (trim60d)
    trim60d.addEventListener("click", () =>
      doTrim(
        { keepDays: 60 },
        "Conservar solo registros de los últimos 60 días",
      ),
    );

  const swbExport = document.getElementById("swb-export-btn");
  if (swbExport) {
    swbExport.addEventListener("click", () => {
      const exportBtn = document.getElementById("export-logs-btn");
      if (exportBtn) exportBtn.click();
    });
  }

  // Dev mode toggle
  const devToggle = document.getElementById("dev-mode-toggle");
  if (devToggle) {
    devToggle.addEventListener("change", async (e) => {
      const on = e.target.checked;
      await chrome.storage.local.set({ dashboardDevMode: on });
      cachedDevMode = on;
      const area = document.getElementById("dev-panel-area");
      if (area) {
        area.innerHTML = on
          ? '<div class="dev-panel-hint">🛠️ <strong>Dev Mode activo</strong> — Haz clic en <strong>🔎 Ver detalles</strong> en cualquier fila del historial para inspeccionar el trace completo de esa petición.</div>'
          : "";
      }
    });
  }

  // ---- History Pagination ----
  let historyPage = 0;
  let historyPageSize = 10;

  function getFilteredRows() {
    const allRows = Array.from(
      document.querySelectorAll("#history-tbody tr[data-platform]"),
    );
    const platVal = document.getElementById("platform-filter")?.value || "all";
    const sourceVal = document.getElementById("source-filter")?.value || "all";
    const modelVal = document.getElementById("model-filter")?.value || "all";
    const validVal = document.getElementById("valid-filter")?.value || "all";
    return allRows.filter(
      (row) =>
        (platVal === "all" || row.dataset.platform === platVal) &&
        (sourceVal === "all" || row.dataset.source === sourceVal) &&
        (modelVal === "all" || row.dataset.model === modelVal) &&
        (validVal === "all" || row.dataset.validated === validVal),
    );
  }

  function applyPagination() {
    const filtered = getFilteredRows();
    const totalPages = Math.max(
      1,
      Math.ceil(filtered.length / historyPageSize),
    );
    if (historyPage >= totalPages) historyPage = totalPages - 1;
    if (historyPage < 0) historyPage = 0;

    // Hide all rows first
    document
      .querySelectorAll("#history-tbody tr[data-platform]")
      .forEach((row) => {
        row.style.display = "none";
      });

    // Show only the current page of filtered rows
    const start = historyPage * historyPageSize;
    const end = start + historyPageSize;
    filtered.forEach((row, idx) => {
      row.style.display = idx >= start && idx < end ? "" : "none";
    });

    // Update controls
    const prevBtn = document.getElementById("page-prev");
    const nextBtn = document.getElementById("page-next");
    const pageInfo = document.getElementById("page-info");
    if (prevBtn) prevBtn.disabled = historyPage <= 0;
    if (nextBtn) nextBtn.disabled = historyPage >= totalPages - 1;
    if (pageInfo) pageInfo.textContent = `${historyPage + 1} / ${totalPages}`;
  }

  // Platform filter
  const platformFilter = document.getElementById("platform-filter");
  if (platformFilter) {
    platformFilter.addEventListener("change", () => {
      historyPage = 0;
      applyPagination();
    });
  }

  const sourceFilter = document.getElementById("source-filter");
  if (sourceFilter) {
    sourceFilter.addEventListener("change", () => {
      historyPage = 0;
      applyPagination();
    });
  }

  const modelFilter = document.getElementById("model-filter");
  if (modelFilter) {
    modelFilter.addEventListener("change", () => {
      historyPage = 0;
      applyPagination();
    });
  }

  const validFilter = document.getElementById("valid-filter");
  if (validFilter) {
    validFilter.addEventListener("change", () => {
      historyPage = 0;
      applyPagination();
    });
  }

  // Page size selector
  const pageSizeSelect = document.getElementById("page-size");
  if (pageSizeSelect) {
    pageSizeSelect.addEventListener("change", () => {
      historyPageSize = parseInt(pageSizeSelect.value, 10) || 10;
      historyPage = 0;
      applyPagination();
    });
  }

  // Prev / Next buttons
  const prevBtn = document.getElementById("page-prev");
  const nextBtn = document.getElementById("page-next");
  if (prevBtn)
    prevBtn.addEventListener("click", () => {
      historyPage--;
      applyPagination();
    });
  if (nextBtn)
    nextBtn.addEventListener("click", () => {
      historyPage++;
      applyPagination();
    });

  // Initial pagination render
  applyPagination();

  // Detail view buttons → open detail subpage
  document.querySelectorAll(".btn-detail-view").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.idx, 10);
      openRecordDetail(idx);
    });
  });

  // Manual QA menu
  const QA_TEST_URL = "https://example.com";

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const sendQAMessageWithRetry = async (tabId, message) => {
    let lastError = null;
    for (let attempt = 1; attempt <= 8; attempt++) {
      try {
        await chrome.tabs.sendMessage(tabId, message);
        return true;
      } catch (error) {
        lastError = error;
        await sleep(350);
      }
    }
    throw lastError || new Error("No se pudo comunicar con la pestaña de QA");
  };

  const getUsableQATabId = async () => {
    const existingTabs = await chrome.tabs.query({
      url: ["https://example.com/*"],
      currentWindow: true,
    });

    if (existingTabs.length > 0 && existingTabs[0]?.id) {
      await chrome.tabs.update(existingTabs[0].id, { active: true });
      return existingTabs[0].id;
    }

    const qaTab = await chrome.tabs.create({
      url: QA_TEST_URL,
      active: true,
    });

    if (!qaTab?.id) {
      throw new Error("No se pudo crear pestaña QA");
    }

    // Esperar a que cargue para que el content script esté disponible
    await sleep(1200);
    return qaTab.id;
  };

  const runQAScenario = async (scenario) => {
    try {
      const tabId = await getUsableQATabId();
      await sendQAMessageWithRetry(tabId, {
        type: "QA_INJECT_SCENARIO",
        scenario,
      });

      alert(
        "Escenario QA cargado.\n\nSiguiente paso:\n1) SHIFT para quick mode\n2) Clic en badge para non-quick\n3) ALT+W para re-detección",
      );
    } catch (e) {
      alert(
        "No se pudo ejecutar QA automáticamente. Verifica permisos de la extensión y vuelve a intentar desde una pestaña web normal.",
      );
    }
  };

  const qaGuideBtn = document.getElementById("qa-guide-btn");
  if (qaGuideBtn) {
    qaGuideBtn.addEventListener("click", showQAGuideModal);
  }

  const qaMoodleMcqBtn = document.getElementById("qa-moodle-mcq-btn");
  if (qaMoodleMcqBtn) {
    qaMoodleMcqBtn.addEventListener("click", () => runQAScenario("moodle-mcq"));
  }

  const qaMoodleTfBtn = document.getElementById("qa-moodle-tf-btn");
  if (qaMoodleTfBtn) {
    qaMoodleTfBtn.addEventListener("click", () =>
      runQAScenario("moodle-truefalse"),
    );
  }

  const qaNetacadMcqBtn = document.getElementById("qa-netacad-mcq-btn");
  if (qaNetacadMcqBtn) {
    qaNetacadMcqBtn.addEventListener("click", () =>
      runQAScenario("netacad-mcq"),
    );
  }

  const qaNetacadMatchingBtn = document.getElementById(
    "qa-netacad-matching-btn",
  );
  if (qaNetacadMatchingBtn) {
    qaNetacadMatchingBtn.addEventListener("click", () =>
      runQAScenario("netacad-matching"),
    );
  }

  const qaNetacadQuizBtn = document.getElementById("qa-netacad-quiz-btn");
  if (qaNetacadQuizBtn) {
    qaNetacadQuizBtn.addEventListener("click", () =>
      runQAScenario("netacad-quiz"),
    );
  }

  const qaMoodleMatchBtn = document.getElementById("qa-moodle-match-btn");
  if (qaMoodleMatchBtn) {
    qaMoodleMatchBtn.addEventListener("click", () =>
      runQAScenario("moodle-match"),
    );
  }

  const qaMoodleShortAnswerBtn = document.getElementById(
    "qa-moodle-shortanswer-btn",
  );
  if (qaMoodleShortAnswerBtn) {
    qaMoodleShortAnswerBtn.addEventListener("click", () =>
      runQAScenario("moodle-shortanswer"),
    );
  }

  const qaMoodleNumericalBtn = document.getElementById(
    "qa-moodle-numerical-btn",
  );
  if (qaMoodleNumericalBtn) {
    qaMoodleNumericalBtn.addEventListener("click", () =>
      runQAScenario("moodle-numerical"),
    );
  }

  const qaMoodleGapSelectBtn = document.getElementById(
    "qa-moodle-gapselect-btn",
  );
  if (qaMoodleGapSelectBtn) {
    qaMoodleGapSelectBtn.addEventListener("click", () =>
      runQAScenario("moodle-gapselect"),
    );
  }

  const qaMoodleMultiBtn = document.getElementById("qa-moodle-multi-btn");
  if (qaMoodleMultiBtn) {
    qaMoodleMultiBtn.addEventListener("click", () =>
      runQAScenario("moodle-multi"),
    );
  }

  const qaMoodleQuizBtn = document.getElementById("qa-moodle-quiz-btn");
  if (qaMoodleQuizBtn) {
    qaMoodleQuizBtn.addEventListener("click", () =>
      runQAScenario("moodle-quiz"),
    );
  }

  // Force AI State Reset (clears processing locks, NOT history/stats)
  const forceResetBtn = document.getElementById("force-reset-btn");
  if (forceResetBtn) {
    forceResetBtn.addEventListener("click", async () => {
      if (
        !confirm(
          "⚡ Esto limpiará todos los bloqueos de peticiones pendientes y flags de procesamiento.\nHistorial y estadísticas NO se verán afectados.\n\n¿Continuar?",
        )
      )
        return;
      try {
        // Cancel any active DeepSeek request
        await chrome.runtime
          .sendMessage({ type: "CANCEL_DEEPSEEK" })
          .catch(() => {});
        // Reset content script state on active tab
        const [tab] = await chrome.tabs.query({
          active: true,
          currentWindow: true,
        });
        if (tab?.id) {
          await chrome.tabs
            .sendMessage(tab.id, { type: "FORCE_STATE_RESET" })
            .catch(() => {});
        }
        alert(
          "Reinicio de estado IA completado. La extensión está lista para nuevas peticiones.",
        );
      } catch (e) {
        alert("Error: " + e.message);
      }
    });
  }

  // Reset session
  const resetSession = document.getElementById("reset-session-btn");
  if (resetSession) {
    resetSession.addEventListener("click", async () => {
      if (
        !confirm(
          "¿Limpiar estadísticas de sesión diaria? El historial completo se mantiene.",
        )
      )
        return;
      // We clear today's counters by clearing all usage data
      // Since counters are derived from records, we'd need to just reload
      // For now: inform user this resets all data
      alert(
        "Las estadísticas de sesión se recalculan del historial. Use 'Reset Completo' para borrar todo.",
      );
    });
  }

  // Full reset
  const fullReset = document.getElementById("full-reset-btn");
  if (fullReset) {
    fullReset.addEventListener("click", async () => {
      if (
        !confirm(
          "¿Borrar TODOS los datos? Esto incluye historial, estadísticas, logs y caché. No se puede deshacer.",
        )
      )
        return;
      await Promise.all([
        chrome.runtime.sendMessage({ type: "CLEAR_USAGE_DATA" }),
        chrome.storage.local.remove([
          "errorLog",
          "lastAiResponse",
          "lastApiRequestData",
          "dashboardDevMode",
        ]),
      ]);
      loadData();
    });
  }

  // Export logs
  const exportBtn = document.getElementById("export-logs-btn");
  if (exportBtn) {
    exportBtn.addEventListener("click", async () => {
      try {
        const [statsRes, historyRes, storageData] = await Promise.all([
          chrome.runtime
            .sendMessage({ type: "GET_USAGE_STATS" })
            .catch(() => ({})),
          chrome.runtime
            .sendMessage({ type: "GET_USAGE_HISTORY", limit: 500 })
            .catch(() => ({})),
          chrome.storage.local.get(["errorLog"]),
        ]);

        const exportData = {
          exportedAt: new Date().toISOString(),
          stats: statsRes?.stats || {},
          history: historyRes?.history || [],
          errorLog: storageData?.errorLog || "",
        };

        const blob = new Blob([JSON.stringify(exportData, null, 2)], {
          type: "application/json",
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download =
          "study-assist-logs-" +
          new Date().toISOString().split("T")[0] +
          ".json";
        a.click();
        URL.revokeObjectURL(url);
      } catch (e) {
        alert("Error exportando: " + e.message);
      }
    });
  }
}

function showQAGuideModal() {
  const detailHtml = `
    <div class="modal-detail-grid">
      <span class="label">Objetivo:</span>
      <span class="value">Validar detección y respuesta de la extensión sin entrar a una plataforma real.</span>

      <span class="label">Quick mode:</span>
      <span class="value">SHIFT para analizar. En V/F debe mostrar <strong>V</strong> o <strong>F</strong>.</span>

      <span class="label">Non-quick:</span>
      <span class="value">Clic en badge para abrir overlay y verificar análisis completo.</span>

      <span class="label">Re-detección:</span>
      <span class="value">ALT+W para reiniciar detección del escenario actual.</span>
    </div>
    <h4 style="margin: 12px 0 6px;">Checklist sugerido</h4>
    <pre>
1) Activar extensión y configurar API keys.
2) Desde este panel ejecutar un escenario (se abrirá/reutilizará example.com).
3) Desde este panel, ejecutar:
   - Moodle MCQ
   - Moodle V/F
   - NetAcad MCQ
   - NetAcad Matching
4) Verificar:
   - Se detecta al menos 1 pregunta
   - Quick mode responde correctamente
   - En Moodle V/F quick mode muestra V o F
   - Non-quick muestra análisis sin errores
5) Para terminar, puedes cerrar la pestaña de example.com.
    </pre>
  `;

  showModal("🧪 Guía QA Manual", detailHtml);
}

// ============================================
// Record Detail Subpage
// ============================================

async function openRecordDetail(idx) {
  const r = cachedHistory[idx];
  if (!r) return;

  // Try to load raw API data – only matches if this is the most recent request
  let apiData = null;
  try {
    const result = await chrome.storage.local.get(["lastApiRequestData"]);
    const raw = result.lastApiRequestData;
    // Match if the API data timestamp is within 90s of the record
    if (raw && Math.abs(raw.timestamp - r.timestamp) < 90000) {
      apiData = raw;
    }
  } catch (_) {}

  const el = document.getElementById("content");
  el.innerHTML = renderRecordDetailPage(
    r,
    idx,
    cachedHistory,
    cachedDevMode,
    apiData,
  );

  // Back button
  document
    .getElementById("detail-back-btn")
    ?.addEventListener("click", loadData);

  // Prev / Next navigation (history is newest-first, so idx+1 = older)
  document
    .getElementById("detail-prev-btn")
    ?.addEventListener("click", () => openRecordDetail(idx + 1));
  document
    .getElementById("detail-next-btn")
    ?.addEventListener("click", () => openRecordDetail(idx - 1));
}

function buildRoutingLines(r) {
  const lines = [];
  const provider = providerLabel(providerIdOf(r));

  if (r.source === "question-bank") {
    lines.push(
      "Respuesta instantánea del banco de preguntas local (sin llamada a la IA).",
    );
    lines.push(`Confianza de coincidencia: ${r.confidence || "HIGH"}`);
    return lines;
  }

  if (r.role === "primary") {
    lines.push(
      `${provider} (${shortModel(r.model)}) analizó la pregunta como modelo principal.`,
    );
    lines.push(`Confianza: ${r.confidence || "—"}`);
    if (r.confidence === "HIGH") {
      lines.push("Confianza alta → respuesta final directa, sin validación.");
    } else {
      lines.push(
        "Confianza baja o media (no se solicitó validación en este caso).",
      );
    }
    return lines;
  }

  if (r.validated) {
    lines.push(
      "El modelo principal analizó la pregunta (confianza media o baja).",
    );
    lines.push(
      `${provider} (${shortModel(r.model)}) validó y refinó la respuesta.`,
    );
    lines.push("Flujo híbrido completado correctamente.");
  } else if (r.fallbackReason === "images") {
    lines.push("La pregunta contiene imágenes → el modelo principal no las soporta.");
    lines.push(
      `${provider} (${shortModel(r.model)}) respondió directamente con contexto de imagen.`,
    );
  } else if (
    r.fallbackReason === "primary_error" ||
    r.fallbackReason === "deepseek_error"
  ) {
    lines.push("El modelo principal fue contactado pero falló (error de API o red).");
    lines.push(`${provider} (${shortModel(r.model)}) actuó como fallback de error.`);
  } else if (r.fallbackReason) {
    lines.push(`Fallback activado por: ${r.fallbackReason}`);
    lines.push(`${provider} (${shortModel(r.model)}) respondió.`);
  } else {
    lines.push(`${provider} (${shortModel(r.model)}) respondió directamente.`);
    lines.push(
      "El modelo principal no estaba disponible, desactivado, o el tipo de pregunta lo omite.",
    );
  }
  return lines;
}

function renderAnswerBlock(r) {
  const raw = (r.answer || "").trim();

  if (!raw) {
    return '<div class="dp-block dp-muted">— Sin respuesta registrada —</div>';
  }

  // Short answer: already an extracted letter/token (e.g. "C", "V", "A,C", "A-1 B-3")
  // This covers quick mode and question-bank results.
  if (raw.length <= 20) {
    return `<div class="dp-block dp-answer">${escapeHtml(raw)}</div>`;
  }

  // Long answer: full Claude analysis text.
  // Extract the final answer letter(s) to show prominently, rest goes into collapsible.
  const shortMatch =
    raw.match(/ANSWER:\s*([A-J](?:\s*[,|]\s*[A-J])*)/i) ||
    raw.match(/^\s*([A-J])\s*[.:\-]?\s*$/m);
  const shortAnswer = shortMatch ? shortMatch[1].trim().toUpperCase() : null;

  if (shortAnswer) {
    return `
      <div class="dp-block dp-answer">${escapeHtml(shortAnswer)}</div>
      <details class="dp-analysis-details" open>
        <summary class="dp-analysis-summary">📄 Análisis completo de Claude</summary>
        <pre class="dp-trace" style="margin-top:8px;">${escapeHtml(raw)}</pre>
      </details>`;
  }

  // Matching or free-text answer without extractable letter—show as plain pre block.
  return `<pre class="dp-trace">${escapeHtml(raw)}</pre>`;
}

function renderRecordDetailPage(r, idx, history, devMode, apiData) {
  const pid = providerIdOf(r);
  const srcBadge = badgeClassForProvider(pid);
  const statusBadge = r.success ? "badge-success" : "badge-error";
  const time = new Date(r.timestamp).toLocaleString();
  const isQA = r.platform === "qa-manual";
  const routingLines = buildRoutingLines(r);

  const metrics = [
    { k: "Proveedor", v: providerLabel(pid) + (r.role ? ` (${roleLabel(r.role)})` : "") },
    { k: "Modelo", v: shortModel(r.model) || "—" },
    {
      k: "Plataforma",
      v: isQA ? "QA Manual (example.com)" : r.platform || "—",
    },
    { k: "Tipo de Pregunta", v: r.questionType || "—" },
    { k: "Modo de Respuesta", v: r.responseMode || "—" },
    { k: "Trigger", v: r.trigger || "auto" },
    { k: "Confianza", v: r.confidence || "—" },
    { k: "Validado por Claude", v: r.validated ? "✅ Sí" : "No" },
    { k: "Razón de Fallback", v: r.fallbackReason || "—" },
    { k: "Estado", v: r.success ? "✅ Éxito" : "❌ Error" },
    { k: "Tokens de Entrada", v: String(r.inputTokens) },
    { k: "Tokens de Salida", v: String(r.outputTokens) },
    { k: "Tokens Totales", v: String(r.inputTokens + r.outputTokens) },
    { k: "Costo", v: "$" + r.costUsd.toFixed(6) },
    { k: "Latencia", v: (r.latencyMs / 1000).toFixed(2) + "s" },
    { k: "Fecha/Hora", v: time },
  ];

  const metricsHtml = metrics
    .map(
      (m) => `
    <div class="dp-metric-row">
      <span class="dp-metric-key">${escapeHtml(m.k)}</span>
      <span class="dp-metric-val">${escapeHtml(m.v)}</span>
    </div>`,
    )
    .join("");

  let html = `
    <div class="detail-page">

      <!-- Header -->
      <div class="dp-header">
        <button class="btn" id="detail-back-btn">← Volver al Dashboard</button>
        <div class="dp-title-row">
          <h2>🔎 Detalles de Petición</h2>
          <span class="badge ${srcBadge}" style="font-size:12px;padding:3px 12px;">${escapeHtml(providerLabel(pid))}</span>
          <span class="badge ${statusBadge}">${r.success ? "OK" : "ERROR"}</span>
          ${isQA ? '<span class="badge badge-qa-manual">QA Manual</span>' : ""}
        </div>
        <span class="dp-timestamp">${time}</span>
      </div>

      <!-- Question -->
      <div class="dp-section">
        <div class="dp-section-label">📝 Pregunta</div>
        <div class="dp-block">${escapeHtml(r.questionText || "—")}</div>
      </div>

      <!-- Answer -->
      <div class="dp-section">
        <div class="dp-section-label">💬 Respuesta Final</div>
        ${renderAnswerBlock(r)}
      </div>

      <!-- Routing -->
      <div class="dp-section">
        <div class="dp-section-label">🔀 Decisión de Enrutamiento</div>
        <div class="dp-block dp-routing">
          ${
            routingLines.length
              ? routingLines
                  .map(
                    (l) =>
                      `<div class="dp-routing-line">${escapeHtml(l)}</div>`,
                  )
                  .join("")
              : '<span class="dp-muted">Sin datos de enrutamiento disponibles.</span>'
          }
        </div>
      </div>

      ${
        r.deepseekReasoning
          ? `
      <!-- DeepSeek Reasoning -->
      <div class="dp-section">
        <div class="dp-section-label" style="color:var(--color-hybrid);">Razonamiento (principal)</div>
        <pre class="dp-trace">${escapeHtml(r.deepseekReasoning)}</pre>
      </div>`
          : ""
      }

      ${
        r.claudeThinking
          ? `
      <!-- Claude Thinking -->
      <div class="dp-section">
        <div class="dp-section-label" style="color:var(--color-claude);">Razonamiento (validador)</div>
        <pre class="dp-trace">${escapeHtml(r.claudeThinking)}</pre>
      </div>`
          : ""
      }
      ${
        r.claudeCorrection
          ? `
      <!-- Claude Correction -->
      <div class="dp-section">
        <div class="dp-section-label" style="color:var(--color-claude);">Validación / Corrección</div>
        <pre class="dp-trace">${escapeHtml(r.claudeCorrection)}</pre>
      </div>`
          : ""
      }

      <!-- Metrics -->
      <div class="dp-section">
        <div class="dp-section-label">📊 Métricas Completas</div>
        <div class="dp-metrics-grid">${metricsHtml}</div>
      </div>

      ${
        devMode
          ? `
      <!-- Dev Trace Completo -->
      <div class="dp-section dp-trace-section">
        <div class="dp-section-label">🔍 Trace Completo <span class="dp-dev-badge">DEV MODE</span></div>
        <p class="dp-muted" style="margin-bottom:12px;">Toda la información almacenada sobre esta petición, incluyendo el payload enviado a la API y la respuesta raw recibida.</p>

        <div class="dp-trace-subtitle">📋 Registro de Uso (JSON completo del UsageRecord)</div>
        <pre class="dp-trace">${escapeHtml(JSON.stringify(r, null, 2))}</pre>

        ${
          apiData
            ? `
        <div class="dp-trace-subtitle" style="margin-top:18px;">🔧 Metadata de la Llamada a la API</div>
        <pre class="dp-trace">Tipo:          ${escapeHtml(apiData.type || "—")}
URL:           ${escapeHtml(apiData.url || "—")}
HTTP Status:   ${apiData.status || "—"}
¿Con imágenes?: ${apiData.hasImages ? "Sí" : "No"}
Timestamp:     ${apiData.timestamp ? new Date(apiData.timestamp).toLocaleString() : "—"}</pre>

        <div class="dp-trace-subtitle" style="margin-top:18px;">📤 Request Body — Prompt enviado a la API</div>
        <pre class="dp-trace dp-trace-tall">${escapeHtml(JSON.stringify(apiData.requestBody, null, 2))}</pre>

        <div class="dp-trace-subtitle" style="margin-top:18px;">📥 Response Body — Respuesta raw de la API</div>
        <pre class="dp-trace dp-trace-tall">${escapeHtml(JSON.stringify(apiData.responseBody, null, 2))}</pre>`
            : `
        <div class="dp-trace-subtitle" style="margin-top:18px;">📤 Request / 📥 Response — Raw API Data</div>
        <div class="dp-trace-unavail">Los datos raw de la API solo están disponibles para la petición más reciente (máx. 90 segundos de antigüedad). Ejecuta una pregunta nueva y abre los detalles inmediatamente.</div>`
        }
      </div>`
          : ""
      }

      <!-- Navigation between records -->
      <div class="dp-nav">
        <button class="btn" id="detail-prev-btn" ${idx >= history.length - 1 ? "disabled" : ""}>← Más antigua</button>
        <span class="dp-nav-pos">${idx + 1} de ${history.length}</span>
        <button class="btn" id="detail-next-btn" ${idx <= 0 ? "disabled" : ""}>Más reciente →</button>
      </div>

    </div>`;

  return html;
}

// ============================================
// Generic Modal
// ============================================

function showModal(title, contentHtml, preText) {
  const modal = document.createElement("div");
  modal.className = "modal-overlay";

  const inner = document.createElement("div");
  inner.className = "modal-content";

  const h3 = document.createElement("h3");
  h3.textContent = title;
  inner.appendChild(h3);

  if (contentHtml) {
    const div = document.createElement("div");
    div.innerHTML = contentHtml;
    inner.appendChild(div);
  }

  if (preText) {
    const pre = document.createElement("pre");
    pre.textContent = preText;
    inner.appendChild(pre);
  }

  const closeBtn = document.createElement("button");
  closeBtn.className = "btn";
  closeBtn.textContent = "Cerrar";
  closeBtn.addEventListener("click", () => modal.remove());
  inner.appendChild(closeBtn);

  modal.appendChild(inner);
  document.body.appendChild(modal);
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.remove();
  });
}

// ============================================
// Utilities
// ============================================

function shortModel(m) {
  if (!m || m === "—") return m || "—";
  // Strip date suffix like -20250929 or -20240307
  return m.replace(/-\d{8}$/, "");
}

function formatTokens(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "K";
  return String(n);
}

function escapeHtml(t) {
  const d = document.createElement("div");
  d.textContent = t || "";
  return d.innerHTML;
}

function escapeAttr(t) {
  return (t || "").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// ============================================
// Init
// ============================================
loadData();
