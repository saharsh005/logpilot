const db = require('../storage/db');

function correlateMetrics(incident) {
  const windowStart = Math.max(0, (incident.first_seen || Date.now()) - 15 * 60 * 1000);
  const windowEnd = (incident.last_seen || Date.now()) + 5 * 60 * 1000;
  const metrics = db.getRecentMetrics(60).filter(m => m.timestamp >= windowStart && m.timestamp <= windowEnd);

  const max = field => Math.max(0, ...metrics.map(m => Number(m[field] || 0)));
  const avg = field => {
    if (!metrics.length) return 0;
    return Math.round(metrics.reduce((sum, m) => sum + Number(m[field] || 0), 0) / metrics.length);
  };

  const summary = {
    samples: metrics.length,
    maxCpu: max('cpu_percent'),
    maxMemory: max('memory_percent'),
    maxEventLoopLag: max('event_loop_lag'),
    avgCpu: avg('cpu_percent'),
    avgMemory: avg('memory_percent'),
  };

  return {
    ...summary,
    cpuSpike: summary.maxCpu >= 80,
    memorySpike: summary.maxMemory >= 80,
    eventLoopLagSpike: summary.maxEventLoopLag >= 250,
  };
}

module.exports = { correlateMetrics };
