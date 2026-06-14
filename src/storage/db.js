const path = require('path');
const fs = require('fs');

let db = null;
let SQL = null;
let dbPath = null;

async function initDB(storageDir) {
  if (db) return db;

  SQL = await require('sql.js')();
  dbPath = path.join(storageDir, 'logpilot.sqlite');

  if (fs.existsSync(dbPath)) {
    const fileBuffer = fs.readFileSync(dbPath);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      level TEXT NOT NULL,
      service TEXT,
      method TEXT,
      path TEXT,
      status_code INTEGER,
      response_time INTEGER,
      message TEXT,
      metadata TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      cpu_percent REAL,
      memory_percent REAL,
      memory_mb REAL,
      event_loop_lag INTEGER,
      heap_used_mb REAL,
      heap_total_mb REAL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS heal_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      rule_name TEXT NOT NULL,
      trigger_detail TEXT,
      action TEXT NOT NULL,
      success INTEGER DEFAULT 1,
      notes TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS incident_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fingerprint TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      service TEXT,
      method TEXT,
      path TEXT,
      status_code INTEGER,
      severity TEXT,
      root_cause TEXT,
      count INTEGER DEFAULT 1,
      first_seen INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      sample_message TEXT,
      last_action TEXT,
      related_group_ids TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS incident_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER NOT NULL,
      log_id INTEGER,
      timestamp INTEGER NOT NULL,
      message TEXT,
      response_time INTEGER,
      metadata TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS heap_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      trigger TEXT,
      heap_used_mb REAL,
      heap_total_mb REAL,
      external_mb REAL,
      rss_mb REAL,
      notes TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS incident_analysis (
      incident_id INTEGER PRIMARY KEY,
      updated_at INTEGER NOT NULL,
      context_json TEXT,
      rca_json TEXT,
      recovery_json TEXT,
      postmortem_md TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS evidence_snapshots (
      incident_id INTEGER PRIMARY KEY,
      created_at INTEGER NOT NULL,
      source TEXT,
      evidence_json TEXT NOT NULL,
      ttl_seconds INTEGER DEFAULT 3600
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_logs_path ON logs(path)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_incident_groups_last_seen ON incident_groups(last_seen)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_incident_events_group_id ON incident_events(group_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_evidence_created ON evidence_snapshots(created_at)`);

  persistDB();
  return db;
}

function persistDB() {
  if (!db || !dbPath) return;
  try {
    const data = db.export();
    fs.writeFileSync(dbPath, Buffer.from(data));
  } catch (e) { /* silent */ }
}

setInterval(persistDB, 5000);

function insertLog(entry) {
  if (!db) return null;
  try {
    db.run(
      `INSERT INTO logs (timestamp, level, service, method, path, status_code, response_time, message, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.timestamp || Date.now(),
        entry.level || 'info',
        entry.service || null,
        entry.method || null,
        entry.path || null,
        entry.statusCode || null,
        entry.responseTime || null,
        entry.message || null,
        entry.metadata ? JSON.stringify(entry.metadata) : null
      ]
    );
    const row = execQuery(`SELECT last_insert_rowid() as id`, [])[0];
    return row?.id || null;
  } catch (e) {
    return null;
  }
}

function recordIncident(entry, logId = null) {
  if (!db) return null;
  if (!isIncidentEntry(entry)) return null;

  const timestamp = entry.timestamp || Date.now();
  const fingerprint = buildIncidentFingerprint(entry);
  const rootCause = inferRootCause(entry);
  const title = buildIncidentTitle(entry, rootCause);
  const severity = entry.statusCode >= 500 || entry.level === 'error' ? 'critical' : 'warning';

  try {
    const existing = execQuery(`SELECT * FROM incident_groups WHERE fingerprint = ? LIMIT 1`, [fingerprint])[0];
    let groupId = existing?.id;

    if (existing) {
      db.run(
        `UPDATE incident_groups
         SET count = count + 1, last_seen = ?, sample_message = ?, severity = ?, root_cause = ?
         WHERE id = ?`,
        [timestamp, entry.message || '', severity, rootCause, groupId]
      );
    } else {
      db.run(
        `INSERT INTO incident_groups
         (fingerprint, title, service, method, path, status_code, severity, root_cause, count, first_seen, last_seen, sample_message)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          fingerprint, title,
          entry.service || null, entry.method || null, entry.path || null,
          entry.statusCode || null, severity, rootCause,
          1, timestamp, timestamp, entry.message || '',
        ]
      );
      groupId = execQuery(`SELECT last_insert_rowid() as id`, [])[0]?.id || null;

      // Find related groups (same root cause or path prefix)
      if (groupId) {
        linkRelatedGroups(groupId, rootCause, entry);
      }
    }

    if (groupId) {
      db.run(
        `INSERT INTO incident_events (group_id, log_id, timestamp, message, response_time, metadata)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          groupId, logId, timestamp,
          entry.message || '',
          entry.responseTime || null,
          entry.metadata ? JSON.stringify(entry.metadata) : null,
        ]
      );
    }

    return groupId ? getIncidentGroup(groupId) : null;
  } catch (e) {
    return null;
  }
}

function linkRelatedGroups(newGroupId, rootCause, entry) {
  try {
    // Find groups with same root cause or overlapping path in last 24h
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const related = execQuery(
      `SELECT id FROM incident_groups
       WHERE id != ? AND last_seen >= ?
       AND (root_cause = ? OR (path IS NOT NULL AND path LIKE ?))
       LIMIT 5`,
      [newGroupId, cutoff, rootCause, `%${(entry.path || '').split('/').slice(0,3).join('/')}%`]
    );
    if (related.length > 0) {
      const ids = related.map(r => r.id).join(',');
      db.run(`UPDATE incident_groups SET related_group_ids = ? WHERE id = ?`, [ids, newGroupId]);
      // Also update the related ones to point back
      for (const rel of related) {
        const existing = execQuery(`SELECT related_group_ids FROM incident_groups WHERE id = ?`, [rel.id])[0];
        const existingIds = existing?.related_group_ids ? existing.related_group_ids.split(',') : [];
        if (!existingIds.includes(String(newGroupId))) {
          existingIds.push(String(newGroupId));
          db.run(`UPDATE incident_groups SET related_group_ids = ? WHERE id = ?`, [existingIds.join(','), rel.id]);
        }
      }
    }
  } catch (e) { /* silent */ }
}

function insertMetric(metric) {
  if (!db) return;
  try {
    db.run(
      `INSERT INTO metrics (timestamp, cpu_percent, memory_percent, memory_mb, event_loop_lag, heap_used_mb, heap_total_mb)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [Date.now(), metric.cpu || 0, metric.memoryPercent || 0, metric.memoryMb || 0,
       metric.eventLoopLag || 0, metric.heapUsedMb || 0, metric.heapTotalMb || 0]
    );
  } catch (e) { /* silent */ }
}

function insertHealAction(action) {
  if (!db) return;
  try {
    db.run(
      `INSERT INTO heal_actions (timestamp, rule_name, trigger_detail, action, success, notes)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [Date.now(), action.ruleName, action.triggerDetail || '', action.action, action.success ? 1 : 0, action.notes || '']
    );
    persistDB();
  } catch (e) { /* silent */ }
}

function insertHeapSnapshot(snap) {
  if (!db) return null;
  try {
    db.run(
      `INSERT INTO heap_snapshots (timestamp, trigger, heap_used_mb, heap_total_mb, external_mb, rss_mb, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [snap.timestamp || Date.now(), snap.trigger || 'manual', snap.heapUsedMb, snap.heapTotalMb,
       snap.externalMb || 0, snap.rssMb || 0, snap.notes || '']
    );
    const row = execQuery(`SELECT last_insert_rowid() as id`, [])[0];
    persistDB();
    return row?.id || null;
  } catch (e) { return null; }
}

function getHeapSnapshots(limit = 20) {
  if (!db) return [];
  return execQuery(`SELECT * FROM heap_snapshots ORDER BY timestamp DESC LIMIT ?`, [limit]);
}

function queryLogs({ level, service, path: routePath, since, until, limit = 200 } = {}) {
  if (!db) return [];
  let sql = `SELECT * FROM logs WHERE 1=1`;
  const params = [];
  if (level) { sql += ` AND level = ?`; params.push(level); }
  if (service) { sql += ` AND service LIKE ?`; params.push(`%${service}%`); }
  if (routePath) { sql += ` AND path LIKE ?`; params.push(`%${routePath}%`); }
  if (since) { sql += ` AND timestamp >= ?`; params.push(since); }
  if (until) { sql += ` AND timestamp <= ?`; params.push(until); }
  sql += ` ORDER BY timestamp DESC LIMIT ?`;
  params.push(limit);
  return execQuery(sql, params);
}

function queryLogsByKeywords(keywords, since, until, limit = 100) {
  if (!db) return [];
  const conditions = keywords.map(() => `(message LIKE ? OR path LIKE ? OR metadata LIKE ?)`).join(' OR ');
  const params = [];
  keywords.forEach(k => params.push(`%${k}%`, `%${k}%`, `%${k}%`));
  if (since) params.push(since);
  if (until) params.push(until);
  params.push(limit);
  const sql = `SELECT * FROM logs WHERE (${conditions})
    ${since ? 'AND timestamp >= ?' : ''}
    ${until ? 'AND timestamp <= ?' : ''}
    ORDER BY timestamp DESC LIMIT ?`;
  return execQuery(sql, params);
}

function getRecentMetrics(minutes = 60) {
  if (!db) return [];
  const since = Date.now() - minutes * 60 * 1000;
  return execQuery(`SELECT * FROM metrics WHERE timestamp >= ? ORDER BY timestamp DESC LIMIT 120`, [since]);
}

function getLatestMetric() {
  if (!db) return null;
  const rows = execQuery(`SELECT * FROM metrics ORDER BY timestamp DESC LIMIT 1`, []);
  return rows[0] || null;
}

function getErrorRate(routePath, windowMs = 5 * 60 * 1000) {
  if (!db) return 0;
  const since = Date.now() - windowMs;
  const total = execQuery(`SELECT COUNT(*) as c FROM logs WHERE path LIKE ? AND timestamp >= ?`, [`%${routePath}%`, since]);
  const errors = execQuery(`SELECT COUNT(*) as c FROM logs WHERE path LIKE ? AND status_code >= 500 AND timestamp >= ?`, [`%${routePath}%`, since]);
  const t = total[0]?.c || 0;
  const e = errors[0]?.c || 0;
  return t > 0 ? Math.round((e / t) * 100) : 0;
}

function getHealActions(limit = 50) {
  if (!db) return [];
  return execQuery(`SELECT * FROM heal_actions ORDER BY timestamp DESC LIMIT ?`, [limit]);
}

function getIncidentGroups({ limit = 50, since } = {}) {
  if (!db) return [];
  let sql = `SELECT * FROM incident_groups WHERE 1=1`;
  const params = [];
  if (since) { sql += ` AND last_seen >= ?`; params.push(since); }
  sql += ` ORDER BY last_seen DESC LIMIT ?`;
  params.push(limit);
  return execQuery(sql, params);
}

function getIncidentGroup(id) {
  if (!db) return null;
  return execQuery(`SELECT * FROM incident_groups WHERE id = ? LIMIT 1`, [id])[0] || null;
}

function getIncidentTimeline(groupId, limit = 100) {
  if (!db) return [];
  return execQuery(
    `SELECT * FROM incident_events WHERE group_id = ? ORDER BY timestamp DESC LIMIT ?`,
    [groupId, limit]
  );
}

function upsertIncidentAnalysis(incidentId, analysis) {
  const id = Number(incidentId);
  if (!db || !Number.isFinite(id)) return;
  try {
    db.run(
      `INSERT OR REPLACE INTO incident_analysis
       (incident_id, updated_at, context_json, rca_json, recovery_json, postmortem_md)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        id,
        Date.now(),
        JSON.stringify(analysis.context || {}),
        JSON.stringify(analysis.rca || {}),
        JSON.stringify(analysis.recovery || {}),
        analysis.postmortem || '',
      ]
    );
    persistDB();
  } catch (e) { /* silent */ }
}

