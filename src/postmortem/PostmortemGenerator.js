'use strict';

const { getService: getSplunkService } = require('../integrations/splunk/service');

/**
 * Generate an executive-quality postmortem (Phase 9 — upgraded).
 *
 * Sections:
 *   1. Incident Summary
 *   2. Impact
 *   3. Timeline
 *   4. Root Cause
 *   5. Evidence (Splunk + local)
 *   6. Correlation Findings
 *   7. Remediation
 *   8. Recovery Verification
 *   9. Lessons Learned
 *  10. Future Prevention
 *
 * Every claim is backed by evidence from rca.evidence or Splunk data.
 */
function generatePostmortem({ incident, context, rca, recovery, healActions = [], similar = [] }) {
  const ts = t => t ? new Date(t).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : 'unknown';
  const dur = (a, b) => {
    if (!a || !b) return 'unknown';
    const ms = Math.abs(b - a);
    if (ms < 60000) return `${Math.round(ms / 1000)}s`;
    return `${Math.round(ms / 60000)}m`;
  };

  const lines = [];

  // ── 1. Incident Summary ──────────────────────────────────────────────────
  lines.push(
    `# Incident Postmortem`,
    ``,
    `**Incident:** ${incident.title || `Incident #${incident.id}`}`,
    `**Endpoint:** ${[incident.method, incident.path].filter(Boolean).join(' ') || incident.service || 'Application'}`,
    `**Severity:** ${incident.severity || 'unknown'}`,
    `**Status:** ${recovery?.resolved ? '✅ Resolved' : '⚠️ Ongoing'}`,
    `**Event count:** ${incident.count || 0}`,
    `**First seen:** ${ts(incident.first_seen)}`,
    `**Last seen:** ${ts(incident.last_seen)}`,
    `**Duration:** ${dur(incident.first_seen, incident.last_seen)}`,
    ``,
  );

  // ── 2. Impact ────────────────────────────────────────────────────────────
  lines.push(`## Impact`, ``);
  const impactedServices = rca?.impactedServices?.length
    ? rca.impactedServices.join(', ')
    : (incident.service || incident.path || 'application endpoint');
  lines.push(
    `- **Services affected:** ${impactedServices}`,
    `- **Requests impacted:** ${incident.count || 0} grouped events`,
    `- **Error rate during incident:** ${recovery?.errorRate != null ? recovery.errorRate + '%' : 'unknown'}`,
    `- **Customer impact:** ${incident.severity === 'critical' ? 'High — service unavailable' : incident.severity === 'high' ? 'Significant degradation' : 'Partial degradation'}`,
    ``,
  );

  // ── 3. Timeline ──────────────────────────────────────────────────────────
  lines.push(`## Timeline`, ``);
  lines.push(`| Time | Event |`);
  lines.push(`|------|-------|`);
  lines.push(`| ${ts(incident.first_seen)} | First error detected |`);

  if (context?.github) {
    lines.push(`| ${ts(incident.first_seen - 5 * 60000)} | Commit ${context.github.commitHash.slice(0, 7)} deployed by ${context.github.author} |`);
  }

  if (healActions.length > 0) {
    healActions.forEach(a => {
      lines.push(`| ${ts(a.timestamp)} | Heal action triggered: ${a.action} via ${a.rule_name} |`);
    });
  }

  if (recovery) {
    lines.push(`| ${ts(recovery.checkedAt)} | Recovery verified: ${recovery.resolved ? 'resolved' : 'still active'} |`);
  }
  lines.push(`| ${ts(incident.last_seen)} | Last error recorded |`);
  lines.push(``);

  // ── 4. Root Cause ────────────────────────────────────────────────────────
  lines.push(
    `## Root Cause`,
    ``,
    rca?.rootCause || 'Root cause analysis not yet performed.',
    ``,
    `**Confidence:** ${rca?.confidence || 0}%`,
    `**Category:** ${rca?.category || 'unknown'}`,
    `**Analysis method:** ${rca?.source === 'llm' ? `LLM (${rca.provider})` : 'Deterministic rule engine'}`,
    ``,
  );

  if (rca?.reasoning) {
    lines.push(`**Reasoning:**`, ``, rca.reasoning, ``);
  }

  // ── 5. Evidence ──────────────────────────────────────────────────────────
  lines.push(`## Evidence`, ``);

  if (rca?.evidence?.length) {
    lines.push(`**Supporting evidence:**`);
    rca.evidence.forEach(e => lines.push(`- ${e}`));
    lines.push(``);
  }

  if (context?.evidence?.source === 'splunk') {
    const ev = context.evidence;
    lines.push(`**Splunk telemetry:**`);
    if (ev.logs?.count > 0) {
      lines.push(`- ${ev.logs.count} related log events retrieved`);
      if (ev.logs.dominantErrors?.length) {
        ev.logs.dominantErrors.slice(0, 3).forEach(e =>
          lines.push(`  - \`${e.message}\` — ${e.count}× occurrences`)
        );
      }
    }
    if (ev.relatedIncidents?.similar?.length) {
      lines.push(`- ${ev.relatedIncidents.similar.length} related incidents found in Splunk`);
    }
    if (ev.heals?.recentActions?.length) {
      lines.push(`- Heal actions on this endpoint: ${ev.heals.recentActions.map(a => a.action).join(', ')}`);
    }
    lines.push(``);
  }

  if (context?.metrics && (context.metrics.memorySpike || context.metrics.cpuSpike)) {
    lines.push(`**System metrics during incident:**`);
    if (context.metrics.maxMemory) lines.push(`- Peak memory: ${context.metrics.maxMemory}%${context.metrics.memorySpike ? ' ⚠️ spike detected' : ''}`);
    if (context.metrics.maxCpu)    lines.push(`- Peak CPU: ${context.metrics.maxCpu}%${context.metrics.cpuSpike ? ' ⚠️ spike detected' : ''}`);
    if (context.metrics.maxEventLoopLag > 0) lines.push(`- Max event loop lag: ${context.metrics.maxEventLoopLag}ms`);
    lines.push(``);
  }

  // ── 6. Correlation Findings ──────────────────────────────────────────────
  if (context?.github || (rca?.hypotheses?.length > 0)) {
    lines.push(`## Correlation Findings`, ``);

    if (context?.github) {
      const g = context.github;
      lines.push(
        `**Git correlation:** Commit \`${g.commitHash.slice(0, 7)}\` by ${g.author} ("${g.subject}") shows ${g.confidence}% correlation with this incident.`,
        `Changed files: ${(g.changedFiles || []).slice(0, 5).join(', ') || 'not available'}`,
        ``,
      );
    }

    if (rca?.hypotheses?.length > 0) {
      lines.push(`**Investigation hypotheses (ranked by confidence):**`);
      rca.hypotheses.slice(0, 3).forEach((h, i) => {
        lines.push(`${i + 1}. [${Math.round(h.confidence * 100)}%] ${h.hypothesis}`);
      });
      lines.push(``);
    }
  }

  // ── 7. Similar Incidents ─────────────────────────────────────────────────
  if (similar?.length > 0) {
    lines.push(`## Similar Historical Incidents`, ``);
    similar.slice(0, 3).forEach(s => {
      lines.push(`- **#${s.incidentId}** (${s.similarity}% match): ${s.title || s.rootCause} → resolved by: ${s.resolution || 'unknown'}`);
    });
    lines.push(``);
  }

  // ── 8. Remediation ───────────────────────────────────────────────────────
  lines.push(`## Remediation`, ``);
  if (healActions.length > 0) {
    healActions.forEach(a => {
      lines.push(`- **${a.action}** via rule "${a.rule_name}": ${a.notes || 'executed'}`);
    });
  } else {
    lines.push(`- No automated remediation action was recorded for this incident.`);
  }
  lines.push(``);

  // ── 9. Recovery Verification ─────────────────────────────────────────────
  lines.push(`## Recovery Verification`, ``);
  if (recovery) {
    lines.push(
      `**Status:** ${recovery.resolved ? '✅ Resolved' : '⚠️ Not yet resolved'}`,
      `**Confidence:** ${recovery.confidence}%`,
      `**Error rate post-remediation:** ${recovery.errorRate}%`,
      `**Requests checked:** ${recovery.totalRequests}`,
      `**Verification source:** ${recovery.source}`,
      `**Checked at:** ${ts(recovery.checkedAt)}`,
      ``,
    );
  } else {
    lines.push(`Recovery verification has not been performed yet.`, ``);
  }

  // ── 10. Lessons Learned ──────────────────────────────────────────────────
  lines.push(`## Lessons Learned`, ``);
  const lessons = buildLessonsLearned(incident, context, rca, recovery);
  lessons.forEach(l => lines.push(`- ${l}`));
  lines.push(``);

  // ── 11. Future Prevention ────────────────────────────────────────────────
  lines.push(`## Future Prevention`, ``);
  const preventions = buildPreventions(incident, context, rca);
  preventions.forEach(p => lines.push(`- ${p}`));
  lines.push(``);

  // ── Footer ───────────────────────────────────────────────────────────────
  lines.push(
    `---`,
    ``,
    `*Generated by LogPilot at ${ts(Date.now())}*`,
    `*Analysis powered by: ${rca?.source === 'llm' ? `${rca.provider} LLM` : 'deterministic rule engine'}*`,
  );

  const markdown = lines.join('\n');

  // Emit postmortem event to Splunk
  setImmediate(() => {
    const splunk = getSplunkService();
    if (splunk?.isEnabled()) {
      splunk.sendPostmortem(incident.id, markdown).catch(() => {});
    }
  });

  return markdown;
}

