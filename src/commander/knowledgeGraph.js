'use strict';

const NODE_TYPES = ['Incident', 'Service', 'Deployment', 'Metric', 'Trace', 'Error', 'Recovery', 'Postmortem'];
const EDGE_TYPES = ['caused_by', 'related_to', 'fixed_by', 'introduced_by', 'similar_to'];

function buildKnowledgeGraph({ incident, evidence = {}, timeline = [], recovery = {}, postmortem = null, similar = [] } = {}) {
  const graph = { nodes: [], edges: [], schema: { nodeTypes: NODE_TYPES, edgeTypes: EDGE_TYPES } };
  const incidentNode = addNode(graph, 'Incident', incident?.incidentId || incident?.id || 'incident', incident?.title || 'Incident', incident);

  if (incident?.service || incident?.path) {
    const serviceNode = addNode(graph, 'Service', incident.service || incident.path, incident.service || incident.path, {
      service: incident.service,
      path: incident.path,
    });
    addEdge(graph, incidentNode.id, serviceNode.id, 'related_to', { reason: 'incident affected service or endpoint' });
  }

  (evidence.deployments?.recent || evidence.deployments || []).forEach(deploy => {
    const node = addNode(graph, 'Deployment', deploy.commitHash || deploy.id || deploy.subject, deploy.subject || deploy.commitHash || 'Deployment', deploy);
    addEdge(graph, node.id, incidentNode.id, 'introduced_by', { confidence: deploy.confidence || 0.5 });
  });

  (evidence.logs?.dominantErrors || evidence.logs?.events || []).slice(0, 8).forEach(error => {
    const node = addNode(graph, 'Error', error.message || error._raw || error.status || 'Error', short(error.message || error._raw || 'Error'), error);
    addEdge(graph, incidentNode.id, node.id, 'caused_by', { count: error.count || 1 });
  });

  Object.entries(evidence.metrics || {}).forEach(([name, value]) => {
    if (!/max|avg|spike|rate|latency|memory|cpu/i.test(name)) return;
    const node = addNode(graph, 'Metric', name, `${name}: ${value}`, { name, value });
    addEdge(graph, incidentNode.id, node.id, 'related_to', { signal: name });
  });

  (evidence.traces?.slowest || evidence.traces || []).slice(0, 5).forEach(trace => {
    const node = addNode(graph, 'Trace', trace.traceId || trace.endpoint || trace.path, trace.endpoint || trace.traceId || 'Trace', trace);
    addEdge(graph, incidentNode.id, node.id, 'related_to', { reason: 'trace evidence' });
  });

  (evidence.heals?.raw || evidence.heals?.recentActions || []).slice(0, 8).forEach(action => {
    const node = addNode(graph, 'Recovery', action.action || action.rule_name || action.ruleName, action.action || 'Recovery', action);
    addEdge(graph, incidentNode.id, node.id, 'fixed_by', { success: action.success });
  });

  similar.slice(0, 8).forEach(item => {
    const node = addNode(graph, 'Incident', item.incidentId || item.id, item.title || item.path || 'Similar incident', item);
    addEdge(graph, incidentNode.id, node.id, 'similar_to', { similarity: item.similarity || item.score || null });
  });

  if (postmortem) {
    const node = addNode(graph, 'Postmortem', `postmortem:${incidentNode.key}`, 'Executive postmortem', { length: String(postmortem).length });
    addEdge(graph, incidentNode.id, node.id, 'related_to', { reason: 'generated report' });
  }

  timeline.forEach((event, idx) => {
    if (idx === 0) return;
    addEdge(graph, timeline[idx - 1].id, event.id, 'related_to', { order: idx, temporal: true });
  });

  return graph;
}

function addNode(graph, type, key, label, data = {}) {
  const safeKey = String(key || `${type}:${graph.nodes.length}`);
  const id = `${type}:${safeKey}`;
  let node = graph.nodes.find(n => n.id === id);
  if (!node) {
    node = { id, type, key: safeKey, label: short(label || safeKey), data };
    graph.nodes.push(node);
  }
  return node;
}

function addEdge(graph, from, to, relation, data = {}) {
  if (!from || !to || from === to) return;
  const id = `${from}->${relation}->${to}`;
  if (!graph.edges.some(edge => edge.id === id)) graph.edges.push({ id, from, to, relation, data });
}

function short(value, max = 80) {
  const text = String(value || '');
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function dashboardVisualizationSpec() {
  return {
    layout: 'force-directed',
    primaryNode: 'Incident',
    interactions: ['hover evidence', 'click node detail', 'filter edge type', 'expand similar incidents'],
    encoding: {
      color: 'node.type',
      edgeColor: 'edge.relation',
      size: 'severity/count/confidence',
    },
  };
}

module.exports = { buildKnowledgeGraph, dashboardVisualizationSpec, NODE_TYPES, EDGE_TYPES };
