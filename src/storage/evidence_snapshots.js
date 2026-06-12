const db = require('./db');

function saveEvidenceSnapshot(incidentId, bundle) {
  if (!db) return;
  try {
    db.run(
      `INSERT OR REPLACE INTO evidence_snapshots (incident_id, created_at, source, evidence_json, ttl_seconds)
       VALUES (?, ?, ?, ?, ?)`,
      [incidentId, Date.now(), bundle.source || 'local', JSON.stringify(bundle), 3600]
    );
  } catch (err) {
    // Silent fail
  }
}

function getEvidenceSnapshot(incidentId) {
  if (!db) return null;
  try {
    const stmt = db.prepare(
      `SELECT * FROM evidence_snapshots WHERE incident_id = ?`
    );
    stmt.bind([incidentId]);
    if (stmt.step()) {
      const row = stmt.getAsObject();
      stmt.free();
      return {
        incident_id: row.incident_id,
        created_at: row.created_at,
        source: row.source,
        evidence_json: row.evidence_json,
        ttl_seconds: row.ttl_seconds,
      };
    }
    stmt.free();
  } catch (err) {
    // Silent fail
  }
  return null;
}

function isSnapshotStale(incidentId) {
  const snapshot = getEvidenceSnapshot(incidentId);
  if (!snapshot) return true;
  const ttl = snapshot.ttl_seconds || 3600;
  return Date.now() - snapshot.created_at > ttl * 1000;
}

function clearOldSnapshots(ageMs = 7 * 24 * 60 * 60 * 1000) {
  if (!db) return;
  try {
    const cutoff = Date.now() - ageMs;
    db.run(`DELETE FROM evidence_snapshots WHERE created_at < ?`, [cutoff]);
  } catch (err) {
    // Silent fail
  }
}

module.exports = {
  saveEvidenceSnapshot,
  getEvidenceSnapshot,
  isSnapshotStale,
  clearOldSnapshots,
};
