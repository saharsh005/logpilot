async function analyzeRootCause(context, config = {}) {
  if (typeof config.rootCauseAnalyzer === 'function') {
    return config.rootCauseAnalyzer(context);
  }

  const incident = context.incident || {};
  const evidence = [];

  // Evidence from Splunk bundle (if available)
  if (context.evidence?.source === 'splunk') {
    if (context.evidence?.logs?.count > 0) {
      evidence.push(`Splunk: ${context.evidence.logs.count} related logs found`);
      const dominantSplunk = context.evidence.logs.dominantErrors?.[0];
      if (dominantSplunk) {
        evidence.push(`  Top error: "${dominantSplunk.message}" (${dominantSplunk.count}x)`);
      }
    }
    if (context.evidence?.relatedIncidents?.similar?.length) {
      evidence.push(`Splunk: ${context.evidence.relatedIncidents.similar.length} similar incidents on record`);
    }
  }

  // Local evidence
  const dominant = context.logs?.dominantErrors?.[0];
  if (dominant) evidence.push(`${dominant.count} matching log events: ${dominant.message}`);
  if (context.metrics?.memorySpike) evidence.push(`Memory peaked at ${context.metrics.maxMemory}%`);
  if (context.metrics?.cpuSpike) evidence.push(`CPU peaked at ${context.metrics.maxCpu}%`);
  if (context.metrics?.eventLoopLagSpike) evidence.push(`Event loop lag reached ${context.metrics.maxEventLoopLag}ms`);
  if (context.github) evidence.push(`Recent commit ${context.github.commitHash.slice(0, 7)} by ${context.github.author}`);
  if (!evidence.length) evidence.push('Incident grouping and recent local logs are the primary evidence.');

  const rootCause = buildRootCause(incident, context);
  let confidence = Math.min(95, 55 + evidence.length * 8 + (context.github?.confidence ? 10 : 0));

  // Boost confidence if Splunk evidence is available
  if (context.evidence?.source === 'splunk') {
    confidence = Math.min(95, confidence + 10);
  }

  return {
    rootCause,
    confidence,
    evidence,
    recommendation: recommend(incident, context),
  };
}

function buildRootCause(incident, context) {
  if (incident.root_cause === 'Data store') return 'Database or cache dependency is failing or timing out.';
  if (incident.root_cause === 'Timeout') return 'Downstream latency is causing request timeouts.';
  if (incident.root_cause === 'Memory' || context.metrics?.memorySpike) return 'Memory pressure is contributing to instability.';
  if (incident.root_cause === 'Rate limit') return 'Traffic volume is exceeding the endpoint capacity.';
  if (context.github) return `A recent code change may be related to ${incident.path || incident.service || 'this incident'}.`;
  return `${incident.root_cause || 'Application error'} affecting ${incident.path || incident.service || 'the application'}.`;
}

function recommend(incident, context) {
  if (context.metrics?.memorySpike) return 'Capture a heap snapshot, run GC if available, and restart under a process manager if pressure persists.';
  if (incident.status_code >= 500 && /payment|checkout|auth/i.test(incident.path || '')) return 'Enable a short circuit breaker and inspect downstream dependency health.';
  if (incident.root_cause === 'Rate limit') return 'Apply a temporary rate limit and review client retry behavior.';
  if (context.github) return 'Review the correlated commit and roll back or patch if the changed files match the failing path.';
  return 'Keep the incident grouped, inspect the dominant logs, and apply a scoped remediation rule if events continue.';
}

module.exports = { analyzeRootCause };