function getIncidentAnalysis(incidentId) {
  const id = Number(incidentId);
  if (!db || !Number.isFinite(id)) return null;
  const row = execQuery(`SELECT * FROM incident_analysis WHERE incident_id = ? LIMIT 1`, [id])[0];
  if (!row) return null;
  return {
    incidentId: row.incident_id,
    updatedAt: row.updated_at,
    context: safeJson(row.context_json, {}),
    rca: safeJson(row.rca_json, {}),
    recovery: safeJson(row.recovery_json, {}),
    postmortem: row.postmortem_md || '',
  };
}

function getRelatedIncidents(groupId) {
  if (!db) return [];
  const group = getIncidentGroup(groupId);
  if (!group || !group.related_group_ids) return [];
  const ids = group.related_group_ids.split(',').map(Number).filter(Boolean);
  if (!ids.length) return [];
  return ids.map(id => getIncidentGroup(id)).filter(Boolean);
}

function markIncidentAction(groupId, action) {
  if (!db || !groupId) return;
  try {
    db.run(`UPDATE incident_groups SET last_action = ? WHERE id = ?`, [action, groupId]);
  } catch (e) { /* silent */ }
}

function getStats() {
  if (!db) return {};
  const totalLogs = execQuery(`SELECT COUNT(*) as c FROM logs`, [])[0]?.c || 0;
  const errorLogs = execQuery(`SELECT COUNT(*) as c FROM logs WHERE level = 'error' OR status_code >= 500`, [])[0]?.c || 0;
  const healCount = execQuery(`SELECT COUNT(*) as c FROM heal_actions`, [])[0]?.c || 0;
  const incidentGroups = execQuery(`SELECT COUNT(*) as c FROM incident_groups`, [])[0]?.c || 0;
  const avgResponse = execQuery(`SELECT AVG(response_time) as a FROM logs WHERE response_time IS NOT NULL AND timestamp >= ?`, [Date.now() - 3600000])[0]?.a || 0;
  return { totalLogs, errorLogs, healCount, incidentGroups, avgResponseMs: Math.round(avgResponse) };
}

