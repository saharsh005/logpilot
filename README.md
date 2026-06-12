# ⚡ logpilot

> Agentic Operations Platform for Node.js — self-healing observability, Splunk integration, AI-powered root cause analysis, and ranked recovery recommendations.

```bash
npm install logpilot
```

```js
import logpilot from 'logpilot';
logpilot.init({ app, healEnabled: true });
```

That's enough to start. Add `logpilot.config.js` when you want endpoint-specific remediation.

---

## What it does

| Feature | Description |
|---|---|
| **HTTP monitoring** | Wraps every Express route — latency, errors, status codes |
| **System metrics** | CPU, memory, event loop lag tracked every 5 seconds |
| **Incident groups** | Repeated endpoint errors grouped into clickable timelines |
| **Splunk integration** | Optional HEC ingest + SPL search; SQLite fallback always available |
| **Evidence collection** | Automatic Splunk + local evidence gathering on each incident |
| **Correlation graph** | Typed node graph: incident ↔ logs, metrics, deploy, heal actions, related incidents |
| **Similar incident search** | TF-IDF + structural scoring finds matching historical incidents with resolutions |
| **AI Investigator** | 6-step agentic pipeline: evidence → correlation → similar → hypotheses → RCA |
| **LLM provider support** | OpenAI, Groq, Ollama — with deterministic fallback when unconfigured |
| **Splunk MCP tools** | Optional tool-use loop: `search_logs`, `find_deployments`, `get_trace`, and more |
| **Recovery recommendations** | Ranked actions: gc, rollback-deployment, circuit-break, restart, rate-limit |
| **Recovery verification** | Post-action scoring: error rate, confidence, recurrence check |
| **Postmortem generation** | Downloadable Markdown reports with timeline, RCA, evidence, and recommendations |
| **NLP log search** | Plain-English queries: *"show payment failures last night"* |
| **Anomaly detection** | EWMA-based per-route baselines flag deviations automatically |
| **Self-healing** | Rate limiting, circuit breaking, GC, restart rules from config |
| **Live dashboard** | 8-tab incident modal: Evidence, Correlation, Similar, AI RCA, Actions, Recovery, Postmortem |
| **Advanced analytics** | Root cause distribution, MTTR, recovery success rate, incident categories |
| **Low infra footprint** | No Redis, no Docker required — SQLite mode works standalone |

---

## Quick Start

### 1. Install

```bash
npm install logpilot
```

### 2. Initialize (2 lines)

```js
const express = require('express');
const logpilot = require('logpilot');

const app = express();

logpilot.init({ app, healEnabled: true });

// ... your routes
app.listen(3000);
```

### 3. Open the dashboard

```
http://localhost:4321
```

### 4. Add a config file (optional but recommended)

Copy `logpilot.config.example.js` to `logpilot.config.js` in your project root and customize it.

---

## AI Investigation

LogPilot can use an LLM to generate root cause analysis. Add an `ai` block to `logpilot.init()`:

```js
logpilot.init({
  app,
  ai: {
    provider: 'openai',                    // 'openai' | 'groq' | 'ollama'
    model: 'gpt-4o-mini',                  // optional — sensible defaults per provider
    apiKey: process.env.OPENAI_API_KEY,    // or GROQ_API_KEY
    temperature: 0.2,
    maxTokens: 1024,
  },
});
```

**Groq (fast + free tier):**
```js
ai: { provider: 'groq', apiKey: process.env.GROQ_API_KEY }
```

**Ollama (local, no API key):**
```js
ai: { provider: 'ollama', model: 'llama3', baseUrl: 'http://localhost:11434' }
```

When no `ai` block is provided, LogPilot uses its built-in deterministic RCA engine — no external dependencies required.

---

## Splunk MCP Tools (optional)

Enable the agentic tool-use loop so the AI Investigator can query Splunk directly:

```js
logpilot.init({
  app,
  splunk: { enabled: true, hecUrl: '...', token: '...', index: 'logpilot' },
  ai:     { provider: 'openai', apiKey: process.env.OPENAI_API_KEY },
  mcp:    { enabled: true, maxToolRounds: 3 },
});
```

Available MCP tools the AI can call:

| Tool | Description |
|------|-------------|
| `search_logs` | Full-text SPL search across Splunk logs |
| `find_deployments` | Recent deployment events near an incident |
| `find_related_incidents` | Historical Splunk incidents by path or root cause |
| `get_trace` | Distributed trace spans for a request |
| `get_metric_history` | CPU/memory/event-loop time series |
| `get_heal_history` | Past remediation actions for an endpoint |

MCP is fully optional — omit `mcp.enabled` and it is never loaded.

---

## Configuration

`logpilot.init()` accepts:

```js
logpilot.init({
  app,                        // Express app (required for HTTP monitoring)
  healEnabled:   true,        // Enable self-heal engine
  dashboard:     true,        // Serve dashboard at dashboardPort
  dashboardPort: 4321,        // Dashboard port (default: 4321)
  configFile:    './logpilot.config.js',  // Path to config file
  storageDir:    './.logpilot',           // SQLite storage directory
  consoleOutput: true,        // Print colored logs to console
  dryRun:        false,       // Simulate heals without executing
  semanticSearch: true,       // Load local embeddings + optional Qdrant semantic search
  splunk: {
    enabled: false,           // Enable Splunk evidence collection
    host: 'localhost',
    port: 8089,
    username: process.env.SPLUNK_USERNAME,
    password: process.env.SPLUNK_PASSWORD,
    index: 'logpilot',
    protocol: 'https',
    rejectUnauthorized: false // useful for local Splunk self-signed certs
  },
});
```

---

## Config File

```js
// logpilot.config.js
module.exports = {
  services: {
    payment: '/api/payment',
    auth:    '/api/auth',
  },

  thresholds: {
    errorRatePercent:   15,    // alert if >15% of requests fail
    memoryUsagePercent: 85,    // alert if RAM > 85%
    responseTimeMs:     2000,  // alert if p95 latency > 2s
  },

  healRules: [
    {
      name: 'Payment endpoint failure burst',
      trigger: {
        endpoint: '/api/payment',
        statusClass: '5xx',
        minOccurrences: 5,
      },
      action: 'rate-limit',
      maxRequests: 30,
      window: '1 minute',
      duration: '10 minutes',
    },
    {
      name: 'Payment high error rate',
      trigger: { service: '/api/payment', errorRate: '> 20%' },
      action: 'circuit-break',
      duration: '10 minutes',
      notify: ['slack:#ops-alerts'],
    },
    {
      name: 'Memory leak recovery',
      trigger: { metric: 'memory', threshold: '> 88%' },
      action: 'restart-service',
      notify: ['slack:#ops-alerts'],
    },
  ],

  alerts: {
    slack: process.env.SLACK_WEBHOOK_URL,
  },

  splunk: {
    enabled: process.env.SPLUNK_ENABLED === 'true',
    host: process.env.SPLUNK_HOST || 'localhost',
    port: process.env.SPLUNK_PORT || 8089,
    username: process.env.SPLUNK_USERNAME,
    password: process.env.SPLUNK_PASSWORD,
    index: process.env.SPLUNK_INDEX || 'logpilot',
    protocol: process.env.SPLUNK_PROTOCOL || 'https',
    rejectUnauthorized: false,
  },
};
```

---

## Splunk, RCA, Recovery, And Postmortems

When an incident is opened in the dashboard, LogPilot now builds a full incident analysis:

1. Splunk Evidence: runs `search index=<index> "<endpoint>" earliest=-15m`.
2. Correlation: combines Splunk/local logs, LogPilot metrics, and recent git commits.
3. AI RCA: produces root cause, confidence, evidence, and a recommended action.
4. Recovery: checks recent requests for the incident endpoint and scores recovery confidence.
5. Postmortem: generates a Markdown report that can be downloaded from the incident modal.

Splunk is optional. If it is disabled or unavailable, LogPilot falls back to local SQLite logs so the RCA flow and dashboard still work during demos.

Environment variables:

```env
SPLUNK_ENABLED=true
SPLUNK_HOST=localhost
SPLUNK_PORT=8089
SPLUNK_USERNAME=admin
SPLUNK_PASSWORD=your_password
SPLUNK_INDEX=logpilot
SPLUNK_PROTOCOL=https
```

