/**
 * logpilot.config.js
 * ───────────────────────────────────────────────────────────────────────────
 * Drop this file (renamed to logpilot.config.js) in your project root.
 * LogPilot picks it up automatically on init.
 *
 * FOCUSED SCOPE: HTTP endpoint monitoring + automated remediation.
 * Future: database, queue, and external-service monitoring.
 */

module.exports = {
  // ── Service map ──────────────────────────────────────────────────────────
  // Maps friendly names to Express route prefixes.
  // Anomaly detection and heal rules match against these names/paths.
  services: {
    payment:  '/api/payment',
    auth:     '/api/auth',
    catalog:  '/api/catalog',
    orders:   '/api/orders',
  },

  // ── Anomaly detection thresholds ─────────────────────────────────────────
  thresholds: {
    errorRatePercent:   15,    // alert if >15% of requests to a service fail
    memoryUsagePercent: 85,    // alert if process RSS > 85%
    responseTimeMs:     2000,  // alert if p95 latency exceeds 2s
  },

  // ── Self-healing rules ────────────────────────────────────────────────────
  // Evaluated every 30s. Each rule watches a trigger condition and fires
  // an action if matched (with a 10-minute cooldown between firings).
  //
  // Supported actions for HTTP endpoints:
  //   rate-limit      → throttle requests to the endpoint (429)
  //   circuit-break   → block the endpoint entirely (503) for a duration
  //   heap-snapshot   → capture memory snapshot for analysis (no restart)
  //   restart-service → capture heap snapshot then exit(1) (use with PM2/nodemon)
  //   gc              → force V8 garbage collection (requires --expose-gc)
  //   notify-only     → alert without taking action
  //   custom-hook     → call your own async handler function
  //
  // Trigger conditions:
  //   endpoint / path / service  → match by route prefix
  //   statusCode                 → exact HTTP status (e.g. 500)
  //   statusClass                → status range (e.g. '5xx', '4xx')
  //   minOccurrences / count     → minimum error count in the incident window
  //   errorRate                  → e.g. '> 20%'  (uses anomaly detector)
  //   metric                     → 'memory' | 'cpu' | 'event-loop'
  //   rootCause / cause          → match inferred root cause string
  healRules: [
    // ── Rate-limit a burst of 5xx errors on the payment endpoint ────────────
    {
      name: 'Payment endpoint failure burst',
      trigger: {
        endpoint: '/api/payment',
        statusClass: '5xx',
        minOccurrences: 5,
      },
      action: 'rate-limit',
      maxRequests: 30,          // allow 30 req per window
      window: '1 minute',
      duration: '10 minutes',   // auto-restores after 10 min
      notify: ['console'],
    },

    // ── Circuit-break when payment error rate is sustained ───────────────
    {
      name: 'Payment service high error rate',
      trigger: {
        service: '/api/payment',
        errorRate: '> 20%',
      },
      action: 'circuit-break',
      duration: '10 minutes',
      notify: ['console'],
    },

    // ── Capture heap snapshot + restart on memory pressure ──────────────
    {
      name: 'Memory pressure — restart with snapshot',
      trigger: {
        metric: 'memory',
        threshold: '> 88%',
      },
      action: 'restart-service',  // captures heap snapshot automatically before exit
      notify: ['console'],
    },

    // ── Heap snapshot only (no restart) for moderate memory usage ───────
    {
      name: 'Moderate memory — snapshot for analysis',
      trigger: {
        metric: 'memory',
        threshold: '> 75%',
      },
      action: 'heap-snapshot',
      notify: ['console'],
    },

    // ── Force GC before memory gets critical ─────────────────────────────
    {
      name: 'Force GC on elevated memory',
      trigger: {
        metric: 'memory',
        threshold: '> 70%',
      },
      action: 'gc',
      notify: ['console'],
    },

    // ── Notify-only for auth anomalies ────────────────────────────────────
    {
      name: 'Auth anomaly — alert only',
      trigger: {
        service: '/api/auth',
        anomalyScore: '> 0.85',
      },
      action: 'notify-only',
      notify: ['console'],
    },

    // ── Custom hook example ───────────────────────────────────────────────
    {
      name: 'Custom webhook on catalog errors',
      trigger: {
        endpoint: '/api/catalog',
        statusClass: '5xx',
        minOccurrences: 10,
      },
      action: 'custom-hook',
      handler: async ({ rule, anomaly, config }) => {
        // Your custom logic here — e.g. call an internal API, page someone, etc.
        console.log('[custom-hook]', rule.name, anomaly.message);
      },
      notify: ['console'],
    },
  ],

  // ── Notification targets ──────────────────────────────────────────────────
  alerts: {
    slack: process.env.SLACK_WEBHOOK_URL,
    // pagerduty: process.env.PAGERDUTY_KEY,  // future
  },

  // ── Dashboard ─────────────────────────────────────────────────────────────
  dashboardPort: 4321,

  // ── Optional overrides ────────────────────────────────────────────────────
  // consoleOutput: true,        // log requests to terminal
  // dryRun: false,              // simulate heals without executing
  // semanticSearch: true,       // enable NLP search (requires Qdrant)
  // qdrantUrl: 'http://localhost:6333',
  // incidentWindow: '10 minutes', // window for incident grouping
};
