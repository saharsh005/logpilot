'use strict';

/**
 * Splunk MCP Tool definitions (Phase 6)
 *
 * These tools can be called by the AI Investigator when MCP is enabled.
 * Each tool maps to a Splunk search query and returns structured results.
 */

const { searchSplunk } = require('../integrations/splunk/splunkSearch');
const db = require('../storage/db');

/**
 * Tool registry — maps tool name → handler function.
 * Each handler receives (params, config) and returns structured data.
 */
const TOOLS = {
  /**
   * search_logs: Full-text search across Splunk logs for a given query.
   */
  async search_logs({ query, index, earliest = '-15m', limit = 50 }, config) {
    const splunkIndex = index || config.splunk?.index || 'logpilot';
    const spl = `search index=${splunkIndex} ${query} earliest=${earliest} | head ${limit}`;
    const result = await searchSplunk(spl, config);
    return {
      tool: 'search_logs',
      source: result.source,
      count: result.count,
      events: (result.events || []).slice(0, limit),
    };
  },

  /**
   * find_deployments: Look for recent deployment events in Splunk.
   */
  async find_deployments({ path, earliest = '-1h' }, config) {
    const index = config.splunk?.index || 'logpilot';
    const pathFilter = path ? ` path="${path}"` : '';
    const spl = `search index=${index} type=deploy${pathFilter} earliest=${earliest}`;
    const result = await searchSplunk(spl, config);
    return {
      tool: 'find_deployments',
      source: result.source,
      count: result.count,
      deployments: result.events || [],
    };
  },

  /**
   * find_related_incidents: Search Splunk for incidents related to a path or root cause.
   */
  async find_related_incidents({ path, rootCause, earliest = '-24h' }, config) {
    const index = config.splunk?.index || 'logpilot';
    const filters = [
      path ? `path="${path}"` : '',
      rootCause ? `rootCause="${rootCause}"` : '',
    ].filter(Boolean).join(' ');
    const spl = `search index=${index} type=incident ${filters} earliest=${earliest} | stats latest(title) as title latest(severity) as severity latest(lastSeen) as lastSeen sum(count) as count by incidentId path rootCause | sort -lastSeen`;
    const result = await searchSplunk(spl, config);
    return {
      tool: 'find_related_incidents',
      source: result.source,
      count: result.count,
      incidents: result.events || [],
    };
  },

  /**
   * get_trace: Look for trace/span data for a specific request.
   */
  async get_trace({ traceId, path, earliest = '-15m' }, config) {
    const index = config.splunk?.index || 'logpilot';
    const filter = traceId ? `traceId="${traceId}"` : (path ? `path="${path}"` : '');
    const spl = `search index=${index} type=trace ${filter} earliest=${earliest} | sort _time`;
    const result = await searchSplunk(spl, config);
    return {
      tool: 'get_trace',
      source: result.source,
      traceId,
      spans: result.events || [],
    };
  },

  /**
   * get_metric_history: Retrieve metric time series from Splunk.
   */
  async get_metric_history({ metric = 'memory_percent', path, earliest = '-30m' }, config) {
    const index = config.splunk?.index || 'logpilot';
    const pathFilter = path ? ` path="${path}"` : '';
    const spl = `search index=${index} type=metric${pathFilter} earliest=${earliest} | timechart span=1m avg(${metric}) as value`;
    const result = await searchSplunk(spl, config);
    return {
      tool: 'get_metric_history',
      source: result.source,
      metric,
      series: result.events || [],
    };
  },

  /**
   * get_heal_history: Retrieve heal action history from Splunk or local SQLite.
   */
  async get_heal_history({ path, earliest = '-24h' }, config) {
    // Try Splunk first
    if (config.splunk?.enabled) {
      const index = config.splunk.index || 'logpilot';
      const pathFilter = path ? ` path="${path}"` : '';
      const spl = `search index=${index} type=heal${pathFilter} earliest=${earliest} | stats count by action rule_name`;
      const result = await searchSplunk(spl, config);
      if (result.source === 'splunk') {
        return { tool: 'get_heal_history', source: 'splunk', heals: result.events || [] };
      }
    }
    // Local fallback
    const heals = db.getHealActions(50);
    return { tool: 'get_heal_history', source: 'local', heals };
  },

  /**
   * simulate_recovery: Estimate the effect and risk of a recovery action before execution.
   */
  async simulate_recovery({ incidentId, path, action, rootCause }, config) {
    const incident = incidentId ? db.getIncidentGroup(Number(incidentId)) : { path, root_cause: rootCause };
    const { scoreRecoveryConfidence } = require('../commander/recoveryConfidence');
    const confidence = await scoreRecoveryConfidence(incident || { path, root_cause: rootCause }, action, config);
    const risk = /restart|rollback/i.test(action) ? 'medium' : /notify/i.test(action) ? 'low' : 'low-medium';
    return {
      tool: 'simulate_recovery',
      source: confidence.evidence?.source || 'local',
      action,
      risk,
      expectedOutcome: confidence.successRate >= 80 ? 'likely_recovery' : confidence.successRate >= 60 ? 'partial_recovery_possible' : 'operator_review_required',
      confidence,
    };
  },

  /**
   * estimate_blast_radius: Estimate affected services/endpoints/users from Splunk evidence.
   */
  async estimate_blast_radius({ path, service, earliest = '-1h' }, config) {
    const index = config.splunk?.index || 'logpilot';
    if (config.splunk?.enabled) {
      const filters = [path ? `path="${path}"` : '', service ? `service="${service}"` : ''].filter(Boolean).join(' ');
      const spl = `search index=${index} ${filters} earliest=${earliest} (statusCode>=500 OR level=error OR type=incident) | stats dc(path) as paths dc(service) as services count as events values(path) as affectedPaths values(service) as affectedServices`;
      const result = await searchSplunk(spl, config);
      const row = result.events?.[0] || {};
      return {
        tool: 'estimate_blast_radius',
        source: result.source,
        events: Number(row.events || 0),
        affectedPathCount: Number(row.paths || 0),
        affectedServiceCount: Number(row.services || 0),
        affectedPaths: splitValues(row.affectedPaths),
        affectedServices: splitValues(row.affectedServices),
      };
    }
    const logs = db.queryLogs({ path, since: Date.now() - 60 * 60 * 1000, limit: 500 });
    return {
      tool: 'estimate_blast_radius',
      source: 'local',
      events: logs.length,
      affectedPathCount: new Set(logs.map(l => l.path).filter(Boolean)).size,
      affectedServiceCount: new Set(logs.map(l => l.service).filter(Boolean)).size,
      affectedPaths: [...new Set(logs.map(l => l.path).filter(Boolean))],
      affectedServices: [...new Set(logs.map(l => l.service).filter(Boolean))],
    };
  },

  /**
   * predict_incident_growth: Project event growth from the recent error slope.
   */
  async predict_incident_growth({ path, earliest = '-30m' }, config) {
    const index = config.splunk?.index || 'logpilot';
    if (config.splunk?.enabled) {
      const pathFilter = path ? ` path="${path}"` : '';
      const spl = `search index=${index}${pathFilter} earliest=${earliest} (statusCode>=500 OR level=error) | timechart span=5m count as errors`;
      const result = await searchSplunk(spl, config);
      return growthResult(result.events || [], 'errors', result.source);
    }
    const logs = db.queryLogs({ path, since: Date.now() - 30 * 60 * 1000, limit: 500 });
    const buckets = {};
    logs.forEach(log => {
      const b = Math.floor(log.timestamp / 300000) * 300000;
      buckets[b] = (buckets[b] || 0) + ((log.level === 'error' || log.status_code >= 500) ? 1 : 0);
    });
    return growthResult(Object.entries(buckets).map(([time, errors]) => ({ _time: Number(time), errors })), 'errors', 'local');
  },

  /**
   * estimate_mttr: Estimate recovery time from similar incidents and heal history.
   */
  async estimate_mttr({ path, rootCause, earliest = '-30d' }, config) {
    const related = await TOOLS.find_related_incidents({ path, rootCause, earliest }, config);
    const heals = await TOOLS.get_heal_history({ path, earliest }, config);
    const durations = (heals.heals || []).map(h => Number(h.mttrMinutes || h.durationMinutes || 0)).filter(Boolean);
    const mttr = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : Math.max(4, Math.min(45, (related.incidents?.length || 1) * 4));
    return {
      tool: 'estimate_mttr',
      source: heals.source || related.source,
      meanMinutes: mttr,
      basis: {
        relatedIncidents: related.incidents?.length || related.count || 0,
        healSamples: heals.heals?.length || 0,
      },
    };
  },

  /**
   * explain_failure_pattern: Convert evidence into a judge-friendly causal narrative.
   */
  async explain_failure_pattern({ path, rootCause, earliest = '-1h' }, config) {
    const [logs, deployments, metrics, heals] = await Promise.all([
      TOOLS.search_logs({ query: path ? `path="${path}" (error OR statusCode>=500)` : '(error OR statusCode>=500)', earliest, limit: 25 }, config),
      TOOLS.find_deployments({ path, earliest: '-6h' }, config),
      TOOLS.get_metric_history({ metric: rootCause && /memory/i.test(rootCause) ? 'memory' : 'responseTime', path, earliest }, config),
      TOOLS.get_heal_history({ path, earliest: '-30d' }, config),
    ]);
    const pattern = [
      deployments.deployments?.length ? 'deployment-proximate' : null,
      logs.events?.length ? 'error-burst' : null,
      metrics.series?.length ? 'metric-shift' : null,
      heals.heals?.length ? 'known-recovery-history' : null,
    ].filter(Boolean);
    return {
      tool: 'explain_failure_pattern',
      source: logs.source || 'local',
      pattern,
      explanation: pattern.length
        ? `Failure pattern combines ${pattern.join(', ')} for ${path || 'the service'}.`
        : `Insufficient evidence to classify the failure pattern for ${path || 'the service'}.`,
      evidence: { logs: logs.count, deployments: deployments.count, metricBuckets: metrics.series?.length || 0, heals: heals.heals?.length || 0 },
    };
  },
};

