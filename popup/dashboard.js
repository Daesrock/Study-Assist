/**
 * Study Assist — Dashboard Script
 * Developer-oriented control panel with routing metrics,
 * token intelligence, last-response inspector, and dev mode.
 */

// ============================================
// Boot
// ============================================

document.getElementById("refresh-btn").addEventListener("click", loadData);

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

// Last AI response
document
  .getElementById("last-response-btn")
  .addEventListener("click", showLastResponseModal);

// ============================================
// Data Loading
// ============================================

async function loadData() {
  const el = document.getElementById("content");
  el.innerHTML = '<div class="loading-spinner">Cargando datos…</div>';

  try {
    const [statsRes, historyRes, configRes, devModeRes] = await Promise.all([
      chrome.runtime
        .sendMessage({ type: "GET_USAGE_STATS" })
        .catch(() => ({ success: false, stats: {} })),
      chrome.runtime
        .sendMessage({ type: "GET_USAGE_HISTORY", limit: 50 })
        .catch(() => ({ success: false, history: [] })),
      chrome.storage.local.get([
        "useDeepSeek",
        "deepseekOnly",
        "claudeModel",
        "deepseekApiKey",
        "claudeApiKey",
      ]),
      chrome.storage.local.get(["dashboardDevMode"]),
    ]);

    const stats = (statsRes && statsRes.stats) || {};
    const history = (historyRes && historyRes.history) || [];
    const config = configRes || {};
    const devMode = devModeRes?.dashboardDevMode ?? false;

    el.innerHTML = renderDashboard(stats, history, config, devMode);
    bindDynamicEvents(history, devMode);
  } catch (e) {
    el.innerHTML =
      '<div class="loading-spinner">Error: ' + escapeHtml(e.message) + "</div>";
  }
}

// ============================================
// Render
// ============================================

