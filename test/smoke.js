const assert = require('assert');
const path = require('path');
const express = require('express');
const fetch = require('node-fetch');
const logpilot = require('../src');

async function main() {
  const app = express();
  app.use(express.json());

  const ready = logpilot.init({
    app,
    dashboard: false,
    healEnabled: false,
    consoleOutput: false,
    semanticSearch: false,
    storageDir: path.join(__dirname, '..', '.logpilot-smoke', String(Date.now())),
    services: {
      payment: '/api/payment',
    },
  });

  app.get('/api/payment/fail', (req, res) => {
    res.status(500).json({ error: 'Payment gateway timeout' });
  });

  await ready;

  const server = app.listen(0);
  const { port } = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/payment/fail`);
    assert.strictEqual(response.status, 500);

    const stats = logpilot.status().stats;
    assert.strictEqual(stats.totalLogs, 1);
    assert.strictEqual(stats.errorLogs, 1);

    const results = await logpilot.query('payment errors');
    assert.strictEqual(results.totalFound, 1);
    assert.strictEqual(results.groups[0].count, 1);

    console.log('[smoke] logpilot captured route logs and keyword search works');
  } finally {
    server.close(() => process.exit(0));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
