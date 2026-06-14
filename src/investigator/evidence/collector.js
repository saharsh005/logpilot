'use strict';

/**
 * Evidence Collector — Phase 2 (production-strength, Splunk-optional)
 *
 * When Splunk is enabled:  pulls logs, metrics, incidents, heals, traces from Splunk
 * When Splunk is disabled: pulls deep local evidence from SQLite — still very rich
 *
 * Returns a structured evidence package used by the correlation engine and AI investigator.
 */

const db = require('../../storage/db');
const { searchSplunk } = require('../../integrations/splunk/splunkSearch');

const CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes

async function collectEvidence(incident, config = {}) {
  // Return cached if fresh
  const cached = db.getEvidenceSnapshot(incident.id);
  if (cached && !isCacheStale(cached, CACHE_TTL_MS)) {
    try { return JSON.parse(cached.evidence_json); } catch (_) {}
  }

  let evidence;
  let splunkAttempted = false;
  if (config.splunk?.enabled) {
    splunkAttempted = true;
    try {
      evidence = await collectFromSplunk(incident, config);
    } catch (_) {}
  }

  if (!evidence) {
    evidence = await collectFromLocal(incident, config);
    if (splunkAttempted) {
      evidence.splunkStatus = 'unreachable';
    }
  }

  try { db.saveEvidenceSnapshot(incident.id, evidence); } catch (_) {}
  return evidence;
}

// ── Splunk path ───────────────────────────────────────────────────────────

