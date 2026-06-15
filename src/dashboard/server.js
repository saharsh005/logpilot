const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const db = require('../storage/db');
const { search } = require('../nlp/search-engine');
const { getCurrentMetrics } = require('../core/metrics');
const { subscribeToLogs } = require('../core/interceptor');
const { subscribeToHeals, getActiveCircuitBreakers, getActiveRateLimits } = require('../heal/heal-engine');
const { getRouteBaselines } = require('../core/anomaly-detector');
const vectorStore = require('../nlp/vector-store');
const { captureSnapshot } = require('../heap/snapshot');
const { buildIncidentContext } = require('../correlation/IncidentCorrelator');
const { buildCorrelationGraph } = require('../correlation/correlator');
const { analyzeRootCause } = require('../ai/RootCauseEngine');
const { verifyRecovery } = require('../recovery/RecoveryVerifier');
const { generatePostmortem } = require('../postmortem/PostmortemGenerator');
const { findSimilarIncidents } = require('../similarity/incident-search');
const { generateRecommendations } = require('../recovery/recommendations');
const { investigate } = require('../agent/investigator');
const { getService: getSplunkService } = require('../integrations/splunk/service');
const splunkDatastore = require('../integrations/splunk/datastore');
const { observabilityQueries } = require('../integrations/splunk/datastore');
const { commandIncident, listCommandableIncidents, getPredictiveSearches } = require('../commander/incidentCommander');
const { buildKnowledgeGraph, dashboardVisualizationSpec } = require('../commander/knowledgeGraph');
const { collectEvidence } = require('../investigator/evidence/collector');
const { executeTool } = require('../mcp/tools');
const { searchSplunk } = require('../integrations/splunk/splunkSearch');

// ── Phase 12: simple in-memory rate limiter for API endpoints ─────────────
const _apiRateCounts = new Map();
function apiRateLimit(maxPerMinute = 60) {
  return (req, res, next) => {
    const key = req.ip + ':' + req.path;
    const now = Date.now();
    const entry = _apiRateCounts.get(key) || { count: 0, resetAt: now + 60000 };
    if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + 60000; }
    entry.count++;
    _apiRateCounts.set(key, entry);
    if (entry.count > maxPerMinute) {
      return res.status(429).json({ error: 'Too many requests', retryAfter: Math.ceil((entry.resetAt - now) / 1000) });
    }
    next();
  };
}

// ── Phase 12: input validation helper ────────────────────────────────────
function validateIncidentId(req, res) {
  const id = parseInt(req.params.id, 10);
  if (!id || id < 1 || id > 1e9) {
    res.status(400).json({ error: 'Invalid incident ID' });
    return null;
  }
  return id;
}

// Allows numeric SQLite ids (1, 42) AND Splunk-sourced ids (splunk-1, splunk-12)
function validateIncidentParam(req, res, next) {
  const id = String(req.params.id || '');
  if (!/^(splunk-)?\d{1,10}$/.test(id)) {
    return res.status(400).json({ error: 'Invalid incident ID' });
  }
  next();
}

let dashboardApp = null;
let dashboardServer = null;
let wss = null;

function startDashboard(port = 4321, config = {}) {
  dashboardApp = express();
  dashboardApp.use(express.json());

  dashboardApp.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
  });

  dashboardApp.get('/api/stats', (req, res) => {
    const { isReady: embedderReady } = require('../nlp/embedder');
    res.json({
      ...db.getStats(),
      currentMetrics: getCurrentMetrics(),
      circuitBreakers: getActiveCircuitBreakers(),
      rateLimits: getActiveRateLimits(),
      uptime: Math.round(process.uptime()),
      searchMode: (embedderReady() && vectorStore.isConnected()) ? 'semantic' : 'keyword',
    });
  });

  dashboardApp.get('/api/logs', (req, res) => {
    const { level, service, limit = 100 } = req.query;
    const logs = db.queryLogs({ level, service, limit: parseInt(limit), since: Date.now() - 24 * 60 * 60 * 1000 });
    res.json({ logs });
  });

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

  dashboardApp.get('/api/metrics', (req, res) => {
    const minutes = parseInt(req.query.minutes) || 60;
    res.json({ metrics: db.getRecentMetrics(minutes) });
  });

  dashboardApp.get('/api/analytics', (req, res) => {
    const hours = parseInt(req.query.hours) || 24;
    res.json(db.getDashboardAnalytics({ since: Date.now() - hours * 60 * 60 * 1000 }));
  });

  dashboardApp.get('/api/heals', (req, res) => {
    res.json({ actions: db.getHealActions(50) });
  });

  dashboardApp.get('/api/incidents', async (req, res) => {
    const hours = parseInt(req.query.hours) || 24;
    try {
      const result = await splunkDatastore.getIncidents(config, {
        hours,
        limit: parseInt(req.query.limit) || 100,
      });
      res.json({ groups: result.incidents, source: result.source, query: result.query });
    } catch (err) {
      // Always fall back to local so the dashboard never breaks
      res.json({
        groups: db.getIncidentGroups({
          limit: parseInt(req.query.limit) || 100,
          since: Date.now() - hours * 60 * 60 * 1000,
        }),
        source: 'local',
        error: err.message,
      });
    }
  });

  dashboardApp.get('/api/incidents/:id/timeline', validateIncidentParam, async (req, res) => {
    try {
      const group = await splunkDatastore.getIncidentById(req.params.id, config);
      if (!group) return res.status(404).json({ error: 'incident group not found' });
      const related = Number.isFinite(group.id) ? db.getRelatedIncidents(group.id) : [];
      const eventsResult = await splunkDatastore.getIncidentEvents(group, config, { limit: parseInt(req.query.limit) || 100 });
      res.json({ group, events: eventsResult.events || [], related, source: eventsResult.source });
    } catch (err) {
      res.status(500).json({ error: 'timeline failed', message: err.message });
    }
  });

  dashboardApp.get('/api/incidents/:id/analysis', validateIncidentParam, async (req, res) => {
    try {
      const analysis = await getIncidentAnalysis(req.params.id, config);
      if (!analysis) return res.status(404).json({ error: 'incident group not found' });
      res.json(analysis);
    } catch (err) {
      res.status(500).json({ error: 'analysis failed', message: err.message });
    }
  });

  dashboardApp.get('/api/incidents/:id/postmortem.md', validateIncidentParam, async (req, res) => {
    try {
      const analysis = await getIncidentAnalysis(req.params.id, config);
      if (!analysis) return res.status(404).send('Incident group not found');
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="logpilot-incident-${req.params.id}-postmortem.md"`);
      res.send(analysis.postmortem || '# Incident Summary\n\nNo postmortem generated.');
    } catch (err) {
      res.status(500).send(`Postmortem generation failed: ${err.message}`);
    }
  });

  dashboardApp.get('/api/incidents/:id/related', (req, res) => {
    const numId = Number(req.params.id);
    const related = Number.isFinite(numId) ? db.getRelatedIncidents(numId) : [];
    res.json({ related });
  });

  dashboardApp.get('/api/baselines', (req, res) => {
    res.json({ baselines: getRouteBaselines() });
  });

  dashboardApp.get('/api/heap-snapshots', (req, res) => {
    res.json({ snapshots: db.getHeapSnapshots(30) });
  });

  dashboardApp.post('/api/heap-snapshots', (req, res) => {
    const snap = captureSnapshot('manual', req.body?.notes || '');
    res.json({ snapshot: snap });
  });

  // ── Phase 11: Splunk health endpoint ────────────────────────────────────
  dashboardApp.get('/api/splunk/health', apiRateLimit(30), async (req, res) => {
    const splunk = getSplunkService();
    if (!splunk) return res.json({ enabled: false, reason: 'Splunk service not initialised' });
    try {
      const health = await splunk.getFullHealth();
      res.json(health);
    } catch (err) {
      res.status(500).json({ error: 'Health check failed', message: err.message });
    }
  });

  // Serve extended dashboard JS (Phase 3-7 render functions)
  dashboardApp.get('/dashboard-ext.js', (req, res) => {
    const fs = require('fs');
    const path = require('path');
    const extPath = path.join(__dirname, 'dashboard-ext.js');
    res.setHeader('Content-Type', 'application/javascript');
    try { res.send(fs.readFileSync(extPath, 'utf8')); }
    catch(e) { res.status(404).send('// dashboard-ext.js not found'); }
  });

  dashboardApp.get('/api/protections', (req, res) => {
    res.json({
      circuitBreakers: getActiveCircuitBreakers(),
      rateLimits: getActiveRateLimits(),
    });
  });

  // ── Phase 3: Correlation Graph ──────────────────────────────────────────
  dashboardApp.get('/api/incidents/:id/correlation', apiRateLimit(30), validateIncidentParam, async (req, res) => {
    try {
      const context = await buildIncidentContext(req.params.id, config);
      if (!context) return res.status(404).json({ error: 'incident not found' });
      const graph = await buildCorrelationGraph(context, config);
      res.json(graph);
    } catch (err) {
      res.status(500).json({ error: 'correlation failed', message: err.message });
    }
  });

  // ── Phase 4: Similar Incidents ──────────────────────────────────────────
  dashboardApp.get('/api/incidents/:id/similar', apiRateLimit(30), validateIncidentParam, async (req, res) => {
    try {
      const incident = await splunkDatastore.getIncidentById(req.params.id, config);
      if (!incident) return res.status(404).json({ error: 'incident not found' });
      const similar = await findSimilarIncidents(incident, {
        limit: parseInt(req.query.limit) || 10,
        threshold: parseInt(req.query.threshold) || 25,
        config,
      });
      res.json({ similar });
    } catch (err) {
      res.status(500).json({ error: 'similarity search failed', message: err.message });
    }
  });

  // ── Phase 5: AI Investigator (full agentic RCA) ─────────────────────────
  dashboardApp.post('/api/incidents/:id/investigate', apiRateLimit(10), validateIncidentParam, async (req, res) => {
    try {
      const result = await investigate(req.params.id, config);
      if (!result) return res.status(404).json({ error: 'incident not found' });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: 'investigation failed', message: err.message });
    }
  });

  // ── Phase 7: Recovery Recommendations ───────────────────────────────────
  dashboardApp.get('/api/incidents/:id/recommendations', apiRateLimit(30), validateIncidentParam, async (req, res) => {
    try {
      const context = await buildIncidentContext(req.params.id, config);
      if (!context) return res.status(404).json({ error: 'incident not found' });
      const similar = await findSimilarIncidents(context.incident, { limit: 5, config });
      const recommendations = generateRecommendations(context, similar, config);
      res.json({ recommendations });
    } catch (err) {
      res.status(500).json({ error: 'recommendations failed', message: err.message });
    }
  });

  // ── Phase 2: Evidence snapshot (always collect fresh, cache for 2min) ────
  dashboardApp.get('/api/incidents/:id/evidence', apiRateLimit(30), validateIncidentParam, async (req, res) => {
    try {
      const incident = await splunkDatastore.getIncidentById(req.params.id, config);
      if (!incident) return res.status(404).json({ error: 'incident not found' });
      // collectEvidence handles its own cache check internally
      const evidence = await collectEvidence(incident, config);
      res.json(evidence);
    } catch (err) {
      res.status(500).json({ error: 'evidence collection failed', message: err.message });
    }
  });

  // ── Phase 8: Recovery Verification ──────────────────────────────────────
  dashboardApp.get('/api/incidents/:id/recovery', apiRateLimit(30), validateIncidentParam, async (req, res) => {
    try {
      const incident = await splunkDatastore.getIncidentById(req.params.id, config);
      if (!incident) return res.status(404).json({ error: 'incident not found' });
      const result = await verifyRecovery(incident, config);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: 'recovery verification failed', message: err.message });
    }
  });

  // ── Incident Commander: Splunk-first autonomous pipeline ────────────────
  // ── Observability + Predictive Analytics queries ──────────────────────────
  dashboardApp.get('/api/commander/predictions', apiRateLimit(20), (req, res) => {
    try {
      const splunkEnabled = !!getSplunkService()?.isEnabled();
      const queries = observabilityQueries(config);
      res.json({ queries, splunkEnabled });
    } catch (err) {
      res.status(500).json({ error: 'predictions failed', message: err.message });
    }
  });

  dashboardApp.get('/api/commander/predictions/run', apiRateLimit(10), async (req, res) => {
    try {
      const queries = observabilityQueries(config);
      const name = req.query.name;
      if (!name || !queries[name]) return res.status(400).json({ error: 'unknown query', available: Object.keys(queries) });
      const q = queries[name];
      const result = await splunkDatastore.searchEvidence(q.spl, config);
      res.json({ name, label: q.label, category: q.category, ...result });
    } catch (err) {
      res.status(500).json({ error: 'query run failed', message: err.message });
    }
  });

  dashboardApp.post('/api/commander/run/:id', apiRateLimit(5), validateIncidentParam, async (req, res) => {
    try {
      const command = await commandIncident(req.params.id, config, {
        execute: req.body?.execute !== false && config.commander?.executeRecovery !== false,
        earliest: req.body?.earliest,
      });
      if (!command) return res.status(404).json({ error: 'incident not found' });
      res.json(command);
    } catch (err) {
      res.status(500).json({ error: 'commander run failed', message: err.message });
    }
  });

  dashboardApp.get('/api/incidents/:id/knowledge-graph', apiRateLimit(20), validateIncidentParam, async (req, res) => {
    try {
      const incident = await splunkDatastore.getIncidentById(req.params.id, config);
      if (!incident) return res.status(404).json({ error: 'incident not found' });
      const evidence = await collectEvidence(incident, config);
      const similarResult = await executeTool('find_related_incidents', {
        path: incident.path, rootCause: incident.root_cause, earliest: '-30d',
      }, config).catch(() => ({ incidents: [] }));
      const graph = buildKnowledgeGraph({ incident, evidence, similar: similarResult.incidents || [] });
      res.json({ ...graph, spec: dashboardVisualizationSpec() });
    } catch (err) {
      res.status(500).json({ error: 'knowledge graph failed', message: err.message });
    }
  });

  dashboardApp.get('/api/incidents/:id/blast-radius', apiRateLimit(20), validateIncidentParam, async (req, res) => {
    try {
      const incident = await splunkDatastore.getIncidentById(req.params.id, config);
      if (!incident) return res.status(404).json({ error: 'incident not found' });
      const result = await executeTool('estimate_blast_radius', {
        service: incident.service, path: incident.path, earliest: '-1h',
      }, config);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: 'blast radius estimation failed', message: err.message });
    }
  });

  dashboardApp.post('/api/incidents/:id/simulate-recovery', apiRateLimit(10), validateIncidentParam, async (req, res) => {
    try {
      const incident = await splunkDatastore.getIncidentById(req.params.id, config);
      if (!incident) return res.status(404).json({ error: 'incident not found' });
      const action = req.body?.action;
      if (!action) return res.status(400).json({ error: 'action is required' });
      const result = await executeTool('simulate_recovery', { incidentId: incident.id, action, path: incident.path }, config);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: 'recovery simulation failed', message: err.message });
    }
  });

  dashboardApp.get('/api/incidents/:id/mttr', apiRateLimit(20), validateIncidentParam, async (req, res) => {
    try {
      const incident = await splunkDatastore.getIncidentById(req.params.id, config);
      if (!incident) return res.status(404).json({ error: 'incident not found' });
      const result = await executeTool('estimate_mttr', { path: incident.path, rootCause: incident.root_cause, earliest: '-30d' }, config);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: 'mttr estimation failed', message: err.message });
    }
  });


  dashboardApp.get('/api/analytics/advanced', async (req, res) => {
    const hours = parseInt(req.query.hours) || 24;
    const since = Date.now() - hours * 60 * 60 * 1000;
    try {
      let incidents, heals, source = 'local';

      if (config.splunk?.enabled) {
        try {
          const idx = config.splunk.index || 'logpilot';
          const incidentQuery = `search index=${idx} type=incident earliest=-${hours}h | stats latest(rootCause) as rootCause latest(lastSeen) as lastSeen min(firstSeen) as firstSeen latest(lastAction) as lastAction by incidentId`;
          const healQuery = `search index=${idx} type=heal earliest=-${hours}h | stats count by action success`;

          const [incR, healR] = await Promise.all([
            searchSplunk(incidentQuery, config),
            searchSplunk(healQuery, config),
          ]);

          if (incR.source === 'splunk') {
            source = 'splunk';
            incidents = (incR.events || []).map(e => ({
              root_cause: e.rootCause || 'Unknown',
              last_seen: Number(e.lastSeen) || Date.now(),
              first_seen: Number(e.firstSeen) || Date.now(),
              last_action: e.lastAction || null,
            }));
            heals = (healR.events || []).flatMap(e => {
              const n = Number(e.count) || 0;
              return Array.from({ length: n }, () => ({ success: String(e.success) === '1' || e.success === true || e.success === 'true' }));
            });
          }
        } catch (_) { /* fall through to local */ }
      }

      if (!incidents) {
        incidents = db.getIncidentGroups({ limit: 500, since });
        heals = db.getHealActions(500);
        source = 'local';
      }

      // Root cause distribution
      const rcaDist = {};
      incidents.forEach(inc => {
        const rc = inc.root_cause || 'Unknown';
        rcaDist[rc] = (rcaDist[rc] || 0) + 1;
      });

      // Recovery success rate
      const totalHeals = heals.length;
      const successfulHeals = heals.filter(h => h.success).length;
      const recoverySuccessRate = totalHeals ? Math.round((successfulHeals / totalHeals) * 100) : 0;

      // Mean time to recovery (approx: last_seen - first_seen for resolved incidents)
      const resolvedTimes = incidents
        .filter(inc => inc.last_action)
        .map(inc => (inc.last_seen - inc.first_seen) / 60000);  // minutes
      const mttr = resolvedTimes.length
        ? Math.round(resolvedTimes.reduce((a, b) => a + b, 0) / resolvedTimes.length)
        : 0;

      // Category distribution
      const categories = {};
      incidents.forEach(inc => {
        const cat = mapRootCauseToCategory(inc.root_cause);
        categories[cat] = (categories[cat] || 0) + 1;
      });

      res.json({
        source,
        rcaDistribution: Object.entries(rcaDist).map(([label, value]) => ({ label, value })),
        recoverySuccessRate,
        mttrMinutes: mttr,
        totalIncidents: incidents.length,
        totalHeals,
        successfulHeals,
        incidentCategories: Object.entries(categories).map(([label, value]) => ({ label, value })),
      });
    } catch (err) {
      res.status(500).json({ error: 'analytics failed', message: err.message });
    }
  });

  dashboardApp.get('/', (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.send(buildDashboardHTML(port, config));
  });

  dashboardServer = http.createServer(dashboardApp);
  wss = new WebSocket.Server({ server: dashboardServer });

  const unsubLogs = subscribeToLogs((entry) => {
    broadcast({ type: 'log', data: entry });
    if (Math.random() < 0.1) {
      broadcast({ type: 'stats', data: { ...db.getStats(), uptime: Math.round(process.uptime()) } });
    }
  });

  const unsubHeals = subscribeToHeals((event) => {
    broadcast({ type: 'heal', data: event });
    broadcast({ type: 'stats', data: { ...db.getStats(), uptime: Math.round(process.uptime()) } });
  });

  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({
      type: 'init',
      data: {
        stats: { ...db.getStats(), currentMetrics: getCurrentMetrics(), uptime: Math.round(process.uptime()) },
        incidents: db.getIncidentGroups({ limit: 50, since: Date.now() - 24 * 60 * 60 * 1000 }),
        heals: db.getHealActions(20),
      }
    }));
  });

  dashboardServer.listen(port, () => {
    console.log(require('chalk').cyan('[logpilot]'), require('chalk').green(`✓ Dashboard → http://localhost:${port}`));
  });

  return dashboardServer;
}