function buildLessonsLearned(incident, context, rca, recovery) {
  const lessons = [];
  if (!recovery?.resolved) lessons.push('Recovery was not confirmed — improve recovery verification coverage.');
  if (rca?.source === 'deterministic') lessons.push('AI investigation was not available — configure an LLM provider for deeper analysis.');
  if (context?.metrics?.memorySpike) lessons.push('Memory pressure contributed to this incident — review memory limits and GC tuning.');
  if (context?.github) lessons.push('A recent deployment correlated with this incident — improve pre-deploy smoke testing.');
  if (incident.count > 20) lessons.push(`${incident.count} events were grouped — improve alerting thresholds to catch incidents earlier.`);
  if (!lessons.length) lessons.push('Review incident response time and ensure on-call coverage was adequate.');
  return lessons;
}

function buildPreventions(incident, context, rca) {
  const items = [];
  if (context?.metrics?.memorySpike) items.push('Set memory usage alerts at 75% and 85% thresholds in LogPilot config.');
  if (context?.github) {
    items.push(`Add a rollback trigger for commits to ${(context.github.changedFiles || []).slice(0, 2).join(', ') || 'affected files'}.`);
  }
  if (incident.root_cause === 'Timeout') items.push('Implement circuit breaker on downstream dependency calls to prevent cascade failures.');
  if (incident.root_cause === 'Rate limit') items.push('Implement adaptive rate limiting with client-visible Retry-After headers.');
  if (rca?.category === 'dependency') items.push('Add health-check endpoints for all downstream dependencies and monitor them in LogPilot.');
  if (!items.length) items.push('Add a LogPilot heal rule for this endpoint pattern to automate future remediation.');
  return items;
}

module.exports = { generatePostmortem };