function renderDashboard(stats, history, config, devMode) {
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
  let deepseekToday = 0,
    claudeValidations = 0,
    fallbacks = 0,
    imageFallbacks = 0;
  let dsLatencySum = 0,
    dsLatencyCount = 0,
    clLatencySum = 0,
    clLatencyCount = 0;

  for (const r of history) {
    const day = new Date(r.timestamp).toISOString().split("T")[0];
    const isToday = day === today;
    if (r.source === "deepseek") {
      if (isToday) deepseekToday++;
      dsLatencySum += r.latencyMs || 0;
      dsLatencyCount++;
    } else if (r.source === "claude") {
      clLatencySum += r.latencyMs || 0;
      clLatencyCount++;
      // Heuristic: if record has deepseek reasoning or is a validation
      if (r.validated) claudeValidations++;
      if (r.fallbackReason) fallbacks++;
      if (r.fallbackReason === "images") imageFallbacks++;
    }
  }

  const dsAvgLatency = dsLatencyCount ? dsLatencySum / dsLatencyCount : 0;
  const clAvgLatency = clLatencyCount ? clLatencySum / clLatencyCount : 0;

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

  // — Model usage ratio —
  const dsReqs = (stats.bySource || {}).deepseek || 0;
  const clReqs = (stats.bySource || {}).claude || 0;
  const aiTotal = dsReqs + clReqs;
  const dsPct = aiTotal > 0 ? ((dsReqs / aiTotal) * 100).toFixed(0) : "0";
  const clPct = aiTotal > 0 ? ((clReqs / aiTotal) * 100).toFixed(0) : "0";

  // — System health (image fallbacks are normal behavior, not errors) —
  const oneHourAgo = Date.now() - 3600_000;
  let recentErrors = 0,
    recentErrorFallbacks = 0,
    recentImageFallbacks = 0,
    lastErrorTs = 0;
  let dsFailures = 0;
  for (const r of history) {
    if (r.timestamp >= oneHourAgo) {
      if (!r.success) {
        recentErrors++;
        lastErrorTs = Math.max(lastErrorTs, r.timestamp);
      }
      if (r.fallbackReason && r.fallbackReason !== "images")
        recentErrorFallbacks++;
      if (r.fallbackReason === "images") recentImageFallbacks++;
      if (r.source === "deepseek" && !r.success) dsFailures++;
    }
  }
  let healthStatus, healthColor;
  if (recentErrors >= 3 || dsFailures >= 2) {
    healthStatus = "Degraded";
    healthColor = "red";
  } else if (recentErrors >= 1 || recentErrorFallbacks >= 2) {
    healthStatus = "Warning";
    healthColor = "yellow";
  } else {
    healthStatus = "Healthy";
    healthColor = "green";
  }

  // — Active mode —
  const useDeepSeek = config.useDeepSeek ?? false;
  const deepseekOnly = config.deepseekOnly ?? false;
  const hasDeepSeekKey = !!config.deepseekApiKey;
  const hasClaudeKey = !!config.claudeApiKey;

  let activeMode, modeCss;
  if (useDeepSeek && deepseekOnly) {
    activeMode = "DeepSeek Only";
    modeCss = "deepseek";
  } else if (useDeepSeek) {
    activeMode = "Hybrid";
    modeCss = "hybrid";
  } else {
    activeMode = "Claude Only";
    modeCss = "claude";
  }

  const lastModel = history.length ? history[0].model : "—";

  // — Source bars —
  const sourceEntries = Object.entries(stats.bySource || {});
  const maxSrc = Math.max(...sourceEntries.map(([, c]) => Number(c)), 1);
  const sourceBars = sourceEntries.length
    ? sourceEntries
        .map(
          ([src, count]) => `
        <div class="chart-bar-row">
          <span class="chart-bar-label">${src}</span>
          <div class="chart-bar-track">
            <div class="chart-bar-fill fill-${src.replace(/\s/g, "-")}" style="width:${(count / maxSrc) * 100}%"></div>
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
      const srcBadge =
        r.source === "claude"
          ? "badge-claude"
          : r.source === "deepseek"
            ? "badge-deepseek"
            : "badge-bank";
      const statusBadge = r.success ? "badge-success" : "badge-error";
      const validated = r.validated ? "badge-yes" : "badge-no";
      const trigger = r.trigger || "auto";
      const plat = r.platform || "other";
      return `
      <tr data-idx="${i}" data-platform="${escapeAttr(plat)}">
        <td>${time}</td>
        <td><span class="text-truncate" title="${escapeAttr(r.questionText)}">${escapeHtml(r.questionText)}</span></td>
        <td><span class="badge ${srcBadge}">${r.source}</span></td>
        <td>${r.model ? shortModel(r.model) : "—"}</td>
        <td><span class="badge badge-platform">${plat}</span></td>
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

  // — Per-AI token/cost data —
  const ds = stats.deepseek || {};
  const cl = stats.claude || {};
  const dsTotalTokens =
    (ds.totalInputTokens || 0) + (ds.totalOutputTokens || 0);
  const clTotalTokens =
    (cl.totalInputTokens || 0) + (cl.totalOutputTokens || 0);

  // ========== Assemble HTML ==========
  let html = "";

  // — Mode Banner —
  html += `
    <div class="mode-banner">
      <div class="mode-info">
        <div class="mode-item">
          <span class="label">Modo:</span>
          <span class="mode-tag ${modeCss}">${activeMode}</span>
        </div>
        <div class="mode-item">
          <span class="label">Modelo:</span>
          <span class="value">${shortModel(lastModel)}</span>
        </div>
        <div class="mode-item">
          <span class="label">DeepSeek:</span>
          <span class="value">${hasDeepSeekKey && useDeepSeek ? "✅" : "❌"}</span>
        </div>
        <div class="mode-item">
          <span class="label">Claude:</span>
          <span class="value">${hasClaudeKey && !deepseekOnly ? "✅" : "❌"}</span>
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
        <span>DeepSeek: <span class="${dsFailures === 0 ? "tag-ok" : "tag-fail"}">${dsFailures === 0 ? "OK" : dsFailures + " fail"}</span></span>
        <span>Claude: <span class="${recentErrors - dsFailures <= 0 ? "tag-ok" : "tag-fail"}">${recentErrors - dsFailures <= 0 ? "OK" : recentErrors - dsFailures + " fail"}</span></span>
        <span>Error Fallbacks (1h): <span class="${recentErrorFallbacks === 0 ? "tag-ok" : "tag-warn"}">${recentErrorFallbacks}</span></span>
        <span>Image→Claude (1h): <span class="tag-ok">${recentImageFallbacks}</span></span>
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

  // — Model Usage Ratio —
  if (aiTotal > 0) {
    html += `
    <div class="ratio-card">
      <h3>🔀 Uso por Modelo</h3>
      <div class="ratio-bar-wrapper">
        <div class="ratio-bar-track">
          <div class="ratio-bar-ds" style="width:${dsPct}%">${Number(dsPct) >= 10 ? dsPct + "%" : ""}</div>
          <div class="ratio-bar-cl" style="width:${clPct}%">${Number(clPct) >= 10 ? clPct + "%" : ""}</div>
        </div>
      </div>
      <div class="ratio-legend">
        <div class="ratio-legend-item"><span class="ratio-dot ds"></span> DeepSeek: ${dsReqs} (${dsPct}%)</div>
        <div class="ratio-legend-item"><span class="ratio-dot cl"></span> Claude: ${clReqs} (${clPct}%)</div>
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
        <div class="grouped-row"><span class="g-label">DeepSeek total</span><span class="g-value ds">${formatTokens(dsTotalTokens)}</span></div>
        <div class="grouped-row"><span class="g-label">Claude total</span><span class="g-value cl">${formatTokens(clTotalTokens)}</span></div>
      </div>
      <div class="grouped-card">
        <h3>💰 Costos</h3>
        <div class="grouped-row"><span class="g-label">Hoy</span><span class="g-value accent">$${costToday.toFixed(4)}</span></div>
        <div class="grouped-row"><span class="g-label">Total</span><span class="g-value">$${stats.totalCostUsd.toFixed(4)}</span></div>
        <div class="grouped-row"><span class="g-label">Est. Mensual (14d)</span><span class="g-value">$${estMonthlyCost.toFixed(2)}</span></div>
        <div class="grouped-row"><span class="g-label">DeepSeek total</span><span class="g-value ds">$${(ds.totalCostUsd || 0).toFixed(4)}</span></div>
        <div class="grouped-row"><span class="g-label">Claude total</span><span class="g-value cl">$${(cl.totalCostUsd || 0).toFixed(4)}</span></div>
      </div>
    </div>`;

  // — Latency Breakdown —
  html += `
    <div class="dual-section">
      <div class="grouped-card">
        <h3>⏱️ Latencia por Modelo</h3>
        <div class="grouped-row"><span class="g-label">DeepSeek prom.</span><span class="g-value ds">${dsLatencyCount ? (dsAvgLatency / 1000).toFixed(1) + "s" : "—"}</span></div>
        <div class="grouped-row"><span class="g-label">Claude prom.</span><span class="g-value cl">${clLatencyCount ? (clAvgLatency / 1000).toFixed(1) + "s" : "—"}</span></div>
        <div class="grouped-row"><span class="g-label">Global prom.</span><span class="g-value">${stats.totalRequests ? (stats.avgLatencyMs / 1000).toFixed(1) + "s" : "—"}</span></div>
      </div>
      <div class="grouped-card">
        <h3>🔀 Routing y Validación</h3>
        <div class="grouped-row"><span class="g-label">DeepSeek hoy</span><span class="g-value ds">${deepseekToday}</span></div>
        <div class="grouped-row"><span class="g-label">Validaciones Claude</span><span class="g-value cl">${claudeValidations}</span></div>
        <div class="grouped-row"><span class="g-label">Fallbacks API</span><span class="g-value ${fallbacks > 0 ? "accent" : ""}">${fallbacks}</span></div>
        <div class="grouped-row"><span class="g-label">Fallbacks imagen</span><span class="g-value">${imageFallbacks}</span></div>
      </div>
    </div>`;

  // — Dev Mode Panel —
  html += `<div id="dev-panel-area"></div>`;

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
        <h3>Peticiones por Fuente</h3>
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
  html += `
    <div class="section-title">📋 Historial Reciente</div>
    <div class="history-card">
      <div class="history-toolbar">
        <label for="platform-filter">🌐 Plataforma:</label>
        <select id="platform-filter" class="platform-select">
          <option value="all" selected>Todas</option>
          ${platformOptions}
        </select>
        <div class="history-pagination">
          <button class="btn-page" id="page-prev" title="Página anterior" disabled>←</button>
          <button class="btn-page" id="page-next" title="Página siguiente">→</button>
          <span class="page-info" id="page-info">1 / 1</span>
          <label class="lines-label">LINES<br>PER<br>PAGE</label>
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
              <th>Fuente</th>
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
      </div>
      <div class="qa-actions">
        <button class="btn" id="qa-moodle-mcq-btn">Moodle MCQ</button>
        <button class="btn" id="qa-moodle-tf-btn">Moodle V/F</button>
        <button class="btn" id="qa-netacad-mcq-btn">NetAcad MCQ</button>
        <button class="btn" id="qa-netacad-matching-btn">NetAcad Matching</button>
        <button class="btn btn-primary" id="qa-guide-btn">Ver guía completa</button>
      </div>
    </div>`;

  // — Action Buttons —
  html += `
    <div class="section-title">⚙️ Acciones</div>
    <div class="actions-row">
      <button class="btn btn-reset-state" id="force-reset-btn">⚡ Force AI State Reset</button>
      <button class="btn btn-warning" id="reset-session-btn">🔄 Reset Estadísticas Sesión</button>
      <button class="btn btn-danger" id="full-reset-btn">🗑️ Reset Completo</button>
      <button class="btn" id="export-logs-btn">📤 Exportar Logs</button>
    </div>`;

  return html;
}

// ============================================
// Post-render Event Binding
// ============================================

function bindDynamicEvents(history, devMode) {
  // Dev mode toggle
  const devToggle = document.getElementById("dev-mode-toggle");
  if (devToggle) {
    devToggle.addEventListener("change", async (e) => {
      const on = e.target.checked;
      await chrome.storage.local.set({ dashboardDevMode: on });
      if (on) {
        renderDevPanel(history);
      } else {
        const area = document.getElementById("dev-panel-area");
        if (area) area.innerHTML = "";
      }
    });
    if (devMode) renderDevPanel(history);
  }

  // ---- History Pagination ----
  let historyPage = 0;
  let historyPageSize = 10;

  function getFilteredRows() {
    const allRows = Array.from(
      document.querySelectorAll("#history-tbody tr[data-platform]"),
    );
    const platVal = document.getElementById("platform-filter")?.value || "all";
    return allRows.filter(
      (row) => platVal === "all" || row.dataset.platform === platVal,
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

  // Detail view buttons → open modal with full details
  document.querySelectorAll(".btn-detail-view").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.idx, 10);
      const r = history[idx];
      if (!r) return;
      showRecordDetailModal(r);
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

  // Force AI State Reset (clears processing locks, NOT history/stats)
  const forceResetBtn = document.getElementById("force-reset-btn");
  if (forceResetBtn) {
    forceResetBtn.addEventListener("click", async () => {
      if (
        !confirm(
          "⚡ This will clear all pending request locks and processing flags.\nStats and history are NOT affected.\n\nProceed?",
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
        alert("AI state reset complete. Extension is ready for new requests.");
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
// Dev Mode Panel
// ============================================

function renderDevPanel(history) {
  const area = document.getElementById("dev-panel-area");
  if (!area) return;

  const last = history.length ? history[0] : null;

  let devHtml = `
    <div class="dev-panel">
      <h3>🛠️ Developer Mode</h3>`;

  if (last) {
    // Show usage record data
    devHtml += `
      <div class="dev-section">
        <h4>Última Petición — Usage Record</h4>
        <pre>${escapeHtml(JSON.stringify(last, null, 2))}</pre>
      </div>`;

    // Routing decision analysis
    const routingReason = [];
    if (last.source === "deepseek") {
      routingReason.push("Respuesta directa de DeepSeek (confianza alta)");
    } else if (last.source === "claude" && last.validated) {
      routingReason.push(
        "Claude validó respuesta de DeepSeek (confianza media/baja)",
      );
    } else if (last.source === "claude" && last.fallbackReason) {
      routingReason.push("Fallback a Claude: " + last.fallbackReason);
    } else if (last.source === "claude") {
      routingReason.push(
        "Claude directo (DeepSeek no disponible o no habilitado)",
      );
    } else if (last.source === "question-bank") {
      routingReason.push("Respuesta del banco de preguntas local");
    }

    devHtml += `
      <div class="dev-section">
        <h4>Decisión de Enrutamiento</h4>
        <pre>${routingReason.join("\n") || "Sin información de enrutamiento"}</pre>
      </div>`;

    // Timing
    devHtml += `
      <div class="dev-section">
        <h4>Timing</h4>
        <pre>Latencia total: ${(last.latencyMs / 1000).toFixed(2)}s
Tokens entrada: ${last.inputTokens}
Tokens salida: ${last.outputTokens}
Costo: $${last.costUsd.toFixed(6)}</pre>
      </div>`;

    // Load and show API request/response data
    devHtml += `
      <div class="dev-section" id="dev-api-data">
        <h4>📤 API Request / 📥 Response — Raw Data</h4>
        <div class="loading-spinner" style="font-size:12px;">Cargando datos de API...</div>
      </div>`;
  } else {
    devHtml +=
      '<div class="no-data-msg">No hay peticiones recientes para analizar.</div>';
  }

  devHtml += "</div>";
  area.innerHTML = devHtml;

  // Load API request data asynchronously
  if (last) {
    loadApiRequestData();
  }
}

async function loadApiRequestData() {
  const container = document.getElementById("dev-api-data");
  if (!container) return;

  try {
    const result = await chrome.storage.local.get(["lastApiRequestData"]);
    const apiData = result.lastApiRequestData;

    if (!apiData) {
      container.innerHTML = `
        <h4>📤 API Request / 📥 Response — Raw Data</h4>
        <pre style="color: #888;">No hay datos de API disponibles. Analiza una pregunta primero.</pre>`;
      return;
    }

    let html = `<h4>📤 API Request / 📥 Response — Raw Data</h4>`;

    // API Metadata
    html += `
      <div style="margin-bottom: 12px;">
        <strong style="color:#4A9EFF;">🔧 Metadata</strong>
        <pre style="font-size: 11px;">Type: ${escapeHtml(apiData.type || "—")}
URL: ${escapeHtml(apiData.url || "—")}
Status: ${apiData.status || "—"}
Has Images: ${apiData.hasImages ? "✅ Yes" : "❌ No"}
Timestamp: ${apiData.timestamp ? new Date(apiData.timestamp).toLocaleString() : "—"}</pre>
      </div>`;

    // Request Body
    if (apiData.requestBody) {
      html += `
        <div style="margin-bottom: 12px;">
          <strong style="color:#4A9EFF;">📤 Request Body</strong>
          <pre style="max-height: 400px; overflow: auto; font-size: 11px;">${escapeHtml(JSON.stringify(apiData.requestBody, null, 2))}</pre>
        </div>`;
    }

    // Response Body
    if (apiData.responseBody) {
      html += `
        <div style="margin-bottom: 12px;">
          <strong style="color:#4A9EFF;">📥 Response Body</strong>
          <pre style="max-height: 400px; overflow: auto; font-size: 11px;">${escapeHtml(JSON.stringify(apiData.responseBody, null, 2))}</pre>
        </div>`;
    }

    container.innerHTML = html;
  } catch (e) {
    container.innerHTML = `
      <h4>📤 API Request / 📥 Response — Raw Data</h4>
      <pre style="color: #f66;">Error cargando datos: ${escapeHtml(e.message)}</pre>`;
  }
}

// ============================================
// Last AI Response Inspector
// ============================================

async function showLastResponseModal() {
  try {
    const result = await chrome.storage.local.get(["lastAiResponse"]);
    const resp = result.lastAiResponse;

    if (!resp) {
      showModal(
        "🔍 Última Respuesta IA",
        null,
        "No hay respuesta registrada aún. Analiza una pregunta primero.",
      );
      return;
    }

    const detailHtml = `
      <div class="modal-detail-grid">
        <span class="label">Pregunta:</span>
        <span class="value">${escapeHtml(resp.questionText || "—")}</span>

        <span class="label">Modelo:</span>
        <span class="value">${escapeHtml(resp.model || "—")}</span>

        <span class="label">Fuente:</span>
        <span class="value"><span class="badge badge-${resp.source || "bank"}">${resp.source || "—"}</span></span>

        <span class="label">Validación:</span>
        <span class="value">${resp.validated ? "Sí — Claude validó DeepSeek" : "No"}</span>

        <span class="label">Confianza:</span>
        <span class="value">${resp.confidence || "—"}</span>

        <span class="label">Tokens:</span>
        <span class="value">In: ${resp.inputTokens || 0} / Out: ${resp.outputTokens || 0} / Total: ${(resp.inputTokens || 0) + (resp.outputTokens || 0)}</span>

        <span class="label">Latencia:</span>
        <span class="value">${resp.latencyMs ? (resp.latencyMs / 1000).toFixed(2) + "s" : "—"}</span>

        <span class="label">Costo:</span>
        <span class="value">$${resp.costUsd ? resp.costUsd.toFixed(6) : "0.000000"}</span>
      </div>

      ${
        resp.deepseekReasoning
          ? `
        <h4 style="margin:10px 0 4px;font-size:12px;color:var(--color-deepseek);">DeepSeek Reasoning</h4>
        <pre>${escapeHtml(resp.deepseekReasoning)}</pre>`
          : ""
      }

      ${
        resp.claudeCorrection
          ? `
        <h4 style="margin:10px 0 4px;font-size:12px;color:var(--color-claude);">Claude Corrección</h4>
        <pre>${escapeHtml(resp.claudeCorrection)}</pre>`
          : ""
      }

      <h4 style="margin:10px 0 4px;font-size:12px;">Respuesta Final</h4>
      <pre>${escapeHtml(resp.answer || resp.result || "—")}</pre>`;

    showModal("🔍 Última Respuesta IA", detailHtml);
  } catch (e) {
    showModal(
      "🔍 Última Respuesta IA",
      null,
      "Error cargando respuesta: " + e.message,
    );
  }
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
// Record Detail Modal
// ============================================

function showRecordDetailModal(r) {
  const srcBadge =
    r.source === "claude"
      ? "badge-claude"
      : r.source === "deepseek"
        ? "badge-deepseek"
        : "badge-bank";
  const statusBadge = r.success ? "badge-success" : "badge-error";
  const time = new Date(r.timestamp).toLocaleString();

  let html = `
    <div class="detail-modal-body">
      <div class="detail-modal-header">
        <span class="badge ${srcBadge}" style="font-size:13px;padding:4px 12px;">${r.source}</span>
        <span style="color:var(--text-secondary);font-size:12px;">${time}</span>
        <span class="badge ${statusBadge}">${r.success ? "OK" : "ERROR"}</span>
      </div>

      <div class="detail-modal-section">
        <h4>📝 Pregunta</h4>
        <div class="detail-modal-block">${escapeHtml(r.questionText || "—")}</div>
      </div>

      <div class="detail-modal-section">
        <h4>💬 Respuesta</h4>
        <div class="detail-modal-block">${escapeHtml(r.answer || "— Sin respuesta registrada —")}</div>
      </div>

      ${
        r.deepseekReasoning
          ? `
      <div class="detail-modal-section">
        <h4 style="color:var(--color-deepseek);">🧠 DeepSeek Reasoning</h4>
        <pre class="detail-modal-pre">${escapeHtml(r.deepseekReasoning)}</pre>
      </div>`
          : ""
      }

      ${
        r.claudeCorrection
          ? `
      <div class="detail-modal-section">
        <h4 style="color:var(--color-claude);">🔧 Claude Corrección</h4>
        <pre class="detail-modal-pre">${escapeHtml(r.claudeCorrection)}</pre>
      </div>`
          : ""
      }

      <div class="detail-modal-section">
        <h4>📊 Metadatos</h4>
        <div class="detail-modal-grid">
          <div class="detail-modal-kv"><span class="detail-k">Modelo</span><span class="detail-v">${r.model || "—"}</span></div>
          <div class="detail-modal-kv"><span class="detail-k">Plataforma</span><span class="detail-v">${r.platform || "—"}</span></div>
          <div class="detail-modal-kv"><span class="detail-k">Tipo</span><span class="detail-v">${r.questionType || "—"}</span></div>
          <div class="detail-modal-kv"><span class="detail-k">Modo</span><span class="detail-v">${r.responseMode || "—"}</span></div>
          <div class="detail-modal-kv"><span class="detail-k">Trigger</span><span class="detail-v">${r.trigger || "auto"}</span></div>
          <div class="detail-modal-kv"><span class="detail-k">Confianza</span><span class="detail-v">${r.confidence || "—"}</span></div>
          <div class="detail-modal-kv"><span class="detail-k">Validado</span><span class="detail-v">${r.validated ? "Sí" : "No"}</span></div>
          <div class="detail-modal-kv"><span class="detail-k">Fallback</span><span class="detail-v">${r.fallbackReason || "—"}</span></div>
        </div>
      </div>

      <div class="detail-modal-section">
        <h4>🔢 Tokens y Costo</h4>
        <div class="detail-modal-grid">
          <div class="detail-modal-kv"><span class="detail-k">Tokens In</span><span class="detail-v">${r.inputTokens}</span></div>
          <div class="detail-modal-kv"><span class="detail-k">Tokens Out</span><span class="detail-v">${r.outputTokens}</span></div>
          <div class="detail-modal-kv"><span class="detail-k">Total Tokens</span><span class="detail-v">${r.inputTokens + r.outputTokens}</span></div>
          <div class="detail-modal-kv"><span class="detail-k">Costo</span><span class="detail-v">$${r.costUsd.toFixed(6)}</span></div>
          <div class="detail-modal-kv"><span class="detail-k">Latencia</span><span class="detail-v">${(r.latencyMs / 1000).toFixed(2)}s</span></div>
        </div>
      </div>
    </div>`;

  showModal("🔎 Detalles Completos", html);
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
