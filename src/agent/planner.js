'use strict';

/**
 * Planner — generates investigation hypotheses from incident context,
 * ranks them, and produces the final RCA prompt for the LLM.
 */

/**
 * Generate candidate hypotheses from available evidence.
 *
 * @param {object} context  - full incident context (from IncidentCorrelator)
 * @param {object} similar  - similar incidents array (from findSimilarIncidents)
 * @returns {Array<{ hypothesis, confidence, evidence }>}
 */
function generateHypotheses(context, similar = []) {
  const incident = context.incident || {};
  const metrics  = context.metrics  || {};
  const logs     = context.logs     || {};
  const github   = context.github   || null;

  const hypotheses = [];

  // ── Hypothesis: memory pressure ─────────────────────────────────────────
  if (metrics.memorySpike) {
    hypotheses.push({
      hypothesis: `Memory pressure (peak ${metrics.maxMemory}%) caused GC pauses leading to increased latency and eventual errors.`,
      confidence: 0.78 + (metrics.maxMemory > 90 ? 0.10 : 0),
      evidence: [`Memory peaked at ${metrics.maxMemory}%`, `${metrics.samples} metric samples`],
      category: 'resource',
    });
  }

  // ── Hypothesis: CPU spike ────────────────────────────────────────────────
  if (metrics.cpuSpike) {
    hypotheses.push({
      hypothesis: `CPU saturation (peak ${metrics.maxCpu}%) starved the event loop, causing timeout cascades.`,
      confidence: 0.72,
      evidence: [`CPU peaked at ${metrics.maxCpu}%`],
      category: 'resource',
    });
  }

  // ── Hypothesis: event loop lag ───────────────────────────────────────────
  if (metrics.eventLoopLagSpike) {
    hypotheses.push({
      hypothesis: `Event loop lag (peak ${metrics.maxEventLoopLag}ms) indicates blocking I/O or a CPU-intensive synchronous operation.`,
      confidence: 0.80,
      evidence: [`Event loop lag reached ${metrics.maxEventLoopLag}ms`],
      category: 'code',
    });
  }

  // ── Hypothesis: error burst from dominant error ──────────────────────────
  const topError = logs.dominantErrors?.[0];
  if (topError && topError.count >= 3) {
    hypotheses.push({
      hypothesis: `Repeated error "${topError.message.slice(0, 100)}" (${topError.count}x) indicates a systemic code or dependency fault.`,
      confidence: 0.65 + Math.min(0.20, topError.count * 0.02),
      evidence: [`${topError.count} occurrences of dominant error`],
      category: 'code',
    });
  }

  // ── Hypothesis: recent deployment ────────────────────────────────────────
  if (github) {
    hypotheses.push({
      hypothesis: `Recent commit ${github.commitHash.slice(0, 7)} by ${github.author} ("${github.subject}") may have introduced a regression.`,
      confidence: github.confidence / 100,
      evidence: [`Commit ${github.commitHash.slice(0, 7)}`, `Changed files: ${(github.changedFiles || []).slice(0, 3).join(', ')}`],
      category: 'deployment',
    });
  }

  // ── Hypothesis: dependency / data store ─────────────────────────────────
  if (incident.root_cause === 'Data store' || incident.root_cause === 'Timeout') {
    hypotheses.push({
      hypothesis: `Downstream dependency (${incident.root_cause === 'Data store' ? 'database/cache' : 'external service'}) is unhealthy, causing upstream timeouts.`,
      confidence: 0.75,
      evidence: [`Root cause classified as: ${incident.root_cause}`],
      category: 'dependency',
    });
  }

  // ── Hypothesis: similar past incident pattern ────────────────────────────
  const topSimilar = similar.filter(s => s.similarity >= 60);
  if (topSimilar.length > 0) {
    const best = topSimilar[0];
    hypotheses.push({
      hypothesis: `This incident matches historical incident #${best.incidentId} (${best.similarity}% similarity). Prior resolution: ${best.resolution}.`,
      confidence: 0.60 + (best.similarity / 100) * 0.25,
      evidence: [`${topSimilar.length} similar past incidents`, `Best match: ${best.similarity}% similar`],
      category: 'recurrence',
    });
  }

  // ── Hypothesis: rate limit / traffic ────────────────────────────────────
  if (incident.root_cause === 'Rate limit') {
    hypotheses.push({
      hypothesis: `Traffic volume exceeded endpoint capacity, triggering rate limiting and client-visible errors.`,
      confidence: 0.82,
      evidence: ['Root cause classified as Rate limit', `${incident.count} incidents grouped`],
      category: 'traffic',
    });
  }

  // ── Fallback hypothesis ───────────────────────────────────────────────────
  if (hypotheses.length === 0) {
    hypotheses.push({
      hypothesis: `Transient ${incident.root_cause || 'application'} error affecting ${incident.path || 'the service'}.`,
      confidence: 0.40,
      evidence: ['Limited evidence available', 'Incident grouping metadata only'],
      category: 'unknown',
    });
  }

  // Sort descending by confidence
  return hypotheses.sort((a, b) => b.confidence - a.confidence);
}