/**
 * Get a list of available tool definitions (for prompting the LLM).
 */
function getToolDefinitions() {
  return [
    {
      name: 'search_logs',
      description: 'Search Splunk logs for a given keyword/SPL query.',
      params: { query: 'string', index: 'string?', earliest: 'string?', limit: 'number?' },
    },
    {
      name: 'find_deployments',
      description: 'Find recent deployment events near an incident.',
      params: { path: 'string?', earliest: 'string?' },
    },
    {
      name: 'find_related_incidents',
      description: 'Find Splunk incidents related to a path or root cause.',
      params: { path: 'string?', rootCause: 'string?', earliest: 'string?' },
    },
    {
      name: 'get_trace',
      description: 'Retrieve distributed trace spans for a request.',
      params: { traceId: 'string?', path: 'string?', earliest: 'string?' },
    },
    {
      name: 'get_metric_history',
      description: 'Get metric time series (cpu_percent, memory_percent, event_loop_lag).',
      params: { metric: 'string?', path: 'string?', earliest: 'string?' },
    },
    {
      name: 'get_heal_history',
      description: 'Retrieve past heal/remediation actions for an endpoint.',
      params: { path: 'string?', earliest: 'string?' },
    },
    {
      name: 'simulate_recovery',
      description: 'Simulate a proposed recovery action and estimate success, risk, and expected outcome.',
      params: { incidentId: 'string?', path: 'string?', action: 'string', rootCause: 'string?' },
    },
    {
      name: 'estimate_blast_radius',
      description: 'Estimate affected paths, services, and event volume for an incident.',
      params: { path: 'string?', service: 'string?', earliest: 'string?' },
    },
    {
      name: 'predict_incident_growth',
      description: 'Predict whether the current incident is accelerating based on recent error slope.',
      params: { path: 'string?', earliest: 'string?' },
    },
    {
      name: 'estimate_mttr',
      description: 'Estimate mean time to recovery from similar incidents and heal history.',
      params: { path: 'string?', rootCause: 'string?', earliest: 'string?' },
    },
    {
      name: 'explain_failure_pattern',
      description: 'Explain the observed failure pattern from logs, deployments, metrics, and heal history.',
      params: { path: 'string?', rootCause: 'string?', earliest: 'string?' },
    },
  ];
}

/**
 * Execute a named tool by name.
 */
async function executeTool(toolName, params, config) {
  const handler = TOOLS[toolName];
  if (!handler) throw new Error(`Unknown MCP tool: ${toolName}`);
  return handler(params, config);
}

module.exports = { TOOLS, getToolDefinitions, executeTool };

function splitValues(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return String(value).split(/\s+/).filter(Boolean);
}

function growthResult(rows, field, source) {
  const values = rows.map(row => Number(row[field] || 0));
  const first = values.slice(0, Math.ceil(values.length / 2)).reduce((a, b) => a + b, 0);
  const second = values.slice(Math.floor(values.length / 2)).reduce((a, b) => a + b, 0);
  const slope = second - first;
  return {
    tool: 'predict_incident_growth',
    source,
    currentWindowEvents: second,
    previousWindowEvents: first,
    slope,
    growth: slope > 10 ? 'accelerating' : slope > 0 ? 'growing' : 'stable_or_declining',
    projectedNext30m: Math.max(0, Math.round(second + slope * 2)),
    series: rows,
  };
}
