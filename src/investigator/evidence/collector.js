const db = require('../../storage/db');
const { searchSplunk } = require('../../integrations/splunk/splunkSearch');

async function collectEvidence(incident, config = {}) {
  const cacheKey = `evidence_${incident.id}`;

  // Check cache
  const cached = db.getEvidenceSnapshot(incident.id);
  if (cached && !isCacheStale(cached)) {
    return JSON.parse(cached.evidence_json);
  }

  // Try Splunk first
  if (config.splunk?.enabled) {
    try {
      const evidence = await collectFromSplunk(incident, config);
      if (evidence) {
        db.saveEvidenceSnapshot(incident.id, evidence);
        return evidence;
      }
    } catch (err) {
      // Fallthrough to local
    }
  }

  // Fallback to local SQLite
  const evidence = await collectFromLocal(incident, config);
  db.saveEvidenceSnapshot(incident.id, evidence);
  return evidence;
}

async function collectFromSplunk(incident, config) {
  const queries = {
    logs: `search index=${config.splunk.index} path="${incident.path}" earliest=-15m | stats count by message | top 5`,
    relatedIncidents: `search index=${config.splunk.index} rootCause="${incident.root_cause}" earliest=-24h | stats count by incidentId`,
    heals: `search index=${config.splunk.index} type=heal path="${incident.path}" earliest=-24h | stats count by action`,
  };

  const [logsResult, incidentsResult, healsResult] = await Promise.all([
    searchSplunk(queries.logs, config),
    searchSplunk(queries.relatedIncidents, config),
    searchSplunk(queries.heals, config),
  ]);

  const dominantErrors = (logsResult?.events || [])
    .map(e => ({ message: e.message || e._raw, count: parseInt(e.count) || 1 }))
    .filter(e => e.message)
    .slice(0, 5);

  const relatedIncidents = (incidentsResult?.events || [])
    .map(e => ({ incidentId: e.incidentId, count: parseInt(e.count) || 1 }))
    .slice(0, 5);

  const healActions = (healsResult?.events || [])
    .reduce((acc, e) => {
      const action = e.action || 'unknown';
      acc[action] = (acc[action] || 0) + 1;
      return acc;
    }, {});

  return {
    source: 'splunk',
    timestamp: Date.now(),
    incident,
    logs: {
      count: logsResult?.count || 0,
      dominantErrors,
      events: logsResult?.events || [],
    },
    heals: {
      count: healsResult?.count || 0,
      recentActions: Object.entries(healActions).map(([action, count]) => ({ action, count })),
    },
    relatedIncidents: {
      count: relatedIncidents.length,
      similar: relatedIncidents,
    },
    deployments: {
      count: 0,
      recent: [],
    },
  };
}

async function collectFromLocal(incident, config) {
  const logs = db.queryLogs({
    path: incident.path,
    since: Date.now() - 15 * 60 * 1000,
    limit: 50,
  });

  const dominantErrors = {};
  logs.forEach(log => {
    const normalized = normalizeMessage(log.message);
    dominantErrors[normalized] = (dominantErrors[normalized] || 0) + 1;
  });

  const sorted = Object.entries(dominantErrors)
    .map(([message, count]) => ({ message, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  // Query local metrics
  const metrics = db.queryMetrics({
    since: Date.now() - 15 * 60 * 1000,
  });

  const maxCpu = Math.max(...metrics.map(m => m.cpu_percent || 0), 0);
  const maxMemory = Math.max(...metrics.map(m => m.memory_percent || 0), 0);
  const maxEventLoopLag = Math.max(...metrics.map(m => m.event_loop_lag || 0), 0);

  return {
    source: 'local',
    timestamp: Date.now(),
    incident,
    logs: {
      count: logs.length,
      dominantErrors: sorted,
      events: logs,
    },
    metrics: {
      samples: metrics.length,
      maxCpu,
      maxMemory,
      maxEventLoopLag,
      cpuSpike: maxCpu >= 80,
      memorySpike: maxMemory >= 80,
      eventLoopLagSpike: maxEventLoopLag >= 250,
    },
    heals: {
      count: 0,
      recentActions: [],
    },
    relatedIncidents: {
      count: 0,
      similar: [],
    },
    deployments: {
      count: 0,
      recent: [],
    },
  };
}

function normalizeMessage(message) {
  return message
    .replace(/\d+/g, '#')
    .replace(/[a-f0-9]{8}-?[a-f0-9]{4}-?[a-f0-9]{4}-?[a-f0-9]{4}-?[a-f0-9]{12}/gi, 'UUID')
    .toLowerCase()
    .trim();
}

function isCacheStale(snapshot) {
  const ttl = snapshot.ttl_seconds || 3600;
  return Date.now() - snapshot.created_at > ttl * 1000;
}

module.exports = { collectEvidence };
