/**
 * Self-Heal Engine
 * Evaluates heal rules against detected anomalies and executes actions.
 * Supports: rate-limit, circuit-break, gc, restart-service (with heap snapshot),
 *           notify-only, scale-replicas, custom-hook
 */

const db = require('../storage/db');
const { detectAnomalies } = require('../core/anomaly-detector');
const { captureSnapshot } = require('../heap/snapshot');

const circuitBreakers = {};
const rateLimits = {};
const ruleCooldowns = {};
let healSubscribers = [];

const COOLDOWN_MS = 10 * 60 * 1000;

async function evaluate(config) {
  if (!config.healRules || config.healRules.length === 0) return;

  const anomalies = detectAnomalies(config);
  const incidentGroups = db.getIncidentGroups({
    limit: 100,
    since: Date.now() - (parseDuration(config.incidentWindow || '10 minutes') || 10 * 60 * 1000),
  });
  if (anomalies.length === 0 && incidentGroups.length === 0) return;

  for (const rule of config.healRules) {
    const matchedAnomaly = matchRule(rule, anomalies, incidentGroups);
    if (!matchedAnomaly) continue;

    const lastFired = ruleCooldowns[rule.name] || 0;
    if (Date.now() - lastFired < COOLDOWN_MS) continue;

    ruleCooldowns[rule.name] = Date.now();

    console.log(require('chalk').yellow(`[logpilot] 🔧 Heal rule triggered: "${rule.name}"`));
    console.log(require('chalk').yellow(`           Trigger: ${matchedAnomaly.message}`));
    console.log(require('chalk').yellow(`           Action: ${rule.action}`));

    await executeAction(rule, matchedAnomaly, config);
  }
}

function matchRule(rule, anomalies, incidentGroups = []) {
  const trigger = rule.trigger;
  if (!trigger) return null;

  const incidentMatch = matchIncidentRule(trigger, incidentGroups);
  if (incidentMatch) return incidentMatch;

  for (const anomaly of anomalies) {
    if (trigger.service && !anomaly.path?.includes(trigger.service)) continue;
    if (trigger.metric === 'memory' && anomaly.type === 'high_memory') return anomaly;
    if (trigger.metric === 'cpu' && anomaly.type === 'high_cpu') return anomaly;
    if (trigger.metric === 'event-loop' && anomaly.type === 'event_loop_lag') return anomaly;

    if (trigger.errorRate && anomaly.type === 'error_rate') {
      const threshold = parseFloat(trigger.errorRate.replace(/[><%\s]/g, ''));
      if (anomaly.value > threshold) return anomaly;
    }

    if (trigger.anomalyScore && anomaly.severity === 'critical') return anomaly;

    if (!trigger.metric && !trigger.errorRate && !trigger.anomalyScore) {
      if (anomaly.type === 'error_rate' && trigger.service &&
          anomaly.path?.includes(trigger.service)) return anomaly;
    }
  }
  return null;
}

function matchIncidentRule(trigger, incidentGroups) {
  const incidentTrigger = trigger.endpoint || trigger.path || trigger.statusCode ||
    trigger.statusClass || trigger.minOccurrences || trigger.count || trigger.rootCause || trigger.cause;
  if (!incidentTrigger) return null;

  const endpoint = trigger.endpoint || trigger.path || trigger.service;
  if (!endpoint) return null;

  for (const group of incidentGroups) {
    const groupPath = group.path || '';
    if (!groupPath) continue;
    if (!groupPath.includes(endpoint) && !String(endpoint).includes(groupPath)) continue;
    if (trigger.method && String(group.method || '').toUpperCase() !== String(trigger.method).toUpperCase()) continue;
    if (trigger.statusCode && Number(group.status_code) !== Number(trigger.statusCode)) continue;
    if (trigger.statusClass && !String(group.status_code || '').startsWith(String(trigger.statusClass).replace('xx', ''))) continue;

    const minOccurrences = trigger.minOccurrences || trigger.count || 1;
    if ((group.count || 0) < minOccurrences) continue;

    const rootCause = trigger.rootCause || trigger.cause;
    if (rootCause && !String(group.root_cause || '').toLowerCase().includes(String(rootCause).toLowerCase())) continue;

    return {
      type: 'incident_group',
      incidentGroupId: group.id,
      service: group.service,
      path: group.path,
      value: group.count,
      severity: group.severity,
      message: `${group.title} (${group.count} events)`,
      rootCause: group.root_cause,
      group,
    };
  }
  return null;
}