async function collectFromSplunk(incident, config) {
  const idx  = config.splunk.index || 'logpilot';
  const path = incident.path ? `path="${incident.path}"` : '';
  const rc   = incident.root_cause ? `rootCause="${incident.root_cause}"` : '';

  const queries = {
    logs:    `search index=${idx} ${path} earliest=-30m | stats count by message level statusCode | sort -count | head 10`,
    logStats: `search index=${idx} type=request ${path} earliest=-30m | stats count as total avg(responseTime) as avgRt max(responseTime) as maxRt p95(responseTime) as p95Rt count(eval(statusCode>=500 OR level="error")) as errCount by statusCode`,
    metrics: `search index=${idx} type=metric ${path} earliest=-30m | stats max(cpu_percent) as maxCpu max(memory_percent) as maxMemory max(event_loop_lag) as maxLag avg(cpu_percent) as avgCpu avg(memory_percent) as avgMemory count as samples`,
    metricSeries: `search index=${idx} type=metric ${path} earliest=-30m | sort 0 _time | fields _time cpu_percent memory_percent event_loop_lag | head 20`,
    related: `search index=${idx} type=incident ${rc} earliest=-24h | stats count by incidentId path rootCause severity | sort -count | head 10`,
    heals:   `search index=${idx} type=heal ${path} earliest=-24h | stats count by action ruleName success | sort -count`,
    errors:  `search index=${idx} statusCode>=500 ${path} earliest=-1h | timechart span=5m count as errors | head 12`,
    traces:  `search index=${idx} type=trace ${path} earliest=-15m | stats avg(responseTime) as avgRt max(responseTime) as maxRt count by endpoint | sort -maxRt | head 5`,
    deploys: `search index=${idx} type=deployment earliest=-6h | stats count by commitHash author subject changedFiles | head 5`,
    anomalies:`search index=${idx} type=anomaly ${path} earliest=-1h | stats count by type severity message | sort -count | head 5`,
  };

  const results = await Promise.all(
    Object.values(queries).map(q => searchSplunk(q, config).catch(() => ({ events: [], count: 0, source: 'local' })))
  );
  const [logsR, logStatsR, metricsR, metricSeriesR, relatedR, healsR, errorsR, tracesR, deploysR, anomaliesR] = results;

  // If Splunk is enabled but unreachable, EVERY sub-query degrades to source:'local'.
  // Detect that and signal the caller to use the local evidence path instead of
  // returning a Frankenstein object labelled 'splunk' that's actually all local data.
  const splunkHits = results.filter(r => r.source === 'splunk').length;
  if (splunkHits === 0) {
    throw new Error('Splunk unreachable — all sub-queries degraded to local');
  }

  const logStatRows = logStatsR.events || [];
  const totalLogCount   = logStatRows.reduce((s, r) => s + (parseInt(r.total) || 0), 0);
  const totalErrCount   = logStatRows.reduce((s, r) => s + (parseInt(r.errCount) || 0), 0);
  const weightedAvgRt   = totalLogCount
    ? Math.round(logStatRows.reduce((s, r) => s + (parseFloat(r.avgRt) || 0) * (parseInt(r.total) || 0), 0) / totalLogCount)
    : 0;
  const maxRtSplunk     = logStatRows.length ? Math.max(...logStatRows.map(r => parseFloat(r.maxRt) || 0)) : 0;
  const p95RtSplunk     = logStatRows.length ? Math.max(...logStatRows.map(r => parseFloat(r.p95Rt) || 0)) : 0;
  const splunkStatusCodes = {};
  logStatRows.forEach(r => {
    const code = String(r.statusCode || 0);
    splunkStatusCodes[code] = (splunkStatusCodes[code] || 0) + (parseInt(r.total) || 0);
  });
  const splunkErrorRate = totalLogCount ? Math.round((totalErrCount / totalLogCount) * 100) : 0;

  const dominantErrors = (logsR.events || [])
    .map(e => ({ message: e.message || e._raw || '', count: parseInt(e.count) || 1, level: e.level, status: e.statusCode }))
    .filter(e => e.message).slice(0, 8);

  const metricRow  = (metricsR.events || [])[0] || {};
  const healEvents = (healsR.events || []);
  const healMap    = {};
  healEvents.forEach(e => { healMap[e.action || 'unknown'] = (healMap[e.action || 'unknown'] || 0) + 1; });

  const errorTimeline = (errorsR.events || []).map(e => ({ time: e._time, errors: parseInt(e.errors) || 0 }));

  const metricSeries = (metricSeriesR.events || []).slice(0, 20).map(e => ({
    t:   e._time,
    cpu: e.cpu_percent != null ? Math.round(parseFloat(e.cpu_percent)) : null,
    mem: e.memory_percent != null ? Math.round(parseFloat(e.memory_percent)) : null,
    lag: e.event_loop_lag != null ? Math.round(parseFloat(e.event_loop_lag)) : null,
  }));

  const computedAnomalies = [];
  const maxCpuS = Math.round(parseFloat(metricRow.maxCpu) || 0);
  const maxMemS = Math.round(parseFloat(metricRow.maxMemory) || 0);
  const maxLagS = Math.round(parseFloat(metricRow.maxLag) || 0);
  if (maxCpuS >= 60)   computedAnomalies.push({ type: 'high_cpu',    severity: maxCpuS >= 90 ? 'critical' : maxCpuS >= 80 ? 'high' : 'warning', message: `CPU peaked at ${maxCpuS}%`, value: maxCpuS, unit: '%', threshold: 60 });
  if (maxMemS >= 60)   computedAnomalies.push({ type: 'high_memory', severity: maxMemS >= 90 ? 'critical' : maxMemS >= 80 ? 'high' : 'warning', message: `Memory peaked at ${maxMemS}%`, value: maxMemS, unit: '%', threshold: 60 });
  if (maxLagS >= 100)  computedAnomalies.push({ type: 'event_loop',  severity: maxLagS >= 1000 ? 'critical' : maxLagS >= 250 ? 'high' : 'warning', message: `Event loop lag ${maxLagS}ms`, value: maxLagS, unit: 'ms', threshold: 100 });
  if (maxRtSplunk >= 1000) computedAnomalies.push({ type: 'slow_response', severity: maxRtSplunk >= 5000 ? 'critical' : maxRtSplunk >= 2000 ? 'high' : 'warning', message: `Max response time ${Math.round(maxRtSplunk)}ms`, value: Math.round(maxRtSplunk), unit: 'ms', threshold: 1000 });
  if (splunkErrorRate >= 5) computedAnomalies.push({ type: 'error_rate', severity: splunkErrorRate >= 50 ? 'critical' : splunkErrorRate >= 20 ? 'high' : 'warning', message: `Error rate ${splunkErrorRate}%`, value: splunkErrorRate, unit: '%', threshold: 5 });

  return {
    source: 'splunk',
    timestamp: Date.now(),
    incident,
    logs: {
      count: totalLogCount || logsR.count || 0,
      dominantErrors,
      errorTimeline,
      errorRate:     splunkErrorRate,
      avgResponseMs: weightedAvgRt,
      maxResponseMs: Math.round(maxRtSplunk),
      p95ResponseMs: Math.round(p95RtSplunk),
      statusCodes:   splunkStatusCodes,
      source: 'splunk',
    },
    metrics: {
      samples: Number(metricRow.samples) || metricSeries.length || 0,
      samplesWithData: metricSeries.filter(m => m.cpu != null).length,
      maxCpu:  Math.round(parseFloat(metricRow.maxCpu)    || 0),
      maxMemory: Math.round(parseFloat(metricRow.maxMemory) || 0),
      maxEventLoopLag: Math.round(parseFloat(metricRow.maxLag) || 0),
      avgCpu:  Math.round(parseFloat(metricRow.avgCpu)    || 0),
      avgMemory: Math.round(parseFloat(metricRow.avgMemory) || 0),
      cpuSpike:    (parseFloat(metricRow.maxCpu) || 0) >= 80,
      memorySpike: (parseFloat(metricRow.maxMemory) || 0) >= 80,
      eventLoopLagSpike: (parseFloat(metricRow.maxLag) || 0) >= 250,
      series: metricSeries,
      heapSnapshots: 0,
      source: 'splunk',
    },
    relatedIncidents: {
      count: relatedR.count || 0,
      similar: (relatedR.events || []).map(e => ({
        incidentId: e.incidentId, path: e.path, rootCause: e.rootCause,
        severity: e.severity, count: parseInt(e.count) || 1,
      })).slice(0, 8),
      source: 'splunk',
    },
    heals: {
      count: healsR.count || 0,
      recentActions: Object.entries(healMap).map(([action, count]) => ({ action, count })),
      raw: healEvents.slice(0, 10),
      source: 'splunk',
    },
    traces: {
      count: tracesR.count || 0,
      slowest: (tracesR.events || []).map(e => ({
        endpoint: e.endpoint, avgRt: parseFloat(e.avgRt) || 0, maxRt: parseFloat(e.maxRt) || 0,
      })),
      source: 'splunk',
    },
    deployments: {
      count: deploysR.count || 0,
      recent: (deploysR.events || []).map(e => ({
        commitHash: e.commitHash, author: e.author, subject: e.subject,
      })),
      source: 'splunk',
    },
    anomalies: {
      count: (anomaliesR.count || 0) + computedAnomalies.length,
      detected: [
        ...(anomaliesR.events || []).map(e => ({
          type: e.type, severity: e.severity, message: e.message, count: parseInt(e.count) || 1,
        })),
        ...computedAnomalies,
      ],
      source: 'splunk',
    },
  };
}

