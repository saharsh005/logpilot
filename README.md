# ⚡ LogPilot — Splunk Incident Commander

> Drop-in Express middleware that turns Splunk into the source of truth for an
> autonomous incident lifecycle: detect → collect evidence → investigate with
> AI + Splunk MCP tools → correlate → find similar past incidents → root-cause
> → recommend & simulate recovery → execute → verify → generate an executive
> postmortem → update the knowledge graph. All visualized live in a built-in
> dashboard.

```bash
npm install logpilot
```

```js
const express = require('express');
const logpilot = require('logpilot');

const app = express();

// IMPORTANT: call init() BEFORE you register your routes — see "Gotchas" below
logpilot.init({ app, healEnabled: true });

app.get('/api/orders', /* ... */);
app.listen(3000);
```

Open `http://localhost:4321` for the live dashboard. That's enough to start —
add `logpilot.config.js` for Splunk, AI providers, and custom heal rules.

---

## Why Splunk-first?

Most "AI wrapped around logs" tools treat Splunk as an export target — data
goes in, nothing useful comes back out. LogPilot flips that:

- **Splunk is the system of record.** `/api/incidents` reads from Splunk first
  (via SPL search over your HEC-ingested events) and only falls back to local
  SQLite if Splunk is unavailable — so the dashboard keeps working in a demo
  even without a live Splunk instance.
- **Splunk MCP tools drive the investigation.** The AI Investigator calls a
  tool-use loop (`search_logs`, `find_deployments`, `get_trace`,
  `find_related_incidents`, `get_metric_history`, `get_heal_history`,
  `simulate_recovery`, `estimate_blast_radius`, `predict_incident_growth`,
  `estimate_mttr`, `explain_failure_pattern`) — 11 tools an LLM can call to
  build its own investigation plan.
- **Splunk MLTK powers predictions.** The Predictions page generates SPL using
  Splunk's Machine Learning Toolkit (`DensityFunction`, `StateSpaceForecast`,
  logistic regression) to forecast latency spikes, memory exhaustion, and
  overall outage risk — before they become incidents.
- **Everything degrades gracefully.** No Splunk? No problem — every feature
  above has a deterministic local fallback using SQLite, so the dashboard,
  RCA, and recovery flow all still work for local development and demos.

---

## What it does

| Feature | Description |
|---|---|
| **HTTP monitoring** | Wraps every Express route — latency, errors, status codes |
| **System metrics** | CPU, memory, event loop lag tracked every 5 seconds |
| **Incident groups** | Repeated endpoint errors grouped into clickable timelines |
| **Splunk-first datastore** | `/api/incidents` and friends read from Splunk via SPL, fall back to SQLite |
| **Evidence collection** | Automatic Splunk + local evidence gathering on each incident, with live charts |
| **Correlation graph** | Typed node graph: incident ↔ logs, metrics, deploy, heal actions, related incidents |
| **Knowledge graph** | Builds an Incident/Service/Deployment/Metric/Trace/Recovery/Postmortem graph from Splunk evidence |
| **Similar incident search** | TF-IDF + structural scoring finds matching historical incidents with resolutions |
| **AI Investigator** | Multi-step agentic pipeline: evidence → correlation → similar → hypotheses → RCA |
| **Incident Commander** | One click runs the full pipeline end-to-end, including execution + verification + postmortem |
| **Splunk MCP tool loop** | 11 tools the AI can call: search, deployments, traces, metrics, heal history, blast radius, MTTR, recovery simulation, growth prediction, failure-pattern explanation |
| **MLTK Predictions** | Live SPL using Splunk's ML Toolkit for latency, memory, and outage-risk forecasting |
| **LLM provider support** | OpenAI, Groq, Ollama — with deterministic fallback when unconfigured |
| **Recovery recommendations** | Ranked actions: gc, rollback-deployment, circuit-break, restart, rate-limit |
| **Recovery simulation & verification** | Dry-run an action before executing it; post-action scoring for error rate, confidence, recurrence |
| **Postmortem generation** | Downloadable Markdown reports with timeline, RCA, evidence, and recommendations — plus an executive-grade variant |
| **NLP log search** | Plain-English queries: *"show payment failures last night"* |
| **Anomaly detection** | EWMA-based per-route baselines flag deviations automatically |
| **Self-healing** | Rate limiting, circuit breaking, GC, restart rules from config |
| **Live dashboard** | Incident modal with Overview, ⚡ Commander, Evidence, Correlation, Similar, AI RCA, Actions, Recovery, Postmortem tabs — every chart renders from live data |
| **Low infra footprint** | No Redis, no Docker required — SQLite mode works standalone; Splunk and Qdrant are fully optional |

