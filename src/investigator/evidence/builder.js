function buildEvidenceBundle(evidence, incident) {
  return {
    ...evidence,
    confidence: calculateConfidence(evidence),
    summary: generateSummary(evidence),
  };
}

function cacheEvidenceSnapshot(incidentId, bundle) {
  const db = require('../../storage/db');
  db.saveEvidenceSnapshot(incidentId, bundle);
}

function getEvidenceSummary(bundle) {
  const lines = [];

  if (bundle.source === 'splunk') {
    lines.push(`Evidence from Splunk (${bundle.logs?.count || 0} logs)`);
  } else {
    lines.push(`Evidence from local cache (${bundle.logs?.count || 0} logs)`);
  }

  if (bundle.logs?.dominantErrors?.length) {
    lines.push(`Top error: "${bundle.logs.dominantErrors[0].message}" (${bundle.logs.dominantErrors[0].count}x)`);
  }

  if (bundle.metrics?.memorySpike) {
    lines.push(`Memory spike: ${bundle.metrics.maxMemory}%`);
  }

  if (bundle.metrics?.cpuSpike) {
    lines.push(`CPU spike: ${bundle.metrics.maxCpu}%`);
  }

  if (bundle.relatedIncidents?.similar?.length) {
    lines.push(`${bundle.relatedIncidents.similar.length} related incidents found`);
  }

  if (bundle.heals?.recentActions?.length) {
    lines.push(`Recent heal actions: ${bundle.heals.recentActions.map(a => a.action).join(', ')}`);
  }

  return lines.join(' • ');
}

function calculateConfidence(evidence) {
  let score = 0.5; // base

  if (evidence.source === 'splunk') {
    score += 0.1; // Splunk is more reliable
  }

  if (evidence.logs?.count > 0) {
    score += Math.min(0.15, evidence.logs.count * 0.02);
  }

  if (evidence.metrics?.cpuSpike || evidence.metrics?.memorySpike) {
    score += 0.1;
  }

  if (evidence.relatedIncidents?.count > 0) {
    score += 0.05;
  }

  if (evidence.heals?.count > 0) {
    score += 0.05;
  }

  return Math.min(0.95, score);
}

function generateSummary(evidence) {
  const parts = [];

  if (evidence.logs?.dominantErrors?.length) {
    const top = evidence.logs.dominantErrors[0];
    parts.push(`Primary issue: ${top.message} (${top.count} occurrences)`);
  }

  if (evidence.metrics?.memorySpike) {
    parts.push(`Memory pressure detected (${evidence.metrics.maxMemory}% usage)`);
  }

  if (evidence.relatedIncidents?.count > 0) {
    parts.push(`${evidence.relatedIncidents.count} similar incidents on record`);
  }

  return parts.length > 0 ? parts.join('; ') : 'No significant evidence found';
}

module.exports = {
  buildEvidenceBundle,
  cacheEvidenceSnapshot,
  getEvidenceSummary,
  calculateConfidence,
};