async function executeAction(rule, anomaly, config) {
  const dryRun = config.dryRun || false;
  let success = true;
  let notes = '';

  switch (rule.action) {
    case 'circuit-break': {
      const targetPath = rule.trigger.endpoint || anomaly.path || rule.trigger.service;
      const durationMs = parseDuration(rule.duration) || 10 * 60 * 1000;
      if (!dryRun) {
        circuitBreakers[targetPath] = {
          active: true,
          until: Date.now() + durationMs,
          ruleName: rule.name,
        };
        setTimeout(() => {
          if (circuitBreakers[targetPath]) {
            circuitBreakers[targetPath].active = false;
            console.log(require('chalk').green(`[logpilot] ✅ Circuit breaker restored: ${targetPath}`));
          }
        }, durationMs);
      }
      notes = `Circuit breaker on ${targetPath} for ${rule.duration || '10 minutes'}${dryRun ? ' (DRY RUN)' : ''}`;
      console.log(require('chalk').red(`[logpilot] ⛔ Circuit breaker: ${targetPath} — traffic will receive 503 for ${rule.duration || '10 minutes'}`));
      break;
    }

    case 'rate-limit': {
      const targetPath = rule.trigger.endpoint || anomaly.path || rule.trigger.service;
      const durationMs = parseDuration(rule.duration) || 10 * 60 * 1000;
      const windowMs = parseDuration(rule.window) || 60 * 1000;
      if (!dryRun) {
        rateLimits[targetPath] = {
          active: true,
          until: Date.now() + durationMs,
          ruleName: rule.name,
          maxRequests: rule.maxRequests || 30,
          windowMs,
          hits: {},
        };
        setTimeout(() => {
          if (rateLimits[targetPath]) {
            rateLimits[targetPath].active = false;
            console.log(require('chalk').green(`[logpilot] Rate limit restored: ${targetPath}`));
          }
        }, durationMs);
      }
      notes = `Rate limit on ${targetPath}: ${rule.maxRequests || 30} req/${rule.window || '1 minute'} for ${rule.duration || '10 minutes'}${dryRun ? ' (DRY RUN)' : ''}`;
      console.log(require('chalk').red(`[logpilot] Rate limit active: ${targetPath}`));
      break;
    }

    case 'restart-service': {
      // Capture heap snapshot BEFORE restart
      if (!dryRun) {
        captureSnapshot('pre-restart', `Rule: ${rule.name} — ${anomaly.message}`);
        notes = `Heap snapshot captured. Service restart triggered.`;
        console.log(require('chalk').yellow(`[logpilot] 🔄 Restarting service (process.exit with restart manager)...`));
        setTimeout(() => process.exit(1), 800);
      } else {
        notes = `Service restart triggered (DRY RUN) — heap snapshot would be captured`;
        console.log(require('chalk').gray(`[logpilot] DRY RUN: Would capture heap snapshot and restart service`));
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

    case 'heap-snapshot': {
      // Explicit heap snapshot action (no restart)
      if (!dryRun) {
        const snap = captureSnapshot('heal-rule', `Rule: ${rule.name} — ${anomaly.message}`);
        notes = `Heap snapshot captured: ${snap.heapUsedMb}MB used / ${snap.heapTotalMb}MB total`;
      } else {
        notes = `Heap snapshot would be captured (DRY RUN)`;
      }
      break;
    }

    case 'custom-hook': {
      if (typeof rule.handler !== 'function') {
        notes = 'Custom hook missing handler function';
        success = false;
        break;
      }
      if (!dryRun) {
        try {
          await rule.handler({ rule, anomaly, config });
          notes = `Custom remediation hook executed`;
        } catch (e) {
          notes = `Custom hook error: ${e.message}`;
          success = false;
        }
      } else {
        notes = `Custom hook would execute (DRY RUN)`;
      }
      break;
    }

    default: {
      notes = `Unknown action: ${rule.action}`;
      success = false;
    }
  }

  db.insertHealAction({
    ruleName: rule.name,
    triggerDetail: anomaly.message,
    action: rule.action,
    success,
    notes,
  });
  if (anomaly.incidentGroupId) {
    db.markIncidentAction(anomaly.incidentGroupId, rule.action);
  }

  if (rule.notify) {
    await sendNotifications(rule.notify, rule, anomaly, notes, config);
  }

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
    for (const [targetPath, breaker] of Object.entries(circuitBreakers)) {
      if (breaker.active && req.path.includes(targetPath)) {
        return res.status(503).json({
          error: 'Service temporarily unavailable',
          reason: 'Circuit breaker active — logpilot is protecting this service',
          retryAfter: Math.round((breaker.until - Date.now()) / 1000),
          rule: breaker.ruleName,
        });
      }
    }
    for (const [targetPath, limiter] of Object.entries(rateLimits)) {
      if (!limiter.active || !req.path.includes(targetPath)) continue;
      const now = Date.now();
      const key = `${req.ip || 'unknown'}:${targetPath}`;
      const hit = limiter.hits[key] || { count: 0, resetAt: now + limiter.windowMs };
      if (now > hit.resetAt) { hit.count = 0; hit.resetAt = now + limiter.windowMs; }
      hit.count += 1;
      limiter.hits[key] = hit;
      if (hit.count > limiter.maxRequests) {
        return res.status(429).json({
          error: 'Too many requests',
          reason: 'logpilot rate limit active for this endpoint',
          retryAfter: Math.round((hit.resetAt - now) / 1000),
          rule: limiter.ruleName,
        });
      }
    }
    next();
  };
}

function getActiveCircuitBreakers() {
  return Object.entries(circuitBreakers)
    .filter(([, b]) => b.active)
    .map(([p, b]) => ({ path: p, until: b.until, ruleName: b.ruleName }));
}

function getActiveRateLimits() {
  return Object.entries(rateLimits)
    .filter(([, b]) => b.active)
    .map(([p, b]) => ({ path: p, until: b.until, ruleName: b.ruleName, maxRequests: b.maxRequests, windowMs: b.windowMs }));
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

module.exports = {
  evaluate, getCircuitBreakerMiddleware,
  getActiveCircuitBreakers, getActiveRateLimits,
  subscribeToHeals, parseDuration,
};
