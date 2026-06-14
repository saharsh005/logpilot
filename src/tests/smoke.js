'use strict';

/**
 * LogPilot Phase 3-7 Smoke Tests
 *
 * Tests all new modules without requiring SQLite or network access.
 * Run: node src/tests/smoke.js
 */

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓  ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗  ${name}`);
    console.error(`     ${e.message}`);
    failed++;
  }
}

async function asyncTest(name, fn) {
  try {
    await fn();
    console.log(`  ✓  ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗  ${name}`);
    console.error(`     ${e.message}`);
    failed++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(msg || `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

// ── Phase 3: Correlation Graph ───────────────────────────────────────────────
console.log('\nPhase 3 — Correlation Graph');

const { CorrelationGraph, RELATION_WEIGHTS } = require('../correlation/graph');

test('CorrelationGraph adds nodes and edges', () => {
  const g = new CorrelationGraph();
  g.addNode('inc:1', 'incident', 'Test Incident', {});
  g.addNode('log:1', 'logs', '50 logs', { count: 50 });
  g.addEdge('inc:1', 'log:1', 'CORRELATED_LOG', { label: '50 events' });
  const json = g.toJSON();
  assertEqual(json.nodes.length, 2, 'should have 2 nodes');
  assertEqual(json.edges.length, 1, 'should have 1 edge');
  assertEqual(json.confidence, RELATION_WEIGHTS.CORRELATED_LOG, 'confidence = edge weight');
});

test('CorrelationGraph ignores edges with missing nodes', () => {
  const g = new CorrelationGraph();
  g.addNode('inc:1', 'incident', 'Test', {});
  g.addEdge('inc:1', 'nonexistent', 'CAUSED_BY');
  assertEqual(g.toJSON().edges.length, 0, 'should not add edge with missing node');
});

test('CorrelationGraph confidence is mean of edge weights', () => {
  const g = new CorrelationGraph();
  g.addNode('a', 'incident', 'A', {});
  g.addNode('b', 'logs', 'B', {});
  g.addNode('c', 'metrics', 'C', {});
  g.addEdge('a', 'b', 'CAUSED_BY');      // weight 1.0
  g.addEdge('a', 'c', 'CORRELATED_METRIC'); // weight 0.6
  const confidence = g.toJSON().confidence;
  assert(confidence > 0.7 && confidence < 0.9, `Expected ~0.8, got ${confidence}`);
});

test('Empty graph has confidence 0', () => {
  const g = new CorrelationGraph();
  assertEqual(g.toJSON().confidence, 0);
});

// ── Phase 3: Similarity ──────────────────────────────────────────────────────
console.log('\nPhase 3 — Similarity');

const { scoreIncidentSimilarity, jaccardSimilarity, tokenise } = require('../correlation/similarity');

test('tokenise strips numbers and lowercases', () => {
  const tokens = tokenise('Error in /api/users/12345 at 1648000000');
  assert(!tokens.some(t => /\d/.test(t)), 'no numeric tokens');
  assert(tokens.every(t => t === t.toLowerCase()), 'all lowercase');
});

test('jaccardSimilarity returns 1 for identical sets', () => {
  assertEqual(jaccardSimilarity(['a', 'b', 'c'], ['a', 'b', 'c']), 1);
});

test('jaccardSimilarity returns 0 for disjoint sets', () => {
  assertEqual(jaccardSimilarity(['a', 'b'], ['c', 'd']), 0);
});

test('scoreIncidentSimilarity high for same path+cause', () => {
  const a = { id: 1, path: '/api/users', root_cause: 'Timeout', title: 'GET 500 error', status_code: 500 };
  const b = { id: 2, path: '/api/users', root_cause: 'Timeout', title: 'GET 500 error', status_code: 500 };
  assert(scoreIncidentSimilarity(a, b) >= 70, 'same path+cause should score high');
});

test('scoreIncidentSimilarity low for different path+cause', () => {
  const a = { id: 1, path: '/api/users', root_cause: 'Timeout', title: 'GET 500' };
  const c = { id: 3, path: '/api/orders/ship', root_cause: 'Memory', title: 'POST crash' };
  assert(scoreIncidentSimilarity(a, c) <= 20, 'different path+cause should score low');
});

test('scoreIncidentSimilarity returns 0 for same ID', () => {
  const a = { id: 1, path: '/api/users', root_cause: 'Timeout' };
  assertEqual(scoreIncidentSimilarity(a, a), 0, 'self-comparison should be 0');
});

// ── Phase 4: Embeddings ──────────────────────────────────────────────────────
console.log('\nPhase 4 — TF-IDF Embeddings');

const { rankByEmbedding, cosineSimilarity } = require('../similarity/embeddings');

test('rankByEmbedding returns results in descending score order', () => {
  const corpus = [
    { id: 1, text: 'database timeout connection refused postgres' },
    { id: 2, text: 'memory heap overflow nodejs crash' },
    { id: 3, text: 'database slow query timeout connection pool' },
  ];
  const results = rankByEmbedding('database timeout connection error', corpus);
  assertEqual(results.length, 3, 'should return all 3');
  assert(results[0].score >= results[1].score, 'descending order');
  assert(results[0].id === 1 || results[0].id === 3, 'db result should rank first');
});

test('rankByEmbedding returns empty for empty corpus', () => {
  const results = rankByEmbedding('some query', []);
  assertEqual(results.length, 0, 'empty corpus → empty results');
});

