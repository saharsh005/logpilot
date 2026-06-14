'use strict';

const { executeTool } = require('../mcp/tools');

async function scoreRecoveryConfidence(currentIncident, recoveryAction, config = {}) {
  const history = await executeTool('find_related_incidents', {
    path: currentIncident.path,
    rootCause: currentIncident.root_cause || currentIncident.rootCause,
    earliest: '-30d',
  }, config).catch(() => ({ incidents: [] }));

  const heals = await executeTool('get_heal_history', {
    path: currentIncident.path,
    earliest: '-30d',
  }, config).catch(() => ({ heals: [] }));

  const matchingHeals = (heals.heals || []).filter(row => {
    const action = row.action || row.rule_name || row.ruleName || '';
    return String(action).toLowerCase().includes(String(recoveryAction).toLowerCase());
  });

  const recovered = matchingHeals.filter(row => row.success === true || row.success === 1 || row.success === '1' || row.success === 'true').length;
  const total = matchingHeals.length || Math.max(0, Number(history.count || 0));
  const successRate = total ? Math.round((recovered / total) * 100) : heuristicSuccessRate(currentIncident, recoveryAction);
  const mttrMinutes = estimateMttrMinutes(matchingHeals, currentIncident);

  return {
    action: recoveryAction,
    successRate,
    recovered,
    total,
    meanRecoveryTimeMinutes: mttrMinutes,
    confidence: Math.min(98, Math.max(35, successRate + Math.min(10, recovered))),
    evidence: {
      source: heals.source || history.source || 'local',
      relatedIncidents: history.incidents || [],
      matchingHeals,
    },
  };
}

function heuristicSuccessRate(incident, action) {
  const cause = String(incident.root_cause || incident.rootCause || '').toLowerCase();
  if (/memory/.test(cause) && /restart|gc/.test(action)) return 82;
  if (/timeout|data/.test(cause) && /circuit/.test(action)) return 74;
  if (/rate/.test(cause) && /rate-limit/.test(action)) return 86;
  if (/deploy|code/.test(cause) && /rollback/.test(action)) return 79;
  return 58;
}

function estimateMttrMinutes(heals, incident) {
  const durations = heals
    .map(row => Number(row.mttrMinutes || row.mttr || row.durationMinutes))
    .filter(Boolean);
  if (durations.length) return Math.round((durations.reduce((a, b) => a + b, 0) / durations.length) * 10) / 10;
  const first = Number(incident.first_seen || incident.firstSeen || Date.now());
  const last = Number(incident.last_seen || incident.lastSeen || Date.now());
  return Math.max(1, Math.round(((last - first) / 60000 || 4) * 10) / 10);
}

module.exports = { scoreRecoveryConfidence };
