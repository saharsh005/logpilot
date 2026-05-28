// logpilot.config.js
// Drop this file in your project root — logpilot picks it up automatically

module.exports = {
  // Map friendly names to your Express route prefixes
  services: {
    payment:  '/api/payment',
    auth:     '/api/auth',
    catalog:  '/api/catalog',
    orders:   '/api/orders',
  },

  // Thresholds for anomaly detection
  thresholds: {
    errorRatePercent:   15,    // alert if >15% of requests to a service fail
    memoryUsagePercent: 85,    // alert if process RAM > 85%
    responseTimeMs:     2000,  // alert if p95 latency exceeds 2 seconds
    dbQueryTimeMs:      500,   // (future) alert if DB query > 500ms
  },

  // Self-healing rules — evaluated every 30 seconds
  healRules: [
    {
      name: 'Payment service high error rate',
      trigger: {
        service: '/api/payment',
        errorRate: '> 20%',
        window: '5 minutes',
      },
      action: 'circuit-break',
      duration: '10 minutes',          // auto-restores after 10 minutes
      notify: ['slack:#ops-alerts'],
    },
    {
      name: 'Memory leak recovery',
      trigger: {
        metric: 'memory',
        threshold: '> 88%',
        sustained: '3 minutes',        // only fires if sustained, not a spike
      },
      action: 'restart-service',       // triggers process.exit(1) — use with PM2/nodemon
      notify: ['slack:#ops-alerts'],
    },
    {
      name: 'Auth anomaly — notify only',
      trigger: {
        service: '/api/auth',
        anomalyScore: '> 0.85',
      },
      action: 'notify-only',           // alert without auto-healing
      notify: ['slack:#security-alerts'],
    },
    {
      name: 'Force GC on high memory',
      trigger: {
        metric: 'memory',
        threshold: '> 75%',
      },
      action: 'gc',                    // runs global.gc() if --expose-gc flag is set
      notify: ['console'],
    },
  ],

  // Notification targets
  alerts: {
    slack: process.env.SLACK_WEBHOOK_URL,
    pagerduty: process.env.PAGERDUTY_KEY,
  },
};