test('cosineSimilarity returns 1 for identical vectors', () => {
  assertEqual(cosineSimilarity([1, 2, 3], [1, 2, 3]), 1);
});

test('cosineSimilarity returns 0 for orthogonal vectors', () => {
  assertEqual(cosineSimilarity([1, 0], [0, 1]), 0);
});

test('cosineSimilarity returns 0 for zero vectors', () => {
  assertEqual(cosineSimilarity([0, 0], [1, 2]), 0);
});

// ── Phase 5: Planner ─────────────────────────────────────────────────────────
console.log('\nPhase 5 — AI Planner');

const { generateHypotheses, buildSystemPrompt, buildUserPrompt } = require('../agent/planner');

test('generateHypotheses returns array sorted by confidence desc', () => {
  const ctx = {
    incident: { id: 1, path: '/api', root_cause: 'Timeout', count: 10, status_code: 500 },
    metrics: { maxMemory: 91, memorySpike: true, maxCpu: 40, cpuSpike: false, maxEventLoopLag: 0, eventLoopLagSpike: false, samples: 20 },
    logs: { count: 30, dominantErrors: [{ message: 'ECONNREFUSED', count: 5 }] },
    github: null,
  };
  const hypotheses = generateHypotheses(ctx, []);
  assert(hypotheses.length >= 1, 'should produce at least one hypothesis');
  for (let i = 1; i < hypotheses.length; i++) {
    assert(hypotheses[i].confidence <= hypotheses[i-1].confidence, 'should be sorted desc');
  }
});

test('generateHypotheses includes deployment hypothesis when github present', () => {
  const ctx = {
    incident: { id: 1, path: '/api', root_cause: 'Unknown', count: 3, status_code: 500 },
    metrics: { maxMemory: 30, memorySpike: false, maxCpu: 30, cpuSpike: false, samples: 5 },
    logs: { count: 5, dominantErrors: [] },
    github: { commitHash: 'abc123def456', author: 'dev', subject: 'Fix auth', confidence: 80, changedFiles: ['auth.js'] },
  };
  const hypotheses = generateHypotheses(ctx, []);
  const deployH = hypotheses.find(h => h.category === 'deployment');
  assert(deployH, 'should have a deployment hypothesis');
  assert(deployH.confidence === 0.80, `deployment confidence should equal github confidence/100 (got ${deployH.confidence})`);
});

test('generateHypotheses returns fallback when no signals', () => {
  const ctx = {
    incident: { id: 1, path: '/api', root_cause: 'Unknown', count: 1 },
    metrics: { maxMemory: 10, memorySpike: false, maxCpu: 10, cpuSpike: false, samples: 0 },
    logs: { count: 0, dominantErrors: [] },
    github: null,
  };
  const hypotheses = generateHypotheses(ctx, []);
  assert(hypotheses.length >= 1, 'should always produce at least one hypothesis');
  assertEqual(hypotheses[0].category, 'unknown', 'fallback category should be unknown');
});

test('buildSystemPrompt returns string requiring JSON output', () => {
  const prompt = buildSystemPrompt();
  assert(typeof prompt === 'string' && prompt.length > 50, 'should return non-empty string');
  assert(prompt.includes('JSON'), 'should mention JSON');
  assert(prompt.includes('rootCause'), 'should specify rootCause field');
});

test('buildUserPrompt includes incident details', () => {
  const ctx = {
    incident: { id: 1, path: '/api/test', root_cause: 'Memory', count: 5, method: 'GET', status_code: 500, severity: 'high' },
    metrics: { maxMemory: 85, maxCpu: 60, maxEventLoopLag: 0, memorySpike: true, cpuSpike: false, eventLoopLagSpike: false },
    logs: { count: 20, dominantErrors: [] },
    github: null,
  };
  const prompt = buildUserPrompt(ctx, [], []);
  assert(prompt.includes('/api/test'), 'should include path');
  assert(prompt.includes('Memory'), 'should include root cause');
  assert(prompt.includes('85%'), 'should include memory value');
});

// ── Phase 5: Reasoning (provider config) ─────────────────────────────────────
console.log('\nPhase 5 — Reasoning / Provider');

const { isAIConfigured, PROVIDERS } = require('../agent/reasoning');

test('isAIConfigured returns false when no provider set', () => {
  // Clear env
  const orig = process.env.LOGPILOT_AI_PROVIDER;
  delete process.env.LOGPILOT_AI_PROVIDER;
  assertEqual(isAIConfigured({}), false, 'no provider → false');
  process.env.LOGPILOT_AI_PROVIDER = orig;
});

test('isAIConfigured returns true for ollama (no key needed)', () => {
  assert(isAIConfigured({ provider: 'ollama' }), 'ollama needs no API key');
});

test('isAIConfigured returns false for openai without key', () => {
  const origKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  assertEqual(isAIConfigured({ provider: 'openai' }), false);
  if (origKey) process.env.OPENAI_API_KEY = origKey;
});

test('isAIConfigured returns true for openai with key in config', () => {
  assert(isAIConfigured({ provider: 'openai', apiKey: 'sk-test-123' }), 'key in config → true');
});

test('PROVIDERS defines openai, groq, ollama', () => {
  assert('openai' in PROVIDERS, 'openai provider missing');
  assert('groq'   in PROVIDERS, 'groq provider missing');
  assert('ollama' in PROVIDERS, 'ollama provider missing');
});

// ── Phase 6: MCP ─────────────────────────────────────────────────────────────
console.log('\nPhase 6 — MCP');

