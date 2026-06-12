function renderEvidenceTab(evidence) {
  const el = document.getElementById('tab-evidence');
  if (!el) return;
  const logs = evidence.logs || {};
  const metrics = evidence.metrics || {};
  const heals = evidence.heals || {};
  const related = evidence.relatedIncidents || {};
  el.innerHTML = `
    <div class="analysis-grid">
      <div class="analysis-box"><div class="analysis-label">Source</div><div class="analysis-value">${esc(evidence.source || 'local')}</div></div>
      <div class="analysis-box"><div class="analysis-label">Log Events</div><div class="analysis-value">${logs.count || 0}</div></div>
      <div class="analysis-box"><div class="analysis-label">Related Incidents</div><div class="analysis-value">${related.count || 0}</div></div>
      <div class="analysis-box"><div class="analysis-label">Heal Actions</div><div class="analysis-value">${heals.count || 0}</div></div>
    </div>
    ${logs.dominantErrors && logs.dominantErrors.length ? `
    <div class="section-label" style="margin-top:14px">Dominant Errors</div>
    <div class="evidence-list">
      ${(logs.dominantErrors || []).map(e => `<div class="evidence-item"><strong>${e.count}×</strong> ${esc(e.message)}</div>`).join('')}
    </div>` : ''}
    ${metrics && Object.keys(metrics).length ? `
    <div class="section-label" style="margin-top:14px">System Metrics</div>
    <div class="analysis-grid">
      <div class="analysis-box"><div class="analysis-label">Max CPU</div><div class="analysis-value" style="color:${(metrics.maxCpu||0)>80?'var(--red)':'inherit'}">${metrics.maxCpu||0}%</div></div>
      <div class="analysis-box"><div class="analysis-label">Max Memory</div><div class="analysis-value" style="color:${(metrics.maxMemory||0)>80?'var(--red)':'inherit'}">${metrics.maxMemory||0}%</div></div>
      <div class="analysis-box"><div class="analysis-label">Loop Lag</div><div class="analysis-value">${metrics.maxEventLoopLag||0}ms</div></div>
    </div>` : ''}
    ${heals.recentActions && heals.recentActions.length ? `
    <div class="section-label" style="margin-top:14px">Recent Heal Actions</div>
    <div class="evidence-list">
      ${heals.recentActions.map(a => `<div class="evidence-item"><strong>${esc(a.action)}</strong> (${a.count}×)</div>`).join('')}
    </div>` : ''}
  `;
}

function renderCorrelationTab(graph) {
  const el = document.getElementById('tab-correlation');
  if (!el) return;
  const nodes = graph.nodes || [];
  const edges = graph.edges || [];
  const confidence = graph.confidence || 0;

  const typeColors = {
    incident: 'var(--red)', logs: 'var(--blue)', metrics: 'var(--yellow)',
    error_burst: 'var(--red)', deployment: 'var(--green)', heal_action: 'var(--green)',
    related_incident: 'var(--yellow)', memory_spike: 'var(--red)', splunk: 'var(--blue)',
  };

  el.innerHTML = `
    <div class="analysis-grid" style="margin-bottom:14px">
      <div class="analysis-box"><div class="analysis-label">Nodes</div><div class="analysis-value">${nodes.length}</div></div>
      <div class="analysis-box"><div class="analysis-label">Edges</div><div class="analysis-value">${edges.length}</div></div>
      <div class="analysis-box"><div class="analysis-label">Confidence</div><div class="analysis-value">${Math.round(confidence*100)}%</div></div>
    </div>
    <div class="section-label">Graph Nodes</div>
    <div class="evidence-list">
      ${nodes.map(n => `
        <div class="evidence-item" style="display:flex;align-items:center;gap:8px">
          <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${typeColors[n.type]||'var(--text4)'};flex-shrink:0"></span>
          <span style="font-size:11px;color:var(--text4);width:90px;flex-shrink:0">${esc(n.type)}</span>
          <span>${esc(n.label)}</span>
        </div>
      `).join('')}
    </div>
    ${edges.length ? `
    <div class="section-label" style="margin-top:14px">Relationships</div>
    <div class="evidence-list">
      ${edges.map(e => {
        const fromNode = nodes.find(n => n.id === e.from);
        const toNode   = nodes.find(n => n.id === e.to);
        return `<div class="evidence-item" style="font-size:12px">
          <span style="color:var(--text2)">${esc((fromNode||{}).label||e.from)}</span>
          <span style="margin:0 6px;color:var(--text4)">→ ${esc(e.relation)} →</span>
          <span style="color:var(--text2)">${esc((toNode||{}).label||e.to)}</span>
          ${e.label ? `<span style="color:var(--text4);font-size:11px;margin-left:6px">(${esc(e.label)})</span>` : ''}
        </div>`;
      }).join('')}
    </div>` : ''}
  `;
}

