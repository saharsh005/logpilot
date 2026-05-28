/**
 * Anomaly Detector
 * Uses EWMA (Exponentially Weighted Moving Average) for baseline,
 * then flags deviations. Simple, effective, zero dependencies.
 */

const db = require('../storage/db');

// EWMA state per route
const routeBaselines = {};
// Global metric baselines
const metricBaselines = { memory: [], cpu: [], responseTime: [] };

const EWMA_ALPHA = 0.1; // smoothing factor — lower = more stable baseline

function updateEWMA(current, previous, alpha = EWMA_ALPHA) {
  if (previous === null || previous === undefined) return current;
  return alpha * current + (1 - alpha) * previous;
}

function updateBaseline(route, responseTime, isError) {
  if (!routeBaselines[route]) {
    routeBaselines[route] = {
      avgResponseTime: responseTime,
      errorRate: isError ? 1 : 0,
      requestCount: 0,
      p95ResponseTime: responseTime,
      recentResponseTimes: [],
    };
  }

  const b = routeBaselines[route];
  b.requestCount++;
  b.avgResponseTime = updateEWMA(responseTime, b.avgResponseTime);
  b.errorRate = updateEWMA(isError ? 1 : 0, b.errorRate);

  b.recentResponseTimes.push(responseTime);
  if (b.recentResponseTimes.length > 100) b.recentResponseTimes.shift();

  // Update p95
  if (b.recentResponseTimes.length >= 20) {
    const sorted = [...b.recentResponseTimes].sort((a, c) => a - c);
    b.p95ResponseTime = sorted[Math.floor(sorted.length * 0.95)];
  }
}

function detectAnomalies(config) {
  const anomalies = [];
  const thresholds = config.thresholds || {};

  // Check per-route error rates
  const services = config.services || {};
  for (const [name, path] of Object.entries(services)) {
    const errorRate = db.getErrorRate(path, 5 * 60 * 1000); // 5 min window
    if (errorRate > (thresholds.errorRatePercent || 20)) {
      anomalies.push({
        type: 'error_rate',
        service: name,
        path,
        value: errorRate,
        threshold: thresholds.errorRatePercent || 20,
        severity: errorRate > 50 ? 'critical' : 'high',
        message: `${name} error rate is ${errorRate}% (threshold: ${thresholds.errorRatePercent || 20}%)`,
      });
    }

    // Check response time from baselines
    const baseline = routeBaselines[path];
    if (baseline && baseline.p95ResponseTime > (thresholds.responseTimeMs || 2000)) {
      anomalies.push({
        type: 'slow_response',
        service: name,
        path,
        value: baseline.p95ResponseTime,
        threshold: thresholds.responseTimeMs || 2000,
        severity: 'medium',
        message: `${name} p95 response time is ${baseline.p95ResponseTime}ms`,
      });
    }
  }

  // Check system metrics
  const latestMetric = db.getLatestMetric();
  if (latestMetric) {
    if (latestMetric.memory_percent > (thresholds.memoryUsagePercent || 85)) {
      anomalies.push({
        type: 'high_memory',
        value: latestMetric.memory_percent,
        threshold: thresholds.memoryUsagePercent || 85,
        severity: latestMetric.memory_percent > 95 ? 'critical' : 'high',
        message: `Memory usage is ${latestMetric.memory_percent}% (threshold: ${thresholds.memoryUsagePercent || 85}%)`,
      });
    }

    if (latestMetric.cpu_percent > 80) {
      anomalies.push({
        type: 'high_cpu',
        value: latestMetric.cpu_percent,
        threshold: 80,
        severity: 'medium',
        message: `CPU usage is ${latestMetric.cpu_percent}%`,
      });
    }

    if (latestMetric.event_loop_lag > 500) {
      anomalies.push({
        type: 'event_loop_lag',
        value: latestMetric.event_loop_lag,
        threshold: 500,
        severity: 'high',
        message: `Event loop lag is ${latestMetric.event_loop_lag}ms — app may be blocking`,
      });
    }
  }

  return anomalies;
}

function getRouteBaselines() {
  return routeBaselines;
}

module.exports = { updateBaseline, detectAnomalies, getRouteBaselines };