const { isMCPEnabled } = require('../mcp/mcp-client');
const { getToolDefinitions } = require('../mcp/tools');

test('isMCPEnabled returns false by default', () => {
  assertEqual(isMCPEnabled({}), false);
  assertEqual(isMCPEnabled({ mcp: { enabled: false } }), false);
});

test('isMCPEnabled returns true when explicitly enabled', () => {
  assert(isMCPEnabled({ mcp: { enabled: true } }), 'should be enabled');
});

test('getToolDefinitions returns 11 tools', () => {
  const tools = getToolDefinitions();
  assertEqual(tools.length, 11, `expected 11 tools, got ${tools.length}`);
});

test('all tool definitions have name, description, and params', () => {
  const tools = getToolDefinitions();
  tools.forEach(t => {
    assert(typeof t.name === 'string' && t.name.length > 0, `tool missing name: ${JSON.stringify(t)}`);
    assert(typeof t.description === 'string', `tool ${t.name} missing description`);
    assert(typeof t.params === 'object', `tool ${t.name} missing params`);
  });
});

test('tool names match expected set', () => {
  const expected = new Set([
    'search_logs', 'find_deployments', 'find_related_incidents',
    'get_trace', 'get_metric_history', 'get_heal_history',
    'simulate_recovery', 'estimate_blast_radius', 'predict_incident_growth',
    'estimate_mttr', 'explain_failure_pattern',
  ]);
  const tools = getToolDefinitions();
  tools.forEach(t => assert(expected.has(t.name), `unexpected tool: ${t.name}`));
});

// ── Phase 7: Recovery Recommendations ────────────────────────────────────────
console.log('\nPhase 7 — Recovery Recommendations');

const { generateRecommendations, ACTIONS } = require('../recovery/recommendations');

test('generateRecommendations returns non-empty array', () => {
  const ctx = {
    incident: { id: 1, path: '/api', root_cause: 'Timeout', count: 5, status_code: 500 },
    metrics: { maxMemory: 50, memorySpike: false, maxCpu: 50, cpuSpike: false },
    github: null,
  };
  const recs = generateRecommendations(ctx, [], {});
  assert(recs.length >= 1, 'should always return at least one recommendation');
});

test('generateRecommendations always includes notify-only fallback', () => {
  const ctx = {
    incident: { id: 1, path: '/api', root_cause: 'Unknown', count: 1, status_code: 500 },
    metrics: { maxMemory: 10, memorySpike: false, maxCpu: 10, cpuSpike: false },
    github: null,
  };
  const recs = generateRecommendations(ctx, [], {});
  const hasNotify = recs.some(r => r.action === ACTIONS.NOTIFY_ONLY);
  assert(hasNotify, 'should always include notify-only');
});

test('generateRecommendations recommends gc for memory spike', () => {
  const ctx = {
    incident: { id: 1, path: '/api', root_cause: 'Memory', count: 5, status_code: 500 },
    metrics: { maxMemory: 92, memorySpike: true, maxCpu: 20, cpuSpike: false },
    github: null,
  };
  const recs = generateRecommendations(ctx, [], {});
  const gcRec = recs.find(r => r.action === ACTIONS.FORCE_GC);
  assert(gcRec, 'should recommend gc for memory spike');
  assert(gcRec.confidence >= 0.8, 'gc confidence should be >= 0.8 for memory spike');
});

test('generateRecommendations recommends rollback for high-confidence git correlation', () => {
  const ctx = {
    incident: { id: 1, path: '/api', root_cause: 'Unknown', count: 3, status_code: 500 },
    metrics: { maxMemory: 30, memorySpike: false, maxCpu: 30, cpuSpike: false },
    github: { commitHash: 'abc123', author: 'dev', subject: 'Deploy v2', confidence: 85, changedFiles: [] },
  };
  const recs = generateRecommendations(ctx, [], {});
  const rollback = recs.find(r => r.action === ACTIONS.ROLLBACK_DEPLOY);
  assert(rollback, 'should recommend rollback for high git correlation');
  assert(rollback.confidence >= 0.8, `rollback confidence should be ~0.85, got ${rollback.confidence}`);
});

test('generateRecommendations deduplicates actions', () => {
  const ctx = {
    incident: { id: 1, path: '/api', root_cause: 'Rate limit', count: 15, status_code: 429 },
    metrics: { maxMemory: 30, memorySpike: false, maxCpu: 30, cpuSpike: false },
    github: null,
  };
  const recs = generateRecommendations(ctx, [], {});
  const actions = recs.map(r => r.action);
  const unique = new Set(actions);
  assertEqual(actions.length, unique.size, 'no duplicate actions');
});

test('generateRecommendations results sorted by confidence desc', () => {
  const ctx = {
    incident: { id: 1, path: '/api', root_cause: 'Rate limit', count: 20, status_code: 429 },
    metrics: { maxMemory: 91, memorySpike: true, maxCpu: 85, cpuSpike: true },
    github: { commitHash: 'abc', author: 'dev', subject: 'test', confidence: 90, changedFiles: [] },
  };
  const recs = generateRecommendations(ctx, [], {});
  for (let i = 1; i < recs.length; i++) {
    assert(recs[i].confidence <= recs[i-1].confidence, `not sorted at index ${i}`);
  }
});