function renderSimilarTab(similar) {
  const el = document.getElementById('tab-similar');
  if (!el) return;
  if (!similar.length) {
    el.innerHTML = '<div class="empty-state"><p>No similar historical incidents found.</p></div>';
    return;
  }
  el.innerHTML = `
    <div class="section-label">${similar.length} Similar Incidents Found</div>
    ${similar.map(s => `
      <div class="event-item" style="cursor:pointer" onclick="closeModal();openIncidentModal(${s.incidentId})">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
          <span style="font-weight:600;font-size:13px">${esc(s.title || 'Incident #' + s.incidentId)}</span>
          <span class="badge ${s.similarity>=70?'badge-red':'badge-yellow'}" style="font-size:11px">${s.similarity}% match</span>
        </div>
        <div style="font-size:12px;color:var(--text2);display:flex;gap:12px">
          <span>Path: ${esc(s.path||'—')}</span>
          <span>Root: ${esc(s.rootCause||'?')}</span>
          <span>Events: ${s.eventCount||0}</span>
        </div>
        <div style="margin-top:6px;font-size:12px">
          <span style="color:var(--text4)">Resolution:</span> <span>${esc(s.resolution||'unknown')}</span>
          <span style="margin-left:12px;color:var(--text4)">Outcome:</span> <span>${esc(s.outcome||'unknown')}</span>
        </div>
      </div>
    `).join('')}
  `;
}

function renderRecommendationsTab(recs) {
  const el = document.getElementById('tab-recommendations');
  if (!el) return;
  if (!recs.length) {
    el.innerHTML = '<div class="empty-state"><p>No recommendations available.</p></div>';
    return;
  }
  const priorityLabel = p => p === 1 ? 'high' : p === 2 ? 'medium' : 'low';
  const priorityColor = p => p === 1 ? 'var(--red)' : p === 2 ? 'var(--yellow)' : 'var(--text4)';
  el.innerHTML = `
    <div class="section-label">${recs.length} Recommended Actions</div>
    ${recs.map((r, i) => `
      <div class="event-item">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
          <span style="font-weight:600;font-size:13px">${i+1}. ${esc(r.action)}</span>
          <div style="display:flex;gap:6px;align-items:center">
            <span style="font-size:11px;color:${priorityColor(r.priority)}">${priorityLabel(r.priority)} priority</span>
            <span class="badge badge-blue" style="font-size:11px">${Math.round(r.confidence*100)}%</span>
          </div>
        </div>
        <div style="font-size:12px;color:var(--text2)">${esc(r.reasoning)}</div>
        ${r.historicalBasis ? '<div style="font-size:11px;color:var(--text4);margin-top:4px">📊 Based on historical incident data</div>' : ''}
      </div>
    `).join('')}
  `;
}

function renderRecoveryTab(recovery) {
  const el = document.getElementById('tab-recovery');
  if (!el) return;
  el.innerHTML = `
    <div class="analysis-grid">
      <div class="analysis-box"><div class="analysis-label">Status</div><div class="analysis-value" style="color:${recovery.resolved?'var(--green)':'var(--red)'}">${recovery.resolved ? '✓ Resolved' : '⚠ Open'}</div></div>
      <div class="analysis-box"><div class="analysis-label">Confidence</div><div class="analysis-value">${recovery.confidence||0}%</div></div>
      <div class="analysis-box"><div class="analysis-label">Error Rate</div><div class="analysis-value" style="color:${(recovery.errorRate||0)>10?'var(--red)':'var(--green)'}">${recovery.errorRate||0}%</div></div>
      <div class="analysis-box"><div class="analysis-label">Requests Checked</div><div class="analysis-value">${recovery.totalRequests||0}</div></div>
    </div>
    <div class="evidence-item" style="margin-top:14px;font-size:12px;color:var(--text2)">
      Source: ${esc(recovery.source||'local')} · Window: ${Math.round((recovery.windowMs||0)/60000)} min · Checked: ${recovery.checkedAt ? new Date(recovery.checkedAt).toLocaleTimeString() : '—'}
    </div>
  `;
}

