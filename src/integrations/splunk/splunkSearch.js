const fetch = require('node-fetch');
const db = require('../../storage/db');
const { getSplunkClient, getBaseUrl, getAgent } = require('./splunkClient');

function normalizeSearch(query) {
  const spl = String(query || '').trim();
  if (!spl) return 'search *';
  if (/^(search|tstats|from|makeresults|inputlookup|metadata|savedsearch|\/)/i.test(spl)) {
    return spl;
  }
  if (spl.startsWith('|')) return spl;
  return `search ${spl}`;
}

function parseExportResponse(text) {
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap(line => {
      try {
        const parsed = JSON.parse(line);
        if (parsed.result) return [parsed.result];
        if (Array.isArray(parsed.results)) return parsed.results;
        if (parsed.preview || parsed.messages) return [];
        return [parsed];
      } catch {
        return [{ _raw: line }];
      }
    });
}

async function searchSplunk(query, config = {}) {
  const client = await getSplunkClient(config);
  const search = normalizeSearch(query);
  const count = Number(config.splunk?.count || config.splunk?.searchLimit || 50);

  if (!client.enabled) {
    return fallbackSearch(search, client.reason, count);
  }

  const body = new URLSearchParams({
    search,
    exec_mode: 'oneshot',
    output_mode: 'json',
    count: String(count),
  });

  try {
    const res = await fetch(
      `${getBaseUrl(client.config)}/services/search/jobs/export`,
      {
        method: 'POST',
        headers: {
          Authorization: client.authHeader,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
        agent: getAgent(client.config),
        timeout: Number(config.splunk?.searchTimeoutMs || 15000),
      }
    );

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Splunk search failed (${res.status}): ${text.slice(0, 160)}`);
    }

    const text = await res.text();
    const events = parseExportResponse(text);

    return {
      source: 'splunk',
      events,
      count: events.length,
      query: search,
    };
  } catch (err) {
    console.error('Splunk search error:', err.message);

    return fallbackSearch(search, err.message, count);
  }
}

function fallbackSearch(query, reason, limit = 50) {
  const events = db.queryLogs({ since: Date.now() - 15 * 60 * 1000, limit });
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

module.exports = { searchSplunk, normalizeSearch, parseExportResponse };