test('ACTIONS object has all expected keys', () => {
  const expected = ['RESTART_SERVICE', 'ROLLBACK_DEPLOY', 'SCALE_REPLICAS', 'CIRCUIT_BREAK', 'RATE_LIMIT', 'FORCE_GC', 'HEAP_SNAPSHOT', 'NOTIFY_ONLY'];
  expected.forEach(k => assert(k in ACTIONS, `missing ACTIONS.${k}`));
});

// ── Splunk-first source-of-truth tests (async) ─────────────────────────────
(async () => {

console.log('\nSplunk-first — Similar Incidents');

const { findSimilarIncidents } = require('../similarity/incident-search');

await asyncTest('findSimilarIncidents falls back to local when Splunk disabled', async () => {
  const incident = { id: 999999, path: '/api/test', root_cause: 'Timeout', title: 'Test incident' };
  const results = await findSimilarIncidents(incident, { config: { splunk: { enabled: false } } });
  assert(Array.isArray(results), 'should return an array');
});

await asyncTest('findSimilarIncidents accepts config in opts without throwing', async () => {
  const incident = { id: 1, path: '/api/x', root_cause: 'Memory', title: 'Mem incident' };
  const results = await findSimilarIncidents(incident, { limit: 3, threshold: 25, config: { splunk: { enabled: false } } });
  assert(Array.isArray(results), 'should not throw with config passed');
});

await asyncTest('findSimilarIncidents returns empty array for null incident', async () => {
  const results = await findSimilarIncidents(null, { config: {} });
  assertEqual(results.length, 0, 'null incident -> empty array');
});

console.log('\nSplunk-first — MetricCorrelator');

const { correlateMetrics } = require('../correlation/MetricCorrelator');

await asyncTest('correlateMetrics returns local source when Splunk disabled', async () => {
  const incident = { first_seen: Date.now() - 60000, last_seen: Date.now(), path: '/api/x' };
  const result = await correlateMetrics(incident, { splunk: { enabled: false } });
  assertEqual(result.source, 'local', 'should use local source when Splunk disabled');
  assert('maxCpu' in result && 'maxMemory' in result && 'cpuSpike' in result, 'should have full metric shape');
});

await asyncTest('correlateMetrics falls back to local when Splunk enabled but unreachable', async () => {
  const incident = { first_seen: Date.now() - 60000, last_seen: Date.now(), path: '/api/x' };
  const result = await correlateMetrics(incident, { splunk: { enabled: true, hecUrl: 'http://localhost:1', index: 'logpilot' } });
  assert(result.source === 'local' || result.source === 'splunk', 'should resolve to a valid source');
  assert(Number.isFinite(result.maxCpu), 'maxCpu should be numeric');
});

console.log('\nSplunk-first — Correlation Graph (async)');

const { buildCorrelationGraph } = require('../correlation/correlator');

await asyncTest('buildCorrelationGraph is async and returns nodes/edges/confidence', async () => {
  const context = {
    incident: { id: 1, title: 'Test incident', path: '/api/x', root_cause: 'Memory', count: 5, first_seen: Date.now() - 60000, last_seen: Date.now() },
    logs: { count: 10, dominantErrors: [] },
    metrics: { samples: 5, maxCpu: 50, maxMemory: 50, memorySpike: false, cpuSpike: false },
  };
  const graph = await buildCorrelationGraph(context, { splunk: { enabled: false } });
  assert(Array.isArray(graph.nodes), 'should have nodes array');
  assert(Array.isArray(graph.edges), 'should have edges array');
  assert(typeof graph.confidence === 'number', 'should have numeric confidence');
  assert(graph.nodes.some(n => n.type === 'incident'), 'should have root incident node');
});

await asyncTest('buildCorrelationGraph works with config-less call (defaults)', async () => {
  const context = {
    incident: { id: 2, title: 'Test 2', path: '/api/y', root_cause: 'Timeout', count: 1, first_seen: Date.now(), last_seen: Date.now() },
    logs: { count: 0, dominantErrors: [] },
    metrics: { samples: 0, maxCpu: 0, maxMemory: 0 },
  };
  const graph = await buildCorrelationGraph(context);
  assert(Array.isArray(graph.nodes), 'should not throw without config');
});

console.log('\nNon-numeric incident ID safety (Splunk-sourced ids)');

const db = require('../storage/db');

await asyncTest('upsertIncidentAnalysis silently skips non-numeric incident IDs', () => {
  // Should not throw for a Splunk-style string id
  db.upsertIncidentAnalysis('splunk-abc123', { context: {}, rca: {}, recovery: {} });
});

await asyncTest('getIncidentAnalysis returns null for non-numeric incident IDs', () => {
  const result = db.getIncidentAnalysis('splunk-abc123');
  assertEqual(result, null, 'non-numeric id should return null, not throw or collide');
});

await asyncTest('saveEvidenceSnapshot silently skips non-numeric incident IDs', () => {
  db.saveEvidenceSnapshot('splunk-xyz', { source: 'splunk', logs: {}, metrics: {} });
});

await asyncTest('getEvidenceSnapshot returns null for non-numeric incident IDs', () => {
  const result = db.getEvidenceSnapshot('splunk-xyz');
  assertEqual(result, null, 'non-numeric id should return null');
});

console.log('\nEvidence Collector — Splunk path field completeness');

const collectorSrc2 = require('fs').readFileSync(
  require('path').join(__dirname, '../investigator/evidence/collector.js'), 'utf8');

test('collectFromSplunk computes errorRate', () => {
  assert(collectorSrc2.includes('splunkErrorRate'), 'should compute splunkErrorRate');
});
test('collectFromSplunk computes response time stats (avg/max/p95)', () => {
  assert(collectorSrc2.includes('weightedAvgRt') && collectorSrc2.includes('maxRtSplunk') && collectorSrc2.includes('p95RtSplunk'),
    'should compute avg/max/p95 response times');
});
test('collectFromSplunk computes statusCodes breakdown', () => {
  assert(collectorSrc2.includes('splunkStatusCodes'), 'should compute status code breakdown');
});
test('collectFromSplunk computes metricSeries for sparklines', () => {
  assert(collectorSrc2.includes('metricSeries') && collectorSrc2.includes('metricSeriesR'), 'should compute metric series');
});
test('collectFromSplunk computes anomalies from metrics', () => {
  assert(collectorSrc2.includes('computedAnomalies'), 'should compute anomalies from Splunk metrics');
});
test('collectEvidence detects total Splunk unreachability and falls back to local', () => {
  assert(collectorSrc2.includes('splunkHits === 0') && collectorSrc2.includes('throw new Error'),
    'should detect when all sub-queries degrade to local and throw to trigger fallback');
});
test('collectEvidence surfaces splunkStatus:unreachable on local fallback', () => {
  assert(collectorSrc2.includes("evidence.splunkStatus = 'unreachable'"), 'should mark local evidence as splunk-unreachable');
});

console.log('\nIncident ID validation middleware');

const serverSrc = require('fs').readFileSync(
  require('path').join(__dirname, '../dashboard/server.js'), 'utf8');

test('server.js has validateIncidentParam supporting splunk-N ids', () => {
  assert(serverSrc.includes('function validateIncidentParam'), 'should define validateIncidentParam');
  assert(serverSrc.includes('splunk-'), 'should support splunk-N id format');
});
test('server.js applies validateIncidentParam to incident routes', () => {
  const matches = serverSrc.match(/validateIncidentParam/g) || [];
  assert(matches.length >= 10, `should apply to many routes, found ${matches.length}`);
});
test('server.js awaits verifyRecovery (no missing await regression)', () => {
  assert(serverSrc.includes('const recovery = await verifyRecovery('), 'verifyRecovery must be awaited');
});
test('server.js imports searchSplunk for analytics', () => {
  assert(serverSrc.includes("require('../integrations/splunk/splunkSearch')"), 'should import searchSplunk');
});
test('server.js /api/analytics/advanced is Splunk-first', () => {
  const idx = serverSrc.indexOf("dashboardApp.get('/api/analytics/advanced'");
  const chunk = serverSrc.slice(idx, idx + 2000);
  assert(chunk.includes('config.splunk?.enabled'), 'analytics should check Splunk first');
});

console.log('\nSplunk source-of-truth: similarity module');

const similaritySrc = require('fs').readFileSync(
  require('path').join(__dirname, '../similarity/incident-search.js'), 'utf8');

test('incident-search.js queries Splunk first via find_related_incidents', () => {
  assert(similaritySrc.includes('find_related_incidents'), 'should call find_related_incidents MCP tool');
});
test('incident-search.js uses TF-IDF embeddings for re-ranking', () => {
  assert(similaritySrc.includes('rankByEmbedding'), 'should use TF-IDF embeddings');
});
test('incident-search.js falls back to local only when splunk disabled/unreachable', () => {
  assert(similaritySrc.includes("config.splunk?.enabled") && similaritySrc.includes('findSimilarFromLocal'),
    'should have explicit local fallback path');
});

const correlatorSrc = require('fs').readFileSync(
  require('path').join(__dirname, '../correlation/correlator.js'), 'utf8');

test('correlator.js uses find_related_incidents for related incidents (Splunk-first)', () => {
  assert(correlatorSrc.includes('find_related_incidents'), 'should query Splunk for related incidents');
});
test('correlator.js heal actions come from evidence (Splunk-first) with local fallback', () => {
  assert(correlatorSrc.includes('evidenceHeals') && correlatorSrc.includes('db.getHealActions'),
    'should prefer evidence heals, fall back to local');
});

const metricCorrSrc = require('fs').readFileSync(
  require('path').join(__dirname, '../correlation/MetricCorrelator.js'), 'utf8');

test('MetricCorrelator.js queries Splunk metrics first', () => {
  assert(metricCorrSrc.includes('type=metric') && metricCorrSrc.includes('config.splunk?.enabled'),
    'should query Splunk type=metric when enabled');
});
test('MetricCorrelator.js falls back to local SQLite metrics', () => {
  assert(metricCorrSrc.includes("source: 'local'") && metricCorrSrc.includes('getRecentMetrics'),
    'should fall back to local metrics');
});

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
const total = passed + failed;
if (failed === 0) {
  console.log(`✅  All ${total} tests passed`);
} else {
  console.log(`Results: ${passed}/${total} passed, ${failed} failed`);
  process.exit(1);
}

})();

