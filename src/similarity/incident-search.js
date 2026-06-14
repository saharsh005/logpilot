'use strict';

/**
 * Similar Incident Search (Phase 4) — Splunk-first
 *
 * Source of truth: Splunk historical incidents (via find_related_incidents MCP tool),
 * re-ranked with TF-IDF cosine similarity against the target incident's text.
 *
 * Falls back to local SQLite scoring only when Splunk is disabled or the
 * Splunk search returns source:'local' (i.e. unreachable).
 *
 * Returns ranked results:
 *   [{ incidentId, similarity, resolution, outcome, title, path, rootCause, severity, eventCount }]
 */

const db = require('../storage/db');
const { scoreIncidentSimilarity, tokenise } = require('../correlation/similarity');
const { rankByEmbedding } = require('./embeddings');

const SIMILARITY_THRESHOLD = 30; // minimum score to include in results
const MAX_RESULTS = 10;

/**
 * Find similar incidents to a given incident.
 *
 * @param {object} incident  - target incident (numeric id from SQLite, or { incidentId, id, ... } from Splunk)
 * @param {object} [opts]
 * @param {number} [opts.limit]     - max results (default 10)
 * @param {number} [opts.threshold] - min similarity score 0-100 (default 30)
 * @param {number} [opts.lookbackHours] - how far back to look (default 168 = 7 days)
 * @param {object} [opts.config]    - logpilot config (needed for Splunk path)
 * @returns {Promise<Array>}
 */
async function findSimilarIncidents(incident, opts = {}) {
  const {
    limit = MAX_RESULTS,
    threshold = SIMILARITY_THRESHOLD,
    lookbackHours = 168,
    config = {},
  } = opts;

  if (!incident) return [];

  if (config.splunk?.enabled) {
    try {
      const splunkResults = await findSimilarFromSplunk(incident, { limit, threshold, lookbackHours, config });
      if (splunkResults && splunkResults.length) return splunkResults;
      // If Splunk returned zero (genuinely no matches, or unreachable), try local as a supplement
      if (splunkResults && splunkResults.source === 'splunk-empty') return [];
    } catch (_) { /* fall through to local */ }
  }

  return findSimilarFromLocal(incident, { limit, threshold, lookbackHours });
}

// ── Splunk-first path ───────────────────────────────────────────────────────

async function findSimilarFromSplunk(incident, { limit, threshold, lookbackHours, config }) {
  const { executeTool } = require('../mcp/tools');

  const earliest = `-${Math.min(lookbackHours, 720)}h`;
  const result = await executeTool('find_related_incidents', {
    path: incident.path,
    rootCause: incident.root_cause || incident.rootCause,
    earliest,
  }, config);

  if (result.source !== 'splunk') return null; // signal: fall back to local

  const selfId = String(incident.incidentId ?? incident.id ?? '');
  const candidates = (result.incidents || [])
    .filter(r => String(r.incidentId) !== selfId)
    .map(r => ({
      incidentId: r.incidentId,
      title:      r.title || `${r.rootCause || 'Incident'} on ${r.path || 'service'}`,
      path:       r.path,
      rootCause:  r.rootCause,
      severity:   r.severity,
      eventCount: Number(r.count) || 1,
      lastSeen:   r.lastSeen || r._time,
    }));

  if (!candidates.length) return { source: 'splunk-empty', length: 0 };

  // ── Structural similarity scoring ──────────────────────────────────────
  const targetText = [incident.title, incident.sample_message, incident.root_cause, incident.path]
    .filter(Boolean).join(' ');

  const structScores = candidates.map(c => ({
    ...c,
    structScore: scoreIncidentSimilarity(
      { id: selfId, path: incident.path, root_cause: incident.root_cause || incident.rootCause,
        title: incident.title, status_code: incident.status_code },
      { id: c.incidentId, path: c.path, root_cause: c.rootCause, title: c.title, status_code: c.status_code }
    ),
  }));

  // ── TF-IDF cosine re-ranking on free text ────────────────────────────────
  const corpus = candidates.map(c => ({ id: c.incidentId, text: [c.title, c.rootCause, c.path].filter(Boolean).join(' ') }));
  const embedRanked = targetText.trim() ? rankByEmbedding(targetText, corpus) : [];
  const embedScoreMap = {};
  embedRanked.forEach(r => { embedScoreMap[r.id] = r.score; });

  // ── Blend: 60% structural, 40% TF-IDF cosine (both 0-100) ────────────────
  const scored = structScores
    .map(c => {
      const embedPct = Math.round((embedScoreMap[c.incidentId] || 0) * 100);
      const similarity = Math.round(c.structScore * 0.6 + embedPct * 0.4);
      if (similarity < threshold) return null;

      return {
        incidentId: c.incidentId,
        title:      c.title,
        path:       c.path,
        rootCause:  c.rootCause,
        severity:   c.severity,
        similarity,
        eventCount: c.eventCount,
        lastSeen:   c.lastSeen,
        resolution: 'see related incident',
        outcome:    'unknown',
        source:     'splunk',
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);

  // ── Enrich resolution/outcome from heal history (Splunk-first) ──────────
  for (const item of scored) {
    try {
      const heals = await executeTool('get_heal_history', { path: item.path, earliest: '-30d' }, config);
      if (heals.heals?.length) {
        item.resolution = [...new Set(heals.heals.map(h => h.action || h.rule_name))].slice(0, 3).join(', ');
      }
    } catch (_) {}
  }

  return scored;
}

// ── Local SQLite fallback ────────────────────────────────────────────────

async function findSimilarFromLocal(incident, { limit, threshold, lookbackHours }) {
  const candidates = db.getIncidentGroups({
    limit: 500,
    since: Date.now() - lookbackHours * 60 * 60 * 1000,
  });

  const selfId = Number(incident.id);

  const structScored = candidates
    .filter(c => c.id !== selfId)
    .map(candidate => {
      const structScore = scoreIncidentSimilarity(incident, candidate);
      return { candidate, structScore };
    })
    .filter(({ structScore }) => structScore >= threshold * 0.5); // pre-filter before TF-IDF

  // TF-IDF re-rank
  const targetText = [incident.title, incident.sample_message, incident.root_cause, incident.path]
    .filter(Boolean).join(' ');
  const corpus = structScored.map(({ candidate }) => ({
    id: candidate.id, text: [candidate.title, candidate.root_cause, candidate.path].filter(Boolean).join(' '),
  }));
  const embedRanked = targetText.trim() ? rankByEmbedding(targetText, corpus) : [];
  const embedScoreMap = {};
  embedRanked.forEach(r => { embedScoreMap[r.id] = r.score; });

  const scored = structScored
    .map(({ candidate, structScore }) => {
      const embedPct = Math.round((embedScoreMap[candidate.id] || 0) * 100);
      const similarity = Math.round(structScore * 0.6 + embedPct * 0.4);
      if (similarity < threshold) return null;

      const analysis = db.getIncidentAnalysis(candidate.id);
      const recovery = analysis?.recovery ? analysis.recovery : (analysis?.recovery_json ? safeJson(analysis.recovery_json) : null);
      const healActions = db.getHealActions(100).filter(h =>
        Math.abs(h.timestamp - (candidate.first_seen || 0)) < 60 * 60 * 1000
      );

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
        source: 'local',
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
