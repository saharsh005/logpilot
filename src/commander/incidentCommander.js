'use strict';

const db = require('../storage/db');
const { getIncidentById, getIncidents, getIncidentEvents, mltkQueries } = require('../integrations/splunk/datastore');
const { collectEvidence } = require('../investigator/evidence/collector');
const { runInvestigationAgent } = require('./investigationAgent');
const { buildTimeline } = require('./timelineBuilder');
const { buildKnowledgeGraph } = require('./knowledgeGraph');
const { scoreRecoveryConfidence } = require('./recoveryConfidence');
const { generateRecommendations } = require('../recovery/recommendations');
const { verifyRecovery } = require('../recovery/RecoveryVerifier');
const { generateExecutivePostmortem } = require('./executivePostmortem');
const { executeTool } = require('../mcp/tools');
const { getService: getSplunkService } = require('../integrations/splunk/service');

async function listCommandableIncidents(config = {}, options = {}) {
  return getIncidents(config, options);
}

async function commandIncident(incidentId, config = {}, options = {}) {
  const incident = await getIncidentById(incidentId, config);
  if (!incident) return null;

  const command = {
    incident,
    startedAt: Date.now(),
    state: 'detected',
    steps: [],
  };

  await step(command, 'evidence_collection', async () => collectEvidence(incident, config));
  await step(command, 'mcp_investigation', async () => runInvestigationAgent(incident, config, options.agent));
  await step(command, 'timeline_reconstruction', async () => {
    const events = await getIncidentEvents(incident, config, { earliest: options.earliest || '-2h' });
    const evidence = command.evidence_collection || {};
    return buildTimeline({
      logs: events.events,
      metrics: evidence.metrics?.series || evidence.metrics?.events || [],
      deployments: evidence.deployments?.recent || [],
      incidents: [incident],
      healActions: evidence.heals?.raw || [],
      traces: evidence.traces?.slowest || [],
    });
  });
  await step(command, 'correlation_analysis', async () => buildKnowledgeGraph({
    incident,
    evidence: command.evidence_collection,
    timeline: command.timeline_reconstruction,
  }));
  await step(command, 'similar_incident_retrieval', async () => executeTool('find_related_incidents', {
    path: incident.path,
    rootCause: incident.root_cause,
    earliest: '-30d',
  }, config));
  await step(command, 'root_cause_analysis', async () => ({
    rootCause: command.mcp_investigation.rootCause,
    confidence: command.mcp_investigation.confidence,
    evidence: command.mcp_investigation.evidence,
    source: command.mcp_investigation.source,
  }));
  await step(command, 'recovery_recommendation', async () => {
    const recommendations = generateRecommendations({
      incident,
      evidence: command.evidence_collection,
      metrics: command.evidence_collection?.metrics || {},
      logs: command.evidence_collection?.logs || {},
    }, command.similar_incident_retrieval?.incidents || [], config);
    const withConfidence = [];
    for (const rec of recommendations.slice(0, 5)) {
      const historical = await scoreRecoveryConfidence(incident, rec.action, config);
      withConfidence.push({ ...rec, historical });
    }
    return withConfidence;
  });
  await step(command, 'recovery_execution', async () => executeRecovery(incident, command.recovery_recommendation?.[0], config, options));
  await step(command, 'recovery_verification', async () => verifyRecovery(incident, config));
  await step(command, 'postmortem_generation', async () => generateExecutivePostmortem({
    incident,
    evidence: command.evidence_collection,
    timeline: command.timeline_reconstruction,
    rca: command.root_cause_analysis,
    recovery: command.recovery_verification,
    recommendations: command.recovery_recommendation,
    recoveryActions: [command.recovery_execution?.summary].filter(Boolean),
  }));
  await step(command, 'knowledge_base_update', async () => {
    const graph = buildKnowledgeGraph({
      incident,
      evidence: command.evidence_collection,
      timeline: command.timeline_reconstruction,
      recovery: command.recovery_verification,
      postmortem: command.postmortem_generation,
      similar: command.similar_incident_retrieval?.incidents || [],
    });
    db.upsertIncidentAnalysis(incident.id, {
      context: { incident, timeline: command.timeline_reconstruction, knowledgeGraph: graph },
      rca: command.root_cause_analysis,
      recovery: command.recovery_verification,
      postmortem: command.postmortem_generation,
    });
    emitCommanderEvent('knowledge_update', { incidentId: incident.id, nodes: graph.nodes.length, edges: graph.edges.length });
    return graph;
  });

  command.state = 'complete';
  command.completedAt = Date.now();
  emitCommanderEvent('incident_command_complete', {
    incidentId: incident.id,
    rootCause: command.root_cause_analysis?.rootCause,
    recoveryVerified: command.recovery_verification?.resolved,
  });
  return command;
}

async function step(command, name, fn) {
  const startedAt = Date.now();
  command.state = name;
  try {
    const output = await fn();
    command[name] = output;
    command.steps.push({ name, status: 'completed', startedAt, completedAt: Date.now() });
    emitCommanderEvent('incident_command_step', { incidentId: command.incident.id, step: name, status: 'completed' });
    return output;
  } catch (err) {
    command.steps.push({ name, status: 'failed', startedAt, completedAt: Date.now(), error: err.message });
    emitCommanderEvent('incident_command_step', { incidentId: command.incident.id, step: name, status: 'failed', error: err.message });
    throw err;
  }
}

async function executeRecovery(incident, recommendation, config = {}, options = {}) {
  if (!recommendation) return { executed: false, summary: 'No recovery recommendation was available.' };
  if (options.execute === false || config.commander?.executeRecovery === false) {
    return {
      executed: false,
      action: recommendation.action,
      summary: `Dry run: would execute ${recommendation.action}.`,
    };
  }
  if (typeof config.commander?.executeRecovery === 'function') {
    const result = await config.commander.executeRecovery({ incident, recommendation, config });
    return { executed: true, action: recommendation.action, summary: `${recommendation.action} executed by custom commander hook.`, result };
  }
  return {
    executed: false,
    action: recommendation.action,
    summary: `No executor configured for ${recommendation.action}; recommendation recorded for operator approval.`,
  };
}

function getPredictiveSearches(config = {}) {
  return mltkQueries(config);
}

function emitCommanderEvent(type, data) {
  setImmediate(() => {
    const splunk = getSplunkService();
    if (splunk?.isEnabled()) splunk.sendEvent(type, data).catch(() => {});
  });
}

module.exports = {
  commandIncident,
  listCommandableIncidents,
  getPredictiveSearches,
};