function getDashboardAnalytics({ since = Date.now() - 24 * 60 * 60 * 1000 } = {}) {
  if (!db) return {};
  return {
    statusClasses: execQuery(
      `SELECT
         CASE
           WHEN status_code >= 500 THEN '5xx'
           WHEN status_code >= 400 THEN '4xx'
           WHEN status_code >= 300 THEN '3xx'
           WHEN status_code >= 200 THEN '2xx'
           ELSE 'other'
         END as label,
         COUNT(*) as value
       FROM logs
       WHERE timestamp >= ? AND status_code IS NOT NULL
       GROUP BY label
       ORDER BY label`,
      [since]
    ),
    rootCauses: execQuery(
      `SELECT COALESCE(root_cause, 'Unknown') as label, COUNT(*) as value
       FROM incident_groups
       WHERE last_seen >= ?
       GROUP BY root_cause
       ORDER BY value DESC
       LIMIT 8`,
      [since]
    ),
    healActions: execQuery(
      `SELECT action as label, COUNT(*) as value
       FROM heal_actions
       WHERE timestamp >= ?
       GROUP BY action
       ORDER BY value DESC
       LIMIT 8`,
      [since]
    ),
    metricSeries: execQuery(
      `SELECT timestamp, cpu_percent, memory_percent, event_loop_lag
       FROM metrics
       WHERE timestamp >= ?
       ORDER BY timestamp ASC
       LIMIT 120`,
      [since]
    ),
  };
}

