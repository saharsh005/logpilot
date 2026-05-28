/**
 * Search Engine — Semantic + Keyword Hybrid
 *
 * Strategy:
 *   1. Parse the NL query -> extract time range, level, service, keywords
 *   2. If Qdrant is connected AND embedder is ready -> semantic vector search
 *      -> re-rank results by time + severity
 *   3. Else -> keyword search against SQLite (existing behavior)
 *   4. Either path -> group results by root cause pattern
 */

const { parseQuery, describeQuery } = require('./query-parser');
const { embed, isReady: embedderReady } = require('./embedder');
const vectorStore = require('./vector-store');
const db = require('../storage/db');

async function search(query) {
  const parsed = parseQuery(query);
  const description = describeQuery(parsed);

  const useVector = embedderReady() && vectorStore.isConnected();

  let logs = [];
  let searchMode = 'keyword';

  if (useVector) {
    try {
      const queryVector = await embed(query);
      if (queryVector) {
        const results = await vectorStore.search(
          queryVector,
          { since: parsed.since, until: parsed.until, level: parsed.level, service: parsed.service },
          100
        );

        if (results && results.length > 0) {
          const idSet = new Set(results.map(r => r.log_id));
          const scoreMap = {};
          results.forEach(r => { scoreMap[r.log_id] = r.score; });

          // Fetch full records from SQLite by IDs
          const allRecent = db.queryLogs({ limit: 500, since: Date.now() - 7 * 24 * 60 * 60 * 1000 });
          logs = allRecent.filter(l => idSet.has(l.id));
          logs.forEach(l => { l._score = scoreMap[l.id] || 0; });
          logs = rerankLogs(logs);
          searchMode = 'semantic';
        }
      }
    } catch (err) {
      console.warn('[logpilot] Semantic search error, falling back to keyword:', err.message);
    }
  }

  // Keyword fallback
  if (logs.length === 0) {
    const searchTerms = [...(parsed.keywords || [])];
    if (parsed.service) searchTerms.push(parsed.service);
    if (parsed.method)  searchTerms.push(parsed.method);

    if (searchTerms.length > 0) {
      logs = db.queryLogsByKeywords(searchTerms, parsed.since, parsed.until, 300);
    } else {
      logs = db.queryLogs({ since: parsed.since, until: parsed.until, limit: 300 });
    }

    if (parsed.level) {
      logs = logs.filter(l => {
        if (parsed.level === 'error') return l.level === 'error' || l.status_code >= 500;
        if (parsed.level === 'warn')  return l.level === 'warn' || l.response_time > 2000;
        return l.level === parsed.level;
      });
    }

    searchMode = 'keyword';
  }

  const groups = groupByPattern(logs);

  return { query, parsed, description, searchMode, totalFound: logs.length, groups, logs: logs.slice(0, 100) };
}

function rerankLogs(logs) {
  const now = Date.now();
  const maxAge = 24 * 60 * 60 * 1000;
  return logs
    .map(l => {
      const semanticScore  = l._score || 0;
      const recencyScore   = Math.max(0, 1 - (now - (l.timestamp || 0)) / maxAge);
      const severityScore  = (l.level === 'error' || l.status_code >= 500) ? 1
        : (l.level === 'warn' || l.status_code >= 400) ? 0.5 : 0;
      l._finalScore = 0.5 * semanticScore + 0.3 * recencyScore + 0.2 * severityScore;
      return l;
    })
    .sort((a, b) => b._finalScore - a._finalScore);
}

function groupByPattern(logs) {
  const groups = {};
  for (const log of logs) {
    let groupKey = 'General';
    const msg = (log.message || '');
    const status = log.status_code;
    if      (/timeout|timed.?out/i.test(msg))                              groupKey = 'Timeout';
    else if (/connection|ECONNREFUSED|ENOTFOUND|ECONNRESET/i.test(msg))    groupKey = 'Connection Error';
    else if (/memory|heap|OOM/i.test(msg))                                 groupKey = 'Memory Issue';
    else if (/rate.?limit|429|too many/i.test(msg))                        groupKey = 'Rate Limit Hit';
    else if (/database|DB|SQL|query|postgres|mongo|redis/i.test(msg))      groupKey = 'Database Error';
    else if (/auth|unauthorized|forbidden|token|jwt/i.test(msg))           groupKey = 'Auth Error';
    else if (/not.?found|404/i.test(msg))                                  groupKey = '404 Not Found';
    else if (/gateway|upstream|proxy/i.test(msg))                          groupKey = 'Gateway Error';
    else if (status >= 500)                                                 groupKey = 'Server Error (5xx)';
    else if (status >= 400)                                                 groupKey = 'Client Error (4xx)';
    if (!groups[groupKey]) groups[groupKey] = [];
    groups[groupKey].push(log);
  }
  return Object.entries(groups)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([name, entries]) => ({ name, count: entries.length, sample: entries[0], entries: entries.slice(0, 10) }));
}

module.exports = { search };
