/**
 * NLP Query Engine
 * Converts plain English into structured log search parameters
 * e.g. "show payment failures last night" → { keywords, since, until, level }
 */

const TIME_PATTERNS = [
  { pattern: /last\s+hour/i,          offset: () => -60 * 60 * 1000 },
  { pattern: /last\s+(\d+)\s+hours?/i, offset: (m) => -parseInt(m[1]) * 60 * 60 * 1000 },
  { pattern: /last\s+(\d+)\s+min/i,   offset: (m) => -parseInt(m[1]) * 60 * 1000 },
  { pattern: /last\s+night/i,          offset: () => {
    const now = new Date();
    const lastNight = new Date(now);
    lastNight.setDate(lastNight.getDate() - (now.getHours() < 8 ? 1 : 0));
    lastNight.setHours(20, 0, 0, 0);
    return lastNight.getTime() - now.getTime() - 8 * 60 * 60 * 1000;
  }},
  { pattern: /yesterday/i,             offset: () => -24 * 60 * 60 * 1000 },
  { pattern: /last\s+(\d+)\s+days?/i, offset: (m) => -parseInt(m[1]) * 24 * 60 * 60 * 1000 },
  { pattern: /today/i,                 offset: () => {
    const s = new Date(); s.setHours(0,0,0,0);
    return s.getTime() - Date.now();
  }},
  { pattern: /this\s+week/i,          offset: () => -7 * 24 * 60 * 60 * 1000 },
  { pattern: /(\d+)\s*(am|pm)/i,      offset: (m) => {
    const h = parseInt(m[1]) + (m[2].toLowerCase() === 'pm' && parseInt(m[1]) !== 12 ? 12 : 0);
    const t = new Date(); t.setHours(h, 0, 0, 0);
    if (t > new Date()) t.setDate(t.getDate() - 1);
    return t.getTime() - Date.now();
  }}
];

const LEVEL_KEYWORDS = {
  error:   ['error', 'fail', 'failure', 'failed', 'crash', 'crashed', 'exception', 'critical', 'fatal', '500', '503', '502'],
  warn:    ['warn', 'warning', 'slow', 'timeout', 'delay', 'degraded'],
  info:    ['info', 'success', 'ok', '200', '201'],
};

const SERVICE_PATTERNS = [
  /\b(payment|auth|user|product|catalog|order|checkout|cart|search|email|notification|webhook)\b/gi
];

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];

function parseQuery(query) {
  if (!query || typeof query !== 'string') return { keywords: [], raw: query };

  const result = {
    raw: query,
    keywords: [],
    level: null,
    service: null,
    since: null,
    until: null,
    method: null,
    statusCode: null,
  };

  // --- Time extraction ---
  let timeMatch = null;
  for (const tp of TIME_PATTERNS) {
    const m = query.match(tp.pattern);
    if (m) {
      timeMatch = m;
      const offsetMs = tp.offset(m);
      result.since = Date.now() + offsetMs;
      // "last night" has an implicit end time
      if (/last\s+night/i.test(query)) {
        const morning = new Date();
        morning.setHours(8, 0, 0, 0);
        if (morning > new Date()) morning.setDate(morning.getDate() - 1);
        result.until = morning.getTime();
      }
      break;
    }
  }

  // Default: last 24h if no time given
  if (!result.since) result.since = Date.now() - 24 * 60 * 60 * 1000;

  // --- Level detection ---
  for (const [level, words] of Object.entries(LEVEL_KEYWORDS)) {
    if (words.some(w => query.toLowerCase().includes(w))) {
      result.level = level;
      break;
    }
  }

  // --- Service detection ---
  for (const pattern of SERVICE_PATTERNS) {
    const match = query.match(pattern);
    if (match) { result.service = match[0].toLowerCase(); break; }
  }

  // --- HTTP method ---
  for (const method of HTTP_METHODS) {
    if (query.toUpperCase().includes(method)) { result.method = method; break; }
  }

  // --- Status code ---
  const statusMatch = query.match(/\b([45]\d{2})\b/);
  if (statusMatch) result.statusCode = parseInt(statusMatch[1]);

  // --- Keyword extraction ---
  // Strip stop words and time phrases
  const stopWords = new Set([
    'show', 'me', 'all', 'the', 'a', 'an', 'in', 'on', 'at', 'from',
    'get', 'find', 'list', 'display', 'what', 'were', 'was', 'is', 'are',
    'logs', 'log', 'errors', 'requests', 'calls', 'last', 'night', 'hour',
    'hours', 'today', 'yesterday', 'this', 'week', 'that', 'have', 'has',
    'during', 'between', 'and', 'or', 'of', 'for', 'with', 'my', 'our'
  ]);

  const words = query
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .map(w => w.toLowerCase())
    .filter(w => w.length > 2 && !stopWords.has(w) && isNaN(w));

  // Remove time words
  const cleaned = words.filter(w => !['yesterday', 'today', 'tonight', 'night', 'morning', 'week'].includes(w));

  result.keywords = [...new Set(cleaned)];

  return result;
}

function describeQuery(parsed) {
  const parts = [];
  if (parsed.service) parts.push(`service: ${parsed.service}`);
  if (parsed.level) parts.push(`level: ${parsed.level}`);
  if (parsed.method) parts.push(`method: ${parsed.method}`);
  if (parsed.since) {
    const diff = Date.now() - parsed.since;
    const hours = Math.round(diff / 3600000);
    parts.push(`last ${hours < 1 ? 'hour' : hours + 'h'}`);
  }
  if (parsed.keywords.length) parts.push(`keywords: [${parsed.keywords.join(', ')}]`);
  return parts.join(' | ') || 'all recent logs';
}

module.exports = { parseQuery, describeQuery };
