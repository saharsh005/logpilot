/**
 * LogPilot — Full configuration example
 * Copy to logpilot.config.js in your project root.
 *
 * Every option has a sensible default — only configure what you need.
 */

module.exports = {
  // ── Express app (required) ────────────────────────────────────────────────
  // app: require('./app'),  // pass your Express instance here

  // ── Dashboard ─────────────────────────────────────────────────────────────
  dashboard:     true,
  dashboardPort: 4321,
  consoleOutput: true,
  storageDir:    '.logpilot',   // SQLite + snapshots go here

  // ── Splunk Integration (Phase 1 + 11) ────────────────────────────────────
  splunk: {
    enabled:            process.env.SPLUNK_ENABLED === 'true' || false,

    // HTTP Event Collector (HEC) — for sending events TO Splunk
    hecUrl:             process.env.SPLUNK_HEC_URL   || 'https://localhost:8088',
    token:              process.env.SPLUNK_HEC_TOKEN || '',   // HEC token
    index:              process.env.SPLUNK_INDEX     || 'logpilot',

    // Splunk REST API — for searching evidence FROM Splunk
    host:               process.env.SPLUNK_HOST      || 'localhost',
    port:               process.env.SPLUNK_PORT      || 8089,
    protocol:           process.env.SPLUNK_PROTOCOL  || 'https',
    username:           process.env.SPLUNK_USERNAME,           // basic auth
    password:           process.env.SPLUNK_PASSWORD,           // or use token below
    // token:           process.env.SPLUNK_TOKEN,              // bearer token for REST API

    // TLS (set false for self-signed dev certs)
    rejectUnauthorized: process.env.SPLUNK_REJECT_TLS !== 'false',

    // HEC tuning
    batchSize:          100,    // events per HEC batch
    flushInterval:      5000,   // ms between auto-flushes
    maxQueueSize:       1000,   // max queued events before backpressure
    maxDLQSize:         500,    // dead-letter queue size
    retryAttempts:      3,      // retries before DLQ
  },

  // ── AI Investigation (Phase 5) ───────────────────────────────────────────
  ai: {
    provider:    process.env.LOGPILOT_AI_PROVIDER || '',  // 'openai' | 'groq' | 'ollama'
    model:       process.env.LOGPILOT_AI_MODEL    || '',  // e.g. 'gpt-4o-mini'
    apiKey:      process.env.OPENAI_API_KEY || process.env.GROQ_API_KEY || '',
    baseUrl:     process.env.OLLAMA_BASE_URL || 'http://localhost:11434',  // Ollama only
    temperature: 0.2,
    maxTokens:   1024,
  },

  // ── MCP Tool Integration (Phase 6) ──────────────────────────────────────
  mcp: {
    enabled:       false,   // set true to enable AI → Splunk tool calls
    maxToolRounds: 3,       // max agentic tool-call loops per investigation
  },

  // ── Self-Healing Engine ───────────────────────────────────────────────────
  healEnabled: false,
  dryRun:      false,        // true = log what would happen, never execute

  healRules: [
    // Memory pressure → force GC, capture snapshot, restart if critical
    {
      name:   'High memory',
      trigger: { metric: 'memory', threshold: '> 85%' },
      action: 'gc',
      cooldown: '10 minutes',
    },

    // Endpoint error burst → circuit break
    {
      name:    'API error burst',
      trigger: { endpoint: '/api', statusClass: '5xx', minOccurrences: 5 },
      action:  'circuit-break',
      options: { windowMs: 60000, failureThreshold: 5, resetTimeout: 30000 },
    },

    // Rate limit abuse
    {
      name:    'Rate limit abuse',
      trigger: { endpoint: '/api', statusCode: 429, minOccurrences: 10 },
      action:  'rate-limit',
      options: { max: 50, windowMs: 60000 },
    },
  ],

  // ── Service labels (optional) ────────────────────────────────────────────
  // Map URL prefixes to service names shown in the dashboard
  services: {
    api:  '/api',
    auth: '/auth',
    web:  '/',
  },

  // ── Alert thresholds ─────────────────────────────────────────────────────
  thresholds: {
    responseTimeMs: 2000,     // warn above this
    errorRatePercent: 5,      // trigger incident grouping
    memoryPercent: 85,        // high memory alert
    cpuPercent: 80,           // high CPU alert
    eventLoopLagMs: 100,      // event loop lag alert
  },

  // ── Semantic search (NLP) ────────────────────────────────────────────────
  semanticSearch: true,
  qdrantUrl:      'http://localhost:6333',  // vector DB (optional)

  // ── Recovery verification ────────────────────────────────────────────────
  recoveryWindowMs: 5 * 60 * 1000,  // 5 minutes post-action monitoring window
};