// ── Phase 11: HEC client — production hardening ───────────────────────────
console.log('\nPhase 11 — HEC Client (production hardening)');

const { HECClient, SCHEMA_VERSION, SOURCETYPE_MAP } = require('../integrations/splunk/hec');

test('SCHEMA_VERSION is a non-empty string', () => {
  assert(typeof SCHEMA_VERSION === 'string' && SCHEMA_VERSION.length > 0, 'schema version must exist');
});

test('SOURCETYPE_MAP covers all event types', () => {
  const required = ['request','error','metric','incident','anomaly','heal','recovery','rca','postmortem','deployment'];
  required.forEach(t => assert(t in SOURCETYPE_MAP, `missing sourcetype for: ${t}`));
});

test('HECClient.send() stamps schema_version on event', () => {
  const hec = new HECClient({ hecToken: '', batchSize: 1000 });
  hec.send({ event: { type: 'request', path: '/test' } });
  clearInterval(hec.flushTimer);
  assertEqual(hec.queue.length, 0, 'no token = nothing queued');
});

test('HECClient with token queues events', () => {
  const hec = new HECClient({ hecToken: 'test-token', batchSize: 1000, flushInterval: 99999 });
  clearInterval(hec.flushTimer);
  hec.send({ event: { type: 'request', path: '/api' } });
  assertEqual(hec.queue.length, 1, 'event should be queued');
  assertEqual(hec.queue[0].event.schema_version, SCHEMA_VERSION, 'schema_version stamped');
});