function mapRootCauseToCategory(rootCause) {
  if (!rootCause) return 'Unknown';
  const rc = rootCause.toLowerCase();
  if (rc.includes('memory') || rc.includes('cpu')) return 'Resource';
  if (rc.includes('data') || rc.includes('timeout')) return 'Dependency';
  if (rc.includes('rate')) return 'Traffic';
  if (rc.includes('deploy') || rc.includes('code')) return 'Deployment';
  return rootCause;
}

async function getIncidentAnalysis(incidentId, config) {
  let incident = db.getIncidentGroup(Number(incidentId));
  if (!incident) incident = await splunkDatastore.getIncidentById(incidentId, config);
  if (!incident) return null;

  const cacheKey = String(incident.id);
  const cached = db.getIncidentAnalysis(cacheKey);
  if (cached && Date.now() - cached.updatedAt < 60 * 1000) return cached;

  const context = await buildIncidentContext(incident.id, config);
  if (!context) return null;
  const rca = await analyzeRootCause(context, config);
  const recovery = await verifyRecovery(incident, config);
  const healActions = db.getHealActions(100).filter(action => {
    const trigger = `${action.trigger_detail || ''} ${action.notes || ''}`;
    return !incident.path || trigger.includes(incident.path) || trigger.includes(incident.title || '');
  });
  const postmortem = generatePostmortem({ incident, context, rca, recovery, healActions });
  const analysis = { incidentId: cacheKey, context, rca, recovery, postmortem, updatedAt: Date.now() };
  db.upsertIncidentAnalysis(cacheKey, analysis);
  return analysis;
}

function broadcast(msg) {
  if (!wss) return;
  const data = JSON.stringify(msg);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(data); } catch (e) {}
    }
  });
}

function buildDashboardHTML(port, config) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>LogPilot</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@300;400;500&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}

:root {
  --bg: #f5f6f8;
  --surface: #ffffff;
  --surface2: #f8f9fb;
  --border: #e8eaed;
  --border2: #dde0e5;
  --text: #1a1d23;
  --text1: #1a1d23;
  --text2: #4b5563;
  --text4: #9ca3af;
  --text2: #4a5568;
  --text3: #8a94a6;
  --text4: #b0bac9;
  --blue: #2563eb;
  --blue-light: #eff4ff;
  --blue-mid: #dbeafe;
  --green: #16a34a;
  --green-light: #f0fdf4;
  --red: #dc2626;
  --red-light: #fef2f2;
  --red-mid: #fee2e2;
  --yellow: #d97706;
  --yellow-light: #fffbeb;
  --orange: #ea580c;
  --orange-light: #fff7ed;
  --purple: #7c3aed;
  --purple-light: #f5f3ff;
  --radius: 10px;
  --radius-sm: 6px;
  --shadow: 0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.04);
  --shadow-md: 0 4px 16px rgba(0,0,0,0.08), 0 2px 6px rgba(0,0,0,0.04);
  --shadow-lg: 0 12px 40px rgba(0,0,0,0.12), 0 4px 12px rgba(0,0,0,0.06);
}

html, body { height:100%; background:var(--bg); color:var(--text); font-family:'DM Sans',sans-serif; font-size:14px; line-height:1.5; overflow:hidden; }

/* ── LAYOUT ─────────────────────────────────────────────────── */
#shell { display:flex; height:100vh; }
#sidebar { width:220px; flex-shrink:0; background:var(--surface); border-right:1px solid var(--border); display:flex; flex-direction:column; overflow:hidden; }
#main { flex:1; display:flex; flex-direction:column; overflow:hidden; min-width:0; }

/* ── SIDEBAR ─────────────────────────────────────────────────── */
.sb-logo {
  padding:18px 16px 14px; display:flex; align-items:center; gap:9px;
  border-bottom:1px solid var(--border);
}
.sb-logo-icon {
  width:30px; height:30px; background:var(--blue); border-radius:8px;
  display:flex; align-items:center; justify-content:center; flex-shrink:0;
}
.sb-logo-icon svg { width:16px; height:16px; }
.sb-logo-text { display:flex; flex-direction:column; line-height:1.1; }
.sb-logo-name { font-size:13px; font-weight:600; color:var(--text); }
.sb-logo-sub { font-size:10px; color:var(--text3); font-weight:400; }

.sb-section { padding:16px 10px 6px; }
.sb-section-label { font-size:10px; font-weight:600; letter-spacing:0.08em; text-transform:uppercase; color:var(--text4); padding:0 8px; margin-bottom:4px; }
.sb-item {
  display:flex; align-items:center; gap:9px; padding:7px 8px; border-radius:var(--radius-sm);
  font-size:13px; font-weight:500; color:var(--text2); cursor:pointer; transition:all 0.12s;
  text-decoration:none; user-select:none;
}
.sb-item:hover { background:var(--surface2); color:var(--text); }
.sb-item.active { background:var(--blue-light); color:var(--blue); }
.sb-item.active .sb-icon { color:var(--blue); }
.sb-icon { width:16px; height:16px; flex-shrink:0; opacity:0.7; }
.sb-item.active .sb-icon { opacity:1; }

.sb-badge {
  margin-left:auto; background:var(--red); color:#fff; font-size:10px; font-weight:600;
  padding:1px 6px; border-radius:10px; line-height:1.4;
}
.sb-badge.yellow { background:var(--yellow); }
.sb-badge.hidden { display:none; }

.sb-footer {
  margin-top:auto; padding:12px 10px; border-top:1px solid var(--border);
}
.sb-status {
  display:flex; align-items:center; gap:7px; padding:6px 8px; border-radius:var(--radius-sm);
  background:var(--green-light); font-size:11px; font-weight:500; color:var(--green);
}
.sb-status-dot { width:6px; height:6px; border-radius:50%; background:var(--green); flex-shrink:0; animation:blink 2.5s infinite; }
@keyframes blink { 0%,100%{opacity:1} 50%{opacity:0.4} }
.sb-status.disconnected { background:var(--red-light); color:var(--red); }
.sb-status.disconnected .sb-status-dot { background:var(--red); animation:none; }

/* ── TOPBAR ─────────────────────────────────────────────────── */
#topbar {
  height:52px; background:var(--surface); border-bottom:1px solid var(--border);
  display:flex; align-items:center; padding:0 20px; gap:12px; flex-shrink:0;
}
.tb-search {
  flex:1; max-width:340px; display:flex; align-items:center; gap:8px;
  background:var(--surface2); border:1px solid var(--border); border-radius:8px;
  padding:7px 12px; cursor:text;
}
.tb-search input {
  flex:1; border:none; background:transparent; font-family:'DM Sans',sans-serif;
  font-size:13px; color:var(--text); outline:none;
}
.tb-search input::placeholder { color:var(--text4); }
.tb-search-icon { color:var(--text4); flex-shrink:0; }
.tb-shortcut {
  background:var(--border); border-radius:4px; padding:1px 5px; font-size:10px;
  color:var(--text3); font-family:'DM Mono',monospace; flex-shrink:0;
}

.tb-spacer { flex:1; }
.tb-actions { display:flex; align-items:center; gap:8px; }
.tb-btn {
  width:32px; height:32px; border-radius:8px; display:flex; align-items:center; justify-content:center;
  border:1px solid var(--border); background:var(--surface); cursor:pointer; color:var(--text3);
  transition:all 0.12s;
}
.tb-btn:hover { background:var(--surface2); color:var(--text2); }
.tb-avatar {
  width:32px; height:32px; border-radius:50%; background:var(--blue); display:flex;
  align-items:center; justify-content:center; font-size:12px; font-weight:600;
  color:#fff; cursor:pointer; flex-shrink:0;
}
.tb-date {
  font-size:12px; color:var(--text3); white-space:nowrap; border:1px solid var(--border);
  border-radius:8px; padding:5px 10px; display:flex; align-items:center; gap:6px;
  cursor:pointer; transition:all 0.12s; background:var(--surface);
}
.tb-date:hover { border-color:var(--blue); color:var(--blue); }

/* ── PAGE CONTENT ───────────────────────────────────────────── */
#page { flex:1; overflow-y:auto; padding:24px; }
.page-title { font-size:22px; font-weight:600; color:var(--text); margin-bottom:20px; }

/* ── KPI CARDS ──────────────────────────────────────────────── */
.kpi-row { display:grid; grid-template-columns:repeat(4,1fr); gap:14px; margin-bottom:20px; }
.kpi-card {
  background:var(--surface); border:1px solid var(--border); border-radius:var(--radius);
  padding:16px 18px; box-shadow:var(--shadow); transition:box-shadow 0.15s;
}
.kpi-card:hover { box-shadow:var(--shadow-md); }
.kpi-label { font-size:11px; font-weight:600; letter-spacing:0.06em; text-transform:uppercase; color:var(--text3); margin-bottom:6px; display:flex; align-items:center; justify-content:space-between; }
.kpi-label-icon { width:28px; height:28px; border-radius:7px; display:flex; align-items:center; justify-content:center; }
.kpi-label-icon.blue { background:var(--blue-light); color:var(--blue); }
.kpi-label-icon.green { background:var(--green-light); color:var(--green); }
.kpi-label-icon.red { background:var(--red-light); color:var(--red); }
.kpi-label-icon.yellow { background:var(--yellow-light); color:var(--yellow); }
.kpi-value { font-size:26px; font-weight:600; color:var(--text); line-height:1.1; font-variant-numeric:tabular-nums; }
.kpi-sub { font-size:11px; color:var(--text3); margin-top:3px; }
.kpi-sub.up { color:var(--red); }
.kpi-sub.down { color:var(--green); }

/* ── GRID ───────────────────────────────────────────────────── */
.grid2 { display:grid; grid-template-columns:1fr 320px; gap:16px; margin-bottom:16px; }
.grid2-wide { display:grid; grid-template-columns:1fr; gap:16px; margin-bottom:16px; }