function execQuery(sql, params) {
  try {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  } catch (e) {
    return [];
  }
}

function cleanup(days = 7) {
  if (!db) return;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  db.run(`DELETE FROM logs WHERE timestamp < ?`, [cutoff]);
  db.run(`DELETE FROM metrics WHERE timestamp < ?`, [cutoff]);
  db.run(`DELETE FROM incident_events WHERE timestamp < ?`, [cutoff]);
  db.run(`DELETE FROM incident_groups WHERE last_seen < ?`, [cutoff]);
  db.run(`DELETE FROM heap_snapshots WHERE timestamp < ?`, [cutoff]);
  db.run(`DELETE FROM incident_analysis WHERE updated_at < ?`, [cutoff]);
  persistDB();
}

function safeJson(value, fallback) {
  try { return value ? JSON.parse(value) : fallback; }
  catch (e) { return fallback; }
}

function isIncidentEntry(entry) {
  return entry && (entry.level === 'error' || entry.statusCode >= 400);
}

function buildIncidentFingerprint(entry) {
  const method = entry.method || 'CUSTOM';
  const pathKey = normalizePath(entry.path || entry.service || 'app');
  const status = entry.statusCode || entry.level || 'unknown';
  const rootCause = inferRootCause(entry);
  return [method, pathKey, status, rootCause].join('|');
}

