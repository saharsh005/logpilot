const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const db = require('../storage/db');
const { search } = require('../nlp/search-engine');
const { getCurrentMetrics } = require('../core/metrics');
const { subscribeToLogs } = require('../core/interceptor');
const { subscribeToHeals, getActiveCircuitBreakers } = require('../heal/heal-engine');
const { getRouteBaselines } = require('../core/anomaly-detector');
const vectorStore = require('../nlp/vector-store');

let dashboardApp = null;
let dashboardServer = null;
let wss = null;

function startDashboard(port = 4321, config = {}) {
  dashboardApp = express();
  dashboardApp.use(express.json());

  // CORS for local dev
  dashboardApp.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    next();
  });

  // ── REST API ──────────────────────────────────────────────

  // Stats overview
  dashboardApp.get('/api/stats', (req, res) => {
    const { isReady: embedderReady } = require('../nlp/embedder');
    res.json({
      ...db.getStats(),
      currentMetrics: getCurrentMetrics(),
      circuitBreakers: getActiveCircuitBreakers(),
      uptime: Math.round(process.uptime()),
      searchMode: (embedderReady() && vectorStore.isConnected()) ? 'semantic' : 'keyword',
      qdrantConnected: vectorStore.isConnected(),
      embeddingReady: embedderReady(),
    });
  });

  // Recent logs
  dashboardApp.get('/api/logs', (req, res) => {
    const { level, service, limit = 100 } = req.query;
    const logs = db.queryLogs({ level, service, limit: parseInt(limit), since: Date.now() - 24 * 60 * 60 * 1000 });
    res.json({ logs });
  });

  // NLP search
  dashboardApp.post('/api/search', async (req, res) => {
    const { query } = req.body;
    if (!query) return res.status(400).json({ error: 'query required' });
    try {
      const result = await search(query);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: 'search failed', message: err.message });
    }
  });

  // Metrics history
  dashboardApp.get('/api/metrics', (req, res) => {
    const minutes = parseInt(req.query.minutes) || 60;
    const metrics = db.getRecentMetrics(minutes);
    res.json({ metrics });
  });

  // Heal actions
  dashboardApp.get('/api/heals', (req, res) => {
    res.json({ actions: db.getHealActions(50) });
  });

  // Route baselines
  dashboardApp.get('/api/baselines', (req, res) => {
    res.json({ baselines: getRouteBaselines() });
  });

  // Serve embedded dashboard UI
  dashboardApp.get('/', (req, res) => {
    res.send(getDashboardHTML(port, config));
  });

  // ── HTTP + WebSocket server ───────────────────────────────
  dashboardServer = http.createServer(dashboardApp);
  wss = new WebSocket.Server({ server: dashboardServer });

  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'connected', message: 'logpilot dashboard connected' }));

    // Send latest stats on connect
    ws.send(JSON.stringify({ type: 'stats', data: db.getStats() }));

    // Subscribe to real-time log events
    const unsubLog = subscribeToLogs((entry) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'log', data: entry }));
      }
    });

    // Subscribe to heal events
    const unsubHeal = subscribeToHeals((event) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'heal', data: event }));
      }
    });

    ws.on('close', () => {
      unsubLog();
      unsubHeal();
    });
  });

  dashboardServer.listen(port, () => {
    const chalk = require('chalk');
    console.log(chalk.cyan('\n[logpilot]'), chalk.green(`Dashboard running at http://localhost:${port}`));
    console.log(chalk.cyan('[logpilot]'), chalk.gray(`WebSocket live stream on ws://localhost:${port}\n`));
  });

  return dashboardServer;
}

