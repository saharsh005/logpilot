'use strict';

/**
 * AI Investigator (Phase 5)
 *
 * Orchestrates the full agentic investigation pipeline:
 *
 *   Step 1 — Gather evidence (EvidenceCollector)
 *   Step 2 — Build correlation graph
 *   Step 3 — Find similar incidents
 *   Step 4 — Generate hypotheses (planner)
 *   Step 5 — Rank hypotheses
 *   Step 6 — Call LLM for RCA (or fall back to deterministic)
 *
 * Output:
 *   { rootCause, confidence, evidence, reasoning, impactedServices, category,
 *     hypotheses, similar, correlationGraph }
 */

const { buildIncidentContext } = require('../correlation/IncidentCorrelator');
const { buildCorrelationGraph } = require('../correlation/correlator');
const { findSimilarIncidents } = require('../similarity/incident-search');
const { generateHypotheses, buildSystemPrompt, buildUserPrompt } = require('./planner');
const { chat, isAIConfigured } = require('./reasoning');
const { analyzeRootCause } = require('../ai/RootCauseEngine');  // deterministic fallback
const db = require('../storage/db');
const { getService: getSplunkService } = require('../integrations/splunk/service');
const { getIncidentById } = require('../integrations/splunk/datastore');

/**
 * Run the full AI investigation for a given incident ID.
 *
 * @param {number|string} incidentId
 * @param {object} config  - full logpilot config (may include config.ai)
 * @returns {Promise<object>}
 */
async function investigate(incidentId, config = {}) {
  let incident = db.getIncidentGroup(Number(incidentId));
  if (!incident) incident = await getIncidentById(incidentId, config);
  if (!incident) return null;
  const id = incident.id;

  // ── Step 1: Gather evidence + build incident context ─────────────────────
  const context = await buildIncidentContext(id, config);
  if (!context) return null;

  // ── Step 2: Build correlation graph ──────────────────────────────────────
  const correlationGraph = await buildCorrelationGraph(context, config);

  // ── Step 3: Find similar incidents ───────────────────────────────────────
  const similar = await findSimilarIncidents(incident, { limit: 5, threshold: 25, config });

  // ── Step 4 & 5: Generate + rank hypotheses ───────────────────────────────
  const hypotheses = generateHypotheses(context, similar);

  // ── Step 6: LLM RCA (or deterministic fallback) ──────────────────────────
  let rca;
  const aiConfig = config.ai || {};

  if (isAIConfigured(aiConfig)) {
    try {
      rca = await runLLMInvestigation(context, hypotheses, similar, aiConfig);
    } catch (err) {
      rca = null;
    }
  }

  if (!rca) {
    // Deterministic fallback — always works, no external deps
    const deterministicRca = await analyzeRootCause(context, config);
    rca = {
      rootCause: deterministicRca.rootCause,
      confidence: deterministicRca.confidence,
      evidence: deterministicRca.evidence || [],
      reasoning: deterministicRca.recommendation || '',
      impactedServices: [incident.service || incident.path || 'app'].filter(Boolean),
      category: inferCategory(context),
      source: 'deterministic',
    };
  }

  const result = {
    ...rca,
    hypotheses,
    similar,
    correlationGraph,
    incidentId: id,
    investigatedAt: Date.now(),
  };

  // Persist to SQLite
  try {
    const existing = db.getIncidentAnalysis(id) || {};
    db.upsertIncidentAnalysis(id, {
      context_json: JSON.stringify({ ...safeJson(existing.context_json), correlationGraph, similar }),
      rca_json: JSON.stringify(result),
    });
  } catch (_) {}

  // Emit RCA event to Splunk (non-blocking)
  setImmediate(() => {
    const splunk = getSplunkService();
    if (splunk?.isEnabled()) {
      splunk.sendRCA(result).catch(() => {});
    }
  });

  return result;
}

// ── LLM path ──────────────────────────────────────────────────────────────

async function runLLMInvestigation(context, hypotheses, similar, aiConfig) {
  const systemPrompt = buildSystemPrompt();
  const userPrompt   = buildUserPrompt(context, hypotheses, similar);

  const raw = await chat(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt },
    ],
    aiConfig
  );

  // Strip markdown fences if the model disobeyed instructions
  const cleaned = raw.replace(/```(?:json)?/g, '').trim();
  const parsed = JSON.parse(cleaned);

  // Validate required fields
  if (!parsed.rootCause || typeof parsed.confidence !== 'number') {
    throw new Error('Malformed LLM response');
  }

  return { ...parsed, source: 'llm', provider: aiConfig.provider || 'openai' };
}

function inferCategory(context) {
  const metrics = context.metrics || {};
  if (metrics.memorySpike || metrics.cpuSpike) return 'resource';
  if (metrics.eventLoopLagSpike) return 'code';
  const rc = (context.incident?.root_cause || '').toLowerCase();
  if (rc.includes('data') || rc.includes('timeout')) return 'dependency';
  if (rc.includes('rate')) return 'traffic';
  if (context.github) return 'deployment';
  return 'unknown';
}

function safeJson(str) {
  try { return str ? JSON.parse(str) : {}; } catch (_) { return {}; }
}

module.exports = { investigate };
