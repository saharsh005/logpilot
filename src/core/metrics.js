const db = require('../storage/db');
const { getService: getSplunkService } = require('../integrations/splunk/service');

let metricsInterval = null;
let eventLoopInterval = null;
let lastEventLoopCheck = Date.now();
let eventLoopLag = 0;
let subscribers = []; // for real-time push to dashboard

function startMetricsCollection(intervalMs = 5000) {
  // Event loop lag detector — measures how delayed the event loop is
  eventLoopInterval = setInterval(() => {
    const now = Date.now();
    eventLoopLag = Math.max(0, now - lastEventLoopCheck - 100);
    lastEventLoopCheck = now;
  }, 100);

  metricsInterval = setInterval(() => {
    const metric = collectMetrics();
    db.insertMetric(metric);
    notifySubscribers(metric);

    // Send sample of metrics to Splunk (10% sample rate to reduce volume)
    if (Math.random() < 0.1) {
      setImmediate(() => {
        const splunk = getSplunkService();
        if (splunk?.isEnabled()) {
          splunk.sendEvent('metric', {
            // CPU
            cpuLoad:      metric.cpuLoad,
            cpuCount:     metric.cpuCount,
            cpu:          metric.cpu,
            // Memory
            memoryPercent:  metric.memoryPercent,
            memoryUsedMB:   metric.memoryUsedMB,
            totalMemoryMB:  metric.totalMemoryMB,
            memoryMb:       metric.memoryMb,
            // Heap
            heapUsedMB:   metric.heapUsedMB,
            heapTotalMB:  metric.heapTotalMB,
            rssMB:        metric.rssMB,
            externalMB:   metric.externalMB,
            heapUsedMb:   metric.heapUsedMb,
            heapTotalMb:  metric.heapTotalMb,
            // Event loop
            eventLoopLagMs: metric.eventLoopLagMs,
            eventLoopLag:   metric.eventLoopLag,
            timestamp:    metric.timestamp,
          }).catch(() => {});
        }
      });
    }
  }, intervalMs);

  // Don't block process exit
  if (metricsInterval.unref) metricsInterval.unref();
  if (eventLoopInterval.unref) eventLoopInterval.unref();
}

function collectMetrics() {
  const os  = require('os');
  const mem = process.memoryUsage();

  // ── CPU ────────────────────────────────────────────────────────────────
  const cpuLoad  = os.loadavg()[0];          // 1-min load average
  const cpuCount = os.cpus().length;

  // Legacy percent approximation (kept for existing dashboard charts)
  const cpuUsage   = process.cpuUsage();
  const cpuPercent = Math.min(100, Math.round((cpuUsage.user + cpuUsage.system) / 10000 / 100));

  // ── Memory ────────────────────────────────────────────────────────────
  const totalMem       = os.totalmem();
  const totalMemoryMB  = Math.round(totalMem / 1024 / 1024);
  const memoryUsedMB   = Math.round((totalMem - os.freemem()) / 1024 / 1024);
  const memoryPercent  = Math.round(((totalMem - os.freemem()) / totalMem) * 100);
  const memMb          = memoryUsedMB;    // alias kept for existing callers

  // ── Node heap ─────────────────────────────────────────────────────────
  const heapUsedMB  = Math.round(mem.heapUsed  / 1024 / 1024);
  const heapTotalMB = Math.round(mem.heapTotal  / 1024 / 1024);
  const rssMB       = Math.round(mem.rss        / 1024 / 1024);
  const externalMB  = Math.round(mem.external   / 1024 / 1024);

  return {
    // ── Canonical field names (task spec) ────────────────────────────────
    cpuLoad,
    cpuCount,
    memoryPercent,
    memoryUsedMB,
    totalMemoryMB,
    heapUsedMB,
    heapTotalMB,
    rssMB,
    externalMB,
    eventLoopLagMs: eventLoopLag,

    // ── Legacy aliases (keep existing dashboard/db callers working) ───────
    cpu:          cpuPercent,
    memoryMb:     memMb,
    heapUsedMb:   heapUsedMB,
    heapTotalMb:  heapTotalMB,
    eventLoopLag,

    timestamp: Date.now(),
  };
}

function getCurrentMetrics() {
  return collectMetrics();
}

function subscribe(fn) {
  subscribers.push(fn);
  return () => { subscribers = subscribers.filter(s => s !== fn); };
}

function notifySubscribers(metric) {
  subscribers.forEach(fn => { try { fn(metric); } catch (e) {} });
}

function stopMetricsCollection() {
  if (metricsInterval) clearInterval(metricsInterval);
  if (eventLoopInterval) clearInterval(eventLoopInterval);
}

module.exports = { startMetricsCollection, stopMetricsCollection, getCurrentMetrics, collectMetrics, subscribe };
