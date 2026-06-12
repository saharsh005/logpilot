const fetch = require('node-fetch');
const https = require('https');
const db = require('../../storage/db');
const { getSplunkClient, getBaseUrl } = require('./splunkClient');

async function searchSplunk(query, config = {}) {
  const client = await getSplunkClient(config);
  if (!client.enabled) {
    return fallbackSearch(query, client.reason);
  }

  const body = new URLSearchParams({
    search: query,
    exec_mode: 'oneshot',
    output_mode: 'json',
    count: String(config.splunk?.count || 50),
  });

  try {
    const agent = client.config.protocol === 'https'
      ? new https.Agent({ rejectUnauthorized: client.config.rejectUnauthorized })
      : undefined;
    const res = await fetch(`${getBaseUrl(client.config)}/services/search/jobs/export`, {
      method: 'POST',
      headers: {
        Authorization: client.authHeader,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
      agent,
    });

    if (!res.ok) throw new Error(`Splunk search failed (${res.status})`);
    const text = await res.text();
    const events = text.split(/\r?\n/)
      .filter(Boolean)
      .map(line => {
        try {
          const parsed = JSON.parse(line);
          return parsed.result || parsed;
        }
        catch (e) { return { _raw: line }; }
      });

    return { source: 'splunk', events, count: events.length, query };
  } catch (err) {
    return fallbackSearch(query, err.message);
  }
}

function fallbackSearch(query, reason) {
  const events = db.queryLogs({ since: Date.now() - 15 * 60 * 1000, limit: 50 });
  return {
    source: 'local',
    reason,
    query,
    events: events.map(log => ({
      _time: new Date(log.timestamp).toISOString(),
      level: log.level,
      service: log.service,
      method: log.method,
      path: log.path,
      status_code: log.status_code,
      response_time: log.response_time,
      _raw: log.message,
    })),
    count: events.length,
  };
}

module.exports = { searchSplunk };