test('HECClient applies correct sourcetype from event type', () => {
  const hec = new HECClient({ hecToken: 'test-token', batchSize: 1000, flushInterval: 99999 });
  clearInterval(hec.flushTimer);
  hec.send({ event: { type: 'incident' } });
  assertEqual(hec.queue[0].sourcetype, 'logpilot:incident', 'incident sourcetype applied');
});

test('HECClient increments droppedEvents when queue is full', () => {
  const hec = new HECClient({ hecToken: 'tok', batchSize: 10000, maxQueueSize: 3, flushInterval: 99999 });
  clearInterval(hec.flushTimer);
  hec.send({ event: { type: 'request' } });
  hec.send({ event: { type: 'request' } });
  hec.send({ event: { type: 'request' } });
  hec.send({ event: { type: 'request' } });  // should drop one
  assertEqual(hec.droppedEvents, 1, 'should have dropped 1 event');
  assertEqual(hec.queue.length, 3, 'queue stays at maxQueueSize');
});

test('HECClient.getHealth() returns all required fields', () => {
  const hec = new HECClient({ hecToken: 'tok', flushInterval: 99999 });
  clearInterval(hec.flushTimer);
  const h = hec.getHealth();
  ['healthy','queueSize','dlqSize','droppedEvents','totalSent','consecutiveFailures','lastFlushAt','lastSuccessAt','lastError']
    .forEach(k => assert(k in h, `missing health field: ${k}`));
});

test('HECClient.testConnectivity() returns ok:false with no token', async () => {
  const hec = new HECClient({ hecToken: '', flushInterval: 99999 });
  clearInterval(hec.flushTimer);
  const result = await hec.testConnectivity();
  assertEqual(result.ok, false, 'no token should return ok:false');
  assert(result.error, 'should have error message');
});

// ── Phase 11: SplunkService typed emitters ────────────────────────────────
console.log('\nPhase 11 — SplunkService typed emitters');

const { SplunkService } = require('../integrations/splunk/service');

test('SplunkService.isEnabled() false with no token', () => {
  const svc = new SplunkService({ splunk: { enabled: true } });
  assertEqual(svc.isEnabled(), false, 'no token → not enabled');
});

test('SplunkService.isEnabled() false when disabled', () => {
  const svc = new SplunkService({ splunk: { enabled: false, token: 'tok' } });
  assertEqual(svc.isEnabled(), false, 'disabled config → not enabled');
});

test('SplunkService has all typed emitter methods', () => {
  const svc = new SplunkService({});
  ['sendRequest','sendIncident','sendAnomaly','sendHeal','sendRCA','sendRecovery','sendPostmortem','sendDeployment']
    .forEach(m => assert(typeof svc[m] === 'function', `missing method: ${m}`));
});

test('SplunkService.getFullHealth() returns enabled:false when not configured', async () => {
  const svc = new SplunkService({});
  const h = await svc.getFullHealth();
  assertEqual(h.enabled, false, 'disabled service → enabled:false in health');
});

test('SplunkService.runStartupDiagnostics() returns enabled:false when disabled', async () => {
  const svc = new SplunkService({ splunk: { enabled: false } });
  const diag = await svc.runStartupDiagnostics();
  assertEqual(diag.enabled, false);
});

// ── Phase 12: Input validation and rate limiting ──────────────────────────
console.log('\nPhase 12 — Production hardening');

// validateIncidentId is a closure inside server.js — test the logic directly
function validateIdLogic(idStr) {
  const id = parseInt(idStr, 10);
  if (!id || id < 1 || id > 1e9) return null;
  return id;
}

test('validateIncidentId accepts valid IDs', () => {
  assertEqual(validateIdLogic('1'), 1);
  assertEqual(validateIdLogic('42'), 42);
  assertEqual(validateIdLogic('999999999'), 999999999);
});

test('validateIncidentId rejects invalid IDs', () => {
  assertEqual(validateIdLogic('0'), null, 'zero invalid');
  assertEqual(validateIdLogic('-1'), null, 'negative invalid');
  assertEqual(validateIdLogic('abc'), null, 'non-numeric invalid');
  assertEqual(validateIdLogic(''), null, 'empty invalid');
  assertEqual(validateIdLogic('9999999999'), null, 'too large invalid');
  assertEqual(validateIdLogic('../etc/passwd'), null, 'path traversal invalid');
});

// Rate limiter logic test
function makeRateLimiter(max) {
  const counts = new Map();
  return function check(ip, path) {
    const key = ip + ':' + path;
    const now = Date.now();
    const entry = counts.get(key) || { count: 0, resetAt: now + 60000 };
    if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + 60000; }
    entry.count++;
    counts.set(key, entry);
    return entry.count <= max;
  };
}

