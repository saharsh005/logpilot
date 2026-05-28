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
      event_loop_lag INTEGER
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

  db.run(`CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_logs_path ON logs(path)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level)`);

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

// Auto-persist every 5 seconds
setInterval(persistDB, 5000);

function insertLog(entry) {
  if (!db) return;
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
  } catch (e) { /* silent */ }
}

function insertMetric(metric) {
  if (!db) return;
  try {
    db.run(
      `INSERT INTO metrics (timestamp, cpu_percent, memory_percent, memory_mb, event_loop_lag)
       VALUES (?, ?, ?, ?, ?)`,
      [Date.now(), metric.cpu || 0, metric.memoryPercent || 0, metric.memoryMb || 0, metric.eventLoopLag || 0]
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

function getStats() {
  if (!db) return {};
  const totalLogs = execQuery(`SELECT COUNT(*) as c FROM logs`, [])[0]?.c || 0;
  const errorLogs = execQuery(`SELECT COUNT(*) as c FROM logs WHERE level = 'error' OR status_code >= 500`, [])[0]?.c || 0;
  const healCount = execQuery(`SELECT COUNT(*) as c FROM heal_actions`, [])[0]?.c || 0;
  const avgResponse = execQuery(`SELECT AVG(response_time) as a FROM logs WHERE response_time IS NOT NULL AND timestamp >= ?`, [Date.now() - 3600000])[0]?.a || 0;
  return { totalLogs, errorLogs, healCount, avgResponseMs: Math.round(avgResponse) };
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
  persistDB();
}

module.exports = { initDB, insertLog, insertMetric, insertHealAction, queryLogs, queryLogsByKeywords, getRecentMetrics, getLatestMetric, getErrorRate, getHealActions, getStats, cleanup, persistDB };
