'use strict';

/**
 * Metric Correlator (Splunk-first, Phase 3)
 *
 * Source of truth: Splunk metric events for the incident window.
 * Falls back to local SQLite only when Splunk is disabled or unreachable
 * (searchSplunk() already does this fallback and reports source: 'local').
 */

const db = require('../storage/db');
const { searchSplunk } = require('../integrations/splunk/splunkSearch');

async function correlateMetrics(incident, config = {}) {
  const windowStart = Math.max(0, (incident.first_seen || Date.now()) - 15 * 60 * 1000);
  const windowEnd   = (incident.last_seen || Date.now()) + 5 * 60 * 1000;

  if (config.splunk?.enabled) {
    const index = config.splunk.index || 'logpilot';
    const pathFilter = incident.path ? ` path="${incident.path}"` : '';
    const query = `search index=${index} type=metric${pathFilter} earliest=-30m | stats max(cpu_percent) as maxCpu max(memory_percent) as maxMemory max(event_loop_lag) as maxLag avg(cpu_percent) as avgCpu avg(memory_percent) as avgMemory count as samples`;
    const result = await searchSplunk(query, config);

    if (result.source === 'splunk') {
      const row = (result.events || [])[0] || {};
      const summary = {
        samples:   Number(row.samples)   || 0,
        maxCpu:    Number(row.maxCpu)    || 0,
        maxMemory: Number(row.maxMemory) || 0,
        maxEventLoopLag: Number(row.maxLag) || 0,
        avgCpu:    Math.round(Number(row.avgCpu)    || 0),
        avgMemory: Math.round(Number(row.avgMemory) || 0),
        source:    'splunk',
      };
      return {
        ...summary,
        cpuSpike:          summary.maxCpu >= 80,
        memorySpike:       summary.maxMemory >= 80,
        eventLoopLagSpike: summary.maxEventLoopLag >= 250,
      };
    }
    // fall through to local if Splunk search returned local/empty
  }

  // ── Local SQLite fallback ────────────────────────────────────────────────
  const metrics = db.getRecentMetrics(60).filter(m => m.timestamp >= windowStart && m.timestamp <= windowEnd);

  const max = field => metrics.length ? Math.max(0, ...metrics.map(m => Number(m[field] || 0))) : 0;
  const avg = field => {
    if (!metrics.length) return 0;
    return Math.round(metrics.reduce((sum, m) => sum + Number(m[field] || 0), 0) / metrics.length);
  };

  const summary = {
    samples: metrics.length,
    maxCpu: max('cpu_percent'),
    maxMemory: max('memory_percent'),
    maxEventLoopLag: max('event_loop_lag'),
    avgCpu: avg('cpu_percent'),
    avgMemory: avg('memory_percent'),
    source: 'local',
  };

  return {
    ...summary,
    cpuSpike: summary.maxCpu >= 80,
    memorySpike: summary.maxMemory >= 80,
    eventLoopLagSpike: summary.maxEventLoopLag >= 250,
  };
}

module.exports = { correlateMetrics };
