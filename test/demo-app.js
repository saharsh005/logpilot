/**
 * logpilot DEMO APP
 * A simulated e-commerce backend with random errors, slow routes, and memory pressure.
 * Shows logpilot monitoring and self-healing in real time.
 *
 * Run: node test/demo-app.js
 * Then open: http://localhost:4321
 */

const express = require('express');
const logpilot = require('../src/index');

const app = express();
app.use(express.json());

// ── Initialize logpilot ───────────────────────────────────────────────────────
logpilot.init({
  app,
  healEnabled:   true,
  dashboard:     true,
  dashboardPort: 4321,
  dryRun:        false,          // safe for demo — won't actually restart
  consoleOutput: true,

  services: {
    payment: '/api/payment',
    auth:    '/api/auth',
    catalog: '/api/catalog',
  },

  thresholds: {
    errorRatePercent:   20,
    memoryUsagePercent: 85,
    responseTimeMs:     1500,
  },

  healRules: [
    {
      name: 'Payment service high error rate',
      trigger: { service: '/api/payment', errorRate: '> 20%' },
      action: 'circuit-break',
      duration: '2 minutes',
      notify: ['console'],
    },
    {
      name: 'High memory usage',
      trigger: { metric: 'memory', threshold: '> 80%' },
      action: 'gc',
      notify: ['console'],
    },
  ],
});

// ── Simulated Routes ──────────────────────────────────────────────────────────

// Payment — 30% error rate to trigger heal rules
app.post('/api/payment/charge', (req, res) => {
  const delay = 200 + Math.random() * 800;
  setTimeout(() => {
    if (Math.random() < 0.30) {
      return res.status(500).json({ error: 'Payment gateway timeout', code: 'GW_TIMEOUT' });
    }
    if (Math.random() < 0.10) {
      return res.status(429).json({ error: 'Rate limit exceeded', retryAfter: 60 });
    }
    res.json({ success: true, transactionId: 'txn_' + Math.random().toString(36).slice(2) });
  }, delay);
});

app.get('/api/payment/history', (req, res) => {
  setTimeout(() => res.json({ transactions: [], total: 0 }), 100 + Math.random() * 300);
});

// Auth — mostly healthy
app.post('/api/auth/login', (req, res) => {
  const delay = 50 + Math.random() * 200;
  setTimeout(() => {
    if (Math.random() < 0.05) return res.status(401).json({ error: 'Invalid credentials' });
    res.json({ token: 'jwt_' + Math.random().toString(36).slice(2), expiresIn: 3600 });
  }, delay);
});

app.post('/api/auth/logout', (req, res) => {
  setTimeout(() => res.json({ success: true }), 30);
});

// Catalog — occasional slow responses
app.get('/api/catalog/products', (req, res) => {
  // Simulate DB query
  const delay = Math.random() < 0.15 ? 2500 + Math.random() * 1000 : 100 + Math.random() * 400;
  setTimeout(() => {
    res.json({
      products: Array.from({ length: 20 }, (_, i) => ({ id: i, name: `Product ${i}`, price: Math.random() * 100 })),
    });
  }, delay);
});

app.get('/api/catalog/search', (req, res) => {
  setTimeout(() => {
    if (Math.random() < 0.08) return res.status(500).json({ error: 'Search index unavailable' });
    res.json({ results: [], query: req.query.q });
  }, 50 + Math.random() * 300);
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', ...logpilot.status() });
});

// ── Start server ──────────────────────────────────────────────────────────────
const PORT = 3000;
app.listen(PORT, () => {
  const chalk = require('chalk');
  console.log(chalk.green(`\n[demo] App running at http://localhost:${PORT}`));
  console.log(chalk.gray('[demo] Generating synthetic traffic...\n'));
  simulateTraffic();
});

// ── Traffic simulator ─────────────────────────────────────────────────────────
function simulateTraffic() {
  const fetch = require('node-fetch');
  const base = `http://localhost:${PORT}`;

  const routes = [
    { method: 'POST', url: '/api/payment/charge',   weight: 4, body: { amount: 99.99, currency: 'USD' } },
    { method: 'GET',  url: '/api/payment/history',  weight: 2 },
    { method: 'POST', url: '/api/auth/login',        weight: 3, body: { email: 'user@example.com', password: 'pass' } },
    { method: 'POST', url: '/api/auth/logout',       weight: 1 },
    { method: 'GET',  url: '/api/catalog/products',  weight: 5 },
    { method: 'GET',  url: '/api/catalog/search?q=shoes', weight: 3 },
    { method: 'GET',  url: '/health',                weight: 1 },
  ];

  // Weighted random selection
  const weighted = routes.flatMap(r => Array(r.weight).fill(r));

  async function fireRequest() {
    const route = weighted[Math.floor(Math.random() * weighted.length)];
    try {
      await fetch(base + route.url, {
        method: route.method,
        headers: { 'Content-Type': 'application/json' },
        body: route.body ? JSON.stringify(route.body) : undefined,
      });
    } catch (e) { /* circuit breaker returns 503 — that's ok */ }
  }

  // Fire requests at variable rates
  function scheduleNext() {
    const delay = 300 + Math.random() * 700; // ~1-2 req/sec
    setTimeout(async () => {
      await fireRequest();
      scheduleNext();
    }, delay);
  }

  // Start 3 concurrent traffic streams
  scheduleNext();
  scheduleNext();
  scheduleNext();

  console.log(require('chalk').cyan('[demo] Traffic streams started. Watch the dashboard at http://localhost:4321'));
}
