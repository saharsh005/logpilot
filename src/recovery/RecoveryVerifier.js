const db = require('../storage/db');
const { searchSplunk } = require('../integrations/splunk/splunkSearch');
const { getService: getSplunkService } = require('../integrations/splunk/service');

async function verifyRecovery(incident, config = {}) {
  const windowMs = config.recoveryWindowMs || 5 * 60 * 1000;
  const since = Math.max(incident.last_seen || Date.now(), Date.now() - windowMs);

  let recent = [];
  let source = 'local';

  // Try Splunk first if enabled
  if (config.splunk?.enabled) {
    try {
      const splunkResult = await searchSplunk(
        `search index=${config.splunk.index} path="${incident.path}" earliest=-5m`,
        config
      );
      if (splunkResult?.events?.length) {
        recent = splunkResult.events;
        source = 'splunk';
      }
    } catch (err) {
      // Fall through to local
    }
  }

  // Fallback to local if Splunk failed or not enabled
  if (recent.length === 0) {
    recent = db.queryLogs({ path: incident.path, since, limit: 100 });
    source = 'local';
  }

  const errors = recent.filter(log => {
    if (source === 'splunk') {
      return parseInt(log.status_code || 0) >= 500;
    }
    return log.level === 'error' || Number(log.status_code || 0) >= 500;
  });

  const errorRate = recent.length ? Math.round((errors.length / recent.length) * 100) : 0;
  const resolved = recent.length === 0 || errorRate < 10;
  const confidence = recent.length === 0 ? 65 : Math.max(35, Math.min(96, 100 - errorRate));

  const result = {
    resolved,
    confidence,
    source,
    checkedAt: Date.now(),
    windowMs,
    totalRequests: recent.length,
    errorCount: errors.length,
    errorRate,
  };

  // Emit recovery event to Splunk (non-blocking)
  setImmediate(() => {
    const splunk = getSplunkService();
    if (splunk?.isEnabled()) {
      splunk.sendRecovery(incident.id, result).catch(() => {});
    }
  });

  return result;
}

module.exports = { verifyRecovery };
