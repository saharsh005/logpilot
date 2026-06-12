const { searchSplunk } = require('../integrations/splunk/splunkSearch');

async function correlateLogs(incident, config = {}) {
  const index = config.splunk?.index || process.env.SPLUNK_INDEX || 'logpilot';
  const endpoint = incident.path ? ` "${incident.path}"` : '';
  const query = `search index=${index}${endpoint} earliest=-15m`;
  const result = await searchSplunk(query, config);
  const frequencies = {};

  for (const event of result.events || []) {
    const message = event._raw || event.message || event.msg || '';
    if (!message) continue;
    const key = normalizeMessage(message);
    frequencies[key] = (frequencies[key] || 0) + 1;
  }

  const dominantErrors = Object.entries(frequencies)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([message, count]) => ({ message, count }));

  return {
    source: result.source,
    query,
    count: result.count,
    reason: result.reason,
    events: result.events || [],
    dominantErrors,
    frequencies,
  };
}

function normalizeMessage(message) {
  return String(message)
    .replace(/\b\d{2,}\b/g, ':num')
    .replace(/[0-9a-f]{8,}/gi, ':id')
    .slice(0, 180);
}

module.exports = { correlateLogs };