function renderIncidentAnalysis(data) {
  const ctx = data.context || {};
  const logs = ctx.logs || {};
  const metrics = ctx.metrics || {};
  const github = ctx.github;
  const rca = data.rca || {};
  const recovery = data.recovery || {};

  const evidenceEl = document.getElementById('tab-evidence');
  if (evidenceEl) evidenceEl.innerHTML = `
    <div class="analysis-grid">
      <div class="analysis-box"><div class="analysis-label">Source</div><div class="analysis-value">${esc(logs.source || 'local')}</div></div>
      <div class="analysis-box"><div class="analysis-label">Events</div><div class="analysis-value">${logs.count || 0}</div></div>
    </div>
    <div class="evidence-list">
      ${(logs.dominantErrors || []).map(e => `<div class="evidence-item"><strong>${e.count}x</strong> ${esc(e.message)}</div>`).join('') || '<div class="evidence-item">No matching log evidence found yet.</div>'}
    </div>
    ${logs.reason ? `<div class="event-sub" style="margin-top:10px">Using local fallback: ${esc(logs.reason)}</div>` : ''}
  `;

  const corrEl = document.getElementById('tab-correlation');
  if (corrEl) corrEl.innerHTML = `
    <div class="analysis-grid">
      <div class="analysis-box"><div class="analysis-label">Memory Peak</div><div class="analysis-value">${metrics.maxMemory || 0}%</div></div>
      <div class="analysis-box"><div class="analysis-label">CPU Peak</div><div class="analysis-value">${metrics.maxCpu || 0}%</div></div>
      <div class="analysis-box"><div class="analysis-label">Loop Lag</div><div class="analysis-value">${metrics.maxEventLoopLag || 0}ms</div></div>
      <div class="analysis-box"><div class="analysis-label">GitHub</div><div class="analysis-value">${github ? github.confidence + '%' : '---'}</div></div>
    </div>
    ${github ? `<div class="evidence-item" style="margin-top:10px">Commit ${esc(github.commitHash.slice(0,7))} by ${esc(github.author)}: ${esc(github.subject || '')}</div>` : '<div class="evidence-item" style="margin-top:10px">No recent git commit correlation found.</div>'}
  `;

  const rcaEl = document.getElementById('tab-rca');
  if (rcaEl) rcaEl.innerHTML = `
    <div class="root-cause-box">
      <div class="rc-label">AI Root Cause Analysis</div>
      <div class="rc-title">${esc(rca.rootCause || 'Unknown')}</div>
      <div class="rc-desc">Confidence: ${rca.confidence || 0}%</div>
    </div>
    <div class="section-label">Evidence</div>
    <div class="evidence-list">${(rca.evidence || []).map(e => `<div class="evidence-item">${esc(e)}</div>`).join('')}</div>
    <div class="section-label" style="margin-top:14px">Recommended Action</div>
    <div class="evidence-item">${esc(rca.recommendation || 'Review logs and remediation history.')}</div>
  `;

  // Recovery tab rendered by renderRecoveryTab() via dedicated API call

  const postEl = document.getElementById('tab-postmortem');
  if (postEl) postEl.innerHTML = `
    <div style="display:flex;justify-content:flex-end;margin-bottom:10px">
      <a class="btn-primary" href="/api/incidents/${data.incidentId}/postmortem.md" style="text-decoration:none">Download Markdown</a>
    </div>
    <div class="postmortem-box">${esc(data.postmortem || '')}</div>
  `;
}

