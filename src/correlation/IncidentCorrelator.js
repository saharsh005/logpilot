const db = require('../storage/db');
const { correlateLogs } = require('./LogCorrelator');
const { correlateMetrics } = require('./MetricCorrelator');
const { correlateGithub } = require('./GithubCorrelator');
const { collectEvidence } = require('../investigator/evidence/collector');
const { getIncidentById } = require('../integrations/splunk/datastore');

async function buildIncidentContext(incidentId, config = {}) {
  // Try local SQLite first (numeric ids), then fall back to the Splunk-first
  // datastore so Splunk-sourced incidents (e.g. "splunk-3") work end-to-end.
  let incident = db.getIncidentGroup(Number(incidentId));
  if (!incident) incident = await getIncidentById(incidentId, config);
  if (!incident) return null;

  const [logs, metrics, github, evidence] = await Promise.all([
    correlateLogs(incident, config),
    Promise.resolve(correlateMetrics(incident, config)),
    Promise.resolve(correlateGithub(incident, config)),
    collectEvidence(incident, config),
  ]);

  return {
    incidentId: String(incident.id),
    incident,
    evidence,
    logs,
    metrics,
    github,
  };
}

module.exports = { buildIncidentContext };
