'use strict';

/**
 * Similar Incident Search (Phase 4)
 *
 * Searches historical incidents for those matching:
 *   - same endpoint path
 *   - similar error message / title
 *   - similar root cause
 *   - similar metric pattern
 *   - similar recovery path (heal actions)
 *
 * Returns ranked results:
 *   [{ incidentId, similarity, resolution, outcome }]
 */

const db = require('../storage/db');
const { scoreIncidentSimilarity } = require('../correlation/similarity');

const SIMILARITY_THRESHOLD = 30; // minimum score to include in results
const MAX_RESULTS = 10;

/**
 * Find similar incidents to a given incident.
 *
 * @param {object} incident  - target incident (from db.getIncidentGroup)
 * @param {object} [opts]
 * @param {number} [opts.limit]     - max results (default 10)
 * @param {number} [opts.threshold] - min similarity score 0-100 (default 30)
 * @param {number} [opts.lookbackHours] - how far back to look (default 168 = 7 days)
 * @returns {Promise<Array>}
 */
async function findSimilarIncidents(incident, opts = {}) {
  const {
    limit = MAX_RESULTS,
    threshold = SIMILARITY_THRESHOLD,
    lookbackHours = 168,
  } = opts;

  if (!incident) return [];

  // Fetch candidate incidents from SQLite
  const candidates = db.getIncidentGroups({
    limit: 500,
    since: Date.now() - lookbackHours * 60 * 60 * 1000,
  });

  const scored = candidates
    .filter(c => c.id !== incident.id)   // exclude self
    .map(candidate => {
      const similarity = scoreIncidentSimilarity(incident, candidate);
      if (similarity < threshold) return null;

      const analysis = db.getIncidentAnalysis(candidate.id);
      const recovery = analysis?.recovery_json ? safeJson(analysis.recovery_json) : null;
      const healActions = db.getHealActions(100).filter(h => {
        // heals near this incident
        return Math.abs(h.timestamp - (candidate.first_seen || 0)) < 60 * 60 * 1000;
      });

      return {
        incidentId: candidate.id,
        title: candidate.title,
        path: candidate.path,
        rootCause: candidate.root_cause,
        severity: candidate.severity,
        similarity,
        resolution: buildResolutionSummary(candidate, healActions),
        outcome: buildOutcome(candidate, recovery),
        lastSeen: candidate.last_seen,
        eventCount: candidate.count,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);

  return scored;
}

function buildResolutionSummary(incident, healActions) {
  if (!healActions.length) {
    return incident.last_action || 'no action recorded';
  }
  const actions = [...new Set(healActions.map(h => h.action))];
  return actions.join(', ');
}

function buildOutcome(incident, recovery) {
  if (!recovery) return 'unknown';
  if (recovery.resolved === true) return `resolved (${recovery.confidence}% confidence)`;
  if (recovery.resolved === false) return `unresolved (error rate ${recovery.errorRate}%)`;
  return 'unknown';
}

function safeJson(str) {
  try { return JSON.parse(str); } catch (_) { return null; }
}

module.exports = { findSimilarIncidents };