---

## Quick Start

### 1. Install

```bash
npm install logpilot
```

`@huggingface/transformers` and `@qdrant/js-client-rest` (used for optional
semantic search) are listed as **optional dependencies** — if they fail to
install on a restricted network, LogPilot still installs and runs fine with
keyword search instead.

### 2. Initialize — **before** your routes

```js
const express = require('express');
const logpilot = require('logpilot');

const app = express();

logpilot.init({ app, healEnabled: true });

// your routes go here, AFTER init()
app.get('/api/orders', (req, res) => { /* ... */ });

app.listen(3000);
```

### 3. Open the dashboard

```
http://localhost:4321
```

### 4. Add a config file (optional but recommended)

Copy `logpilot.config.example.js` to `logpilot.config.js` in your project root
and customize thresholds, heal rules, Splunk connection, and AI provider.

---

## ⚠️ Gotchas

**Call `logpilot.init({ app })` before registering your own routes.**
Express matches middleware and routes in registration order. If your routes
are registered first, requests never pass through LogPilot's monitoring
middleware — you'll see an empty dashboard with `totalLogs: 0` and no
incidents, even though your app is returning errors. This is the #1 cause of
"the dashboard shows nothing."

```js
// ✅ Correct
logpilot.init({ app });
app.get('/api/orders', handler);

// ❌ Wrong — /api/orders never gets monitored
app.get('/api/orders', handler);
logpilot.init({ app });
```

**Incidents take a moment to appear.** LogPilot groups repeated errors on the
same endpoint into an incident — send a few failing requests and wait a couple
of seconds for the dashboard to pick it up.

---

## Splunk Setup

See [`SPLUNK_SETUP.md`](./SPLUNK_SETUP.md) for a from-scratch guide (Docker
one-liner included) covering HEC token creation, index setup, and the REST API
credentials needed for SPL search.

```env
SPLUNK_ENABLED=true
SPLUNK_HOST=localhost
SPLUNK_PORT=8089
SPLUNK_HEC_URL=https://localhost:8088
SPLUNK_HEC_TOKEN=your-hec-token
SPLUNK_USERNAME=admin
SPLUNK_PASSWORD=your_password
SPLUNK_INDEX=logpilot
SPLUNK_PROTOCOL=https
```

Splunk is fully optional. If `splunk.enabled` is `false` or Splunk is
unreachable, every endpoint — including the Commander, knowledge graph,
blast radius, and MTTR endpoints — transparently falls back to local SQLite
evidence so the dashboard and demo keep working.

---

## AI Investigation

LogPilot can use an LLM to generate root cause analysis and drive the MCP tool
loop. Add an `ai` block to `logpilot.init()`:

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

When no `ai` block is provided, LogPilot uses its built-in deterministic RCA
engine — no external dependencies required, and no risk of a hallucinated
investigation path during a live demo.

---

## Splunk MCP Tools

Enable the agentic tool-use loop so the AI Investigator can query Splunk
directly and reason over the results:

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
| `simulate_recovery` | Dry-run a recovery action and estimate its effect |
| `estimate_blast_radius` | How many services/paths/events are affected |
| `predict_incident_growth` | Forecast whether an incident is escalating |
| `estimate_mttr` | Estimate time-to-recovery from historical data |
| `explain_failure_pattern` | Natural-language explanation of a recurring failure signature |

MCP is fully optional — omit `mcp.enabled` and it is never loaded.

---

## Incident Commander

The dashboard's **⚡ Commander** tab runs the entire pipeline for a single
incident in one click:

