'use strict';

const db = require('../../storage/db');
const { searchSplunk } = require('./splunkSearch');

function indexName(config = {}) {
  return config.splunk?.index || 'logpilot';
}

function canUseSplunk(config = {}) {
  return config.splunk?.enabled === true;
}

function quote(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function msFromSplunkTime(value) {
  if (!value) return Date.now();
  const ts = Date.parse(value);
  return Number.isNaN(ts) ? Date.now() : ts;
}

function normalizeIncident(row = {}, fallbackId) {
  const id = row.incidentId || row.incident_id || row.id || fallbackId;
  return {
    id,
    incidentId: id,
    title: row.title || `${row.rootCause || row.root_cause || 'Incident'} on ${row.path || row.service || 'service'}`,
    service: row.service || null,
    method: row.method || null,
    path: row.path || null,
    status_code: Number(row.statusCode || row.status_code || 0) || null,
    severity: row.severity || 'warning',
    root_cause: row.rootCause || row.root_cause || row.root || 'Unknown',
    count: Number(row.count || row.events || 1),
    first_seen: Number(row.firstSeen || row.first_seen) || msFromSplunkTime(row.firstTime || row.first_time || row._time),
    last_seen: Number(row.lastSeen || row.last_seen) || msFromSplunkTime(row.lastTime || row.last_time || row._time),
    sample_message: row.sampleMessage || row.sample_message || row.message || row._raw || '',
    source: row.source || 'splunk',
  };
}

function normalizeEvent(row = {}) {
  return {
    ...row,
    timestamp: Number(row.timestamp) || msFromSplunkTime(row._time),
    message: row.message || row._raw || '',
    status_code: Number(row.statusCode || row.status_code || 0) || null,
    response_time: Number(row.responseTime || row.response_time || 0) || null,
  };
}

async function getIncidents(config = {}, options = {}) {
  const limit = Number(options.limit || 100);
  const earliest = options.earliest || `-${Number(options.hours || 24)}h`;

  if (canUseSplunk(config)) {
    const query = [
      `search index=${indexName(config)} type=incident earliest=${earliest}`,
      '| stats latest(title) as title latest(service) as service latest(method) as method latest(path) as path',
      'latest(statusCode) as statusCode latest(severity) as severity latest(rootCause) as rootCause',
      'sum(count) as count min(firstSeen) as firstSeen max(lastSeen) as lastSeen latest(_raw) as sampleMessage by incidentId',
      '| sort -lastSeen',
      `| head ${limit}`,
    ].join(' ');
    const result = await searchSplunk(query, config);
    if (result.source === 'splunk') {
      return {
        source: 'splunk',
        query,
        incidents: (result.events || []).map((row, i) => normalizeIncident(row, `splunk-${i + 1}`)),
      };
    }
  }

  return {
    source: 'local',
    incidents: db.getIncidentGroups({
      limit,
      since: Date.now() - Number(options.hours || 24) * 60 * 60 * 1000,
    }).map(row => ({ ...row, source: 'local' })),
  };
}

async function getIncidentById(incidentId, config = {}) {
  if (canUseSplunk(config)) {
    const id = quote(incidentId);
    const query = [
      `search index=${indexName(config)} type=incident incidentId="${id}" earliest=-30d`,
      '| stats latest(title) as title latest(service) as service latest(method) as method latest(path) as path',
      'latest(statusCode) as statusCode latest(severity) as severity latest(rootCause) as rootCause',
      'sum(count) as count min(firstSeen) as firstSeen max(lastSeen) as lastSeen latest(_raw) as sampleMessage by incidentId',
    ].join(' ');
    const result = await searchSplunk(query, config);
    if (result.source === 'splunk' && result.events?.[0]) {
      return normalizeIncident(result.events[0], incidentId);
    }
  }

  const local = db.getIncidentGroup(Number(incidentId));
  return local ? { ...local, source: 'local' } : null;
}

async function getIncidentEvents(incident, config = {}, options = {}) {
  const limit = Number(options.limit || 200);
  const earliest = options.earliest || '-2h';

  if (canUseSplunk(config)) {
    const filters = [
      incident.incidentId ? `incidentId="${quote(incident.incidentId)}"` : '',
      incident.path ? `path="${quote(incident.path)}"` : '',
    ].filter(Boolean).join(' OR ');
    const query = `search index=${indexName(config)} (${filters || 'type=*'}) earliest=${earliest} | sort 0 _time | head ${limit}`;
    const result = await searchSplunk(query, config);
    if (result.source === 'splunk') {
      return { source: 'splunk', query, events: (result.events || []).map(normalizeEvent) };
    }
  }

  return {
    source: 'local',
    events: db.getIncidentTimeline(Number(incident.id), limit).map(normalizeEvent),
  };
}

async function searchEvidence(spl, config = {}) {
  if (!canUseSplunk(config)) return { source: 'local', events: [], count: 0, query: spl };
  return searchSplunk(spl, config);
}

function observabilityQueries(config = {}) {
  const index = indexName(config);
  return {
    requestVolume:   { label: 'Request Volume',   icon: '\u{1F4CA}', category: 'observability', desc: 'Total requests per minute across all endpoints.',                              spl: `index=${index} | timechart span=1m count` },
    responseTime:    { label: 'Response Time',    icon: '\u23F1',  category: 'observability', desc: 'Average response time per minute for all HTTP requests.',                     spl: `index=${index} sourcetype=logpilot:request | timechart span=1m avg(responseTime)` },
    cpuUsage:        { label: 'CPU Load',         icon: '\u{1F5A5}', category: 'observability', desc: 'Average 1-min CPU load average per minute.',                                  spl: `index=${index} | timechart span=1m avg(cpuLoad)` },
    memoryUsage:     { label: 'Memory Usage',     icon: '\u{1F9E0}', category: 'observability', desc: 'Average memory utilisation % per minute.',                                    spl: `index=${index} | timechart span=1m avg(memoryPercent)` },
    heapUsage:       { label: 'Heap Usage',       icon: '\u{1F4BE}', category: 'observability', desc: 'Average Node.js heap used (MB) per minute.',                                  spl: `index=${index} | timechart span=1m avg(heapUsedMB)` },
    errorRate:       { label: 'Error Rate',       icon: '\u26A0',  category: 'observability', desc: 'Number of HTTP 4xx/5xx responses per minute.',                                spl: `index=${index} statusCode>=400 | timechart span=1m count` },
    latencyForecast: { label: 'Latency Forecast', icon: '\u{1F52E}', category: 'forecast',      desc: 'Forecasts avg response time 10 min ahead using Splunk predict (no MLTK app).', spl: `index=${index} sourcetype=logpilot:request\n| timechart span=1m avg(responseTime) as responseTime\n| predict responseTime future_timespan=10` },
    cpuForecast:     { label: 'CPU Forecast',     icon: '\u{1F52E}', category: 'forecast',      desc: 'Forecasts CPU load 10 min ahead.',                                             spl: `index=${index}\n| timechart span=1m avg(cpuLoad) as cpuLoad\n| predict cpuLoad future_timespan=10` },
    memoryForecast:  { label: 'Memory Forecast',  icon: '\u{1F52E}', category: 'forecast',      desc: 'Forecasts memory % 10 min ahead.',                                             spl: `index=${index}\n| timechart span=1m avg(memoryPercent) as memoryPercent\n| predict memoryPercent future_timespan=10` },
  };
}

// Legacy alias — keeps existing callers working
function mltkQueries(config = {}) {
  const q = observabilityQueries(config);
  return { latencySpike: q.latencyForecast.spl, memoryExhaustion: q.memoryForecast.spl, outageRisk: q.cpuForecast.spl };
}

module.exports = {
  getIncidents,
  getIncidentById,
  getIncidentEvents,
  searchEvidence,
  mltkQueries,
  observabilityQueries,
  normalizeIncident,
  normalizeEvent,
  indexName,
};
