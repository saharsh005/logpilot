'use strict';

const { executeTool } = require('../mcp/tools');

const DEFAULT_TOOL_PLAN = [
  'search_logs',
  'find_deployments',
  'get_trace',
  'get_metric_history',
  'find_related_incidents',
  'get_heal_history',
];

async function runInvestigationAgent(incident, config = {}, options = {}) {
  const maxIterations = Number(options.maxIterations || 8);
  const transcript = [];
  const evidence = {};
  const plan = [...DEFAULT_TOOL_PLAN];

  for (let i = 0; i < Math.min(maxIterations, plan.length); i += 1) {
    const tool = plan[i];
    const params = buildParams(tool, incident, evidence);
    const result = await executeTool(tool, params, config).catch(err => ({
      tool,
      error: err.message,
      source: 'error',
    }));
    transcript.push({ thought: thoughtFor(tool, incident), tool, params, result });
    evidence[tool] = result;
  }

  const decision = decide(incident, evidence);
  return {
    incidentId: incident.incidentId || incident.id,
    rootCause: decision.rootCause,
    confidence: decision.confidence,
    evidence: decision.evidence,
    recovery: decision.recovery,
    source: 'mcp-agent',
    transcript,
    toolCalls: transcript.map(t => ({ tool: t.tool, params: t.params, source: t.result?.source, count: t.result?.count })),
  };
}

function buildParams(tool, incident, evidence) {
  const path = incident.path;
  const rootCause = incident.root_cause || incident.rootCause;
  if (tool === 'search_logs') return { query: path ? `path="${path}" (statusCode>=500 OR level=error OR error)` : '(statusCode>=500 OR level=error OR error)', earliest: '-30m', limit: 100 };
  if (tool === 'find_deployments') return { path, earliest: '-6h' };
  if (tool === 'get_trace') return { traceId: incident.traceId, path, earliest: '-30m' };
  if (tool === 'get_metric_history') return { metric: chooseMetric(rootCause), path, earliest: '-1h' };
  if (tool === 'find_related_incidents') return { path, rootCause, earliest: '-30d' };
  if (tool === 'get_heal_history') return { path, earliest: '-30d' };
  return {};
}

function chooseMetric(rootCause = '') {
  if (/memory/i.test(rootCause)) return 'memory';
  if (/cpu/i.test(rootCause)) return 'cpu';
  if (/timeout|latency/i.test(rootCause)) return 'responseTime';
  return 'eventLoopLag';
}

function thoughtFor(tool, incident) {
  const path = incident.path || incident.service || 'service';
  const thoughts = {
    search_logs: `Inspect failing logs for ${path}.`,
    find_deployments: `Check whether a release preceded the failure.`,
    get_trace: `Look for slow or broken spans around the failing request.`,
    get_metric_history: `Validate whether metrics moved before or during the incident.`,
    find_related_incidents: `Retrieve prior incidents with the same signature.`,
    get_heal_history: `Check what remediations worked previously.`,
  };
  return thoughts[tool] || `Run ${tool}.`;
}

function decide(incident, evidence) {
  const logs = evidence.search_logs?.events || [];
  const deployments = evidence.find_deployments?.deployments || [];
  const metricRows = evidence.get_metric_history?.series || [];
  const related = evidence.find_related_incidents?.incidents || [];
  const heals = evidence.get_heal_history?.heals || [];
  const text = [
    incident.root_cause,
    incident.sample_message,
    ...logs.slice(0, 10).map(row => row.message || row._raw || ''),
  ].join(' ').toLowerCase();

  const findings = [];
  if (logs.length) findings.push(`${logs.length} relevant Splunk log events were collected.`);
  if (deployments.length) findings.push(`${deployments.length} deployment event(s) are near the incident window.`);
  if (metricRows.length) findings.push(`${metricRows.length} metric buckets were reviewed.`);
  if (related.length) findings.push(`${related.length} related incident(s) were found.`);
  if (heals.length) findings.push(`${heals.length} historical heal action(s) were reviewed.`);

  if (/timeout|econn|connection|database|redis|postgres|mongo/.test(text)) {
    return result('Downstream data dependency latency or connection failure.', 88, findings, 'circuit-break');
  }
  if (/memory|heap|oom/.test(text)) {
    return result('Memory pressure or leak causing service instability.', 86, findings, 'restart-service');
  }
  if (deployments.length) {
    return result('Recent deployment introduced the failure pattern.', 82, findings, 'rollback-deployment');
  }
  if (/rate|429|too many/.test(text)) {
    return result('Traffic burst exceeded endpoint capacity.', 84, findings, 'rate-limit');
  }
  return result(incident.root_cause || 'Application error affecting the service.', 64, findings, 'notify-only');
}

function result(rootCause, confidence, evidence, recoveryAction) {
  return {
    rootCause,
    confidence,
    evidence: evidence.length ? evidence : ['MCP investigation completed with limited matching evidence.'],
    recovery: {
      action: recoveryAction,
      rationale: `Best first recovery based on root cause classification: ${rootCause}`,
    },
  };
}

module.exports = { runInvestigationAgent, DEFAULT_TOOL_PLAN };
