/**
 * Heap Snapshot Module
 * Captures memory snapshots before restart actions.
 * Stores lightweight snapshots (no v8 heapdump dependency) in DB.
 */
const db = require('../storage/db');

function captureSnapshot(trigger = 'manual', notes = '') {
  const mem = process.memoryUsage();
  const snap = {
    timestamp: Date.now(),
    trigger,
    heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024 * 10) / 10,
    heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024 * 10) / 10,
    externalMb: Math.round(mem.external / 1024 / 1024 * 10) / 10,
    rssMb: Math.round(mem.rss / 1024 / 1024 * 10) / 10,
    notes,
  };
  const id = db.insertHeapSnapshot(snap);
  console.log(require('chalk').cyan(`[logpilot] 📸 Heap snapshot captured (trigger: ${trigger}) — heap ${snap.heapUsedMb}MB / ${snap.heapTotalMb}MB`));
  return { ...snap, id };
}

module.exports = { captureSnapshot };