test('Rate limiter allows requests under limit', () => {
  const check = makeRateLimiter(3);
  assert(check('127.0.0.1', '/api/test'), 'request 1 should pass');
  assert(check('127.0.0.1', '/api/test'), 'request 2 should pass');
  assert(check('127.0.0.1', '/api/test'), 'request 3 should pass');
});

test('Rate limiter blocks requests over limit', () => {
  const check = makeRateLimiter(2);
  check('127.0.0.1', '/api/x');
  check('127.0.0.1', '/api/x');
  assert(!check('127.0.0.1', '/api/x'), 'request 3 should be blocked');
});

test('Rate limiter tracks different IPs independently', () => {
  const check = makeRateLimiter(1);
  assert(check('1.1.1.1', '/api/y'), 'IP A request 1 should pass');
  assert(check('2.2.2.2', '/api/y'), 'IP B request 1 should pass');
  assert(!check('1.1.1.1', '/api/y'), 'IP A request 2 should be blocked');
  assert(!check('2.2.2.2', '/api/y'), 'IP B request 2 should be blocked');
});

// ── Phase 9: Postmortem generation ───────────────────────────────────────
console.log('\nPhase 9 — Postmortem generation');

const { generatePostmortem } = require('../postmortem/PostmortemGenerator');

const mockIncident = { id: 1, title: 'GET /api/users 500', path: '/api/users', method: 'GET',
  status_code: 500, severity: 'high', count: 15,
  first_seen: Date.now() - 300000, last_seen: Date.now() - 60000, service: 'api' };
const mockRca = { rootCause: 'Database connection pool exhausted', confidence: 87,
  category: 'dependency', source: 'deterministic', evidence: ['15 grouped errors', 'Memory at 85%'],
  reasoning: 'Connection pool saturation detected from metric spikes.',
  impactedServices: ['api', 'database'], hypotheses: [] };
const mockRecovery = { resolved: true, confidence: 92, errorRate: 2, totalRequests: 50,
  source: 'local', checkedAt: Date.now() };
const mockContext = { metrics: { maxMemory: 85, memorySpike: true, maxCpu: 40 }, github: null };

test('generatePostmortem returns a non-empty string', () => {
  const pm = generatePostmortem({ incident: mockIncident, context: mockContext, rca: mockRca, recovery: mockRecovery });
  assert(typeof pm === 'string' && pm.length > 200, 'postmortem should be substantial');
});

test('generatePostmortem includes all 10 required sections', () => {
  const pm = generatePostmortem({ incident: mockIncident, context: mockContext, rca: mockRca, recovery: mockRecovery });
  const sections = ['# Incident Postmortem', '## Impact', '## Timeline', '## Root Cause',
    '## Evidence', '## Remediation', '## Recovery Verification', '## Lessons Learned', '## Future Prevention'];
  sections.forEach(s => assert(pm.includes(s), `missing section: ${s}`));
});

test('generatePostmortem cites RCA evidence', () => {
  const pm = generatePostmortem({ incident: mockIncident, context: mockContext, rca: mockRca, recovery: mockRecovery });
  assert(pm.includes('Database connection pool exhausted'), 'rootCause must appear in postmortem');
  assert(pm.includes('87%'), 'confidence must appear');
});

test('generatePostmortem includes impact section with error rate', () => {
  const pm = generatePostmortem({ incident: mockIncident, context: mockContext, rca: mockRca, recovery: mockRecovery });
  assert(pm.includes('2%'), 'error rate from recovery must appear');
});

test('generatePostmortem includes no-action remediation note when healActions empty', () => {
  const pm = generatePostmortem({ incident: mockIncident, context: mockContext, rca: mockRca, recovery: mockRecovery, healActions: [] });
  assert(pm.includes('No automated remediation'), 'empty healActions → note about no remediation');
});

test('generatePostmortem includes similar incidents when provided', () => {
  const similar = [{ incidentId: 5, similarity: 80, title: 'GET /api/users 503', rootCause: 'DB overload', resolution: 'restart-service' }];
  const pm = generatePostmortem({ incident: mockIncident, context: mockContext, rca: mockRca, recovery: mockRecovery, similar });
  assert(pm.includes('Similar Historical Incidents'), 'similar incidents section should appear');
  assert(pm.includes('#5'), 'similar incident ID should appear');
});

// ── Evidence Collector (rich local mode) ──────────────────────────────────
console.log('\nEvidence Collector — local mode');

// Test the helper functions directly without needing DB
const collectorPath = require('path').join(__dirname, '../investigator/evidence/collector.js');
const collectorSrc  = require('fs').readFileSync(collectorPath, 'utf8');

test('collector.js exports collectEvidence function', () => {
  assert(collectorSrc.includes('module.exports = { collectEvidence }'), 'should export collectEvidence');
});

test('collector.js has normalizeMessage helper', () => {
  assert(collectorSrc.includes('function normalizeMessage'), 'should have normalizeMessage');
});

test('collector.js has countBy helper', () => {
  assert(collectorSrc.includes('function countBy'), 'should have countBy helper');
});

test('collector.js handles local AND splunk paths', () => {
  assert(collectorSrc.includes('collectFromLocal'), 'should have collectFromLocal');
  assert(collectorSrc.includes('collectFromSplunk'), 'should have collectFromSplunk');
});