/**
 * Build the system prompt for the LLM investigator.
 */
function buildSystemPrompt() {
  return `You are an expert Site Reliability Engineer performing root cause analysis.
You will receive an incident context including logs, metrics, git correlation, and similar incidents.
Respond ONLY with a valid JSON object (no markdown fences) with this exact shape:
{
  "rootCause": "concise one-sentence root cause",
  "confidence": <integer 0-100>,
  "evidence": ["evidence item 1", "evidence item 2"],
  "reasoning": "2-4 sentence explanation of how you reached the root cause",
  "impactedServices": ["service1", "service2"],
  "category": "resource|code|dependency|deployment|traffic|recurrence|unknown"
}`;
}

/**
 * Build the user prompt from the full incident context + hypotheses.
 */
function buildUserPrompt(context, hypotheses, similar) {
  const incident = context.incident || {};
  const metrics  = context.metrics  || {};
  const logs     = context.logs     || {};

  const parts = [
    `## Incident`,
    `Title: ${incident.title || 'Unknown'}`,
    `Path: ${incident.method || ''} ${incident.path || 'N/A'}`,
    `Status: ${incident.status_code || 'N/A'}`,
    `Severity: ${incident.severity || 'unknown'}`,
    `Event count: ${incident.count || 0}`,
    `Root cause classification: ${incident.root_cause || 'unclassified'}`,
    '',
    `## System Metrics`,
    `Max CPU: ${metrics.maxCpu || 0}%  (spike: ${metrics.cpuSpike ? 'YES' : 'no'})`,
    `Max Memory: ${metrics.maxMemory || 0}%  (spike: ${metrics.memorySpike ? 'YES' : 'no'})`,
    `Max Event Loop Lag: ${metrics.maxEventLoopLag || 0}ms  (spike: ${metrics.eventLoopLagSpike ? 'YES' : 'no'})`,
    '',
    `## Log Evidence`,
    `Total logs: ${logs.count || 0}`,
  ];

  if (logs.dominantErrors?.length) {
    parts.push('Top errors:');
    logs.dominantErrors.slice(0, 3).forEach(e => {
      parts.push(`  - "${e.message}" (${e.count}x)`);
    });
  }

  if (context.github) {
    const g = context.github;
    parts.push('', `## Recent Git Commit`, `${g.commitHash.slice(0, 7)} by ${g.author}: ${g.subject}`);
    if (g.changedFiles?.length) {
      parts.push(`Changed: ${g.changedFiles.slice(0, 5).join(', ')}`);
    }
  }

  if (similar.length > 0) {
    parts.push('', '## Similar Past Incidents');
    similar.slice(0, 3).forEach(s => {
      parts.push(`  - #${s.incidentId} (${s.similarity}% similar): ${s.title} → ${s.resolution}`);
    });
  }

  if (hypotheses.length > 0) {
    parts.push('', '## Generated Hypotheses (ranked by confidence)');
    hypotheses.slice(0, 3).forEach((h, i) => {
      parts.push(`${i + 1}. [${Math.round(h.confidence * 100)}%] ${h.hypothesis}`);
    });
  }

  parts.push('', 'Based on this evidence, produce a JSON root cause analysis.');
  return parts.join('\n');
}

module.exports = { generateHypotheses, buildSystemPrompt, buildUserPrompt };
