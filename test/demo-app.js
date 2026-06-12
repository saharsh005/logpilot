/**
 * logpilot DEMO APP
 * ─────────────────────────────────────────────────────────────────────────
 * Simulated e-commerce backend that showcases ALL logpilot features:
 *   • Incident groups (error clustering)
 *   • Root-cause correlation & connected incidents
 *   • Incident timeline (click any group)
 *   • Rate limiting + circuit breaker auto-heal
 *   • Heap snapshot capture (manual + auto on restart)
 *   • Custom remediation hook
 *   • Live log stream
 *   • NLP search
 *
 * Run:   node test/demo-app.js
 * Open:  http://localhost:4321
 */

require('dotenv').config();

const express = require('express');
const logpilot = require('../src/index');

const app = express();
app.use(express.json());

logpilot.init({
  app,

  // Core
  healEnabled: true,
  dashboard: true,
  dashboardPort: 4321,
  dryRun: false,
  consoleOutput: true,

  // Splunk Integration
  splunk: {
    enabled: true,

    // HEC
    hecUrl: process.env.SPLUNK_HEC_URL,
    token: process.env.SPLUNK_HEC_TOKEN,
    index: process.env.SPLUNK_INDEX || 'logpilot',

    // Search API
    host: process.env.SPLUNK_HOST || 'localhost',
    port: process.env.SPLUNK_PORT || 8089,
    protocol: process.env.SPLUNK_PROTOCOL || 'https',
    username: process.env.SPLUNK_USERNAME,
    password: process.env.SPLUNK_PASSWORD,

    rejectUnauthorized: false,

    batchSize: 100,
    flushInterval: 5000,
    retryAttempts: 3,
    maxQueueSize: 1000
  },

  // AI Investigator
  ai: {
    provider: process.env.LOGPILOT_AI_PROVIDER || 'groq',
    apiKey: process.env.GROQ_API_KEY,
    model: process.env.LOGPILOT_AI_MODEL || 'llama-3.3-70b-versatile',
    temperature: 0.2,
    maxTokens: 1024
  },

  // MCP Agent Tools
  mcp: {
    enabled: true,
    maxToolRounds: 3
  },

  services: {
    payment: '/api/payment',
    auth: '/api/auth',
    catalog: '/api/catalog',
    orders: '/api/orders'
  },

  thresholds: {
    errorRatePercent: 20,
    memoryUsagePercent: 85,
    responseTimeMs: 1500
  },

  healRules: [
    {
      name: 'Payment: rate-limit on failure burst',
      trigger: {
        endpoint: '/api/payment',
        statusClass: '5xx',
        minOccurrences: 5
      },
      action: 'rate-limit',
      maxRequests: 5,
      window: '1 minute',
      duration: '2 minutes',
      notify: ['console']
    },

    {
      name: 'Payment: circuit-break high error rate',
      trigger: {
        service: '/api/payment',
        errorRate: '> 30%'
      },
      action: 'circuit-break',
      duration: '2 minutes',
      notify: ['console']
    },

    {
      name: 'Memory: capture heap snapshot',
      trigger: {
        metric: 'memory',
        threshold: '> 50%'
      },
      action: 'heap-snapshot',
      notify: ['console']
    },

    {
      name: 'Memory: force GC',
      trigger: {
        metric: 'memory'
      },
      action: 'gc',
      notify: ['console']
    },

    {
      name: 'Catalog: custom webhook alert',
      trigger: {
        endpoint: '/api/catalog',
        statusClass: '5xx',
        minOccurrences: 8
      },
      action: 'custom-hook',
      handler: async ({ rule, anomaly }) => {
        console.log(
          `[demo-hook] ${rule.name}: ${anomaly.message}`
        );
      },
      notify: ['console']
    }
  ]
});


// ── Routes ──────────────────────────────────────────────────────────────────

// Payment — high error rate to trigger heal rules
app.post('/api/payment/charge', (req, res) => {
  setTimeout(() => {
    const r = Math.random();
    if (r < 0.35) return res.status(500).json({ error: 'Payment gateway timeout', code: 'GW_TIMEOUT' });
    if (r < 0.45) return res.status(429).json({ error: 'Rate limit exceeded', retryAfter: 60 });
    res.json({ success: true, transactionId: 'txn_' + Math.random().toString(36).slice(2) });
  }, 200 + Math.random() * 800);
});

app.get('/api/payment/history', (req, res) => {
  setTimeout(() => res.json({ transactions: [], total: 0 }), 80 + Math.random() * 200);
});

app.post('/api/payment/refund', (req, res) => {
  setTimeout(() => {
    if (Math.random() < 0.2) return res.status(500).json({ error: 'Refund service unavailable' });
    res.json({ success: true, refundId: 'ref_' + Math.random().toString(36).slice(2) });
  }, 150 + Math.random() * 400);
});