function fetchAdvancedAnalytics() {
  fetch('/api/analytics/advanced?hours=24').then(r => r.json()).then(data => {
    const el = document.getElementById('advanced-analytics');
    if (!el) return;
    el.innerHTML = `
      <div class="analysis-grid">
        <div class="analysis-box"><div class="analysis-label">Total Incidents</div><div class="analysis-value">${data.totalIncidents||0}</div></div>
        <div class="analysis-box"><div class="analysis-label">Recovery Success</div><div class="analysis-value" style="color:var(--green)">${data.recoverySuccessRate||0}%</div></div>
        <div class="analysis-box"><div class="analysis-label">MTTR</div><div class="analysis-value">${data.mttrMinutes||0}m</div></div>
        <div class="analysis-box"><div class="analysis-label">Heal Actions</div><div class="analysis-value">${data.totalHeals||0}</div></div>
      </div>
      ${data.rcaDistribution && data.rcaDistribution.length ? `
      <div class="section-label" style="margin-top:14px">Root Cause Distribution</div>
      <div class="evidence-list">
        ${data.rcaDistribution.sort((a,b) => b.value - a.value).slice(0, 8).map(d => {
          const pct = data.totalIncidents ? Math.round(d.value / data.totalIncidents * 100) : 0;
          return `<div class="evidence-item" style="display:flex;align-items:center;gap:8px">
            <span style="width:120px;font-size:12px">${esc(d.label)}</span>
            <div style="flex:1;background:var(--surface2);border-radius:4px;height:8px;overflow:hidden">
              <div style="width:${pct}%;background:var(--blue-mid);height:100%"></div>
            </div>
            <span style="width:30px;text-align:right;font-size:12px;color:var(--text2)">${d.value}</span>
          </div>`;
        }).join('')}
      </div>` : ''}
      ${data.incidentCategories && data.incidentCategories.length ? `
      <div class="section-label" style="margin-top:14px">Incident Categories</div>
      <div class="evidence-list">
        ${data.incidentCategories.sort((a,b) => b.value - a.value).map(c => `
          <div class="evidence-item" style="display:flex;justify-content:space-between">
            <span>${esc(c.label)}</span>
            <span class="badge badge-blue" style="font-size:11px">${c.value}</span>
          </div>
        `).join('')}
      </div>` : ''}
    `;
  }).catch(() => {});
}

function runAIInvestigation() {
  if (!activeModal) return;
  const btn = document.getElementById('btn-investigate');
  if (btn) { btn.textContent = '⏳ Investigating…'; btn.disabled = true; }
  fetch('/api/incidents/' + activeModal + '/investigate', { method: 'POST' })
    .then(r => r.json())
    .then(data => {
      if (btn) { btn.textContent = '✓ Done'; btn.disabled = false; }
      if (data && data.rootCause) {
        // Update RCA tab with AI results
        const rcaEl = document.getElementById('tab-rca');
        if (rcaEl) rcaEl.innerHTML = `
          <div class="root-cause-box">
            <div class="rc-label">AI Root Cause Analysis ${data.source==='llm' ? '(LLM · ' + (data.provider||'') + ')' : '(Deterministic)'}</div>
            <div class="rc-title">${esc(data.rootCause || 'Unknown')}</div>
            <div class="rc-desc">Confidence: ${data.confidence || 0}% · Category: ${esc(data.category||'unknown')}</div>
          </div>
          ${data.reasoning ? `<div class="section-label" style="margin-top:14px">Reasoning</div><div class="evidence-item">${esc(data.reasoning)}</div>` : ''}
          <div class="section-label" style="margin-top:14px">Evidence</div>
          <div class="evidence-list">${(data.evidence||[]).map(e => `<div class="evidence-item">${esc(e)}</div>`).join('')}</div>
          ${data.impactedServices && data.impactedServices.length ? `
          <div class="section-label" style="margin-top:14px">Impacted Services</div>
          <div class="evidence-list">${data.impactedServices.map(s => `<div class="evidence-item">${esc(s)}</div>`).join('')}</div>` : ''}
        `;
        if (data.similar) renderSimilarTab(data.similar);
        if (data.correlationGraph) renderCorrelationTab(data.correlationGraph);
      }
    })
    .catch(() => {
      if (btn) { btn.textContent = '🤖 AI Investigate'; btn.disabled = false; }
    });
}
// ── Phase 11: Splunk Health Dashboard ────────────────────────────────────

function fetchSplunkHealth() {
  const el = document.getElementById('splunk-health-content');
  if (el) el.innerHTML = '<div class="empty-state"><p>Checking Splunk connectivity…</p></div>';

  fetch('/api/splunk/health')
    .then(r => r.json())
    .then(data => renderSplunkHealth(data))
    .catch(err => {
      if (el) el.innerHTML = `<div class="empty-state"><p>Failed to fetch: ${esc(err.message)}</p></div>`;
    });
}

