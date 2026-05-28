/**
 * Self-Heal Engine
 * Evaluates heal rules against detected anomalies and executes actions.
 * All actions are logged to DB with full audit trail.
 */

const db = require('../storage/db');
const { detectAnomalies } = require('../core/anomaly-detector');

// Active circuit breakers: path → { until, active }
const circuitBreakers = {};
// Rule cooldowns: ruleName → lastFiredAt timestamp
const ruleCooldowns = {};
// Heal subscribers for real-time dashboard updates
let healSubscribers = [];

const COOLDOWN_MS = 10 * 60 * 1000; // 10 min between same rule firing

async function evaluate(config) {
  if (!config.healRules || config.healRules.length === 0) return;

  const anomalies = detectAnomalies(config);
  if (anomalies.length === 0) return;

  for (const rule of config.healRules) {
    const matchedAnomaly = matchRule(rule, anomalies);
    if (!matchedAnomaly) continue;

    // Check cooldown — don't spam the same action
    const lastFired = ruleCooldowns[rule.name] || 0;
    if (Date.now() - lastFired < COOLDOWN_MS) continue;

    ruleCooldowns[rule.name] = Date.now();

    console.log(require('chalk').yellow(`[logpilot] 🔧 Heal rule triggered: "${rule.name}"`));
    console.log(require('chalk').yellow(`           Anomaly: ${matchedAnomaly.message}`));
    console.log(require('chalk').yellow(`           Action: ${rule.action}`));

    await executeAction(rule, matchedAnomaly, config);
  }
}

function matchRule(rule, anomalies) {
  const trigger = rule.trigger;
  if (!trigger) return null;

  for (const anomaly of anomalies) {
    // Match by service path
    if (trigger.service && !anomaly.path?.includes(trigger.service)) continue;

    // Match by anomaly type
    if (trigger.metric === 'memory' && anomaly.type === 'high_memory') return anomaly;
    if (trigger.metric === 'cpu'    && anomaly.type === 'high_cpu') return anomaly;
    if (trigger.metric === 'event-loop' && anomaly.type === 'event_loop_lag') return anomaly;

    // Match by error rate
    if (trigger.errorRate && anomaly.type === 'error_rate') {
      const threshold = parseFloat(trigger.errorRate.replace(/[><%\s]/g, ''));
      if (anomaly.value > threshold) return anomaly;
    }

    // Match by anomaly score (general)
    if (trigger.anomalyScore && anomaly.severity === 'critical') return anomaly;

    // Match general high error rate rule
    if (!trigger.metric && !trigger.errorRate && !trigger.anomalyScore) {
      if (anomaly.type === 'error_rate' && trigger.service &&
          anomaly.path?.includes(trigger.service)) return anomaly;
    }
  }
  return null;
}

async function executeAction(rule, anomaly, config) {
  const dryRun = config.dryRun || false;
  let success = true;
  let notes = '';

  switch (rule.action) {
    case 'circuit-break': {
      const path = anomaly.path || rule.trigger.service;
      const durationMs = parseDuration(rule.duration) || 10 * 60 * 1000;
      if (!dryRun) {
        circuitBreakers[path] = {
          active: true,
          until: Date.now() + durationMs,
          ruleName: rule.name,
        };
        // Auto-restore
        setTimeout(() => {
          if (circuitBreakers[path]) {
            circuitBreakers[path].active = false;
            console.log(require('chalk').green(`[logpilot] ✅ Circuit breaker restored: ${path}`));
          }
        }, durationMs);
      }
      notes = `Circuit breaker on ${path} for ${rule.duration || '10 minutes'}${dryRun ? ' (DRY RUN)' : ''}`;
      console.log(require('chalk').red(`[logpilot] ⛔ Circuit breaker: ${path} — traffic will receive 503 for ${rule.duration || '10 minutes'}`));
      break;
    }

    case 'restart-service': {
      notes = `Service restart triggered${dryRun ? ' (DRY RUN)' : ''}`;
      if (!dryRun) {
        console.log(require('chalk').yellow(`[logpilot] 🔄 Restarting service (process.exit with restart manager)...`));
        // Give time to log before exit
        setTimeout(() => process.exit(1), 500);
      } else {
        console.log(require('chalk').gray(`[logpilot] DRY RUN: Would restart service`));
      }
      break;
    }

    case 'notify-only': {
      notes = `Anomaly detected — notification sent`;
      break;
    }

    case 'scale-replicas': {
      notes = `Scale-up requested (max: ${rule.maxReplicas || 3}) — requires orchestrator integration`;
      console.log(require('chalk').cyan(`[logpilot] 📈 Scale-up signal: ${notes}`));
      break;
    }

    case 'gc': {
      notes = 'Forced garbage collection';
      if (!dryRun && global.gc) {
        global.gc();
        console.log(require('chalk').green(`[logpilot] 🧹 Garbage collection triggered`));
      }
      break;
    }

    default: {
      notes = `Unknown action: ${rule.action}`;
      success = false;
    }
  }

  // Log to DB
  db.insertHealAction({
    ruleName: rule.name,
    triggerDetail: anomaly.message,
    action: rule.action,
    success,
    notes,
  });

  // Send notifications
  if (rule.notify) {
    await sendNotifications(rule.notify, rule, anomaly, notes, config);
  }

  // Notify dashboard subscribers
  notifyHealSubscribers({ rule, anomaly, notes, success, timestamp: Date.now() });
}