// Auth — occasional 401s and slow responses (connects to payment via Auth root cause)
app.post('/api/auth/login', (req, res) => {
  setTimeout(() => {
    if (Math.random() < 0.07) return res.status(401).json({ error: 'Invalid credentials' });
    if (Math.random() < 0.03) return res.status(500).json({ error: 'Auth service error' });
    res.json({ token: 'jwt_' + Math.random().toString(36).slice(2), expiresIn: 3600 });
  }, 50 + Math.random() * 200);
});

app.post('/api/auth/logout', (req, res) => {
  setTimeout(() => res.json({ success: true }), 30);
});

app.post('/api/auth/refresh', (req, res) => {
  setTimeout(() => {
    if (Math.random() < 0.05) return res.status(401).json({ error: 'Token expired' });
    res.json({ token: 'jwt_' + Math.random().toString(36).slice(2) });
  }, 60 + Math.random() * 150);
});

// Catalog — occasional slow + errors (share root cause with orders)
app.get('/api/catalog/products', (req, res) => {
  const slow = Math.random() < 0.15;
  setTimeout(() => {
    if (Math.random() < 0.10) return res.status(500).json({ error: 'Database query timeout' });
    res.json({ products: Array.from({ length: 20 }, (_, i) => ({ id: i, name: `Product ${i}`, price: +(Math.random()*100).toFixed(2) })) });
  }, slow ? 2500 + Math.random() * 1000 : 80 + Math.random() * 300);
});

app.get('/api/catalog/search', (req, res) => {
  setTimeout(() => {
    if (Math.random() < 0.08) return res.status(500).json({ error: 'Search index unavailable' });
    res.json({ results: [], query: req.query.q });
  }, 50 + Math.random() * 250);
});

// Orders — similar DB errors to catalog (will correlate as related incidents)
app.post('/api/orders/create', (req, res) => {
  setTimeout(() => {
    if (Math.random() < 0.12) return res.status(500).json({ error: 'Database connection timeout' });
    res.json({ orderId: 'ord_' + Math.random().toString(36).slice(2), status: 'pending' });
  }, 100 + Math.random() * 500);
});

app.get('/api/orders/:id', (req, res) => {
  setTimeout(() => {
    if (Math.random() < 0.05) return res.status(404).json({ error: 'Order not found' });
    res.json({ id: req.params.id, status: 'shipped' });
  }, 60 + Math.random() * 200);
});

// Health
app.get('/health', (req, res) => {
  res.json({ status: 'ok', ...logpilot.status() });
});

// ── Start server ─────────────────────────────────────────────────────────────
const PORT = 3000;
app.listen(PORT, () => {
  const chalk = require('chalk');
  console.log(chalk.green(`\n[demo] App listening at http://localhost:${PORT}`));
  console.log(chalk.cyan('[demo] Dashboard → http://localhost:4321'));
  console.log(chalk.gray('[demo] Generating synthetic traffic across all endpoints...\n'));
  simulateTraffic();
});

// ── Traffic simulator ─────────────────────────────────────────────────────────
function simulateTraffic() {
  const fetch = require('node-fetch');
  const base = `http://localhost:${PORT}`;

  const routes = [
    { method: 'POST', url: '/api/payment/charge',  weight: 5, body: { amount: 99.99 } },
    { method: 'GET',  url: '/api/payment/history', weight: 2 },
    { method: 'POST', url: '/api/payment/refund',  weight: 1, body: { txnId: 'txn_abc' } },
    { method: 'POST', url: '/api/auth/login',       weight: 3, body: { email: 'user@example.com', password: 'pass' } },
    { method: 'POST', url: '/api/auth/logout',      weight: 1 },
    { method: 'POST', url: '/api/auth/refresh',     weight: 2 },
    { method: 'GET',  url: '/api/catalog/products', weight: 5 },
    { method: 'GET',  url: '/api/catalog/search?q=shoes', weight: 3 },
    { method: 'POST', url: '/api/orders/create',    weight: 3, body: { productId: 1 } },
    { method: 'GET',  url: '/api/orders/ord_123',   weight: 2 },
    { method: 'GET',  url: '/health',               weight: 1 },
  ];

  const weighted = routes.flatMap(r => Array(r.weight).fill(r));

  async function fireRequest() {
    const route = weighted[Math.floor(Math.random() * weighted.length)];
    try {
      await fetch(base + route.url, {
        method: route.method,
        headers: { 'Content-Type': 'application/json' },
        body: route.body ? JSON.stringify(route.body) : undefined,
        timeout: 5000,
      });
    } catch (e) { /* circuit breaker 503 / rate limit 429 — expected */ }
  }

  function scheduleNext(jitter = 0) {
    setTimeout(async () => {
      await fireRequest();
      scheduleNext(Math.random() * 200);
    }, 400 + jitter);
  }

  // 4 concurrent streams
  scheduleNext(0);
  scheduleNext(100);
  scheduleNext(200);
  scheduleNext(300);

  console.log(require('chalk').cyan('[demo] 4 traffic streams running. Open http://localhost:4321 to watch.'));
}
