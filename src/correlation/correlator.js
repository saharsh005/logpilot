'use strict';

/**
 * Incident Correlation Engine
 *
 * Builds a full correlation graph for an incident by connecting:
 *   Incident ↔ Logs
 *   Incident ↔ Metrics
 *   Incident ↔ Deployment (git)
 *   Incident ↔ Heal Actions
 *   Incident ↔ Previous Incidents
 *   Incident ↔ Memory Spike
 *   Incident ↔ Error Burst
 *
 * Returns: { nodes, edges, confidence }
 */

const { CorrelationGraph } = require('./graph');
const db = require('../storage/db');

/**
 * Build a correlation graph for an incident context.
 * @param {object} context  - from buildIncidentContext()
 * @returns {{ nodes, edges, confidence }}
 */
async function buildCorrelationGraph(context, config = {}) {
  const g = new CorrelationGraph();
  const incident = context.incident || {};
  const incidentNodeId = `incident:${incident.id}`;

  // ── Root incident node ────────────────────────────────────────────────────
  g.addNode(incidentNodeId, 'incident', incident.title || `Incident #${incident.id}`, {
    id: incident.id,
    severity: incident.severity,
    rootCause: incident.root_cause,
    path: incident.path,
    count: incident.count,
  });

  // ── Log correlation ───────────────────────────────────────────────────────
  const logs = context.logs || {};
  if (logs.count > 0) {
    const logNodeId = `logs:${incident.id}`;
    g.addNode(logNodeId, 'logs', `${logs.count} related logs`, {
      count: logs.count,
      source: logs.source,
      dominantErrors: logs.dominantErrors?.slice(0, 3),
    });
    g.addEdge(incidentNodeId, logNodeId, 'CORRELATED_LOG', {
      label: `${logs.count} log events`,
    });
  }

  // ── Error burst ───────────────────────────────────────────────────────────
  const topError = context.logs?.dominantErrors?.[0];
  if (topError && topError.count >= 3) {
    const burstNodeId = `error_burst:${incident.id}`;
    g.addNode(burstNodeId, 'error_burst', `Error burst: "${topError.message.slice(0, 60)}"`, {
      message: topError.message,
      count: topError.count,
    });
    g.addEdge(incidentNodeId, burstNodeId, 'TRIGGERED', {
      label: `${topError.count} occurrences`,
    });
  }

  // ── Metric correlation ────────────────────────────────────────────────────
  const metrics = context.metrics || {};
  if (metrics.samples > 0) {
    const metricNodeId = `metrics:${incident.id}`;
    g.addNode(metricNodeId, 'metrics', `System metrics (${metrics.samples} samples)`, {
      maxCpu: metrics.maxCpu,
      maxMemory: metrics.maxMemory,
      maxEventLoopLag: metrics.maxEventLoopLag,
      cpuSpike: metrics.cpuSpike,
      memorySpike: metrics.memorySpike,
    });
    g.addEdge(incidentNodeId, metricNodeId, 'CORRELATED_METRIC', {
      label: `CPU ${metrics.maxCpu}% / Mem ${metrics.maxMemory}%`,
    });
  }

  // ── Memory spike ─────────────────────────────────────────────────────────
  if (metrics.memorySpike) {
    const memNodeId = `memory_spike:${incident.id}`;
    g.addNode(memNodeId, 'memory_spike', `Memory spike ${metrics.maxMemory}%`, {
      maxMemory: metrics.maxMemory,
      threshold: 80,
    });
    g.addEdge(incidentNodeId, memNodeId, 'CAUSED_BY', {
      label: `Memory exceeded ${metrics.maxMemory}%`,
    });
  }

  // ── Deployment / git correlation ─────────────────────────────────────────
  const github = context.github;
  if (github) {
    const deployNodeId = `deploy:${github.commitHash.slice(0, 7)}`;
    g.addNode(deployNodeId, 'deployment', `Commit ${github.commitHash.slice(0, 7)} by ${github.author}`, {
      commitHash: github.commitHash,
      author: github.author,
      subject: github.subject,
      changedFiles: github.changedFiles,
      confidence: github.confidence,
    });
    g.addEdge(deployNodeId, incidentNodeId, 'CORRELATED_DEPLOY', {
      label: `${github.confidence}% commit correlation`,
    });
  }

  // ── Heal actions (Splunk-first via evidence, SQLite fallback) ────────────
  const evidenceHeals = context.evidence?.heals;
  let healActions = [];
  if (evidenceHeals?.raw?.length) {
    healActions = evidenceHeals.raw;
  } else if (evidenceHeals?.source === 'local' || !evidenceHeals) {
    const incidentTime = incident.first_seen || Date.now();
    healActions = db.getHealActions(20).filter(a =>
      Math.abs(a.timestamp - incidentTime) < 30 * 60 * 1000
    );
  }

  healActions.slice(0, 10).forEach((heal, i) => {
    const healNodeId = `heal:${heal.id || heal.action || i}`;
    g.addNode(healNodeId, 'heal_action', `${heal.action} via ${heal.rule_name || heal.ruleName || 'rule'}`, {
      action: heal.action,
      rule: heal.rule_name || heal.ruleName,
      success: heal.success,
      timestamp: heal.timestamp,
    });
    g.addEdge(incidentNodeId, healNodeId, 'CORRELATED_HEAL', {
      label: heal.success ? 'healed' : 'attempted',
    });
  });

  // ── Previous / related incidents (Splunk-first via MCP tool) ─────────────
  let related = [];
  if (config.splunk?.enabled) {
    try {
      const { executeTool } = require('../mcp/tools');
      const result = await executeTool('find_related_incidents', {
        path: incident.path, rootCause: incident.root_cause, earliest: '-7d',
      }, config);
      related = (result.incidents || [])
        .filter(r => String(r.incidentId) !== String(incident.id) && String(r.incidentId) !== String(incident.incidentId))
        .map(r => ({
          id: r.incidentId, title: r.title || `${r.rootCause || 'Incident'} on ${r.path || 'service'}`,
          severity: r.severity, root_cause: r.rootCause, last_seen: r.lastSeen || r._time,
        }));
    } catch (_) {}
  }
  if (!related.length && db.getRelatedIncidents) {
    related = db.getRelatedIncidents(Number(incident.id) || 0) || [];
  }

  related.slice(0, 5).forEach(rel => {
    const relNodeId = `incident:${rel.id}`;
    g.addNode(relNodeId, 'related_incident', rel.title || `Incident #${rel.id}`, {
      id: rel.id,
      severity: rel.severity,
      rootCause: rel.root_cause,
      lastSeen: rel.last_seen,
    });
    g.addEdge(incidentNodeId, relNodeId, 'SIMILAR_INCIDENT', {
      label: `same root cause: ${rel.root_cause}`,
    });
  });

  // ── Splunk evidence overlay ───────────────────────────────────────────────
  const splunkEvidence = context.evidence;
  if (splunkEvidence?.source === 'splunk') {
    const splunkNodeId = `splunk:${incident.id}`;
    g.addNode(splunkNodeId, 'splunk', `Splunk evidence (${splunkEvidence.logs?.count || 0} logs)`, {
      logCount: splunkEvidence.logs?.count,
      relatedIncidents: splunkEvidence.relatedIncidents?.count,
      healCount: splunkEvidence.heals?.count,
    });
    g.addEdge(incidentNodeId, splunkNodeId, 'CORRELATED_LOG', {
      label: 'Splunk telemetry',
    });
  }

  return g.toJSON();
}

/**
 * Persist graph to SQLite incident_analysis.context_json for later retrieval.
 */
function saveCorrelationGraph(incidentId, graph) {
  try {
    const existing = db.getIncidentAnalysis(incidentId) || {};
    const contextJson = existing.context_json ? JSON.parse(existing.context_json) : {};
    contextJson.correlationGraph = graph;
    db.upsertIncidentAnalysis(incidentId, {
      context_json: JSON.stringify(contextJson),
    });
  } catch (_) {}
}

module.exports = { buildCorrelationGraph, saveCorrelationGraph };