async function sendNotifications(notifyList, rule, anomaly, notes, config) {
  const targets = Array.isArray(notifyList) ? notifyList : [notifyList];

  for (const target of targets) {
    if (target.startsWith('slack:') && config.alerts?.slack) {
      await sendSlackAlert(config.alerts.slack, rule, anomaly, notes);
    }
    if (target === 'console') {
      console.log(require('chalk').magenta(`[logpilot] 📢 ALERT: ${anomaly.message} → ${notes}`));
    }
  }
}

async function sendSlackAlert(webhookUrl, rule, anomaly, notes) {
  try {
    const fetch = require('node-fetch');
    const payload = {
      text: `🚨 *logpilot Alert — ${rule.name}*`,
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: `🚨 logpilot Alert` } },
        { type: 'section', fields: [
          { type: 'mrkdwn', text: `*Rule:*\n${rule.name}` },
          { type: 'mrkdwn', text: `*Action:*\n${rule.action}` },
          { type: 'mrkdwn', text: `*Trigger:*\n${anomaly.message}` },
          { type: 'mrkdwn', text: `*Time:*\n${new Date().toLocaleString()}` },
        ]},
        { type: 'section', text: { type: 'mrkdwn', text: `*Notes:* ${notes}` } },
      ],
    };
    await fetch(webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  } catch (e) {
    console.error('[logpilot] Slack notification failed:', e.message);
  }
}

function getCircuitBreakerMiddleware() {
  return function circuitBreakerMiddleware(req, res, next) {
    for (const [path, breaker] of Object.entries(circuitBreakers)) {
      if (breaker.active && req.path.includes(path)) {
        return res.status(503).json({
          error: 'Service temporarily unavailable',
          reason: 'Circuit breaker active — logpilot is protecting this service',
          retryAfter: Math.round((breaker.until - Date.now()) / 1000),
          rule: breaker.ruleName,
        });
      }
    }
    next();
  };
}

function getActiveCircuitBreakers() {
  return Object.entries(circuitBreakers)
    .filter(([, b]) => b.active)
    .map(([path, b]) => ({ path, until: b.until, ruleName: b.ruleName }));
}

function parseDuration(str) {
  if (!str) return null;
  const m = str.match(/(\d+)\s*(minute|min|hour|second|sec)/i);
  if (!m) return null;
  const val = parseInt(m[1]);
  const unit = m[2].toLowerCase();
  if (unit.startsWith('hour')) return val * 3600000;
  if (unit.startsWith('min')) return val * 60000;
  if (unit.startsWith('sec')) return val * 1000;
  return null;
}

function subscribeToHeals(fn) {
  healSubscribers.push(fn);
  return () => { healSubscribers = healSubscribers.filter(s => s !== fn); };
}

function notifyHealSubscribers(event) {
  healSubscribers.forEach(fn => { try { fn(event); } catch (e) {} });
}

module.exports = { evaluate, getCircuitBreakerMiddleware, getActiveCircuitBreakers, subscribeToHeals };
