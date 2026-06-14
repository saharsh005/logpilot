'use strict';

function generateExecutivePostmortem(input = {}) {
  const incident = input.incident || {};
  const timeline = input.timeline || [];
  const rca = input.rca || {};
  const recovery = input.recovery || {};
  const recommendations = input.recommendations || [];
  const impact = estimateBusinessImpact(incident, input.evidence || {});

  return [
    `# Executive Postmortem: ${incident.title || incident.incidentId || incident.id || 'Incident'}`,
    '',
    '## Summary',
    `${incident.severity || 'Unknown'} incident affecting ${incident.service || incident.path || 'the application'}. ${recovery.resolved ? 'Service has recovered.' : 'Recovery is still being verified.'}`,
    '',
    '## Business Impact',
    `Estimated impact: ${impact.summary}. Requests affected: ${impact.requestsAffected}. Customer-facing risk: ${impact.customerRisk}.`,
    '',
    '## Timeline',
    ...formatTimeline(timeline),
    '',
    '## Root Cause',
    `${rca.rootCause || 'Root cause is not yet confirmed.'}`,
    `Confidence: ${rca.confidence || 0}%.`,
    '',
    '## Contributing Factors',
    ...list(rca.contributingFactors || inferContributingFactors(input)),
    '',
    '## Recovery Actions',
    ...list(input.recoveryActions || recommendations.map(r => `${r.action}: ${r.reasoning || `${Math.round((r.confidence || 0) * 100)}% confidence`}`)),
    '',
    '## Lessons Learned',
    ...list(input.lessonsLearned || inferLessons(input)),
    '',
    '## Preventive Measures',
    ...list(input.preventiveMeasures || inferPrevention(input)),
    '',
    '## Follow-up Tasks',
    ...list(input.followUpTasks || inferFollowups(input)),
    '',
    '## Evidence',
    ...list((rca.evidence || []).slice(0, 12)),
    '',
  ].join('\n');
}

function estimateBusinessImpact(incident, evidence) {
  const count = Number(incident.count || evidence.logs?.count || 0);
  const severity = String(incident.severity || '').toLowerCase();
  return {
    requestsAffected: count,
    customerRisk: severity === 'critical' || Number(incident.status_code || 0) >= 500 ? 'High' : 'Moderate',
    summary: count ? `${count} correlated events in the incident window` : 'impact depends on affected endpoint traffic',
  };
}

function formatTimeline(timeline) {
  if (!timeline.length) return ['- Timeline unavailable.'];
  return timeline.map(item => `- ${new Date(item.timestamp).toLocaleTimeString()} ${item.label}`);
}

function list(items) {
  return items?.length ? items.map(item => `- ${item}`) : ['- None recorded.'];
}

function inferContributingFactors({ evidence = {} }) {
  const out = [];
  if (evidence.metrics?.memorySpike) out.push('Memory pressure exceeded normal operating range.');
  if (evidence.metrics?.cpuSpike) out.push('CPU saturation likely reduced request handling capacity.');
  if (evidence.deployments?.count) out.push('Recent deployment was close enough to the incident window to require review.');
  if (!out.length) out.push('Insufficient telemetry depth to isolate secondary factors.');
  return out;
}

function inferLessons({ evidence = {} }) {
  const out = ['Splunk-indexed evidence should remain the audit trail for incident decisions.'];
  if (!evidence.traces?.count) out.push('Trace coverage should be expanded for faster causality checks.');
  return out;
}

function inferPrevention({ incident = {}, rca = {} }) {
  const text = `${incident.root_cause || ''} ${rca.rootCause || ''}`.toLowerCase();
  if (/memory/.test(text)) return ['Add memory forecast alerting through Splunk MLTK.', 'Capture heap snapshots before restart actions.'];
  if (/timeout|data|database/.test(text)) return ['Add dependency latency SLO alerts.', 'Tune circuit breaker thresholds from Splunk baselines.'];
  if (/deploy|code/.test(text)) return ['Gate deployments with canary error-budget checks.', 'Index deployment metadata into Splunk for every release.'];
  return ['Create a Splunk anomaly detector for this incident signature.', 'Add regression coverage for the failing path.'];
}

function inferFollowups(input) {
  return [
    'Owner: service team. Validate permanent fix in Splunk over the next 24 hours.',
    'Owner: platform team. Add this incident signature to the knowledge graph.',
  ];
}

module.exports = { generateExecutivePostmortem };