function renderSplunkHealth(data) {
  const el = document.getElementById('splunk-health-content');
  if (!el) return;

  if (!data.enabled) {
    el.innerHTML = `
      <div class="empty-state">
        <p>Splunk integration is <strong>disabled</strong>.</p>
        <p style="font-size:12px;color:var(--text4);margin-top:8px">
          Enable it in your logpilot config:<br>
          <code style="font-size:11px">splunk: { enabled: true, token: '...', hecUrl: 'http://localhost:8088' }</code>
        </p>
      </div>`;
    return;
  }

  const hec  = data.hecHealth  || {};
  const diag = data.startupDiagnostics || {};
  const hecOk = data.hecStatus?.ok;

  const badge = (ok, label) => `<span class="badge ${ok ? 'badge-green' : 'badge-red'}" style="font-size:11px">${label}</span>`;
  const fmt   = ts => ts ? new Date(ts).toLocaleTimeString() : '—';

  el.innerHTML = `
    <div class="analysis-grid" style="margin-bottom:16px">
      <div class="analysis-box">
        <div class="analysis-label">HEC Status</div>
        <div class="analysis-value">${badge(hecOk, hecOk ? '● Live' : '● Down')}</div>
      </div>
      <div class="analysis-box">
        <div class="analysis-label">Queue Size</div>
        <div class="analysis-value" style="color:${(hec.queueSize||0)>500?'var(--red)':'inherit'}">${hec.queueSize||0}</div>
      </div>
      <div class="analysis-box">
        <div class="analysis-label">DLQ Size</div>
        <div class="analysis-value" style="color:${(hec.dlqSize||0)>0?'var(--yellow)':'inherit'}">${hec.dlqSize||0}</div>
      </div>
      <div class="analysis-box">
        <div class="analysis-label">Dropped Events</div>
        <div class="analysis-value" style="color:${(hec.droppedEvents||0)>0?'var(--red)':'inherit'}">${hec.droppedEvents||0}</div>
      </div>
      <div class="analysis-box">
        <div class="analysis-label">Total Sent</div>
        <div class="analysis-value">${hec.totalSent||0}</div>
      </div>
      <div class="analysis-box">
        <div class="analysis-label">Failures</div>
        <div class="analysis-value" style="color:${(hec.consecutiveFailures||0)>2?'var(--red)':'inherit'}">${hec.consecutiveFailures||0}</div>
      </div>
    </div>

    <div class="section-label">Connection Details</div>
    <div class="evidence-list" style="margin-bottom:14px">
      <div class="evidence-item"><strong>Index:</strong> ${esc(data.index||'logpilot')}</div>
      <div class="evidence-item"><strong>Host:</strong> ${esc(data.host||'—')}</div>
      <div class="evidence-item"><strong>Schema version:</strong> v${esc(data.schemaVersion||'?')}</div>
      <div class="evidence-item"><strong>Last successful flush:</strong> ${fmt(hec.lastSuccessAt)}</div>
      <div class="evidence-item"><strong>Last flush attempt:</strong> ${fmt(hec.lastFlushAt)}</div>
      ${hec.lastError ? `<div class="evidence-item" style="color:var(--red)"><strong>Last error:</strong> ${esc(hec.lastError)}</div>` : ''}
    </div>

    ${diag.hec ? `
    <div class="section-label">Startup Diagnostics</div>
    <div class="evidence-list">
      <div class="evidence-item">HEC connectivity: ${badge(diag.hec.ok, diag.hec.ok ? 'OK' : 'FAILED')}
        ${diag.hec.latencyMs != null ? `<span style="font-size:11px;color:var(--text4);margin-left:8px">${diag.hec.latencyMs}ms</span>` : ''}
        ${diag.hec.error ? `<span style="color:var(--red);font-size:11px;margin-left:8px">${esc(diag.hec.error)}</span>` : ''}
      </div>
      <div class="evidence-item">Search API: ${badge(diag.search?.ok, diag.search?.ok ? 'OK' : 'Unavailable')}</div>
      <div class="evidence-item" style="font-size:11px;color:var(--text4)">Checked at: ${fmt(diag.checkedAt)}</div>
    </div>` : ''}

    <div style="margin-top:16px;display:flex;gap:8px">
      <button class="btn-outline" style="font-size:12px" onclick="retestSplunkConnectivity()">Re-test connectivity</button>
    </div>
  `;
}

async function retestSplunkConnectivity() {
  const el = document.getElementById('splunk-health-content');
  if (el) el.innerHTML = '<div class="empty-state"><p>Testing HEC connectivity…</p></div>';
  fetchSplunkHealth();
}