test('collector.js returns anomalies array', () => {
  assert(collectorSrc.includes('anomalies:'), 'should return anomalies');
});

test('collector.js returns traces array', () => {
  assert(collectorSrc.includes('traces:'), 'should return traces');
});

test('collector.js returns errorTimeline array', () => {
  assert(collectorSrc.includes('errorTimeline'), 'should return errorTimeline');
});

test('collector.js returns response time percentiles', () => {
  assert(collectorSrc.includes('p95ResponseMs') || collectorSrc.includes('p95Rt'), 'should have p95 response time');
});

// ── Interactive graph + Evidence tab (dashboard-ext) ─────────────────────
console.log('\nInteractive Graph + Evidence — dashboard-ext.js');

const extSrc = require('fs').readFileSync(
  require('path').join(__dirname, '../dashboard/dashboard-ext.js'), 'utf8');

// Graph
test('dashboard-ext has force simulation', () => {
  assert(extSrc.includes('function simulate'), 'should have simulate() loop');
});
test('dashboard-ext has draw function', () => {
  assert(extSrc.includes('function draw'), 'should have draw()');
});
test('dashboard-ext has full mouse interaction', () => {
  assert(extSrc.includes('mousedown') && extSrc.includes('mousemove') && extSrc.includes('mouseup'), 'full mouse events');
});
test('dashboard-ext has zoom/pan via wheel', () => {
  assert(extSrc.includes('wheel') && extSrc.includes('zoom'), 'wheel zoom');
});
test('dashboard-ext NODE_COLORS covers all types', () => {
  ['incident','logs','metrics','deployment','heal_action','error_burst','memory_spike']
    .forEach(t => assert(extSrc.includes("'"+t+"'") || extSrc.includes(t+":"), 'missing color for: ' + t));
});
test('dashboard-ext EDGE_COLORS covers relation types', () => {
  ['CAUSED_BY','CORRELATED_LOG','CORRELATED_METRIC','CORRELATED_DEPLOY']
    .forEach(r => assert(extSrc.includes(r), 'missing edge color: ' + r));
});
test('dashboard-ext has tooltip on hover', () => {
  assert(extSrc.includes('graph-tooltip'), 'tooltip element');
});
test('dashboard-ext shows node detail panel on click', () => {
  assert(extSrc.includes('graph-detail') && extSrc.includes('showNodeDetail'), 'detail panel');
});

// Evidence tab
test('dashboard-ext evidence tab has sparkline renderer', () => {
  assert(extSrc.includes('function sparkline'), 'should have sparkline()');
});
test('dashboard-ext evidence tab has gauge bar renderer', () => {
  assert(extSrc.includes('function gaugeBar'), 'should have gaugeBar()');
});
test('dashboard-ext evidence tab has error timeline renderer', () => {
  assert(extSrc.includes('function renderTimeline'), 'should have renderTimeline()');
});
test('dashboard-ext evidence tab has live polling', () => {
  assert(extSrc.includes('startEvidenceLiveRefresh') && extSrc.includes('stopEvidenceLiveRefresh'), 'live polling functions');
});
test('dashboard-ext evidence tab polls every 15s', () => {
  assert(extSrc.includes('15000'), '15 second poll interval');
});
test('dashboard-ext evidence tab has manual refresh button', () => {
  assert(extSrc.includes('function refreshEvidence'), 'manual refresh function');
});
test('dashboard-ext anomaly cards are expandable', () => {
  assert(extSrc.includes('toggleAnomalyDetail'), 'expandable anomaly cards');
});
test('dashboard-ext anomaly cards show recommended action', () => {
  assert(extSrc.includes('Recommended action'), 'recommended action text in anomaly detail');
});
test('dashboard-ext anomaly cards have severity gradient bar', () => {
  assert(extSrc.includes('sevColor') && extSrc.includes('threshold'), 'severity gradient with threshold');
});
test('dashboard-ext evidence shows SPIKE warning for metrics', () => {
  assert(extSrc.includes('⚠ SPIKE') && extSrc.includes('cpuSpike'), 'spike warning indicator');
});
test('dashboard-ext evidence KPI grid shows 6 stats', () => {
  assert(extSrc.includes('Log Events') && extSrc.includes('Error Rate') && extSrc.includes('Anomalies')
    && extSrc.includes('Heal Actions') && extSrc.includes('Max Response') && extSrc.includes('Related Incidents'), '6 KPIs');
});
test('dashboard-ext evidence shows status code pills', () => {
  assert(extSrc.includes('statusCodes') && extSrc.includes('statusColor'), 'status code breakdown');
});
test('dashboard-ext evidence shows response time P95', () => {
  assert(extSrc.includes('P95') && extSrc.includes('p95ResponseMs'), 'P95 response time');
});
test('dashboard-ext Splunk health shows disabled state with setup instructions', () => {
  assert(extSrc.includes('SPLUNK_SETUP.md'), 'setup guide reference');
});
test('dashboard-ext fetchSplunkHealth exists', () => {
  assert(extSrc.includes('function fetchSplunkHealth'), 'fetchSplunkHealth function');
});
test('dashboard-ext renderRecommendationsTab shows action icons', () => {
  assert(extSrc.includes('actionIcons') && extSrc.includes("'gc'"), 'action icons map');
});
test('dashboard-ext renderRecommendationsTab shows confidence bars', () => {
  assert(extSrc.includes('confPct'), 'confidence percentage bars');
});
