const db = require('../storage/db');
const { correlateLogs } = require('./LogCorrelator');
const { correlateMetrics } = require('./MetricCorrelator');
const { correlateGithub } = require('./GithubCorrelator');
const { collectEvidence } = require('../investigator/evidence/collector');

async function buildIncidentContext(incidentId, config = {}) {
  const incident = db.getIncidentGroup(Number(incidentId));
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
