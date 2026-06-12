const db = require('../storage/db');
const { updateBaseline } = require('./anomaly-detector');
const { embed, buildLogText, isReady: embedderReady } = require('../nlp/embedder');
const vectorStore = require('../nlp/vector-store');
const { getService: getSplunkService } = require('../integrations/splunk/service');

// Counter for generating Qdrant-compatible integer IDs
let vectorIdCounter = Date.now();

async function indexLogVector(entry) {
  if (!embedderReady() || !vectorStore.isConnected()) return;
  try {
    const logText = buildLogText(entry);
    const vector  = await embed(logText);
    if (!vector) return;
    // Use incrementing ID — Qdrant needs integer or UUID
    const pointId = vectorIdCounter++;
    await vectorStore.upsert(pointId, vector, { ...entry, logText });
  } catch (e) { /* silent — never break the request path */ }
}

let logSubscribers = []; // real-time log push to dashboard

function createMiddleware(config) {
  return function logpilotMiddleware(req, res, next) {
    const startTime = Date.now();
    const originalJson = res.json.bind(res);
    const originalSend = res.send.bind(res);

    let responseCaptured = false;

    function captureResponse(statusCode) {
      if (responseCaptured) return;
      responseCaptured = true;

      const responseTime = Date.now() - startTime;
      const isError = statusCode >= 500;
      const isWarn  = statusCode >= 400 || responseTime > (config.thresholds?.responseTimeMs || 2000);
      const level   = isError ? 'error' : isWarn ? 'warn' : 'info';

      // Detect which service this route belongs to
      let service = 'unknown';
      if (config.services) {
        for (const [name, path] of Object.entries(config.services)) {
          if (req.path.startsWith(path)) { service = name; break; }
        }
      }

      const entry = {
        timestamp: Date.now(),
        level,
        service,
        method: req.method,
        path: req.path,
        statusCode,
        responseTime,
        message: buildMessage(req, statusCode, responseTime),
        metadata: {
          ip: req.ip,
          userAgent: req.get('user-agent'),
          query: Object.keys(req.query).length ? req.query : undefined,
        },
      };

      // Store raw log and attach endpoint failures to a durable incident group.
      const logId = db.insertLog(entry);
      const incident = db.recordIncident(entry, logId);
      if (incident) entry.incidentGroupId = incident.id;

      // Async vector indexing — runs after response is sent, never blocks
      setImmediate(() => indexLogVector(entry).catch(() => {}));

      // Update anomaly baselines
      updateBaseline(req.path, responseTime, isError);

      // Push to real-time subscribers (dashboard WebSocket)
      notifyLogSubscribers(entry);

      // Send to Splunk HEC (non-blocking, fire-and-forget)
      setImmediate(() => {
        const splunk = getSplunkService();
        if (!splunk?.isEnabled()) return;
        splunk.sendRequest(entry).catch(() => {});
        // Emit error event for 5xx responses
        if (entry.statusCode >= 500) {
          splunk.sendEvent('error', {
            method:       entry.method,
            path:         entry.path,
            statusCode:   entry.statusCode,
            responseTime: entry.responseTime,
            service:      entry.service,
            message:      entry.message,
          }).catch(() => {});
        }
        // Emit incident event when a new group is created or updated
        if (incident) {
          splunk.sendIncident(incident).catch(() => {});
        }
      });

      // Console output with color coding
      if (config.consoleOutput !== false) {
        printLog(entry);
      }
    }

    // Intercept res.json
    res.json = function(body) {
      captureResponse(res.statusCode);
      return originalJson(body);
    };

    // Intercept res.send
    res.send = function(body) {
      captureResponse(res.statusCode);
      return originalSend(body);
    };

    // Catch responses that skip json/send
    res.on('finish', () => captureResponse(res.statusCode));

    next();
  };
}

function buildMessage(req, statusCode, responseTime) {
  const parts = [`${req.method} ${req.path} → ${statusCode} (${responseTime}ms)`];
  if (statusCode >= 500) parts.push('Server error');
  else if (statusCode === 429) parts.push('Rate limit exceeded');
  else if (statusCode === 401) parts.push('Unauthorized');
  else if (statusCode === 403) parts.push('Forbidden');
  else if (statusCode === 404) parts.push('Not found');
  else if (responseTime > 3000) parts.push('Slow response');
  return parts.join(' — ');
}

function printLog(entry) {
  const chalk = require('chalk');
  const time = new Date(entry.timestamp).toLocaleTimeString();
  const method = entry.method?.padEnd(6) || '      ';
  const path = entry.path?.padEnd(30) || '';
  const status = String(entry.statusCode || '').padEnd(4);
  const rt = `${entry.responseTime}ms`.padEnd(8);

  let line;
  if (entry.level === 'error') {
    line = chalk.red(`[${time}] ✗ ${method} ${path} ${status} ${rt}`);
  } else if (entry.level === 'warn') {
    line = chalk.yellow(`[${time}] ⚠ ${method} ${path} ${status} ${rt}`);
  } else {
    line = chalk.gray(`[${time}] ✓ ${method} ${path} ${status} ${rt}`);
  }

  console.log(chalk.cyan('[logpilot]'), line);
}

function subscribeToLogs(fn) {
  logSubscribers.push(fn);
  return () => { logSubscribers = logSubscribers.filter(s => s !== fn); };
}

function notifyLogSubscribers(entry) {
  logSubscribers.forEach(fn => { try { fn(entry); } catch (e) {} });
}

// For manually logging custom messages
function logCustom(level, message, metadata = {}) {
  const entry = {
    timestamp: Date.now(),
    level,
    message,
    metadata,
    service: metadata.service || 'app',
  };
  const logId = db.insertLog(entry);
  const incident = db.recordIncident(entry, logId);
  if (incident) entry.incidentGroupId = incident.id;
  notifyLogSubscribers(entry);
}

module.exports = { createMiddleware, subscribeToLogs, logCustom };
