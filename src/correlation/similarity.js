'use strict';

/**
 * Similarity utilities used by both the correlation engine and the
 * similar-incident search.  All functions are pure and synchronous.
 */

/**
 * Jaccard similarity between two sets of tokens.
 * Returns [0, 1].
 */
function jaccardSimilarity(tokensA, tokensB) {
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  if (setA.size === 0 && setB.size === 0) return 1;
  let intersection = 0;
  for (const t of setA) {
    if (setB.has(t)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Tokenise a string for similarity comparison.
 * Strips numbers (IDs, timestamps) and lowercases.
 */
function tokenise(str) {
  if (!str) return [];
  return String(str)
    .toLowerCase()
    .replace(/[0-9a-f]{8,}/g, '')   // strip hex IDs
    .replace(/\d+/g, '')             // strip numbers
    .split(/[\s\W]+/)
    .filter(t => t.length > 2);
}

/**
 * Score similarity between two incidents (0–100 integer).
 *
 * Factors:
 *   - same endpoint path       → +40
 *   - same root cause          → +25
 *   - similar error message    → up to +25 (Jaccard on tokens)
 *   - same status code         → +10
 */
function scoreIncidentSimilarity(incidentA, incidentB) {
  if (!incidentA || !incidentB || incidentA.id === incidentB.id) return 0;

  let score = 0;

  // Path match
  if (incidentA.path && incidentB.path) {
    const pa = normalizePath(incidentA.path);
    const pb = normalizePath(incidentB.path);
    if (pa === pb) score += 40;
    else if (pa && pb && (pa.startsWith(pb) || pb.startsWith(pa))) score += 20;
  }

  // Root cause match
  if (incidentA.root_cause && incidentB.root_cause &&
      incidentA.root_cause.toLowerCase() === incidentB.root_cause.toLowerCase()) {
    score += 25;
  }

  // Title / message similarity
  const titleSim = jaccardSimilarity(
    tokenise(incidentA.title || incidentA.sample_message),
    tokenise(incidentB.title || incidentB.sample_message)
  );
  score += Math.round(titleSim * 25);

  // Status code match
  if (incidentA.status_code && incidentB.status_code &&
      incidentA.status_code === incidentB.status_code) {
    score += 10;
  }

  return Math.min(100, score);
}

function normalizePath(p) {
  // Strip numeric segments so /api/users/123 → /api/users/:id
  return String(p || '').replace(/\/[0-9a-f-]{4,}/g, '/:id').toLowerCase();
}

module.exports = { scoreIncidentSimilarity, jaccardSimilarity, tokenise };
