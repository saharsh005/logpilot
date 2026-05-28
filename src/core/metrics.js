const db = require('../storage/db');

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
  }, intervalMs);

  // Don't block process exit
  if (metricsInterval.unref) metricsInterval.unref();
  if (eventLoopInterval.unref) eventLoopInterval.unref();
}

function collectMetrics() {
  const mem = process.memoryUsage();
  const totalMem = require('os').totalmem();
  const memMb = Math.round(mem.rss / 1024 / 1024);
  const memPercent = Math.round((mem.rss / totalMem) * 100);

  // CPU usage approximation via process.cpuUsage()
  const cpuUsage = process.cpuUsage();
  const cpuPercent = Math.min(100, Math.round((cpuUsage.user + cpuUsage.system) / 10000 / 100));

  return {
    cpu: cpuPercent,
    memoryMb: memMb,
    memoryPercent: memPercent,
    eventLoopLag,
    heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
    heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
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