function normalizePath(routePath) {
  return String(routePath)
    .replace(/[0-9a-f]{8,}/gi, ':id')
    .replace(/\b\d+\b/g, ':id')
    .replace(/\/+/g, '/');
}

function inferRootCause(entry) {
  const text = `${entry.message || ''} ${entry.path || ''} ${JSON.stringify(entry.metadata || {})}`;
  if (/timeout|timed.?out/i.test(text)) return 'Timeout';
  if (/connection|ECONNREFUSED|ENOTFOUND|ECONNRESET/i.test(text)) return 'Connection';
  if (/memory|heap|OOM/i.test(text)) return 'Memory';
  if (/rate.?limit|too many|429/i.test(text)) return 'Rate limit';
  if (/database|DB|SQL|query|postgres|redis|mongo/i.test(text)) return 'Data store';
  if (/auth|unauthorized|forbidden|token|jwt|401|403/i.test(text)) return 'Auth';
  if (/not.?found|404/i.test(text)) return 'Not found';
  if (/gateway|upstream|proxy/i.test(text)) return 'Upstream';
  if ((entry.statusCode || 0) >= 500) return 'Server error';
  if ((entry.statusCode || 0) >= 400) return 'Client error';
  return 'Application error';
}

function buildIncidentTitle(entry, rootCause) {
  const endpoint = [entry.method, entry.path].filter(Boolean).join(' ') || entry.service || 'Application';
  const status = entry.statusCode ? ` ${entry.statusCode}` : '';
  return `${rootCause}${status} on ${endpoint}`;
}

function queryMetrics({ since, until, limit = 120 } = {}) {
  if (!db) return [];
  let sql = `SELECT * FROM metrics WHERE 1=1`;
  const params = [];
  if (since) { sql += ` AND timestamp >= ?`; params.push(since); }
  if (until) { sql += ` AND timestamp <= ?`; params.push(until); }
  sql += ` ORDER BY timestamp DESC LIMIT ?`;
  params.push(limit);
  return execQuery(sql, params);
}

function saveEvidenceSnapshot(incidentId, bundle) {
  const id = Number(incidentId);
  if (!db || !Number.isFinite(id)) return;
  try {
    db.run(
      `INSERT OR REPLACE INTO evidence_snapshots (incident_id, created_at, source, evidence_json, ttl_seconds)
       VALUES (?, ?, ?, ?, ?)`,
      [id, Date.now(), bundle.source || 'local', JSON.stringify(bundle), 3600]
    );
    persistDB();
  } catch (err) {
    // Silent fail
  }
}

function getEvidenceSnapshot(incidentId) {
  const id = Number(incidentId);
  if (!db || !Number.isFinite(id)) return null;
  try {
    const rows = execQuery(
      `SELECT * FROM evidence_snapshots WHERE incident_id = ? LIMIT 1`,
      [id]
    );
    return rows[0] || null;
  } catch (err) {
    return null;
  }
}

module.exports = {
  initDB, insertLog, recordIncident, insertMetric, insertHealAction,
  insertHeapSnapshot, getHeapSnapshots,
  queryLogs, queryLogsByKeywords, getRecentMetrics, getLatestMetric, queryMetrics,
  getErrorRate, getHealActions, getIncidentGroups, getIncidentGroup,
  getIncidentTimeline, getRelatedIncidents, markIncidentAction,
  upsertIncidentAnalysis, getIncidentAnalysis,
  saveEvidenceSnapshot, getEvidenceSnapshot,
  getStats, getDashboardAnalytics, cleanup, persistDB,
};
