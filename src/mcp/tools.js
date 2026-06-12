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
    const spl = `search index=${index} type=incident ${filters} earliest=${earliest} | stats count by incidentId path rootCause`;
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
