'use strict';

/**
 * Recovery Recommendation Engine (Phase 7)
 *
 * Generates ranked remediation actions based on:
 *   - incident root cause
 *   - metric evidence (memory/CPU spikes)
 *   - similar incident history (what worked before)
 *   - current heal rule coverage
 *
 * Output:
 *   [{ action, confidence, reasoning, priority }]
 */

const db = require('../storage/db');

const ACTIONS = {
  RESTART_SERVICE:    'restart-service',
  ROLLBACK_DEPLOY:    'rollback-deployment',
  SCALE_REPLICAS:     'scale-replicas',
  CIRCUIT_BREAK:      'circuit-break',
  RATE_LIMIT:         'rate-limit',
  FORCE_GC:           'gc',
  HEAP_SNAPSHOT:      'heap-snapshot',
  NOTIFY_ONLY:        'notify-only',
};

/**
 * Generate ranked recovery recommendations for an incident.
 *
 * @param {object} context   - from buildIncidentContext
 * @param {object} [similar] - from findSimilarIncidents
 * @param {object} [config]  - logpilot config
 * @returns {Array<{action, confidence, reasoning, priority}>}
 */
function generateRecommendations(context, similar = [], config = {}) {
  const incident = context.incident || {};
  const metrics  = context.metrics  || {};
  const github   = context.github   || null;

  const candidates = [];

  // ── Memory pressure → GC first, then snapshot, then restart ──────────────
  if (metrics.memorySpike) {
    candidates.push({
      action: ACTIONS.FORCE_GC,
      confidence: 0.82,
      reasoning: `Memory peaked at ${metrics.maxMemory}%. Force GC to recover heap before resorting to restart.`,
      priority: 1,
    });
    candidates.push({
      action: ACTIONS.HEAP_SNAPSHOT,
      confidence: 0.75,
      reasoning: `Capture heap snapshot to identify memory leak source before taking disruptive action.`,
      priority: 2,
    });
    if (metrics.maxMemory > 90) {
      candidates.push({
        action: ACTIONS.RESTART_SERVICE,
        confidence: 0.80,
        reasoning: `Memory at ${metrics.maxMemory}% — critical pressure. Service restart under process manager recommended.`,
        priority: 3,
      });
    }
  }

  // ── Recent deployment → rollback ─────────────────────────────────────────
  if (github && github.confidence >= 70) {
    candidates.push({
      action: ACTIONS.ROLLBACK_DEPLOY,
      confidence: github.confidence / 100,
      reasoning: `Commit ${github.commitHash.slice(0, 7)} by ${github.author} is ${github.confidence}% correlated. Rollback is low-risk first response.`,
      priority: 1,
    });
  }

  // ── High error rate → circuit break ─────────────────────────────────────
  if (incident.root_cause === 'Rate limit' || (incident.count >= 10 && incident.status_code >= 500)) {
    candidates.push({
      action: ACTIONS.CIRCUIT_BREAK,
      confidence: 0.78,
      reasoning: `${incident.count} grouped errors on ${incident.path || 'endpoint'}. Circuit breaker protects downstream dependencies.`,
      priority: 2,
    });
  }

  // ── Traffic burst → rate limit ────────────────────────────────────────────
  if (incident.root_cause === 'Rate limit') {
    candidates.push({
      action: ACTIONS.RATE_LIMIT,
      confidence: 0.85,
      reasoning: `Root cause classified as rate limiting. Apply request throttle to ${incident.path || 'endpoint'}.`,
      priority: 1,
    });
  }

  // ── Scaling hint on CPU spike ─────────────────────────────────────────────
  if (metrics.cpuSpike && metrics.maxCpu > 85) {
    candidates.push({
      action: ACTIONS.SCALE_REPLICAS,
      confidence: 0.65,
      reasoning: `CPU at ${metrics.maxCpu}%. Horizontal scaling could distribute load if deployment supports it.`,
      priority: 3,
    });
  }

  // ── Similar incidents resolved by specific action ─────────────────────────
  if (similar.length > 0) {
    const actionCounts = {};
    similar.filter(s => s.similarity >= 50).forEach(s => {
      const actions = (s.resolution || '').split(',').map(a => a.trim()).filter(Boolean);
      actions.forEach(a => {
        actionCounts[a] = (actionCounts[a] || 0) + 1;
      });
    });

    const topHistoricalAction = Object.entries(actionCounts)
      .sort((a, b) => b[1] - a[1])[0];

    if (topHistoricalAction) {
      const [action, count] = topHistoricalAction;
      // Only add if it's a known action and not already in candidates
      const isKnown = Object.values(ACTIONS).includes(action);
      const alreadyIn = candidates.some(c => c.action === action);
      if (isKnown && !alreadyIn) {
        candidates.push({
          action,
          confidence: 0.60 + Math.min(0.25, count * 0.05),
          reasoning: `"${action}" resolved similar incidents ${count} time(s) in history.`,
          priority: 2,
          historicalBasis: true,
        });
      }
    }
  }

  // ── Data store / timeout → notify + investigate ───────────────────────────
  if (incident.root_cause === 'Data store' || incident.root_cause === 'Timeout') {
    candidates.push({
      action: ACTIONS.CIRCUIT_BREAK,
      confidence: 0.72,
      reasoning: `${incident.root_cause} detected. Circuit breaker on ${incident.path || 'endpoint'} prevents cascading failures while root cause is investigated.`,
      priority: 2,
    });
  }

  // ── Always include a notify-only as a safe fallback ──────────────────────
  if (candidates.length === 0 || !candidates.some(c => c.action === ACTIONS.NOTIFY_ONLY)) {
    candidates.push({
      action: ACTIONS.NOTIFY_ONLY,
      confidence: 0.55,
      reasoning: `Insufficient evidence for automated action. Alert on-call team and await further signals.`,
      priority: 4,
    });
  }

  // Deduplicate (keep highest confidence per action), sort by confidence desc
  const seen = new Set();
  return candidates
    .sort((a, b) => b.confidence - a.confidence)
    .filter(c => {
      if (seen.has(c.action)) return false;
      seen.add(c.action);
      return true;
    })
    .map(c => ({ ...c, confidence: Math.round(c.confidence * 100) / 100 }));
}

module.exports = { generateRecommendations, ACTIONS };
