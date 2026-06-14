'use strict';

function buildTimeline(inputs = {}) {
  const items = [];
  addMany(items, inputs.logs, 'log', logLabel);
  addMany(items, inputs.metrics, 'metric', metricLabel);
  addMany(items, inputs.deployments, 'deployment', deployLabel);
  addMany(items, inputs.incidents, 'incident', incidentLabel);
  addMany(items, inputs.healActions || inputs.heals, 'recovery', healLabel);
  addMany(items, inputs.traces, 'trace', traceLabel);

  return items
    .filter(item => item.timestamp)
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((item, index) => ({ ...item, order: index + 1, time: new Date(item.timestamp).toISOString() }));
}

function addMany(items, value, type, labeler) {
  const rows = Array.isArray(value) ? value : (value?.events || value?.recent || value?.raw || value?.series || []);
  rows.forEach(row => {
    const timestamp = normalizeTime(row.timestamp || row._time || row.time || row.first_seen || row.last_seen);
    if (!timestamp) return;
    items.push({
      id: `${type}:${timestamp}:${items.length}`,
      type,
      timestamp,
      label: labeler(row),
      severity: row.severity || inferSeverity(type, row),
      data: row,
    });
  });
}

function normalizeTime(value) {
  if (!value) return null;
  if (typeof value === 'number') return value < 10000000000 ? value * 1000 : value;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function logLabel(row) {
  if (Number(row.statusCode || row.status_code || 0) >= 500) return `${row.statusCode || row.status_code} error on ${row.path || row.service || 'service'}`;
  return row.message || row._raw || `Log event on ${row.path || row.service || 'service'}`;
}

function metricLabel(row) {
  const metric = row.metric || row.name || 'Metric';
  const value = row.value || row.memory || row.cpu || row.errors || row.latency;
  return value == null ? `${metric} changed` : `${metric} reached ${value}`;
}

function deployLabel(row) {
  return `Deployment ${row.commitHash ? String(row.commitHash).slice(0, 7) : 'event'}${row.author ? ` by ${row.author}` : ''}`;
}

function incidentLabel(row) {
  return row.title || `${row.rootCause || row.root_cause || 'Incident'} on ${row.path || row.service || 'service'}`;
}

function healLabel(row) {
  return `Recovery ${row.action || row.rule_name || row.ruleName || 'action'} ${row.success === false || row.success === 0 ? 'failed' : 'succeeded'}`;
}

function traceLabel(row) {
  return `Trace ${row.traceId || row.endpoint || row.path || 'span'} ${row.durationMs || row.responseTime || ''}`.trim();
}

function inferSeverity(type, row) {
  if (type === 'incident') return row.severity || 'critical';
  if (type === 'recovery') return row.success === false || row.success === 0 ? 'critical' : 'info';
  if (Number(row.statusCode || row.status_code || 0) >= 500) return 'critical';
  return 'info';
}

module.exports = { buildTimeline };