// ── Local SQLite path (rich, no Splunk needed) ────────────────────────────

async function collectFromLocal(incident, config) {
  const window15m = Date.now() - 15 * 60 * 1000;
  const window1h  = Date.now() - 60 * 60 * 1000;
  const window24h = Date.now() - 24 * 60 * 60 * 1000;

  // ── Logs for this endpoint ──────────────────────────────────────────────
  const recentLogs = db.queryLogs({ path: incident.path, since: window15m, limit: 200 });
  const allPathLogs = db.queryLogs({ path: incident.path, since: window1h, limit: 500 });

  // Dominant errors with frequency
  const errCounts = {};
  recentLogs.forEach(log => {
    const key = normalizeMessage(log.message || '');
    if (key) errCounts[key] = (errCounts[key] || 0) + 1;
  });
  const dominantErrors = Object.entries(errCounts)
    .map(([message, count]) => ({ message, count }))
    .sort((a, b) => b.count - a.count).slice(0, 8);

  // Error timeline (5-min buckets over last hour)
  const buckets = {};
  allPathLogs.forEach(log => {
    const bucket = Math.floor(log.timestamp / 300000) * 300000;
    if (!buckets[bucket]) buckets[bucket] = { time: new Date(bucket).toISOString(), errors: 0, total: 0 };
    buckets[bucket].total++;
    if (log.level === 'error' || log.status_code >= 500) buckets[bucket].errors++;
  });
  const errorTimeline = Object.values(buckets).sort((a, b) => a.time.localeCompare(b.time));

  // Response time stats
  const rtValues = recentLogs.map(l => l.response_time).filter(Boolean);
  const avgRt  = rtValues.length ? Math.round(rtValues.reduce((a, b) => a + b, 0) / rtValues.length) : 0;
  const maxRt  = rtValues.length ? Math.max(...rtValues) : 0;
  const p95Rt  = rtValues.length ? rtValues.sort((a, b) => a - b)[Math.floor(rtValues.length * 0.95)] : 0;

  // ── System metrics (null-safe, fall back to 1h window if sparse) ──────
  let metrics = db.queryMetrics({ since: window15m });
  if (metrics.length < 3) metrics = db.queryMetrics({ since: window1h });

  // Null-safe: some rows may have null cpu_percent if process never emitted
  const cpuVals = metrics.map(m => m.cpu_percent  != null ? m.cpu_percent  : null).filter(v => v != null);
  const memVals = metrics.map(m => m.memory_percent != null ? m.memory_percent : null).filter(v => v != null);
  const lagVals = metrics.map(m => m.event_loop_lag != null ? m.event_loop_lag : null).filter(v => v != null);

  const maxCpu = cpuVals.length ? Math.max(...cpuVals) : 0;
  const maxMem = memVals.length ? Math.max(...memVals) : 0;
  const maxLag = lagVals.length ? Math.max(...lagVals) : 0;

  // Sparkline series for the UI (last 20 points, newest last)
  const metricSeries = metrics.slice(0, 20).reverse().map(m => ({
    t:   m.timestamp,
    cpu: m.cpu_percent  != null ? Math.round(m.cpu_percent)  : null,
    mem: m.memory_percent != null ? Math.round(m.memory_percent) : null,
    lag: m.event_loop_lag != null ? m.event_loop_lag : null,
  }));

  // ── Heal actions for this path ──────────────────────────────────────────
  const allHeals = db.getHealActions(100);
  const pathHeals = allHeals.filter(h => {
    const detail = (h.trigger_detail || '').toLowerCase();
    const path   = (incident.path || '').toLowerCase();
    return detail.includes(path) || !incident.path;
  });

  const healMap = {};
  pathHeals.forEach(h => { healMap[h.action] = (healMap[h.action] || 0) + 1; });

  // ── Similar incidents from local DB ─────────────────────────────────────
  const allGroups = db.getIncidentGroups({ limit: 200, since: window24h });
  const similar = allGroups
    .filter(g => g.id !== incident.id)
    .filter(g => g.path === incident.path || g.root_cause === incident.root_cause)
    .slice(0, 8)
    .map(g => ({
      incidentId: g.id, path: g.path, rootCause: g.root_cause,
      severity: g.severity, count: g.count, title: g.title,
    }));

  // ── Heap snapshots ──────────────────────────────────────────────────────
  const snapshots = db.getHeapSnapshots ? db.getHeapSnapshots(5) : [];

  // ── Error rate signal ───────────────────────────────────────────────────
  const errorCount  = recentLogs.filter(l => l.level === 'error' || l.status_code >= 500).length;
  const errorRate   = recentLogs.length ? Math.round((errorCount / recentLogs.length) * 100) : 0;

  // ── Anomaly signals from current metrics ────────────────────────────────
  const anomalies = [];
  if (maxCpu >= 60)   anomalies.push({ type: 'high_cpu',    severity: maxCpu >= 90 ? 'critical' : maxCpu >= 80 ? 'high' : 'warning', message: `CPU peaked at ${maxCpu}%`, value: maxCpu, unit: '%', threshold: 60 });
  if (maxMem >= 60)   anomalies.push({ type: 'high_memory', severity: maxMem >= 90 ? 'critical' : maxMem >= 80 ? 'high' : 'warning', message: `Memory peaked at ${maxMem}%`, value: maxMem, unit: '%', threshold: 60 });
  if (maxLag >= 100)  anomalies.push({ type: 'event_loop',  severity: maxLag >= 1000 ? 'critical' : maxLag >= 250 ? 'high' : 'warning', message: `Event loop lag ${maxLag}ms`, value: maxLag, unit: 'ms', threshold: 100 });
  if (maxRt >= 1000)  anomalies.push({ type: 'slow_response', severity: maxRt >= 5000 ? 'critical' : maxRt >= 2000 ? 'high' : 'warning', message: `Max response time ${maxRt}ms`, value: maxRt, unit: 'ms', threshold: 1000 });
  if (errorRate >= 5) anomalies.push({ type: 'error_rate',  severity: errorRate >= 50 ? 'critical' : errorRate >= 20 ? 'high' : 'warning', message: `Error rate ${errorRate}%`, value: errorRate, unit: '%', threshold: 5 });

  return {
    source: 'local',
    timestamp: Date.now(),
    incident,
    logs: {
      count:         recentLogs.length,
      dominantErrors,
      errorTimeline,
      errorRate,
      avgResponseMs: avgRt,
      maxResponseMs: maxRt,
      p95ResponseMs: p95Rt,
      statusCodes:   countBy(recentLogs, l => String(l.status_code || 0)),
      source:        'local',
    },
    metrics: {
      samples:          metrics.length,
      samplesWithData:  cpuVals.length,
      maxCpu:           Math.round(maxCpu),
      maxMemory:        Math.round(maxMem),
      maxEventLoopLag:  Math.round(maxLag),
      avgCpu:           Math.round(avg(cpuVals)),
      avgMemory:        Math.round(avg(memVals)),
      cpuSpike:         maxCpu >= 80,
      memorySpike:      maxMem >= 80,
      eventLoopLagSpike: maxLag >= 250,
      heapSnapshots:    snapshots.length,
      series:           metricSeries,
      source:           'local',
    },
    relatedIncidents: {
      count:   similar.length,
      similar,
      source:  'local',
    },
    heals: {
      count:         pathHeals.length,
      recentActions: Object.entries(healMap).map(([action, count]) => ({ action, count })),
      raw:           pathHeals.slice(0, 10),
      source:        'local',
    },
    traces: {
      count: recentLogs.length,
      slowest: [{ endpoint: incident.path, avgRt, maxRt, p95Rt }],
      source: 'local',
    },
    deployments: { count: 0, recent: [], source: 'local' },
    anomalies: {
      count:    anomalies.length,
      detected: anomalies,
      source:   'local',
    },
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────

function normalizeMessage(msg) {
  return msg
    .replace(/[a-f0-9]{8,}/gi, 'HEX')
    .replace(/\b\d{4,}\b/g, 'N')
    .replace(/[\\/]/g, '/')
    .toLowerCase()
    .trim()
    .slice(0, 120);
}

function isCacheStale(snapshot, ttlMs) {
  return (Date.now() - (snapshot.created_at || 0)) > ttlMs;
}

function countBy(arr, fn) {
  const out = {};
  arr.forEach(x => { const k = fn(x); out[k] = (out[k] || 0) + 1; });
  return out;
}

function avg(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

module.exports = { collectEvidence };