You can also provide a custom RCA function:

```js
logpilot.init({
  app,
  rootCauseAnalyzer: async (context) => ({
    rootCause: 'Payment database timeout',
    confidence: 91,
    evidence: ['Dominant Splunk error: Database timeout'],
    recommendation: 'Circuit-break payment writes and inspect the DB pool',
  }),
});
```

---

## Dashboard Charts

The dashboard keeps the same operational layout, with additional visualizations:

- Request and error trends
- HTTP status mix
- Incident root-cause distribution
- CPU and memory recovery signals
- Heal action distribution on the RCA Reports page

Incident details include tabs for Overview, Splunk Evidence, Correlation, AI RCA, Recovery, and Postmortem.

---

## Heal Actions

| Action | What it does |
|---|---|
| `rate-limit` | Temporarily applies per-client request limiting for a matching endpoint |
| `circuit-break` | Returns 503 for matching routes for a configurable duration |
| `restart-service` | Calls `process.exit(1)` — use with PM2 or nodemon for auto-restart |
| `gc` | Triggers `global.gc()` (run node with `--expose-gc`) |
| `scale-replicas` | Emits a scale signal (requires orchestrator integration) |
| `notify-only` | Sends alert without taking action |
| `custom-hook` | Runs a config-provided async handler for custom remediation |

Endpoint rules can match collected incident groups:

```js
{
  name: 'Checkout 5xx protection',
  trigger: {
    endpoint: '/api/checkout',
    method: 'POST',
    statusClass: '5xx',
    minOccurrences: 3,
  },
  action: 'circuit-break',
  duration: '5 minutes',
}
```

---

## NLP Search

```js
// Programmatic search
const results = await logpilot.query('payment errors last night');
console.log(results.groups);   // grouped by root cause pattern
console.log(results.totalFound);
```

Or use the dashboard search bar with queries like:
- *"show all 500 errors"*
- *"auth failures last hour"*
- *"slow requests on catalog"*
- *"DB timeouts yesterday"*
- *"payment gateway rate limit"*

---

## Manual Logging

```js
logpilot.log('error', 'Payment gateway unreachable', { service: 'payment', orderId: '123' });
logpilot.log('warn',  'High cart abandonment rate detected');
logpilot.log('info',  'Batch job completed', { processed: 1500 });
```

---

## Run the Demo

```bash
node test/demo-app.js
```

Then open `http://localhost:4321` to see logpilot in action with simulated traffic, errors, and heal events.

---

## Dry Run Mode

Safe for testing heal rules in production without risk:

```js
logpilot.init({ app, healEnabled: true, dryRun: true });
```

All heal actions are logged and alerted but not executed.

---

## Data Retention

Logs and metrics are stored in `.logpilot/logpilot.sqlite` in your project directory.
Data is automatically cleaned up after 7 days via a 3am cron job.

---

## Current Focus And Roadmap

- [x] Group repeated endpoint errors into incident groups
- [x] Show incident timelines from the grouped dashboard view
- [x] Execute config-driven HTTP endpoint actions
- [x] Automatic rate limiting policy suggestions
- [x] Heap snapshots before restart
- [x] **NEW:** Trace-ID based incident correlation across services
- [x] **NEW:** Link heal actions to incidents in timeline
- [x] **NEW:** Heap snapshot health analysis with memory pressure alerts
- [x] **NEW:** Custom remediation hooks support
- [x] **NEW:** Splunk evidence collection with local fallback
- [x] **NEW:** Incident correlation across logs, metrics, and git changes
- [x] **NEW:** AI root-cause analysis reports
- [x] **NEW:** Recovery verification scoring
- [x] **NEW:** Auto-generated Markdown postmortems
- [x] **NEW:** Dashboard charts for status mix, root causes, metrics, and heal actions
- [ ] OpenTelemetry ingestion
- [ ] PostgreSQL/Redis awareness
- [ ] Docker support
- [ ] Kubernetes support
- [ ] Advanced root-cause correlation (transactional tracing)
- [ ] Web-based alert rule editor
- [ ] npm publish

---

## License

MIT