/* ── CARDS ──────────────────────────────────────────────────── */
.card {
  background:var(--surface); border:1px solid var(--border); border-radius:var(--radius);
  box-shadow:var(--shadow); overflow:hidden;
}
.card-header {
  padding:14px 18px 12px; display:flex; align-items:center; justify-content:space-between;
  border-bottom:1px solid var(--border);
}
.card-title { font-size:13px; font-weight:600; color:var(--text); display:flex; align-items:center; gap:7px; }
.card-title-badge {
  font-size:10px; font-weight:600; padding:2px 7px; border-radius:10px; line-height:1.4;
}
.card-title-badge.red { background:var(--red-mid); color:var(--red); }
.card-title-badge.yellow { background:#fef3c7; color:var(--yellow); }
.card-title-badge.blue { background:var(--blue-mid); color:var(--blue); }
.card-action {
  font-size:12px; color:var(--blue); cursor:pointer; font-weight:500;
  padding:4px 10px; border-radius:var(--radius-sm); transition:background 0.12s;
  display:flex; align-items:center; gap:4px; border:1px solid transparent;
}
.card-action:hover { background:var(--blue-light); border-color:var(--blue-mid); }

/* ── TREND CHART ─────────────────────────────────────────────── */
.chart-wrap { padding:16px 18px 12px; }
.chart-legend { display:flex; gap:16px; margin-bottom:12px; }
.legend-item { display:flex; align-items:center; gap:6px; font-size:12px; color:var(--text2); }
.legend-dot { width:8px; height:8px; border-radius:2px; }
#trend-canvas { width:100%; height:180px; display:block; }
.mini-chart-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:16px; margin-bottom:16px; }
.mini-chart { height:190px; padding:12px 14px; }
.chart-canvas { width:100%; height:130px; display:block; }
.analysis-grid { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
.analysis-box { background:var(--surface2); border:1px solid var(--border); border-radius:8px; padding:11px 12px; }
.analysis-label { font-size:10px; font-weight:600; letter-spacing:0.07em; text-transform:uppercase; color:var(--text4); margin-bottom:5px; }
.analysis-value { font-size:17px; font-weight:600; color:var(--text); }
.evidence-list { display:flex; flex-direction:column; gap:8px; margin-top:10px; }
.evidence-item { border:1px solid var(--border); border-radius:8px; padding:9px 10px; background:var(--surface); font-size:12px; color:var(--text2); }
.postmortem-box { white-space:pre-wrap; font-family:'DM Mono',monospace; font-size:11px; line-height:1.55; background:var(--surface2); border:1px solid var(--border); border-radius:8px; padding:12px; max-height:260px; overflow:auto; color:var(--text2); }
.tab-row { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:14px; border-bottom:1px solid var(--border); padding-bottom:10px; }
.tab-btn { border:1px solid var(--border); background:var(--surface); color:var(--text2); font:500 12px 'DM Sans',sans-serif; padding:6px 10px; border-radius:7px; cursor:pointer; }
.tab-btn.active { background:var(--blue-light); border-color:var(--blue-mid); color:var(--blue); }

/* ── SYSTEM EVENTS ───────────────────────────────────────────── */
.event-list { padding:6px 0; max-height:300px; overflow-y:auto; }
.event-item {
  display:flex; align-items:flex-start; gap:10px; padding:10px 18px;
  border-bottom:1px solid var(--border); cursor:pointer; transition:background 0.12s;
}
.event-item:last-child { border-bottom:none; }
.event-item:hover { background:var(--surface2); }
.event-dot { width:8px; height:8px; border-radius:50%; flex-shrink:0; margin-top:4px; }
.event-dot.critical { background:var(--red); box-shadow:0 0 0 3px var(--red-mid); }
.event-dot.warning { background:var(--yellow); box-shadow:0 0 0 3px #fef3c7; }
.event-dot.info { background:var(--blue); box-shadow:0 0 0 3px var(--blue-mid); }
.event-dot.success { background:var(--green); box-shadow:0 0 0 3px #dcfce7; }
.event-body { flex:1; min-width:0; }
.event-title { font-size:13px; font-weight:500; color:var(--text); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.event-sub { font-size:11px; color:var(--text3); margin-top:1px; }
.event-arrow { color:var(--text4); margin-top:2px; flex-shrink:0; transition:transform 0.12s; }
.event-item:hover .event-arrow { color:var(--blue); transform:translateX(2px); }
.event-empty { padding:24px 18px; text-align:center; font-size:13px; color:var(--text3); }

/* ── INCIDENTS TABLE ─────────────────────────────────────────── */
.inc-table { width:100%; border-collapse:collapse; }
.inc-table th {
  text-align:left; font-size:10px; font-weight:600; letter-spacing:0.07em;
  text-transform:uppercase; color:var(--text3); padding:9px 16px;
  background:var(--surface2); border-bottom:1px solid var(--border);
}
.inc-table td { padding:10px 16px; font-size:13px; border-bottom:1px solid var(--border); vertical-align:middle; }
.inc-table tr:last-child td { border-bottom:none; }
.inc-table tbody tr { cursor:pointer; transition:background 0.1s; }
.inc-table tbody tr:hover { background:var(--surface2); }
.inc-table tbody tr.selected { background:var(--blue-light); }

.badge {
  display:inline-flex; align-items:center; padding:2px 8px; border-radius:20px;
  font-size:11px; font-weight:600; line-height:1.4; white-space:nowrap;
}
.badge-red { background:var(--red-mid); color:var(--red); }
.badge-yellow { background:#fef3c7; color:var(--yellow); }
.badge-blue { background:var(--blue-mid); color:var(--blue); }
.badge-green { background:#dcfce7; color:var(--green); }
.badge-purple { background:#ede9fe; color:var(--purple); }
.badge-gray { background:var(--surface2); color:var(--text2); border:1px solid var(--border2); }

.method-tag {
  display:inline-flex; padding:2px 6px; border-radius:4px; font-size:10px; font-weight:700;
  font-family:'DM Mono',monospace; letter-spacing:0.03em;
}
.method-GET { background:#f0fdf4; color:#166534; }
.method-POST { background:#eff6ff; color:#1e40af; }
.method-PUT { background:#fffbeb; color:#92400e; }
.method-DELETE { background:#fef2f2; color:#991b1b; }
.method-PATCH { background:#f5f3ff; color:#4c1d95; }

.mono { font-family:'DM Mono',monospace; font-size:12px; }

/* ── LIVE LOGS ───────────────────────────────────────────────── */
#log-stream { padding:0; }
.log-row {
  display:flex; align-items:baseline; gap:10px; padding:7px 18px;
  border-bottom:1px solid var(--border); font-family:'DM Mono',monospace;
  font-size:11.5px; transition:background 0.08s; line-height:1.4;
}
.log-row:hover { background:var(--surface2); }
.log-row.error { background:#fff8f8; }
.log-row.warn { background:#fffdf5; }
.log-row.error:hover { background:#fff1f1; }
.log-row.warn:hover { background:#fffaed; }
.log-time { color:var(--text4); flex-shrink:0; font-size:11px; }
.log-lvl { flex-shrink:0; width:38px; text-align:center; }
.lvl-badge { display:inline-flex; padding:1px 5px; border-radius:4px; font-size:9px; font-weight:700; letter-spacing:0.04em; }
.lvl-badge.error { background:var(--red-mid); color:var(--red); }
.lvl-badge.warn  { background:#fef3c7; color:#92400e; }
.lvl-badge.info  { background:var(--blue-mid); color:#1e40af; }
.log-msg { color:var(--text2); flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.log-rt  { color:var(--text4); flex-shrink:0; font-size:11px; }

/* ── DETAIL PANEL ─────────────────────────────────────────────── */
#detail-overlay {
  display:none; position:fixed; inset:0; z-index:100;
  background:rgba(15,18,26,0.35); backdrop-filter:blur(2px);
  align-items:center; justify-content:center;
}
#detail-overlay.open { display:flex; }
#detail-modal {
  background:var(--surface); border-radius:14px; box-shadow:var(--shadow-lg);
  width:580px; max-width:95vw; max-height:88vh; display:flex; flex-direction:column;
  overflow:hidden; animation:modalIn 0.18s ease;
}
@keyframes modalIn { from{opacity:0;transform:translateY(12px) scale(0.98)} to{opacity:1;transform:none} }
.modal-header {
  padding:18px 20px 14px; border-bottom:1px solid var(--border);
  display:flex; align-items:flex-start; justify-content:space-between; gap:12px; flex-shrink:0;
}
.modal-badge { display:flex; align-items:center; gap:6px; font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:0.06em; margin-bottom:6px; }
.modal-badge .dot { width:7px; height:7px; border-radius:50%; }
.modal-badge.critical { color:var(--red); }
.modal-badge.critical .dot { background:var(--red); }
.modal-badge.warning { color:var(--yellow); }
.modal-badge.warning .dot { background:var(--yellow); }
.modal-title { font-size:18px; font-weight:600; color:var(--text); line-height:1.2; }
.modal-close {
  width:28px; height:28px; border-radius:6px; display:flex; align-items:center; justify-content:center;
  cursor:pointer; color:var(--text3); transition:all 0.12s; flex-shrink:0; margin-top:2px;
  border:1px solid transparent;
}
.modal-close:hover { background:var(--surface2); border-color:var(--border); color:var(--text); }
.modal-body { flex:1; overflow-y:auto; padding:18px 20px; }
.modal-footer {
  padding:14px 20px; border-top:1px solid var(--border); display:flex; align-items:center;
  justify-content:space-between; flex-shrink:0;
}
.modal-ts { font-family:'DM Mono',monospace; font-size:11px; color:var(--text3); }
.modal-actions { display:flex; gap:8px; }
.btn-outline {
  padding:7px 16px; border-radius:7px; font-family:'DM Sans',sans-serif; font-size:13px;
  font-weight:500; cursor:pointer; transition:all 0.12s; border:1px solid var(--border2);
  background:var(--surface); color:var(--text2);
}
.btn-outline:hover { border-color:var(--text3); color:var(--text); }
.btn-primary {
  padding:7px 16px; border-radius:7px; font-family:'DM Sans',sans-serif; font-size:13px;
  font-weight:500; cursor:pointer; transition:all 0.12s; border:none;
  background:var(--blue); color:#fff; display:flex; align-items:center; gap:6px;
}
.btn-primary:hover { background:#1d4ed8; }

/* ── MODAL CONTENT ───────────────────────────────────────────── */
.detail-stat-row { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; margin-bottom:18px; }
.detail-stat { background:var(--surface2); border:1px solid var(--border); border-radius:8px; padding:10px 12px; }
.detail-stat-label { font-size:10px; font-weight:600; letter-spacing:0.06em; text-transform:uppercase; color:var(--text3); margin-bottom:3px; }
.detail-stat-val { font-size:16px; font-weight:600; color:var(--text); }

.root-cause-box {
  background:linear-gradient(135deg,var(--blue-light),#f5f3ff);
  border:1px solid var(--blue-mid); border-radius:8px; padding:12px 14px; margin-bottom:16px;
}
.rc-label { font-size:10px; font-weight:600; letter-spacing:0.07em; text-transform:uppercase; color:var(--blue); margin-bottom:4px; }
.rc-title { font-size:14px; font-weight:600; color:var(--text); margin-bottom:4px; }
.rc-desc { font-size:12px; color:var(--text2); line-height:1.55; }

.section-label { font-size:11px; font-weight:600; letter-spacing:0.06em; text-transform:uppercase; color:var(--text3); margin-bottom:8px; display:flex; align-items:center; gap:7px; }

.related-row { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:16px; }
.related-chip {
  display:flex; align-items:center; gap:6px; padding:6px 10px; border-radius:7px;
  border:1px solid var(--border2); background:var(--surface); cursor:pointer;
  transition:all 0.12s; font-size:12px;
}
.related-chip:hover { border-color:var(--blue); background:var(--blue-light); color:var(--blue); }
.related-chip .rc-count { color:var(--text3); font-size:11px; }

.timeline-list { display:flex; flex-direction:column; }
.tl-row { display:flex; gap:12px; padding:7px 0; position:relative; }
.tl-row::before {
  content:''; position:absolute; left:6px; top:22px; width:1px;
  height:calc(100% - 10px); background:var(--border);
}
.tl-row:last-child::before { display:none; }
.tl-dot {
  width:13px; height:13px; border-radius:50%; flex-shrink:0; margin-top:3px;
  border:2px solid var(--border); background:var(--surface); position:relative; z-index:1;
}
.tl-dot.first { background:var(--red); border-color:var(--red); }
.tl-content { flex:1; min-width:0; }
.tl-msg { font-size:12px; color:var(--text2); line-height:1.4; }
.tl-meta { font-size:11px; color:var(--text4); margin-top:2px; font-family:'DM Mono',monospace; display:flex; gap:10px; }

/* ── MINI METRIC BARS ─────────────────────────────────────────── */
.metric-grid { display:grid; grid-template-columns:1fr 1fr; gap:10px; padding:14px 18px; }
.metric-block { }
.metric-block-label { font-size:11px; color:var(--text3); margin-bottom:4px; display:flex; justify-content:space-between; }
.metric-block-label span:last-child { font-weight:600; color:var(--text); font-family:'DM Mono',monospace; }
.mbar { height:5px; background:var(--border); border-radius:3px; overflow:hidden; }
.mbar-fill { height:100%; border-radius:3px; transition:width 0.6s ease; background:var(--blue); }
.mbar-fill.warn { background:var(--yellow); }
.mbar-fill.crit { background:var(--red); }

/* ── HEAL ACTIONS ─────────────────────────────────────────────── */
.heal-list { padding:6px 0; max-height:280px; overflow-y:auto; }
.heal-row {
  display:flex; gap:10px; padding:9px 16px; border-bottom:1px solid var(--border);
  align-items:flex-start; animation:fadeIn 0.3s ease;
}
@keyframes fadeIn { from{opacity:0;transform:translateY(-3px)} to{opacity:1;transform:none} }
.heal-row:last-child { border-bottom:none; }
.heal-icon-wrap { width:28px; height:28px; border-radius:7px; background:var(--yellow-light); display:flex; align-items:center; justify-content:center; flex-shrink:0; margin-top:1px; }
.heal-body { flex:1; min-width:0; }
.heal-rule { font-size:12px; font-weight:600; color:var(--text); }
.heal-action-tag { display:inline-flex; align-items:center; gap:4px; font-size:11px; color:var(--text3); margin-top:2px; }
.heal-notes { font-size:11px; color:var(--text3); margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.heal-time { font-size:11px; color:var(--text4); font-family:'DM Mono',monospace; flex-shrink:0; }

/* ── HEAP SNAPSHOTS ───────────────────────────────────────────── */
.snap-list { padding:6px 0; }
.snap-row { display:flex; align-items:center; gap:10px; padding:9px 16px; border-bottom:1px solid var(--border); }
.snap-row:last-child { border-bottom:none; }
.snap-trigger { font-size:11px; font-weight:600; color:var(--text2); flex-shrink:0; }
.snap-info { flex:1; font-size:12px; color:var(--text2); font-family:'DM Mono',monospace; }
.snap-time { font-size:11px; color:var(--text4); font-family:'DM Mono',monospace; flex-shrink:0; }

/* ── SEARCH BAR ───────────────────────────────────────────────── */
.search-expanded {
  background:var(--surface); border-bottom:1px solid var(--border);
  padding:12px 20px; display:none;
}
.search-expanded.open { display:flex; gap:8px; }
.search-inp {
  flex:1; background:var(--surface2); border:1px solid var(--border2); border-radius:8px;
  padding:8px 12px; font-family:'DM Sans',sans-serif; font-size:13px; color:var(--text); outline:none;
  transition:border-color 0.15s;
}
.search-inp:focus { border-color:var(--blue); box-shadow:0 0 0 3px rgba(37,99,235,0.08); }
.search-inp::placeholder { color:var(--text4); }
.btn-search {
  padding:8px 16px; border-radius:8px; background:var(--blue); color:#fff;
  font-family:'DM Sans',sans-serif; font-size:13px; font-weight:500;
  border:none; cursor:pointer; transition:background 0.12s;
}
.btn-search:hover { background:#1d4ed8; }

/* ── PROTECTIONS BANNER ───────────────────────────────────────── */
.protection-banner {
  margin-bottom:16px; border-radius:var(--radius); overflow:hidden;
  border:1px solid var(--border); display:none;
}
.protection-banner.visible { display:block; }
.pb-item {
  display:flex; align-items:center; gap:10px; padding:10px 16px;
  border-bottom:1px solid var(--border); font-size:12px;
}
.pb-item:last-child { border-bottom:none; }
.pb-item.circuit { background:var(--red-light); }
.pb-item.ratelimit { background:var(--yellow-light); }
.pb-label { font-weight:600; flex-shrink:0; }
.pb-path { font-family:'DM Mono',monospace; color:var(--text2); flex:1; }
.pb-expires { color:var(--text3); flex-shrink:0; }

/* ── SCROLLBARS ───────────────────────────────────────────────── */
::-webkit-scrollbar { width:5px; height:5px; }
::-webkit-scrollbar-track { background:transparent; }
::-webkit-scrollbar-thumb { background:var(--border2); border-radius:4px; }
::-webkit-scrollbar-thumb:hover { background:var(--text4); }

/* ── PAGES ────────────────────────────────────────────────────── */
.page { display:none; flex:1; overflow-y:auto; padding:24px; }
.page.active { display:block; }

/* ── EMPTY ────────────────────────────────────────────────────── */
.empty-state { padding:32px; text-align:center; color:var(--text3); }
.empty-state svg { margin:0 auto 10px; display:block; opacity:0.3; }
.empty-state p { font-size:13px; }

/* ── SEARCH RESULTS ───────────────────────────────────────────── */
.sr-group { background:var(--surface); border:1px solid var(--border); border-radius:var(--radius); margin-bottom:12px; overflow:hidden; }
.sr-group-hdr { padding:10px 16px; background:var(--surface2); display:flex; align-items:center; justify-content:space-between; border-bottom:1px solid var(--border); font-size:13px; font-weight:600; color:var(--text); }
.sr-row { padding:8px 16px; border-bottom:1px solid var(--border); font-family:'DM Mono',monospace; font-size:12px; color:var(--text2); }
.sr-row:last-child { border-bottom:none; }

/* ── TABS ─────────────────────────────────────────────────────── */
.tab-bar { display:flex; gap:2px; background:var(--surface2); padding:4px; border-radius:9px; width:fit-content; margin-bottom:16px; }
.tab-btn {
  padding:6px 14px; border-radius:7px; font-size:12px; font-weight:500; cursor:pointer;
  color:var(--text2); transition:all 0.12s; border:none; background:transparent; font-family:'DM Sans',sans-serif;
}
.tab-btn.active { background:var(--surface); color:var(--text); box-shadow:var(--shadow); font-weight:600; }
.tab-pane { display:none; }
.tab-pane.active { display:block; }
</style>
</head>
<body>
<div id="shell">

<!-- ── SIDEBAR ─────────────────────────────────────────── -->
<div id="sidebar">
  <div class="sb-logo">
    <div class="sb-logo-icon">
      <svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round">
        <path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>
      </svg>
    </div>
    <div class="sb-logo-text">
      <span class="sb-logo-name">LogPilot</span>
      <span class="sb-logo-sub">Agentic Ops Layer · Splunk</span>
    </div>
  </div>

  <div class="sb-section">
    <div class="sb-section-label">Overview</div>
    <div class="sb-item active" id="nav-dashboard" onclick="navigate('dashboard')">
      <svg class="sb-icon" viewBox="0 0 20 20" fill="currentColor"><path d="M2 4a2 2 0 012-2h3a2 2 0 012 2v3a2 2 0 01-2 2H4a2 2 0 01-2-2V4zm9 0a2 2 0 012-2h3a2 2 0 012 2v3a2 2 0 01-2 2h-3a2 2 0 01-2-2V4zM2 13a2 2 0 012-2h3a2 2 0 012 2v3a2 2 0 01-2 2H4a2 2 0 01-2-2v-3zm9 0a2 2 0 012-2h3a2 2 0 012 2v3a2 2 0 01-2 2h-3a2 2 0 01-2-2v-3z"/></svg>
      Dashboard
    </div>
  </div>

  <div class="sb-section">
    <div class="sb-section-label">Monitoring</div>
    <div class="sb-item" id="nav-incidents" onclick="navigate('incidents')">
      <svg class="sb-icon" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clip-rule="evenodd"/></svg>
      Incidents
      <span class="sb-badge hidden" id="sb-inc-badge">0</span>
    </div>
    <div class="sb-item" id="nav-live" onclick="navigate('live')">
      <svg class="sb-icon" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M3 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z" clip-rule="evenodd"/></svg>
      Live Logs
    </div>
    <div class="sb-item" id="nav-heals" onclick="navigate('heals')">
      <svg class="sb-icon" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M11.3 1.046A1 1 0 0112 2v5h4a1 1 0 01.82 1.573l-7 10A1 1 0 018 18v-5H4a1 1 0 01-.82-1.573l7-10a1 1 0 011.12-.38z" clip-rule="evenodd"/></svg>
      Heal Actions
      <span class="sb-badge yellow hidden" id="sb-heal-badge">0</span>
    </div>
  </div>

  <div class="sb-section">
    <div class="sb-section-label">Analysis</div>
    <div class="sb-item" id="nav-search" onclick="navigate('search')">
      <svg class="sb-icon" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z" clip-rule="evenodd"/></svg>
      Search Logs
    </div>
    <div class="sb-item" id="nav-memory" onclick="navigate('memory')">
      <svg class="sb-icon" viewBox="0 0 20 20" fill="currentColor"><path d="M3 4a1 1 0 00-1 1v10a1 1 0 001 1h14a1 1 0 001-1V5a1 1 0 00-1-1H3zm5 6a1 1 0 100 2 1 1 0 000-2zm4 0a1 1 0 100 2 1 1 0 000-2z"/></svg>
      Heap Snapshots
    </div>
    <div class="sb-item" id="nav-splunk" onclick="navigate('splunk')">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
      Splunk Health
    </div>
    <div class="sb-item" id="nav-analysis" onclick="navigate('analysis')">
      <svg class="sb-icon" viewBox="0 0 20 20" fill="currentColor"><path d="M2 11a1 1 0 011-1h2a1 1 0 011 1v5a1 1 0 01-1 1H3a1 1 0 01-1-1v-5zm6-7a1 1 0 011-1h2a1 1 0 011 1v12a1 1 0 01-1 1H9a1 1 0 01-1-1V4zm6 4a1 1 0 011-1h2a1 1 0 011 1v8a1 1 0 01-1 1h-2a1 1 0 01-1-1V8z"/></svg>
      RCA Reports
    </div>
    <div class="sb-item" id="nav-predictions" onclick="navigate('predictions')">
      <svg class="sb-icon" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M3 3a1 1 0 000 2v8a2 2 0 002 2h2.586l-1.293 1.293a1 1 0 101.414 1.414L10 15.414l2.293 2.293a1 1 0 001.414-1.414L12.414 15H15a2 2 0 002-2V5a1 1 0 100-2H3zm11.707 4.707a1 1 0 00-1.414-1.414L10 9.586 8.707 8.293a1 1 0 00-1.414 0l-2 2a1 1 0 101.414 1.414L8 10.414l1.293 1.293a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/></svg>
      Analytics &amp; Forecasts
    </div>
    <div class="sb-item" id="nav-open-splunk" onclick="window.open('http://localhost:8000/en-US/app/search/dashboards','_blank')" title="Open Splunk Analytics">
      <svg class="sb-icon" viewBox="0 0 20 20" fill="currentColor"><path d="M11 3a1 1 0 100 2h2.586l-6.293 6.293a1 1 0 101.414 1.414L15 6.414V9a1 1 0 102 0V4a1 1 0 00-1-1h-5z"/><path d="M5 5a2 2 0 00-2 2v8a2 2 0 002 2h8a2 2 0 002-2v-3a1 1 0 10-2 0v3H5V7h3a1 1 0 000-2H5z"/></svg>
      Open Splunk Analytics
    </div>
  </div>

  <div class="sb-footer">
    <div class="sb-status disconnected" id="ws-status">
      <div class="sb-status-dot"></div>
      <span id="ws-label">Connecting…</span>
    </div>
  </div>
</div>

<!-- ── MAIN ─────────────────────────────────────────────── -->
<div id="main">

  <!-- Topbar -->
  <div id="topbar">
    <div class="tb-search" onclick="document.getElementById('global-search').focus()">
      <svg class="tb-search-icon" width="14" height="14" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z" clip-rule="evenodd"/></svg>
      <input id="global-search" placeholder="Search anything…" onkeydown="if(event.key==='Enter')openSearch()" />
      <span class="tb-shortcut">⌘K</span>
    </div>
    <div class="tb-spacer"></div>
    <div class="tb-actions">
      <div class="tb-date" onclick="navigate('search')">
        <svg width="12" height="12" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M6 2a1 1 0 00-1 1v1H4a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V6a2 2 0 00-2-2h-1V3a1 1 0 10-2 0v1H7V3a1 1 0 00-1-1zm0 5a1 1 0 000 2h8a1 1 0 100-2H6z" clip-rule="evenodd"/></svg>
        <span id="tb-date-range">Last 24h</span>
      </div>
      <div class="tb-btn" title="Refresh" onclick="refreshAll()">
        <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M4 2a1 1 0 011 1v2.101a7.002 7.002 0 0111.601 2.566 1 1 0 11-1.885.666A5.002 5.002 0 005.999 7H9a1 1 0 010 2H4a1 1 0 01-1-1V3a1 1 0 011-1zm.008 9.057a1 1 0 011.276.61A5.002 5.002 0 0014.001 13H11a1 1 0 110-2h5a1 1 0 011 1v5a1 1 0 11-2 0v-2.101a7.002 7.002 0 01-11.601-2.566 1 1 0 01.61-1.276z" clip-rule="evenodd"/></svg>
      </div>
      <div class="tb-avatar">A</div>
    </div>
  </div>

  <!-- ── PAGES ────────────────────────────────────────── -->

  <!-- DASHBOARD PAGE -->
  <div class="page active" id="page-dashboard">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px">
      <h1 class="page-title" style="margin-bottom:0">Dashboard</h1>
    </div>

    <!-- KPIs -->
    <div class="kpi-row">
      <div class="kpi-card">
        <div class="kpi-label">Total Requests
          <div class="kpi-label-icon blue">
            <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor"><path d="M2 11a1 1 0 011-1h2a1 1 0 011 1v5a1 1 0 01-1 1H3a1 1 0 01-1-1v-5zM8 7a1 1 0 011-1h2a1 1 0 011 1v9a1 1 0 01-1 1H9a1 1 0 01-1-1V7zM14 4a1 1 0 011-1h2a1 1 0 011 1v12a1 1 0 01-1 1h-2a1 1 0 01-1-1V4z"/></svg>
          </div>
        </div>
        <div class="kpi-value" id="kpi-total">—</div>
        <div class="kpi-sub" id="kpi-total-sub">Loading…</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Incident Groups
          <div class="kpi-label-icon red">
            <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clip-rule="evenodd"/></svg>
          </div>
        </div>
        <div class="kpi-value" id="kpi-incidents">—</div>
        <div class="kpi-sub" id="kpi-inc-sub">Last 24h</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Avg Response Time
          <div class="kpi-label-icon yellow">
            <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" clip-rule="evenodd"/></svg>
          </div>
        </div>
        <div class="kpi-value" id="kpi-rt">—</div>
        <div class="kpi-sub" id="kpi-rt-sub">p50 latency</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Heal Actions
          <div class="kpi-label-icon green">
            <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M11.3 1.046A1 1 0 0112 2v5h4a1 1 0 01.82 1.573l-7 10A1 1 0 018 18v-5H4a1 1 0 01-.82-1.573l7-10a1 1 0 011.12-.38z" clip-rule="evenodd"/></svg>
          </div>
        </div>
        <div class="kpi-value" id="kpi-heals">—</div>
        <div class="kpi-sub" id="kpi-heals-sub">Auto-remediations</div>
      </div>
    </div>

    <!-- Active protections banner -->
    <div class="protection-banner" id="protection-banner"></div>

    <!-- Charts + events -->
    <div class="grid2">
      <!-- Trend chart -->
      <div class="card">
        <div class="card-header">
          <div class="card-title">
            Request & Error Trends
          </div>
          <div style="display:flex;gap:16px">
            <div class="legend-item"><div class="legend-dot" style="background:#2563eb"></div><span style="font-size:12px;color:var(--text2)">Requests</span></div>
            <div class="legend-item"><div class="legend-dot" style="background:#dc2626"></div><span style="font-size:12px;color:var(--text2)">Errors</span></div>
          </div>
        </div>
        <div class="chart-wrap" style="padding-bottom:4px">
          <canvas id="trend-canvas" height="160"></canvas>
        </div>
      </div>

      <!-- System events -->
      <div class="card">
        <div class="card-header">
          <div class="card-title">
            System Events
            <span class="card-title-badge red" id="critical-badge" style="display:none">0 Critical</span>
          </div>
          <div class="card-action" onclick="navigate('incidents')">
            View all <svg width="12" height="12" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clip-rule="evenodd"/></svg>
          </div>
        </div>
        <div class="event-list" id="event-list">
          <div class="event-empty">No incidents yet</div>
        </div>
      </div>
    </div>

    <div class="mini-chart-grid">
      <div class="card mini-chart">
        <div class="card-title">Status Mix</div>
        <canvas id="status-chart" class="chart-canvas" height="120"></canvas>
      </div>
      <div class="card mini-chart">
        <div class="card-title">Root Causes</div>
        <canvas id="root-chart" class="chart-canvas" height="120"></canvas>
      </div>
      <div class="card mini-chart">
        <div class="card-title">Recovery Signals</div>
        <canvas id="metrics-chart" class="chart-canvas" height="120"></canvas>
      </div>
    </div>

    <!-- Metrics row -->
    <div class="card" style="margin-bottom:16px">
      <div class="card-header">
        <div class="card-title">System Metrics</div>
        <span id="uptime-badge" class="badge badge-green" style="font-size:11px">—</span>
      </div>
      <div class="metric-grid">
        <div class="metric-block">
          <div class="metric-block-label"><span>Memory</span><span id="mv-mem">—</span></div>
          <div class="mbar"><div class="mbar-fill" id="mb-mem" style="width:0%"></div></div>
        </div>
        <div class="metric-block">
          <div class="metric-block-label"><span>CPU</span><span id="mv-cpu">—</span></div>
          <div class="mbar"><div class="mbar-fill" id="mb-cpu" style="width:0%"></div></div>
        </div>
        <div class="metric-block">
          <div class="metric-block-label"><span>Heap Used</span><span id="mv-heap">—</span></div>
          <div class="mbar"><div class="mbar-fill" id="mb-heap" style="width:0%"></div></div>
        </div>
        <div class="metric-block">
          <div class="metric-block-label"><span>Event Loop Lag</span><span id="mv-lag">—</span></div>
          <div class="mbar"><div class="mbar-fill" id="mb-lag" style="width:0%"></div></div>
        </div>
      </div>
    </div>
  </div>

  <!-- INCIDENTS PAGE -->
  <div class="page" id="page-incidents">
    <h1 class="page-title">Incidents</h1>
    <div class="card">
      <div class="card-header">
        <div class="card-title">Incident Groups <span class="card-title-badge blue" id="inc-count-badge">—</span></div>
        <div class="card-action" onclick="fetchIncidents()">
          <svg width="13" height="13" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M4 2a1 1 0 011 1v2.101a7.002 7.002 0 0111.601 2.566 1 1 0 11-1.885.666A5.002 5.002 0 005.999 7H9a1 1 0 010 2H4a1 1 0 01-1-1V3a1 1 0 011-1zm.008 9.057a1 1 0 011.276.61A5.002 5.002 0 0014.001 13H11a1 1 0 110-2h5a1 1 0 011 1v5a1 1 0 11-2 0v-2.101a7.002 7.002 0 01-11.601-2.566 1 1 0 01.61-1.276z" clip-rule="evenodd"/></svg>
          Refresh
        </div>
      </div>
      <div id="inc-table-wrap">
        <div class="empty-state"><p>No incidents in the last 24h</p></div>
      </div>
    </div>
  </div>

  <!-- LIVE LOGS PAGE -->
  <div class="page" id="page-live">
    <h1 class="page-title">Live Logs</h1>
    <div class="card" style="overflow:hidden">
      <div class="card-header">
        <div class="card-title">Request Stream</div>
        <div style="display:flex;gap:8px">
          <select id="log-filter-level" onchange="filterLogs()" style="font-family:'DM Sans',sans-serif;font-size:12px;border:1px solid var(--border);border-radius:6px;padding:4px 8px;background:var(--surface2);color:var(--text2);outline:none">
            <option value="">All levels</option>
            <option value="error">Errors only</option>
            <option value="warn">Warnings</option>
            <option value="info">Info</option>
          </select>
        </div>
      </div>
      <div id="log-stream" style="max-height:calc(100vh - 240px);overflow-y:auto">
        <div class="empty-state"><p>Waiting for requests…</p></div>
      </div>
    </div>
  </div>

  <!-- HEALS PAGE -->
  <div class="page" id="page-heals">
    <h1 class="page-title">Heal Actions</h1>
    <div class="grid2">
      <div class="card">
        <div class="card-header">
          <div class="card-title">Remediation History</div>
        </div>
        <div class="heal-list" id="heal-list-full" style="max-height:calc(100vh - 240px)">
          <div class="empty-state"><p>No heal actions yet</p></div>
        </div>
      </div>
      <div>
        <div class="card" style="margin-bottom:14px">
          <div class="card-header">
            <div class="card-title">Active Protections</div>
          </div>
          <div id="prot-list-full" style="padding:6px 0">
            <div class="empty-state" style="padding:14px"><p>None active</p></div>
          </div>
        </div>
        <div class="card">
          <div class="card-header">
            <div class="card-title">Heal Rule Config</div>
          </div>
          <div style="padding:14px 16px">
            <div style="font-size:12px;color:var(--text3);line-height:1.7" id="rule-summary">
              <div style="margin-bottom:6px;font-size:11px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:var(--text4)">Configured Rules</div>
              <div id="rule-list">—</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- SEARCH PAGE -->
  <div class="page" id="page-search">
    <h1 class="page-title">Search Logs</h1>
    <div class="card" style="margin-bottom:16px">
      <div style="padding:16px 18px;display:flex;gap:10px">
        <input class="search-inp" id="search-main-inp" placeholder='Try: "payment errors last hour" · "timeout" · "auth 500"' style="flex:1" onkeydown="if(event.key==='Enter')runSearch()"/>
        <button class="btn-search" onclick="runSearch()">Search</button>
      </div>
    </div>
    <div id="search-results">
      <div class="empty-state" style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius)"><p>Enter a query to search logs</p></div>
    </div>
  </div>

  <!-- MEMORY PAGE -->
  <div class="page" id="page-memory">
    <h1 class="page-title">Heap Snapshots</h1>
    <div class="card">
      <div class="card-header">
        <div class="card-title">Memory Snapshots</div>
        <button class="btn-primary" id="snap-btn" onclick="captureSnap()">
          <svg width="13" height="13" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M4 5a2 2 0 00-2 2v8a2 2 0 002 2h12a2 2 0 002-2V7a2 2 0 00-2-2h-1.586a1 1 0 01-.707-.293l-1.121-1.121A2 2 0 0011.172 3H8.828a2 2 0 00-1.414.586L6.293 4.707A1 1 0 015.586 5H4zm6 9a3 3 0 100-6 3 3 0 000 6z" clip-rule="evenodd"/></svg>
          Capture Snapshot
        </button>
      </div>
      <div id="snap-list">
        <div class="empty-state"><p>No snapshots yet</p></div>
      </div>
    </div>
  </div>

  <!-- ANALYSIS PAGE -->
  <div class="page" id="page-splunk">
  <div class="page-header"><h1 class="page-title">Splunk Integration Health</h1></div>
  <div class="card">
    <div class="card-header">
      <div class="card-title">HEC Status</div>
      <div class="card-action" onclick="fetchSplunkHealth()">Refresh</div>
    </div>
    <div id="splunk-health-content"><div class="empty-state"><p>Loading Splunk health…</p></div></div>
  </div>
</div>

<div class="page" id="page-analysis">
    <h1 class="page-title">RCA Reports</h1>
    <div class="mini-chart-grid">
      <div class="card mini-chart">
        <div class="card-title">Incident Root Causes</div>
        <canvas id="analysis-root-chart" class="chart-canvas" height="120"></canvas>
      </div>
      <div class="card mini-chart">
        <div class="card-title">Heal Actions</div>
        <canvas id="heal-chart" class="chart-canvas" height="120"></canvas>
      </div>
      <div class="card mini-chart">
        <div class="card-title">Status Classes</div>
        <canvas id="analysis-status-chart" class="chart-canvas" height="120"></canvas>
      </div>
    </div>
    <div class="card">
      <div class="card-header">
        <div class="card-title">Latest AI Analysis</div>
        <div class="card-action" onclick="fetchIncidents();fetchAnalytics()">Refresh</div>
      </div>
      <div id="analysis-list">
        <div class="empty-state"><p>Open an incident to generate RCA details</p></div>
      </div>
    </div>
    <div class="card">
      <div class="card-header">
        <div class="card-title">Advanced Analytics</div>
        <div class="card-action" onclick="fetchAdvancedAnalytics()">Refresh</div>
      </div>
      <div id="advanced-analytics">
        <div class="empty-state"><p>Loading analytics…</p></div>
      </div>
    </div>
  </div>

  <!-- MLTK PREDICTIONS PAGE -->
  <div class="page" id="page-predictions">
    <h1 class="page-title">Analytics &amp; Forecasts</h1>

    <!-- Part 6: Splunk connection banner — dynamic, filled by JS -->
    <div id="splunk-analytics-banner" style="margin-bottom:16px"></div>

    <!-- Part 5: Open Splunk button -->
    <div style="display:flex;justify-content:flex-end;margin-bottom:16px">
      <button class="btn-primary" onclick="window.open('http://localhost:8000/en-US/app/search/dashboards','_blank')" style="display:flex;align-items:center;gap:6px">
        <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor"><path d="M11 3a1 1 0 100 2h2.586l-6.293 6.293a1 1 0 101.414 1.414L15 6.414V9a1 1 0 102 0V4a1 1 0 00-1-1h-5z"/><path d="M5 5a2 2 0 00-2 2v8a2 2 0 002 2h8a2 2 0 002-2v-3a1 1 0 10-2 0v3H5V7h3a1 1 0 000-2H5z"/></svg>
        Open Splunk Analytics
      </button>
    </div>

    <!-- Observability queries (Part 3) -->
    <div style="margin-bottom:8px">
      <div class="section-label" style="margin-bottom:10px">Observability — Live SPL</div>
      <div id="observability-list" class="grid2" style="gap:12px">
        <div class="empty-state"><p style="font-size:12px">Loading…</p></div>
      </div>
    </div>

    <!-- Forecast queries (Part 4) -->
    <div style="margin-top:20px">
      <div class="section-label" style="margin-bottom:10px">Predictive Analytics — Splunk predict (no MLTK required)</div>
      <div id="forecast-list" class="grid2" style="gap:12px">
        <div class="empty-state"><p style="font-size:12px">Loading…</p></div>
      </div>
    </div>
  </div>
</div>

</div>

<!-- ── INCIDENT DETAIL MODAL ──────────────────────────── -->
<div id="detail-overlay" onclick="if(event.target===this)closeModal()">
  <div id="detail-modal">
    <div class="modal-header">
      <div style="flex:1;min-width:0">
        <div class="modal-badge critical" id="modal-badge">
          <div class="dot"></div>
          <span id="modal-severity">CRITICAL EVENT</span>
        </div>
        <div class="modal-title" id="modal-title">—</div>
      </div>
      <div class="modal-close" onclick="closeModal()">
        <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd"/></svg>
      </div>
    </div>
    <div class="modal-body" id="modal-body">Loading…</div>
    <div class="modal-footer">
      <div class="modal-ts" id="modal-ts">—</div>
      <div class="modal-actions">
        <button class="btn-outline" onclick="closeModal()">Dismiss</button>
        <button class="btn-outline" onclick="runAIInvestigation()" id="btn-investigate" style="display:none">
          🤖 AI Investigate
        </button>
        <button class="btn-primary" onclick="viewFullReport()">
          View Full Report
          <svg width="13" height="13" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clip-rule="evenodd"/></svg>
        </button>
      </div>
    </div>
  </div>
</div>

<script>
// ── STATE ────────────────────────────────────────────────
let stats = {};
let incidents = [];
let heals = [];
let logEntries = [];
let snapshots = [];
let analytics = {};
let analyses = {};
let activeModal = null;
let logFilter = '';
const MAX_LOGS = 500;
const TREND_POINTS = 24;
let trendReqs = new Array(TREND_POINTS).fill(0);
let trendErrs = new Array(TREND_POINTS).fill(0);
let trendLabels = [];
let trendCanvas, trendCtx;

// ── WEBSOCKET ────────────────────────────────────────────
const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
const ws = new WebSocket(wsProto + '://' + location.hostname + ':${port}');
ws.onopen = () => setWs(true);
ws.onclose = () => { setWs(false); setTimeout(() => location.reload(), 4000); };
ws.onmessage = e => {
  const msg = JSON.parse(e.data);
  if (msg.type === 'init') {
    applyStats(msg.data.stats);
    incidents = msg.data.incidents || [];
    renderAll();
    renderHeals(msg.data.heals || []);
  }
  if (msg.type === 'log') onLog(msg.data);
  if (msg.type === 'heal') onHeal(msg.data);
  if (msg.type === 'stats') applyStats(msg.data);
};
function setWs(on) {
  const el = document.getElementById('ws-status');
  const lb = document.getElementById('ws-label');
  el.className = 'sb-status' + (on ? '' : ' disconnected');
  lb.textContent = on ? 'Connected' : 'Disconnected';
}

// ── POLLING ───────────────────────────────────────────────
setInterval(fetchStats, 8000);
setInterval(fetchIncidents, 10000);
setInterval(fetchProtections, 12000);
setInterval(fetchAnalytics, 15000);
fetchStats(); fetchIncidents(); fetchHeals(); fetchProtections(); fetchSnaps(); fetchAnalytics();

function refreshAll() { fetchStats(); fetchIncidents(); fetchHeals(); fetchProtections(); fetchSnaps(); fetchAnalytics(); }

function fetchStats() {
  fetch('/api/stats').then(r=>r.json()).then(applyStats).catch(()=>{});
}
function fetchIncidents() {
  fetch('/api/incidents').then(r=>r.json()).then(d => {
    incidents = d.groups || [];
    renderIncidentList();
    renderEventList();
    const badge = document.getElementById('sb-inc-badge');
    const critical = incidents.filter(i => i.severity === 'critical').length;
    if (incidents.length) { badge.textContent = incidents.length; badge.classList.remove('hidden'); }
    else badge.classList.add('hidden');
    const cb = document.getElementById('critical-badge');
    if (critical) { cb.textContent = critical + ' Critical'; cb.style.display = ''; }
    else cb.style.display = 'none';
    const countBadge = document.getElementById('inc-count-badge');
    if (countBadge) countBadge.textContent = incidents.length;
  }).catch(()=>{});
}
function fetchHeals() {
  fetch('/api/heals').then(r=>r.json()).then(d => {
    heals = d.actions || [];
    renderHeals(heals);
    const badge = document.getElementById('sb-heal-badge');
    if (heals.length) { badge.textContent = heals.length; badge.classList.remove('hidden'); }
    else badge.classList.add('hidden');
  }).catch(()=>{});
}
function fetchProtections() {
  fetch('/api/protections').then(r=>r.json()).then(d => {
    renderProtections(d, 'protection-banner');
    renderProtections(d, 'prot-list-full');
  }).catch(()=>{});
}
function fetchSnaps() {
  fetch('/api/heap-snapshots').then(r=>r.json()).then(d => {
    snapshots = d.snapshots || [];
    renderSnaps();
  }).catch(()=>{});
}
function fetchAnalytics() {
  fetch('/api/analytics').then(r=>r.json()).then(d => {
    analytics = d || {};
    renderAnalyticsCharts();
    renderAnalysisList();
  }).catch(()=>{});
}

function applyStats(s) {
  stats = { ...stats, ...s };
  setText('kpi-total', num(s.totalLogs || 0));
  setText('kpi-incidents', num(s.incidentGroups || 0));
  setText('kpi-rt', (s.avgResponseMs || 0) + 'ms');
  setText('kpi-heals', num(s.healCount || 0));
  if (s.incidentGroups > 0) {
    setText('kpi-inc-sub', 'Groups active');
  }
  setText('uptime-badge', 'Uptime ' + fmtUptime(s.uptime || 0));
  if (s.currentMetrics) updateMetrics(s.currentMetrics);
  updateTrend(s.totalLogs || 0, s.errorLogs || 0);
}
function updateMetrics(m) {
  setBar('mb-mem','mv-mem', m.memoryPercent, m.memoryPercent + '%');
  setBar('mb-cpu','mv-cpu', m.cpu || 0, (m.cpu||0) + '%');
  const hp = m.heapTotalMb > 0 ? Math.round(m.heapUsedMb / m.heapTotalMb * 100) : 0;
  setBar('mb-heap','mv-heap', hp, m.heapUsedMb + 'MB');
  const lagPct = Math.min(100, (m.eventLoopLag || 0) / 2);
  setBar('mb-lag','mv-lag', lagPct, (m.eventLoopLag||0) + 'ms');
}
function setBar(barId, valId, pct, label) {
  const bar = document.getElementById(barId), val = document.getElementById(valId);
  if (!bar || !val) return;
  bar.style.width = Math.min(100, pct) + '%';
  bar.className = 'mbar-fill' + (pct > 85 ? ' crit' : pct > 65 ? ' warn' : '');
  val.textContent = label;
}

// ── TREND CHART ────────────────────────────────────────────
let lastTotal = 0, lastErrors = 0;
function updateTrend(total, errors) {
  const reqDelta = Math.max(0, total - lastTotal);
  const errDelta = Math.max(0, errors - lastErrors);
  lastTotal = total; lastErrors = errors;
  if (reqDelta > 0 || trendReqs.every(v => v === 0)) {
    trendReqs.push(reqDelta); trendReqs.shift();
    trendErrs.push(errDelta); trendErrs.shift();
  }
  drawChart();
}
function initChart() {
  trendCanvas = document.getElementById('trend-canvas');
  if (!trendCanvas) return;
  trendCtx = trendCanvas.getContext('2d');
  // Build time labels
  for (let i = TREND_POINTS - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 5 * 60 * 1000);
    trendLabels.push(d.getHours() + ':' + String(d.getMinutes()).padStart(2,'0'));
  }
  drawChart();
}
function drawChart() {
  if (!trendCtx) return;
  const dpr = window.devicePixelRatio || 1;
  const w = trendCanvas.clientWidth;
  const h = trendCanvas.clientHeight;
  if (w === 0 || h === 0) return;
  trendCanvas.width = w * dpr;
  trendCanvas.height = h * dpr;
  trendCtx.scale(dpr, dpr);
  const ctx = trendCtx;
  ctx.clearRect(0, 0, w, h);

  const pad = { top: 10, right: 10, bottom: 28, left: 36 };
  const cw = w - pad.left - pad.right;
  const ch = h - pad.top - pad.bottom;
  const n = trendReqs.length;
  const maxR = Math.max(...trendReqs, 1);

  const xStep = cw / (n - 1);
  const xAt = i => pad.left + i * xStep;
  const yAt = (v, mx) => pad.top + ch - (v / mx) * ch;

  // Grid lines
  ctx.strokeStyle = '#e8eaed';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad.top + (ch / 4) * i;
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(pad.left + cw, y); ctx.stroke();
    const label = Math.round(maxR * (1 - i / 4));
    ctx.fillStyle = '#8a94a6';
    ctx.font = '10px DM Mono, monospace';
    ctx.textAlign = 'right';
    ctx.fillText(label, pad.left - 5, y + 3.5);
  }

  // X labels (every 4th)
  ctx.textAlign = 'center';
  ctx.fillStyle = '#b0bac9';
  ctx.font = '10px DM Sans, sans-serif';
  for (let i = 0; i < n; i++) {
    if (i % 4 === 0) ctx.fillText(trendLabels[i] || '', xAt(i), h - 6);
  }

  // Requests area
  const grad = ctx.createLinearGradient(0, pad.top, 0, pad.top + ch);
  grad.addColorStop(0, 'rgba(37,99,235,0.15)');
  grad.addColorStop(1, 'rgba(37,99,235,0)');
  ctx.beginPath();
  ctx.moveTo(xAt(0), yAt(trendReqs[0], maxR));
  for (let i = 1; i < n; i++) {
    const cpx = xAt(i - 0.5), cpy1 = yAt(trendReqs[i-1], maxR), cpy2 = yAt(trendReqs[i], maxR);
    ctx.bezierCurveTo(cpx, cpy1, cpx, cpy2, xAt(i), cpy2);
  }
  ctx.lineTo(xAt(n-1), pad.top + ch);
  ctx.lineTo(xAt(0), pad.top + ch);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // Requests line
  ctx.beginPath();
  ctx.moveTo(xAt(0), yAt(trendReqs[0], maxR));
  for (let i = 1; i < n; i++) {
    const cpx = xAt(i - 0.5);
    ctx.bezierCurveTo(cpx, yAt(trendReqs[i-1], maxR), cpx, yAt(trendReqs[i], maxR), xAt(i), yAt(trendReqs[i], maxR));
  }
  ctx.strokeStyle = '#2563eb';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Errors line (if any)
  const maxE = Math.max(...trendErrs, 1);
  if (trendErrs.some(v => v > 0)) {
    ctx.beginPath();
    ctx.moveTo(xAt(0), yAt(trendErrs[0], maxR));
    for (let i = 1; i < n; i++) {
      const cpx = xAt(i - 0.5);
      ctx.bezierCurveTo(cpx, yAt(trendErrs[i-1], maxR), cpx, yAt(trendErrs[i], maxR), xAt(i), yAt(trendErrs[i], maxR));
    }
    ctx.strokeStyle = '#dc2626';
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

function renderAnalyticsCharts() {
  drawBars('status-chart', analytics.statusClasses || [], ['#16a34a','#d97706','#dc2626','#8a94a6']);
  drawBars('analysis-status-chart', analytics.statusClasses || [], ['#16a34a','#d97706','#dc2626','#8a94a6']);
  drawBars('root-chart', analytics.rootCauses || [], ['#2563eb','#7c3aed','#ea580c','#dc2626','#16a34a']);
  drawBars('analysis-root-chart', analytics.rootCauses || [], ['#2563eb','#7c3aed','#ea580c','#dc2626','#16a34a']);
  drawBars('heal-chart', analytics.healActions || [], ['#7c3aed','#16a34a','#d97706','#2563eb','#dc2626']);
  drawMetricLines('metrics-chart', analytics.metricSeries || []);
}

function drawBars(id, rows, colors) {
  const canvas = document.getElementById(id);
  if (!canvas) return;
  const ctx = prepCanvas(canvas);
  const w = canvas.clientWidth, h = canvas.clientHeight;
  ctx.clearRect(0, 0, w, h);
  const data = rows.length ? rows : [{ label: 'No data', value: 0 }];
  const max = Math.max(...data.map(r => Number(r.value || 0)), 1);
  const pad = { top: 10, right: 8, bottom: 28, left: 26 };
  const bw = (w - pad.left - pad.right) / data.length - 8;
  data.forEach((row, i) => {
    const value = Number(row.value || 0);
    const bh = Math.max(2, ((h - pad.top - pad.bottom) * value) / max);
    const x = pad.left + i * (bw + 8);
    const y = h - pad.bottom - bh;
    ctx.fillStyle = colors[i % colors.length];
    ctx.fillRect(x, y, Math.max(8, bw), bh);
    ctx.fillStyle = '#4a5568';
    ctx.font = '10px DM Mono, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(String(value), x + bw / 2, y - 4);
    ctx.fillStyle = '#8a94a6';
    ctx.font = '10px DM Sans, sans-serif';
    ctx.fillText(String(row.label || '').slice(0, 10), x + bw / 2, h - 8);
  });
}

function drawMetricLines(id, rows) {
  const canvas = document.getElementById(id);
  if (!canvas) return;
  const ctx = prepCanvas(canvas);
  const w = canvas.clientWidth, h = canvas.clientHeight;
  ctx.clearRect(0, 0, w, h);
  if (!rows.length) {
    ctx.fillStyle = '#8a94a6';
    ctx.font = '12px DM Sans, sans-serif';
    ctx.fillText('No metrics yet', 12, 24);
    return;
  }
  const pad = { top: 12, right: 10, bottom: 22, left: 28 };
  const n = rows.length;
  const xAt = i => pad.left + ((w - pad.left - pad.right) * i / Math.max(1, n - 1));
  const yAt = v => pad.top + (h - pad.top - pad.bottom) - (Math.min(100, v) / 100) * (h - pad.top - pad.bottom);
  drawMetricPath(ctx, rows.map(r => Number(r.memory_percent || 0)), xAt, yAt, '#16a34a');
  drawMetricPath(ctx, rows.map(r => Number(r.cpu_percent || 0)), xAt, yAt, '#2563eb');
  ctx.fillStyle = '#8a94a6';
  ctx.font = '10px DM Sans, sans-serif';
  ctx.fillText('Memory', pad.left, h - 6);
  ctx.fillStyle = '#2563eb';
  ctx.fillText('CPU', pad.left + 58, h - 6);
}

function drawMetricPath(ctx, values, xAt, yAt, color) {
  ctx.beginPath();
  values.forEach((v, i) => {
    if (i === 0) ctx.moveTo(xAt(i), yAt(v));
    else ctx.lineTo(xAt(i), yAt(v));
  });
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.stroke();
}

function prepCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 240;
  const h = canvas.clientHeight || 120;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

// ── EVENT LIST (dashboard sidebar) ─────────────────────────
function renderEventList() {
  const el = document.getElementById('event-list');
  if (!incidents.length) {
    el.innerHTML = '<div class="event-empty">No incidents yet</div>';
    return;
  }
  el.innerHTML = incidents.slice(0, 6).map(g => {
    const dot = g.severity === 'critical' ? 'critical' : g.severity === 'warning' ? 'warning' : 'info';
    const action = g.last_action ? \` · \${g.last_action}\` : '';
    return \`<div class="event-item" onclick="openIncidentModal('\${g.id}')">
      <div class="event-dot \${dot}"></div>
      <div class="event-body">
        <div class="event-title">\${esc(g.title || 'Incident')}</div>
        <div class="event-sub">\${esc(g.root_cause || '')} · \${g.count} events\${esc(action)}</div>
      </div>
      <svg class="event-arrow" width="14" height="14" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clip-rule="evenodd"/></svg>
    </div>\`;
  }).join('');
}

// ── INCIDENT TABLE ─────────────────────────────────────────
function renderIncidentList() {
  const wrap = document.getElementById('inc-table-wrap');
  if (!incidents.length) {
    wrap.innerHTML = '<div class="empty-state"><p>No incidents in the last 24h</p></div>';
    return;
  }
  wrap.innerHTML = \`<div style="overflow-x:auto"><table class="inc-table">
    <thead><tr>
      <th>Incident</th><th>Root Cause</th><th>Endpoint</th><th>Events</th><th>Last Seen</th><th>Action</th>
    </tr></thead>
    <tbody>
      \${incidents.map(g => \`
        <tr onclick="openIncidentModal('\${g.id}')">
          <td>
            <div style="font-weight:500;color:var(--text)">\${esc(g.title||'Incident').slice(0,48)}</div>
            <div style="font-size:11px;color:var(--text3);margin-top:2px">\${esc(g.sample_message||'').slice(0,60)}</div>
          </td>
          <td>\${g.root_cause ? \`<span class="badge \${g.severity==='critical'?'badge-red':'badge-yellow'}">\${esc(g.root_cause)}</span>\` : '—'}</td>
          <td>
            \${g.method ? \`<span class="method-tag method-\${g.method}">\${g.method}</span> \` : ''}
            <span class="mono" style="color:var(--text3)">\${esc(g.path||'—').slice(0,32)}</span>
          </td>
          <td><span style="font-family:'DM Mono',monospace;font-size:12px">\${g.count||0}</span></td>
          <td><span style="font-size:12px;color:var(--text3)">\${fmtAgo(g.last_seen)}</span></td>
          <td>\${g.last_action ? \`<span class="badge badge-purple">\${esc(g.last_action)}</span>\` : '<span style="color:var(--text4)">—</span>'}</td>
        </tr>\`).join('')}
    </tbody>
  </table></div>\`;
}

function renderAll() {
  renderIncidentList();
  renderEventList();
}

// ── INCIDENT MODAL ─────────────────────────────────────────
function openIncidentModal(id) {
  const group = incidents.find(g => String(g.id) === String(id));
  if (!group) return;
  activeModal = id;
  const severity = group.severity || 'warning';
  const modalBadge = document.getElementById('modal-badge');
  modalBadge.className = 'modal-badge ' + severity;
  setText('modal-severity', (severity + ' event').toUpperCase());
  setText('modal-title', group.title || 'Incident');
  setText('modal-ts', 'Timestamp: ' + fmtDate(group.last_seen));
  document.getElementById('modal-body').innerHTML = '<div style="text-align:center;padding:20px;color:var(--text3)">Loading timeline…</div>';
  document.getElementById('detail-overlay').classList.add('open');
  document.body.style.overflow = 'hidden';

  const investigateBtn = document.getElementById('btn-investigate');
  if (investigateBtn) investigateBtn.style.display = '';

  fetch('/api/incidents/' + id + '/timeline').then(r => r.json()).then(data => {
    renderModalBody(data.group || {}, data.events || [], data.related || []);
  }).catch(() => {
    document.getElementById('modal-body').innerHTML = '<div style="padding:20px;color:var(--red)">Failed to load timeline</div>';
  });
}
function viewFullReport() {
  if (activeModal) { closeModal(); navigate('incidents'); }
}
function closeModal() {
  document.getElementById('detail-overlay').classList.remove('open');
  document.body.style.overflow = '';
  if (typeof stopEvidenceLiveRefresh === 'function') stopEvidenceLiveRefresh();
  const investigateBtn = document.getElementById('btn-investigate');
  if (investigateBtn) { investigateBtn.style.display = 'none'; investigateBtn.textContent = '\u{1F916} AI Investigate'; investigateBtn.disabled = false; }
  activeModal = null;
}

function renderModalBody(group, events, related) {
  const rcDesc = getRCDesc(group.root_cause);
  const body = document.getElementById('modal-body');
  body.innerHTML = \`
    <div class="tab-row">
      <button class="tab-btn active" onclick="showIncidentTab('overview', this)">Overview</button>
      <button class="tab-btn" onclick="showIncidentTab('commander', this)">⚡ Commander</button>
      <button class="tab-btn" onclick="showIncidentTab('evidence', this)">Evidence</button>
      <button class="tab-btn" onclick="showIncidentTab('correlation', this)">Correlation</button>
      <button class="tab-btn" onclick="showIncidentTab('similar', this)">Similar</button>
      <button class="tab-btn" onclick="showIncidentTab('rca', this)">AI RCA</button>
      <button class="tab-btn" onclick="showIncidentTab('recommendations', this)">Actions</button>
      <button class="tab-btn" onclick="showIncidentTab('recovery', this)">Recovery</button>
      <button class="tab-btn" onclick="showIncidentTab('postmortem', this)">Postmortem</button>
    </div>
    <div class="tab-pane active" id="tab-overview">
    <div class="detail-stat-row">
      <div class="detail-stat">
        <div class="detail-stat-label">Status</div>
        <div class="detail-stat-val">\${group.status_code || '—'}</div>
      </div>
      <div class="detail-stat">
        <div class="detail-stat-label">Total Events</div>
        <div class="detail-stat-val">\${group.count || 0}</div>
      </div>
      <div class="detail-stat">
        <div class="detail-stat-label">Duration</div>
        <div class="detail-stat-val" style="font-size:13px">\${fmtDuration(group.first_seen, group.last_seen)}</div>
      </div>
    </div>

    <div class="root-cause-box">
      <div class="rc-label">Root Cause Analysis</div>
      <div class="rc-title">\${esc(group.root_cause || 'Unknown')}</div>
      <div class="rc-desc">\${rcDesc}</div>
    </div>

    \${related.length ? \`
    <div style="margin-bottom:16px">
      <div class="section-label">
        <svg width="13" height="13" viewBox="0 0 20 20" fill="currentColor" style="color:var(--text4)"><path fill-rule="evenodd" d="M12.586 4.586a2 2 0 112.828 2.828l-3 3a2 2 0 01-2.828 0 1 1 0 00-1.414 1.414 4 4 0 005.656 0l3-3a4 4 0 00-5.656-5.656l-1.5 1.5a1 1 0 101.414 1.414l1.5-1.5zm-5 5a2 2 0 012.828 0 1 1 0 101.414-1.414 4 4 0 00-5.656 0l-3 3a4 4 0 105.656 5.656l1.5-1.5a1 1 0 10-1.414-1.414l-1.5 1.5a2 2 0 11-2.828-2.828l3-3z" clip-rule="evenodd"/></svg>
        Connected Incidents
      </div>
      <div class="related-row">
        \${related.map(r => \`
          <div class="related-chip" onclick="closeModal();openIncidentModal('\${r.id}')">
            <span class="badge \${r.severity==='critical'?'badge-red':'badge-yellow'}" style="font-size:10px">\${esc(r.root_cause||'?')}</span>
            <span style="color:var(--text2)">\${esc((r.title||'').slice(0,30))}</span>
            <span class="rc-count">\${r.count}</span>
          </div>
        \`).join('')}
      </div>
    </div>
    \` : ''}

    <div class="section-label">
      <svg width="12" height="12" viewBox="0 0 20 20" fill="currentColor" style="color:var(--text4)"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" clip-rule="evenodd"/></svg>
      Event Timeline (\${events.length})
    </div>
    <div class="timeline-list">
      \${events.slice(0, 12).map((e, i) => \`
        <div class="tl-row">
          <div class="tl-dot \${i===0?'first':''}"></div>
          <div class="tl-content">
            <div class="tl-msg">\${esc(e.message || '—')}</div>
            <div class="tl-meta">
              <span>\${fmtDate(e.timestamp)}</span>
              \${e.response_time ? \`<span>\${e.response_time}ms</span>\` : ''}
            </div>
          </div>
        </div>
      \`).join('')}
      \${events.length > 12 ? \`<div style="padding:6px 0 2px 24px;font-size:11px;color:var(--text4)">\${events.length - 12} more events…</div>\` : ''}
    </div>
    </div>
    <div class="tab-pane" id="tab-commander">
      <div class="root-cause-box" style="margin-bottom:16px">
        <div class="rc-label">Splunk-First Incident Commander</div>
        <div class="rc-desc">Runs the full autonomous pipeline against Splunk: evidence collection → MCP investigation → timeline → correlation → similar incidents → RCA → recovery recommendation → execution → verification → executive postmortem → knowledge graph update.</div>
        <button class="btn-primary" id="btn-run-commander" style="margin-top:12px" onclick="runCommander('\${group.id}')">▶ Run Commander Pipeline</button>
      </div>
      <div id="commander-output">
        <div class="empty-state"><p>Click <strong>Run Commander Pipeline</strong> to execute the full Splunk-first investigation and remediation flow for this incident.</p></div>
      </div>
      <div class="grid2" style="margin-top:16px">
        <div class="card">
          <div class="card-header"><div class="card-title">🌐 Blast Radius</div>
            <div class="card-action" onclick="loadBlastRadius('\${group.id}')">Check</div>
          </div>
          <div id="blast-radius-out" class="empty-state"><p style="font-size:12px">Not yet checked</p></div>
        </div>
        <div class="card">
          <div class="card-header"><div class="card-title">⏱ Estimated MTTR</div>
            <div class="card-action" onclick="loadMTTR('\${group.id}')">Estimate</div>
          </div>
          <div id="mttr-out" class="empty-state"><p style="font-size:12px">Not yet estimated</p></div>
        </div>
      </div>
      <div class="card" style="margin-top:16px">
        <div class="card-header"><div class="card-title">🧠 Knowledge Graph</div>
          <div class="card-action" onclick="loadKnowledgeGraph('\${group.id}')">Build</div>
        </div>
        <div id="kg-out" class="empty-state"><p style="font-size:12px">Not yet built — Splunk evidence + similar incidents become nodes and edges here.</p></div>
      </div>
    </div>
    <div class="tab-pane" id="tab-evidence"><div class="empty-state"><p>Loading evidence...</p></div></div>
    <div class="tab-pane" id="tab-correlation"><div class="empty-state"><p>Building correlation graph...</p></div></div>
    <div class="tab-pane" id="tab-similar"><div class="empty-state"><p>Searching for similar incidents...</p></div></div>
    <div class="tab-pane" id="tab-rca"><div class="empty-state"><p>Running AI investigation...</p></div></div>
    <div class="tab-pane" id="tab-recommendations"><div class="empty-state"><p>Generating recommendations...</p></div></div>
    <div class="tab-pane" id="tab-recovery"><div class="empty-state"><p>Checking recovery status...</p></div></div>
    <div class="tab-pane" id="tab-postmortem"><div class="empty-state"><p>Preparing postmortem...</p></div></div>
  \`;
  fetchIncidentAnalysis(group.id);
}

// ── LIVE LOGS ────────────────────────────────────────────────
function showIncidentTab(name, btn) {
  document.querySelectorAll('#modal-body .tab-btn').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('#modal-body .tab-pane').forEach(el => el.classList.remove('active'));
  if (btn) btn.classList.add('active');
  const pane = document.getElementById('tab-' + name);
  if (pane) pane.classList.add('active');
}

function fetchIncidentAnalysis(id) {
  // Fire all data fetches in parallel — show loading spinners
  ['evidence','correlation','similar','rca','recommendations','recovery'].forEach(tab => {
    const el = document.getElementById('tab-' + tab);
    if (el) el.innerHTML = '<div class="empty-state" style="padding:20px 0"><span style="opacity:.5;font-size:12px">Loading ' + tab + '…</span></div>';
  });

  const analysisP     = fetch('/api/incidents/' + id + '/analysis').then(r => r.json()).catch(() => null);
  const correlationP  = fetch('/api/incidents/' + id + '/correlation').then(r => r.json()).catch(() => null);
  const similarP      = fetch('/api/incidents/' + id + '/similar').then(r => r.json()).catch(() => null);
  const recsP         = fetch('/api/incidents/' + id + '/recommendations').then(r => r.json()).catch(() => null);
  const recoveryP     = fetch('/api/incidents/' + id + '/recovery').then(r => r.json()).catch(() => null);
  const evidenceP     = fetch('/api/incidents/' + id + '/evidence').then(r => r.json()).catch(() => null);

  analysisP.then(data => {
    if (data) { analyses[id] = data; renderIncidentAnalysis(data); renderAnalysisList(); }
  });
  correlationP.then(graph => {
    if (graph) renderCorrelationTab(graph);
    else {
      const el = document.getElementById('tab-correlation');
      if (el) el.innerHTML = '<div class="empty-state"><p>No correlation data yet — click <strong>🤖 AI Investigate</strong> to build the graph.</p></div>';
    }
  });
  similarP.then(data => { renderSimilarTab(data?.similar || []); });
  recsP.then(data => { renderRecommendationsTab(data?.recommendations || []); });
  recoveryP.then(data => {
    if (data) renderRecoveryTab(data);
    else {
      const el = document.getElementById('tab-recovery');
      if (el) el.innerHTML = '<div class="empty-state"><p>Recovery data not available yet.</p></div>';
    }
  });
  evidenceP.then(data => {
    if (data) renderEvidenceTab(data);
    else {
      const el = document.getElementById('tab-evidence');
      if (el) el.innerHTML = '<div class="empty-state"><p>No evidence collected yet — click <strong>🤖 AI Investigate</strong> to gather evidence.</p></div>';
    }
  });
}

// ── INCIDENT COMMANDER (Splunk-first pipeline) ─────────────────
function runCommander(id) {
  const out = document.getElementById('commander-output');
  const btn = document.getElementById('btn-run-commander');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Running pipeline…'; }
  out.innerHTML = '<div class="empty-state"><p>Running full Splunk-first commander pipeline… this collects evidence, investigates via MCP tools, builds the timeline & knowledge graph, scores recovery confidence, and generates an executive postmortem.</p></div>';

  fetch('/api/commander/run/' + id, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ execute: false }) })
    .then(r => r.json())
    .then(cmd => {
      if (btn) { btn.disabled = false; btn.textContent = '▶ Run Commander Pipeline'; }
      if (cmd.error) { out.innerHTML = '<div class="empty-state"><p style="color:var(--red)">' + esc(cmd.error) + ': ' + esc(cmd.message||'') + '</p></div>'; return; }

      const stepsHtml = (cmd.steps||[]).map(s => \`
        <div class="event-item">
          <div class="event-dot \${s.status==='completed'?'success':'critical'}"></div>
          <div class="event-body">
            <div class="event-title">\${esc(s.name.replace(/_/g,' '))}</div>
            <div class="event-sub">\${s.status} · \${(s.completedAt - s.startedAt)}ms\${s.error ? ' · '+esc(s.error) : ''}</div>
          </div>
        </div>
      \`).join('');

      const rca = cmd.root_cause_analysis || {};
      const recovery = cmd.recovery_execution || {};
      const verified = cmd.recovery_verification || {};

      out.innerHTML = \`
        <div class="root-cause-box" style="margin-bottom:12px">
          <div class="rc-label">Root Cause (via \${esc(rca.source||'commander')})</div>
          <div class="rc-title">\${esc(rca.rootCause || 'Unknown')}</div>
          <div class="rc-desc">Confidence: \${rca.confidence || 0}%</div>
        </div>
        <div class="detail-stat-row" style="margin-bottom:12px">
          <div class="detail-stat">
            <div class="detail-stat-label">Recovery Action</div>
            <div class="detail-stat-val" style="font-size:13px">\${esc(recovery.action || '—')}</div>
          </div>
          <div class="detail-stat">
            <div class="detail-stat-label">Executed</div>
            <div class="detail-stat-val" style="font-size:13px">\${recovery.executed ? 'Yes' : 'No (dry run)'}</div>
          </div>
          <div class="detail-stat">
            <div class="detail-stat-label">Resolved</div>
            <div class="detail-stat-val" style="font-size:13px">\${verified.resolved ? '✅ Yes' : '⏳ Pending'}</div>
          </div>
        </div>
        <div class="section-label">Pipeline Steps (\${(cmd.steps||[]).length})</div>
        <div class="timeline-list" style="margin-bottom:12px">\${stepsHtml}</div>
        \${cmd.postmortem_generation ? \`
          <div class="section-label">Executive Postmortem</div>
          <pre style="white-space:pre-wrap;font-size:12px;background:var(--bg2);padding:12px;border-radius:8px;max-height:240px;overflow:auto;border:1px solid var(--border)">\${esc(typeof cmd.postmortem_generation === 'string' ? cmd.postmortem_generation : JSON.stringify(cmd.postmortem_generation, null, 2))}</pre>
        \` : ''}
      \`;
    })
    .catch(err => {
      if (btn) { btn.disabled = false; btn.textContent = '▶ Run Commander Pipeline'; }
      out.innerHTML = '<div class="empty-state"><p style="color:var(--red)">Commander run failed: ' + esc(err.message) + '</p></div>';
    });
}

function loadBlastRadius(id) {
  const el = document.getElementById('blast-radius-out');
  el.innerHTML = '<div class="empty-state"><p style="font-size:12px">Checking…</p></div>';
  fetch('/api/incidents/' + id + '/blast-radius').then(r => r.json()).then(data => {
    if (data.error) { el.innerHTML = '<div class="empty-state"><p style="font-size:12px;color:var(--red)">' + esc(data.error) + '</p></div>'; return; }
    el.innerHTML = \`
      <div class="detail-stat-row">
        <div class="detail-stat"><div class="detail-stat-label">Events</div><div class="detail-stat-val">\${data.events||0}</div></div>
        <div class="detail-stat"><div class="detail-stat-label">Affected Paths</div><div class="detail-stat-val">\${data.affectedPathCount||0}</div></div>
        <div class="detail-stat"><div class="detail-stat-label">Affected Services</div><div class="detail-stat-val">\${data.affectedServiceCount||0}</div></div>
      </div>
      <div style="margin-top:8px;font-size:12px;color:var(--text2)">Source: \${esc(data.source||'local')}\${(data.affectedPaths||[]).length ? ' · Paths: '+data.affectedPaths.map(esc).join(', ') : ''}</div>
    \`;
  }).catch(err => { el.innerHTML = '<div class="empty-state"><p style="font-size:12px;color:var(--red)">' + esc(err.message) + '</p></div>'; });
}

function loadMTTR(id) {
  const el = document.getElementById('mttr-out');
  el.innerHTML = '<div class="empty-state"><p style="font-size:12px">Estimating…</p></div>';
  fetch('/api/incidents/' + id + '/mttr').then(r => r.json()).then(data => {
    if (data.error) { el.innerHTML = '<div class="empty-state"><p style="font-size:12px;color:var(--red)">' + esc(data.error) + '</p></div>'; return; }
    el.innerHTML = \`
      <div class="detail-stat" style="margin-bottom:8px"><div class="detail-stat-label">Mean Time To Recovery</div><div class="detail-stat-val">\${data.meanMinutes||0} min</div></div>
      <div style="font-size:12px;color:var(--text2)">Source: \${esc(data.source||'local')} · based on \${(data.basis?.relatedIncidents ?? data.basis?.heals ?? 0)} historical record(s)</div>
    \`;
  }).catch(err => { el.innerHTML = '<div class="empty-state"><p style="font-size:12px;color:var(--red)">' + esc(err.message) + '</p></div>'; });
}

function loadKnowledgeGraph(id) {
  const el = document.getElementById('kg-out');
  el.innerHTML = '<div class="empty-state"><p style="font-size:12px">Building graph from Splunk evidence…</p></div>';
  fetch('/api/incidents/' + id + '/knowledge-graph').then(r => r.json()).then(graph => {
    if (graph.error) { el.innerHTML = '<div class="empty-state"><p style="font-size:12px;color:var(--red)">' + esc(graph.error) + '</p></div>'; return; }
    const typeColors = { Incident:'#dc2626', Service:'#2563eb', Deployment:'#7c3aed', Metric:'#16a34a', Trace:'#0891b2', Error:'#ea580c', Recovery:'#059669', Postmortem:'#64748b' };
    const grouped = {};
    (graph.nodes||[]).forEach(n => { (grouped[n.type] = grouped[n.type] || []).push(n); });
    el.innerHTML = \`
      <div style="font-size:12px;color:var(--text2);margin-bottom:10px">\${(graph.nodes||[]).length} nodes · \${(graph.edges||[]).length} edges · layout: \${esc(graph.spec?.layout||'force-directed')}</div>
      \${Object.entries(grouped).map(([type, nodes]) => \`
        <div style="margin-bottom:10px">
          <div style="font-size:11px;font-weight:600;color:\${typeColors[type]||'var(--text2)'};margin-bottom:4px">\${esc(type)} (\${nodes.length})</div>
          <div style="display:flex;flex-wrap:wrap;gap:6px">
            \${nodes.slice(0,10).map(n => \`<span class="badge" style="border-color:\${typeColors[type]||'var(--border)'};color:\${typeColors[type]||'var(--text2)'}" title="\${esc(JSON.stringify(n.data||{}).slice(0,200))}">\${esc(n.label)}</span>\`).join('')}
          </div>
        </div>
      \`).join('')}
    \`;
  }).catch(err => { el.innerHTML = '<div class="empty-state"><p style="font-size:12px;color:var(--red)">' + esc(err.message) + '</p></div>'; });
}


function renderAnalysisList() {
  const el = document.getElementById('analysis-list');
  if (!el) return;
  const rows = Object.values(analyses).filter(a => a && a.rca);
  if (!rows.length) {
    el.innerHTML = '<div class="empty-state"><p>Open an incident to generate RCA details</p></div>';
    return;
  }
  el.innerHTML = rows.map(a => {
    const inc = a.context?.incident || {};
    return \`
      <div class="event-item" onclick="openIncidentModal('\${inc.id}')">
        <div class="event-dot \${inc.severity === 'critical' ? 'critical' : 'warning'}"></div>
        <div class="event-body">
          <div class="event-title">\${esc(inc.title || 'Incident analysis')}</div>
          <div class="event-sub">\${esc(a.rca.rootCause || '')} - \${a.rca.confidence || 0}% confidence - \${a.recovery?.resolved ? 'resolved' : 'open'}</div>
        </div>
      </div>
    \`;
  }).join('');
}

let logFilterLevel = '';
function onLog(entry) {
  logEntries.unshift(entry);
  if (logEntries.length > MAX_LOGS) logEntries.pop();
  if (entry.level === 'error' || (entry.statusCode && entry.statusCode >= 400)) {
    setTimeout(fetchIncidents, 500);
  }
  const stream = document.getElementById('log-stream');
  if (!stream) return;
  if (logFilterLevel && entry.level !== logFilterLevel) return;
  // Clear empty state
  if (stream.querySelector('.empty-state')) stream.innerHTML = '';
  const row = document.createElement('div');
  row.className = 'log-row ' + (entry.level || '');
  row.innerHTML = \`
    <span class="log-time">\${fmtTime(entry.timestamp)}</span>
    <span class="log-lvl"><span class="lvl-badge \${entry.level||'info'}">\${(entry.level||'INFO').toUpperCase().slice(0,4)}</span></span>
    \${entry.method ? \`<span class="method-tag method-\${entry.method}" style="flex-shrink:0">\${entry.method}</span>\` : ''}
    <span class="log-msg">\${esc(entry.message || entry.path || '')}</span>
    \${entry.responseTime ? \`<span class="log-rt">\${entry.responseTime}ms</span>\` : ''}
  \`;
  stream.insertBefore(row, stream.firstChild);
  while (stream.children.length > MAX_LOGS) stream.removeChild(stream.lastChild);
}
function filterLogs() {
  logFilterLevel = document.getElementById('log-filter-level').value;
  const stream = document.getElementById('log-stream');
  stream.innerHTML = '';
  logEntries
    .filter(e => !logFilterLevel || e.level === logFilterLevel)
    .slice(0, 200)
    .forEach(e => onLog(e));
}

// ── HEALS ────────────────────────────────────────────────────
function onHeal(event) {
  fetchHeals(); fetchProtections(); fetchIncidents(); fetchStats();
}
function renderHeals(actions) {
  ['heal-list-full'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    if (!actions.length) {
      el.innerHTML = '<div class="empty-state"><p>No heal actions yet</p></div>';
      return;
    }
    el.innerHTML = actions.map(a => \`
      <div class="heal-row">
        <div class="heal-icon-wrap">
          <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor" style="color:var(--yellow)"><path fill-rule="evenodd" d="M11.3 1.046A1 1 0 0112 2v5h4a1 1 0 01.82 1.573l-7 10A1 1 0 018 18v-5H4a1 1 0 01-.82-1.573l7-10a1 1 0 011.12-.38z" clip-rule="evenodd"/></svg>
        </div>
        <div class="heal-body">
          <div class="heal-rule">\${esc(a.rule_name)}</div>
          <div class="heal-action-tag">
            <span class="badge badge-purple" style="font-size:10px">\${esc(a.action)}</span>
            <span style="color:\${a.success?'var(--green)':'var(--red)'}">\${a.success?'Success':'Failed'}</span>
          </div>
          \${a.notes ? \`<div class="heal-notes">\${esc(a.notes.slice(0,80))}</div>\` : ''}
        </div>
        <div class="heal-time">\${fmtAgo(a.timestamp)}</div>
      </div>
    \`).join('');
  });

  // Render rules summary
  const ruleEl = document.getElementById('rule-list');
  if (ruleEl) {
    const unique = [...new Set(actions.map(a => a.rule_name))];
    ruleEl.innerHTML = unique.slice(0,8).map(r => \`
      <div style="padding:4px 0;border-bottom:1px solid var(--border);font-size:12px;color:var(--text2)">• \${esc(r)}</div>
    \`).join('') || '<div style="font-size:12px;color:var(--text3)">No rules triggered yet</div>';
  }
}

// ── PROTECTIONS ──────────────────────────────────────────────
function renderProtections(data, targetId) {
  const cb = data.circuitBreakers || [];
  const rl = data.rateLimits || [];
  const all = [...cb.map(b => ({...b,type:'circuit'})), ...rl.map(b => ({...b,type:'ratelimit'}))];

  if (targetId === 'protection-banner') {
    const banner = document.getElementById('protection-banner');
    if (!all.length) { banner.classList.remove('visible'); return; }
    banner.classList.add('visible');
    banner.innerHTML = all.map(p => \`
      <div class="pb-item \${p.type}">
        <span class="pb-label" style="color:\${p.type==='circuit'?'var(--red)':'var(--yellow)'}">
          \${p.type === 'circuit' ? '⛔ Circuit Breaker' : '⚠ Rate Limit'}
        </span>
        <span class="pb-path">\${esc(p.path)}</span>
        <span class="pb-expires">expires \${fmtTime(p.until)}</span>
      </div>
    \`).join('');
    return;
  }

  const el = document.getElementById(targetId);
  if (!el) return;
  if (!all.length) {
    el.innerHTML = '<div class="empty-state" style="padding:14px"><p>No active protections</p></div>';
    return;
  }
  el.innerHTML = all.map(p => \`
    <div class="heal-row">
      <div class="heal-icon-wrap" style="background:\${p.type==='circuit'?'var(--red-light)':'var(--yellow-light)'}">
        <span style="font-size:14px">\${p.type === 'circuit' ? '⛔' : '⚠'}</span>
      </div>
      <div class="heal-body">
        <div class="heal-rule">\${p.type === 'circuit' ? 'Circuit Breaker' : 'Rate Limit'}</div>
        <div class="heal-action-tag"><span class="mono">\${esc(p.path)}</span></div>
      </div>
      <div class="heal-time">until \${fmtTime(p.until)}</div>
    </div>
  \`).join('');
}

// ── SNAPSHOTS ────────────────────────────────────────────────
async function captureSnap() {
  const btn = document.getElementById('snap-btn');
  btn.disabled = true; btn.textContent = 'Capturing…';
  try {
    await fetch('/api/heap-snapshots', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({notes:'Manual'}) });
    await fetchSnaps();
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M4 5a2 2 0 00-2 2v8a2 2 0 002 2h12a2 2 0 002-2V7a2 2 0 00-2-2h-1.586a1 1 0 01-.707-.293l-1.121-1.121A2 2 0 0011.172 3H8.828a2 2 0 00-1.414.586L6.293 4.707A1 1 0 015.586 5H4zm6 9a3 3 0 100-6 3 3 0 000 6z" clip-rule="evenodd"/></svg> Capture Snapshot';
  }
}
function renderSnaps() {
  const el = document.getElementById('snap-list');
  if (!snapshots.length) {
    el.innerHTML = '<div class="empty-state"><p>No snapshots yet. Capture one manually or configure a heap-snapshot rule.</p></div>';
    return;
  }
  el.innerHTML = \`<table class="inc-table">
    <thead><tr><th>Trigger</th><th>Heap Used</th><th>Heap Total</th><th>RSS</th><th>Notes</th><th>Time</th></tr></thead>
    <tbody>
      \${snapshots.map(s => \`
        <tr>
          <td><span class="badge badge-blue">\${esc(s.trigger||'manual')}</span></td>
          <td class="mono">\${s.heap_used_mb||0} MB</td>
          <td class="mono">\${s.heap_total_mb||0} MB</td>
          <td class="mono">\${s.rss_mb||0} MB</td>
          <td style="color:var(--text3);font-size:12px">\${esc((s.notes||'').slice(0,40))}</td>
          <td style="font-size:12px;color:var(--text3)">\${fmtDate(s.timestamp)}</td>
        </tr>
      \`).join('')}
    </tbody>
  </table>\`;
}

// ── SEARCH ─────────────────────────────────────────────────
function openSearch() {
  const q = document.getElementById('global-search').value.trim();
  if (!q) return;
  document.getElementById('search-main-inp').value = q;
  navigate('search');
  runSearch();
}
function runSearch() {
  const q = document.getElementById('search-main-inp').value.trim();
  if (!q) return;
  const el = document.getElementById('search-results');
  el.innerHTML = '<div class="empty-state" style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius)"><p>Searching…</p></div>';
  fetch('/api/search', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({query:q}) })
    .then(r => r.json())
    .then(data => {
      if (!data.groups?.length) {
        el.innerHTML = \`<div class="empty-state" style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius)"><p>No results for "\${esc(q)}"</p></div>\`;
        return;
      }
      el.innerHTML = \`
        <div style="font-size:12px;color:var(--text3);margin-bottom:12px;display:flex;align-items:center;gap:8px">
          Found <strong style="color:var(--text);margin:0 3px">\${data.totalFound}</strong> logs
          — \${esc(data.description||'')}
          <span class="badge \${data.searchMode==='semantic'?'badge-blue':'badge-gray'}" style="margin-left:auto">\${data.searchMode==='semantic'?'⚡ Semantic':'🔤 Keyword'}</span>
        </div>
        \${data.groups.map(g => \`
          <div class="sr-group">
            <div class="sr-group-hdr">
              <span>\${esc(g.name)}</span>
              <span class="badge badge-gray">\${g.count} logs</span>
            </div>
            \${(g.entries||[]).slice(0,4).map(e => \`
              <div class="sr-row">[\${fmtTime(e.timestamp)}] \${esc(e.message||e.path||'')} \${e.responseTime?e.responseTime+'ms':''}</div>
            \`).join('')}
          </div>
        \`).join('')}
      \`;
    }).catch(() => {
      el.innerHTML = '<div class="empty-state" style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius)"><p>Search failed</p></div>';
    });
}

// ── NAVIGATION ──────────────────────────────────────────────
function navigate(page) {
  document.querySelectorAll('.sb-item').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.page').forEach(el => el.classList.remove('active'));
  const nav = document.getElementById('nav-' + page);
  if (nav) nav.classList.add('active');
  const pg = document.getElementById('page-' + page);
  if (pg) pg.classList.add('active');
  if (page === 'incidents') fetchIncidents();
  if (page === 'heals') { fetchHeals(); fetchProtections(); }
  if (page === 'memory') fetchSnaps();
  if (page === 'splunk')   { fetchSplunkHealth(); }
  if (page === 'analysis') { fetchAnalytics(); renderAnalysisList(); fetchAdvancedAnalytics(); }
  if (page === 'predictions') fetchPredictions();
}

// ── HELPERS ─────────────────────────────────────────────────
function setText(id, v) { const el = document.getElementById(id); if (el) el.textContent = v; }
function esc(v) { return String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function num(n) { return Number(n).toLocaleString(); }
function fmtTime(ts) { return new Date(ts).toLocaleTimeString(); }
function fmtDate(ts) { return new Date(ts).toLocaleString(); }
function fmtAgo(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s/60) + 'm ago';
  if (s < 86400) return Math.floor(s/3600) + 'h ago';
  return Math.floor(s/86400) + 'd ago';
}
function fmtUptime(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h > 0 ? h + 'h ' + m + 'm' : m + 'm';
}
function fmtDuration(first, last) {
  const ms = (last || Date.now()) - (first || Date.now());
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s/60) + 'm';
  return Math.floor(s/3600) + 'h ' + Math.floor((s%3600)/60) + 'm';
}
function getRCDesc(cause) {
  const map = {
    'Timeout': 'Endpoint is not responding in time. Check downstream services, DB queries, and external API calls.',
    'Connection': 'A dependency (DB, cache, or external API) is refusing connections. Verify services are reachable.',
    'Memory': 'Process memory is elevated. Consider running GC, reviewing leaks, or triggering a graceful restart.',
    'Rate limit': 'Request volume exceeds capacity. Rate limiting or a circuit breaker may be needed.',
    'Data store': 'Errors from a database or cache layer. Check query performance and connection pool health.',
    'Auth': 'Authentication or authorization is failing. Check token validity, expiry, and permissions.',
    'Not found': 'Resources are consistently missing. Possible routing issue or stale client references.',
    'Upstream': 'An upstream service is returning errors. Check proxy configuration and upstream health.',
    'Server error': 'Generic 5xx server error. Check logs for stack traces or uncaught exceptions.',
    'Client error': 'Client is sending invalid requests. Check request validation and API contract.',
    'Application error': 'Unclassified error. Review recent deployments and application logs.',
  };
  return map[cause] || 'Review application logs and recent deployments for context.';
}

// ── INIT ─────────────────────────────────────────────────────
window.addEventListener('resize', () => { drawChart(); renderAnalyticsCharts(); });
window.addEventListener('load', () => {
  initChart();
  // Set date range label
  const now = new Date();
  const then = new Date(now - 24*60*60*1000);
  const fmt = d => d.toLocaleDateString('en-US', {month:'short', day:'numeric', year:'numeric'});
  setText('tb-date-range', fmt(then) + ' – ' + fmt(now));
  // Keyboard shortcut
  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      document.getElementById('global-search').focus();
    }
    if (e.key === 'Escape') closeModal();
  });
});
</script>
<script src="/dashboard-ext.js"></script>
</body>
</html>`;
}

function stopDashboard() {
  if (dashboardServer) dashboardServer.close();
}

module.exports = { startDashboard, stopDashboard };