1. **Evidence** — Splunk + local evidence collection
2. **MCP Investigation** — autonomous tool-use loop
3. **Timeline** — normalized event timeline (logs, metrics, deploys, traces, heals)
4. **Correlation** — typed correlation graph
5. **Similar incidents** — TF-IDF + structural matching against history
6. **RCA** — root cause, confidence, evidence
7. **Recovery recommendation** — ranked actions with confidence scoring
8. **Execution** (optional) — runs the recommended heal action
9. **Verification** — checks whether the incident actually resolved
10. **Executive postmortem** — business impact, root cause, contributing factors, prevention
11. **Knowledge graph update** — new nodes/edges for the incident, evidence, and recovery

Each step is shown as it completes, with status and timing. By default,
execution is a **dry run** — toggle `execute: true` when calling
`/api/commander/run/:id` to actually apply the recommended action.

The same tab also exposes **Blast Radius** (how far an incident's impact
spreads), **Estimated MTTR** (based on historical incidents and heal actions),
and the **Knowledge Graph** itself, grouped by node type.

---

## MLTK Predictions

The **MLTK Predictions** page in the dashboard lists Splunk Machine Learning
Toolkit searches for:

- **Latency Spike Forecast** — `DensityFunction`-based outlier detection on response times
- **Memory Exhaustion Forecast** — `StateSpaceForecast` 24h-ahead memory projection
- **Outage Risk Score** — logistic regression combining error rate, latency, memory, and recent incidents

Each card shows the generated SPL, and "Run" executes it against Splunk,
rendering results as dynamic bar charts. Without Splunk enabled, the SPL is
still shown for reference and falls back to local evidence.

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
    enabled: false,           // Enable Splunk evidence collection + Splunk-first datastore
    host: 'localhost',
    port: 8089,
    username: process.env.SPLUNK_USERNAME,
    password: process.env.SPLUNK_PASSWORD,
    index: 'logpilot',
    protocol: 'https',
    rejectUnauthorized: false // useful for local Splunk self-signed certs
  },
  ai: {
    provider: 'openai',       // 'openai' | 'groq' | 'ollama' — omit for deterministic RCA
  },
  mcp: {
    enabled: false,           // Enable the Splunk MCP tool-use loop
    maxToolRounds: 3,
  },
  commander: {
    executeRecovery: false,   // if true, /api/commander/run/:id executes the recommended action by default
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

## Dry Run Mode

Safe for testing heal rules in production without risk:

```js
logpilot.init({ app, healEnabled: true, dryRun: true });
```

All heal actions are logged and alerted but not executed.

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

Then open `http://localhost:4321` to see LogPilot in action with simulated
traffic, errors, and heal events.

---

## Data Retention

Logs and metrics are stored in `.logpilot/logpilot.sqlite` in your project
directory. Data is automatically cleaned up after 7 days via a 3am cron job.

---

## Roadmap

- [x] Group repeated endpoint errors into incident groups
- [x] Show incident timelines from the grouped dashboard view
- [x] Execute config-driven HTTP endpoint actions
- [x] Automatic rate limiting policy suggestions
- [x] Heap snapshots before restart
- [x] Trace-ID based incident correlation across services
- [x] Link heal actions to incidents in timeline
- [x] Heap snapshot health analysis with memory pressure alerts
- [x] Custom remediation hooks support
- [x] Splunk-first datastore with local fallback
- [x] Incident correlation across logs, metrics, and git changes
- [x] AI root-cause analysis reports
- [x] Recovery verification scoring
- [x] Auto-generated Markdown postmortems
- [x] Dashboard charts for status mix, root causes, metrics, and heal actions
- [x] Splunk MCP tool-use loop (11 tools)
- [x] Incident Commander — one-click full pipeline
- [x] Knowledge graph (Incident/Service/Deployment/Metric/Trace/Recovery/Postmortem)
- [x] MLTK predictive searches (latency, memory, outage risk)
- [x] Executive postmortems
- [ ] OpenTelemetry ingestion
- [ ] PostgreSQL/Redis awareness
- [ ] Docker support
- [ ] Kubernetes support
- [ ] Web-based alert rule editor

---

## License

MIT — see [LICENSE](./LICENSE)