function getDashboardHTML(port, config) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>logpilot — Dashboard</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #0d1117; --surface: #161b22; --border: #30363d;
    --text: #c9d1d9; --muted: #8b949e; --accent: #58a6ff;
    --green: #3fb950; --red: #f85149; --yellow: #d29922;
    --purple: #bc8cff;
  }
  body { background: var(--bg); color: var(--text); font-family: 'Segoe UI', system-ui, monospace; font-size: 13px; }
  header { background: var(--surface); border-bottom: 1px solid var(--border); padding: 12px 24px; display: flex; align-items: center; gap: 12px; }
  .logo { font-size: 18px; font-weight: 700; color: var(--accent); letter-spacing: -0.5px; }
  .badge { background: var(--green); color: #000; font-size: 10px; padding: 2px 8px; border-radius: 99px; font-weight: 700; }
  .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1px; background: var(--border); border-bottom: 1px solid var(--border); }
  .stat-card { background: var(--surface); padding: 16px 20px; }
  .stat-label { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px; }
  .stat-value { font-size: 26px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .stat-value.green { color: var(--green); }
  .stat-value.red { color: var(--red); }
  .stat-value.yellow { color: var(--yellow); }
  .stat-value.blue { color: var(--accent); }
  .main { display: grid; grid-template-columns: 1fr 380px; gap: 0; height: calc(100vh - 130px); }
  .panel { display: flex; flex-direction: column; border-right: 1px solid var(--border); }
  .panel-header { padding: 12px 16px; border-bottom: 1px solid var(--border); font-weight: 600; color: var(--muted); font-size: 11px; text-transform: uppercase; display: flex; align-items: center; justify-content: space-between; }
  .search-bar { padding: 12px 16px; border-bottom: 1px solid var(--border); display: flex; gap: 8px; }
  .search-bar input { flex: 1; background: var(--bg); border: 1px solid var(--border); color: var(--text); padding: 8px 12px; border-radius: 6px; font-size: 13px; outline: none; }
  .search-bar input:focus { border-color: var(--accent); }
  .search-bar button { background: var(--accent); color: #000; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 12px; }
  .search-bar button:hover { opacity: 0.85; }
  .log-stream { flex: 1; overflow-y: auto; font-family: 'Courier New', monospace; font-size: 12px; }
  .log-entry { padding: 5px 16px; border-bottom: 1px solid rgba(255,255,255,0.03); display: flex; gap: 10px; align-items: flex-start; transition: background 0.1s; }
  .log-entry:hover { background: rgba(255,255,255,0.03); }
  .log-entry.error { border-left: 2px solid var(--red); }
  .log-entry.warn  { border-left: 2px solid var(--yellow); }
  .log-entry.info  { border-left: 2px solid transparent; }
  .log-time { color: var(--muted); min-width: 80px; }
  .log-level { min-width: 42px; font-weight: 700; }
  .log-level.error { color: var(--red); }
  .log-level.warn  { color: var(--yellow); }
  .log-level.info  { color: var(--green); }
  .log-msg { color: var(--text); flex: 1; word-break: break-all; }
  .log-rt { color: var(--muted); min-width: 55px; text-align: right; font-size: 11px; }
  .sidebar { display: flex; flex-direction: column; overflow: hidden; }
  .sidebar-section { border-bottom: 1px solid var(--border); }
  .sidebar-title { padding: 10px 16px; font-size: 11px; text-transform: uppercase; color: var(--muted); font-weight: 600; }
  .metric-row { display: flex; justify-content: space-between; align-items: center; padding: 6px 16px; }
  .metric-name { color: var(--muted); }
  .metric-val { font-weight: 600; font-variant-numeric: tabular-nums; }
  .bar-wrap { background: var(--border); border-radius: 4px; height: 4px; width: 80px; overflow: hidden; }
  .bar-fill { height: 100%; border-radius: 4px; transition: width 0.5s; background: var(--green); }
  .bar-fill.warn { background: var(--yellow); }
  .bar-fill.critical { background: var(--red); }
  .heal-entry { padding: 8px 16px; border-bottom: 1px solid rgba(255,255,255,0.04); }
  .heal-rule { font-weight: 600; color: var(--purple); margin-bottom: 2px; }
  .heal-action { color: var(--muted); font-size: 11px; }
  .heal-time { color: var(--muted); font-size: 10px; margin-top: 2px; }
  .search-results { padding: 12px 16px; flex: 1; overflow-y: auto; }
  .result-group { margin-bottom: 16px; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
  .result-group-header { padding: 10px 14px; background: rgba(255,255,255,0.04); font-weight: 600; display: flex; justify-content: space-between; }
  .result-group-header .count { color: var(--accent); }
  .result-entry { padding: 6px 14px; border-top: 1px solid var(--border); font-size: 11px; color: var(--muted); font-family: monospace; }
  .no-results { color: var(--muted); text-align: center; padding: 40px; }
  .live-dot { width: 6px; height: 6px; background: var(--green); border-radius: 50%; display: inline-block; animation: pulse 1.5s infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
  .tabs { display: flex; border-bottom: 1px solid var(--border); }
  .tab { padding: 10px 16px; cursor: pointer; font-size: 12px; color: var(--muted); border-bottom: 2px solid transparent; }
  .tab.active { color: var(--accent); border-bottom-color: var(--accent); }
  .tab-content { flex: 1; overflow-y: auto; }
  .tab-content.hidden { display: none; }
  .pill { padding: 2px 8px; border-radius: 99px; font-size: 10px; font-weight: 700; }
  .pill.green { background: rgba(63,185,80,0.15); color: var(--green); }
  .pill.red   { background: rgba(248,81,73,0.15);  color: var(--red); }
  .pill.yellow{ background: rgba(210,153,34,0.15); color: var(--yellow); }
  ::-webkit-scrollbar { width: 4px; } ::-webkit-scrollbar-track { background: transparent; } ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
</style>
</head>
<body>
<header>
  <span class="logo">⚡ logpilot</span>
  <span class="badge">LIVE</span>
  <span style="margin-left:auto;color:var(--muted);font-size:11px;">
    <span class="live-dot"></span> Connected to ws://localhost:${port}
  </span>
</header>

<div class="grid">
  <div class="stat-card">
    <div class="stat-label">Total Logs</div>
    <div class="stat-value blue" id="stat-total">—</div>
  </div>
  <div class="stat-card">
    <div class="stat-label">Errors (24h)</div>
    <div class="stat-value red" id="stat-errors">—</div>
  </div>
  <div class="stat-card">
    <div class="stat-label">Avg Response</div>
    <div class="stat-value green" id="stat-response">—</div>
  </div>
  <div class="stat-card">
    <div class="stat-label">Auto-Heals</div>
    <div class="stat-value yellow" id="stat-heals">—</div>
  </div>
</div>

<div class="main">
  <!-- Left: Log stream + Search -->
  <div class="panel">
    <div class="search-bar">
      <input id="search-input" placeholder='Try: "show payment errors last night" or "auth failures"' />
      <button onclick="runSearch()">Search</button>
    </div>
    <div class="tabs">
      <div class="tab active" onclick="switchTab('live')">Live Stream</div>
      <div class="tab" onclick="switchTab('search')">Search Results</div>
    </div>
    <div class="tab-content" id="tab-live">
      <div class="log-stream" id="log-stream"></div>
    </div>
    <div class="tab-content hidden" id="tab-search">
      <div class="search-results" id="search-results">
        <div class="no-results">Enter a query above and click Search</div>
      </div>
    </div>
  </div>

  <!-- Right: Metrics + Heals -->
  <div class="sidebar">
    <div class="sidebar-section">
      <div class="sidebar-title">System Metrics</div>
      <div class="metric-row">
        <span class="metric-name">Memory</span>
        <div style="display:flex;align-items:center;gap:8px">
          <div class="bar-wrap"><div class="bar-fill" id="bar-mem" style="width:0%"></div></div>
          <span class="metric-val" id="val-mem">—</span>
        </div>
      </div>
      <div class="metric-row">
        <span class="metric-name">CPU</span>
        <div style="display:flex;align-items:center;gap:8px">
          <div class="bar-wrap"><div class="bar-fill" id="bar-cpu" style="width:0%"></div></div>
          <span class="metric-val" id="val-cpu">—</span>
        </div>
      </div>
      <div class="metric-row">
        <span class="metric-name">Event Loop Lag</span>
        <span class="metric-val" id="val-lag">—</span>
      </div>
      <div class="metric-row">
        <span class="metric-name">Uptime</span>
        <span class="metric-val" id="val-uptime">—</span>
      </div>
    </div>

    <div class="sidebar-section" style="flex:1;overflow:hidden;display:flex;flex-direction:column">
      <div class="sidebar-title">Heal Actions</div>
      <div style="flex:1;overflow-y:auto" id="heal-list">
        <div style="padding:20px;color:var(--muted);text-align:center;font-size:11px">No heal actions yet</div>
      </div>
    </div>
  </div>
</div>

<script>
const MAX_LOGS = 200;
let logEntries = [];
let activeTab = 'live';

// Connect WebSocket
const ws = new WebSocket('ws://localhost:${port}');
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.type === 'log') appendLog(msg.data);
  if (msg.type === 'heal') appendHeal(msg.data);
  if (msg.type === 'stats') updateStats(msg.data);
};
ws.onerror = () => console.warn('logpilot WS error');

// Poll stats every 5s
setInterval(fetchStats, 5000);
fetchStats();
fetchHeals();

function fetchStats() {
  fetch('/api/stats').then(r => r.json()).then(data => {
    document.getElementById('stat-total').textContent = data.totalLogs?.toLocaleString() || '0';
    document.getElementById('stat-errors').textContent = data.errorLogs?.toLocaleString() || '0';
    document.getElementById('stat-response').textContent = (data.avgResponseMs || 0) + 'ms';
    document.getElementById('stat-heals').textContent = data.healCount || '0';
    if (data.currentMetrics) updateMetrics(data.currentMetrics);
    document.getElementById('val-uptime').textContent = formatUptime(data.uptime || 0);
  }).catch(() => {});
}

function fetchHeals() {
  fetch('/api/heals').then(r => r.json()).then(data => {
    const list = document.getElementById('heal-list');
    if (!data.actions?.length) return;
    list.innerHTML = data.actions.map(a => \`
      <div class="heal-entry">
        <div class="heal-rule">\${a.rule_name}</div>
        <div class="heal-action">Action: \${a.action}</div>
        <div class="heal-time">\${new Date(a.timestamp).toLocaleString()} — \${a.notes || ''}</div>
      </div>
    \`).join('');
  }).catch(() => {});
}

function updateStats(data) {
  document.getElementById('stat-total').textContent = (data.totalLogs || 0).toLocaleString();
  document.getElementById('stat-errors').textContent = (data.errorLogs || 0).toLocaleString();
  document.getElementById('stat-heals').textContent = (data.healCount || 0).toLocaleString();
}

function updateMetrics(m) {
  setBar('bar-mem', 'val-mem', m.memoryPercent, m.memoryPercent + '%');
  setBar('bar-cpu', 'val-cpu', m.cpu, m.cpu + '%');
  document.getElementById('val-lag').textContent = m.eventLoopLag + 'ms';
}

function setBar(barId, valId, pct, label) {
  const bar = document.getElementById(barId);
  const val = document.getElementById(valId);
  if (!bar || !val) return;
  bar.style.width = Math.min(100, pct) + '%';
  bar.className = 'bar-fill' + (pct > 85 ? ' critical' : pct > 65 ? ' warn' : '');
  val.textContent = label;
}

function appendLog(entry) {
  logEntries.unshift(entry);
  if (logEntries.length > MAX_LOGS) logEntries.pop();
  if (activeTab === 'live') renderLogs();
}

function renderLogs() {
  const stream = document.getElementById('log-stream');
  const wasAtTop = stream.scrollTop < 50;
  stream.innerHTML = logEntries.map(e => \`
    <div class="log-entry \${e.level}">
      <span class="log-time">\${fmtTime(e.timestamp)}</span>
      <span class="log-level \${e.level}">\${(e.level||'').toUpperCase()}</span>
      <span class="log-msg">\${e.message || ''}</span>
      \${e.responseTime ? \`<span class="log-rt">\${e.responseTime}ms</span>\` : ''}
    </div>
  \`).join('');
  if (wasAtTop) stream.scrollTop = 0;
}

function appendHeal(event) {
  fetchHeals();
  fetchStats();
  const banner = document.createElement('div');
  banner.style.cssText = 'position:fixed;top:16px;right:16px;background:#bc8cff;color:#000;padding:10px 16px;border-radius:8px;font-weight:700;z-index:999;font-size:13px';
  banner.textContent = '🔧 Heal action: ' + event.rule?.name;
  document.body.appendChild(banner);
  setTimeout(() => banner.remove(), 5000);
}

function runSearch() {
  const query = document.getElementById('search-input').value.trim();
  if (!query) return;
  const results = document.getElementById('search-results');
  results.innerHTML = '<div class="no-results">Searching...</div>';
  switchTab('search');
  fetch('/api/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query }) })
    .then(r => r.json())
    .then(data => {
      if (!data.groups?.length) {
        results.innerHTML = \`<div class="no-results">No results for "<b>\${query}</b>"<br><br><span style="font-size:11px;color:var(--muted)">\${data.description || ''}</span></div>\`;
        return;
      }
      results.innerHTML = \`
        <div style="padding:8px 0;margin-bottom:12px;color:var(--muted);font-size:12px;display:flex;gap:10px;align-items:center">
          Found <b style="color:var(--text)">\${data.totalFound}</b> logs — \${data.description}
          <span style="margin-left:auto;padding:2px 8px;border-radius:99px;font-size:10px;font-weight:700;\${data.searchMode==='semantic'?'background:rgba(88,166,255,0.15);color:#58a6ff':'background:rgba(139,148,158,0.15);color:#8b949e'}">\${data.searchMode==='semantic'?'⚡ Semantic':'🔤 Keyword'}</span>
        </div>
        \${data.groups.map(g => \`
          <div class="result-group">
            <div class="result-group-header">
              <span>\${g.name}</span>
              <span class="count">\${g.count} logs</span>
            </div>
            \${g.entries.slice(0, 3).map(e => \`
              <div class="result-entry">[\${fmtTime(e.timestamp)}] \${e.message || e.path || ''}</div>
            \`).join('')}
          </div>
        \`).join('')}
      \`;
    }).catch(() => { results.innerHTML = '<div class="no-results">Search failed</div>'; });
}

document.getElementById('search-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });

function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.tab').forEach((t, i) => t.classList.toggle('active', ['live','search'][i] === tab));
  document.getElementById('tab-live').classList.toggle('hidden', tab !== 'live');
  document.getElementById('tab-search').classList.toggle('hidden', tab !== 'search');
  if (tab === 'live') renderLogs();
}

function fmtTime(ts) { return new Date(ts).toLocaleTimeString(); }
function formatUptime(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h > 0 ? \`\${h}h \${m}m\` : \`\${m}m\`;
}
</script>
</body>
</html>`;
}

function stopDashboard() {
  if (dashboardServer) dashboardServer.close();
}

module.exports = { startDashboard, stopDashboard };
