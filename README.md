# ⚡ logpilot

> Zero-config monitoring, NLP log search, and self-healing for Node.js apps.

```bash
npm install logpilot
```

```js
import logpilot from 'logpilot';
logpilot.init({ app, healEnabled: true });
```

That's it. Your app is now monitored, searchable, and self-healing.

---

## What it does

| Feature | Description |
|---|---|
| **Auto monitoring** | Wraps every Express route — captures latency, errors, status codes |
| **System metrics** | Tracks CPU, memory, event loop lag every 5 seconds |
| **NLP log search** | Query logs in plain English: *"show payment failures last night"* |
| **Anomaly detection** | EWMA-based baselines per route — flags deviations automatically |
| **Self-healing** | Circuit breaking, GC, restart, scale — defined in a config file |
| **Live dashboard** | Real-time UI at `localhost:4321` with WebSocket log stream |
| **Zero dependencies on infra** | No Redis, no Docker, no cloud — just SQLite locally |

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
};
```

---

## Heal Actions

| Action | What it does |
|---|---|
| `circuit-break` | Returns 503 for matching routes for a configurable duration |
| `restart-service` | Calls `process.exit(1)` — use with PM2 or nodemon for auto-restart |
| `gc` | Triggers `global.gc()` (run node with `--expose-gc`) |
| `scale-replicas` | Emits a scale signal (requires orchestrator integration) |
| `notify-only` | Sends alert without taking action |

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

## Roadmap

- [ ] PostgreSQL storage backend for multi-instance deployments
- [ ] Kubernetes-native heal actions via k8s API
- [ ] Vector embeddings for true semantic search
- [ ] Distributed tracing integration (OpenTelemetry)
- [ ] Web-based alert rule editor
- [ ] npm publish

---

## License

MIT
