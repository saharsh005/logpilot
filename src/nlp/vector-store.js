/**
 * Qdrant Vector Store
 *
 * Connects to a Qdrant instance (local or remote) and provides:
 * - upsert: store a log entry as a vector
 * - search: find semantically similar logs by query vector
 *
 * Qdrant setup (one-time, optional):
 *   docker run -p 6333:6333 qdrant/qdrant
 *
 * If Qdrant is not running, logpilot falls back to keyword search silently.
 *
 * Collection schema:
 *   name: "logpilot_logs"
 *   vector size: 384 (all-MiniLM-L6-v2 output)
 *   distance: Cosine
 *   payload: { log_id, timestamp, level, service, path, message }
 */

const { QdrantClient } = require('@qdrant/js-client-rest');
const { getVectorSize } = require('./embedder');

const COLLECTION_NAME = 'logpilot_logs';

let client = null;
let connected = false;
let connectionAttempted = false;

/**
 * Connect to Qdrant and create collection if it doesn't exist.
 * Non-blocking — called once at startup.
 */
async function connect(qdrantUrl = 'http://localhost:6333') {
  if (connectionAttempted) return connected;
  connectionAttempted = true;

  try {
    client = new QdrantClient({ url: qdrantUrl });

    // Health check — will throw if Qdrant isn't running
    await client.getCollections();

    // Create collection if not exists
    const collections = await client.getCollections();
    const exists = collections.collections.some(c => c.name === COLLECTION_NAME);

    if (!exists) {
      await client.createCollection(COLLECTION_NAME, {
        vectors: {
          size: getVectorSize(),         // 384 for all-MiniLM-L6-v2
          distance: 'Cosine',            // cosine similarity — best for text
        },
        // Payload indexes for fast pre-filtering
        // (filter by time/level before vector search)
      });

      // Create payload indexes for efficient filtering
      await client.createPayloadIndex(COLLECTION_NAME, {
        field_name: 'timestamp',
        field_schema: 'integer',
      });
      await client.createPayloadIndex(COLLECTION_NAME, {
        field_name: 'level',
        field_schema: 'keyword',
      });
      await client.createPayloadIndex(COLLECTION_NAME, {
        field_name: 'service',
        field_schema: 'keyword',
      });

      console.log(`[logpilot] ✅ Qdrant collection "${COLLECTION_NAME}" created`);
    }

    connected = true;
    console.log(`[logpilot] ✅ Qdrant connected at ${qdrantUrl} — semantic search active`);
    return true;

  } catch (err) {
    connected = false;
    client = null;
    if (err.code === 'ECONNREFUSED' || err.message?.includes('ECONNREFUSED')) {
      console.log('[logpilot] ℹ Qdrant not running — using keyword search fallback');
      console.log('[logpilot]   To enable semantic search: docker run -p 6333:6333 qdrant/qdrant');
    } else {
      console.warn('[logpilot] ⚠ Qdrant connection failed:', err.message);
    }
    return false;
  }
}

/**
 * Store a log entry vector in Qdrant.
 * @param {number} logId       - SQLite row ID (used as Qdrant point ID)
 * @param {number[]} vector    - 384-dim float array
 * @param {object} payload     - Metadata stored alongside vector for filtering
 */
async function upsert(logId, vector, payload) {
  if (!connected || !client) return false;

  try {
    await client.upsert(COLLECTION_NAME, {
      wait: false,  // async write — don't block the request
      points: [
        {
          id: logId,
          vector,
          payload: {
            log_id:    logId,
            timestamp: payload.timestamp || Date.now(),
            level:     payload.level || 'info',
            service:   payload.service || 'unknown',
            path:      payload.path || '',
            method:    payload.method || '',
            status:    payload.statusCode || 0,
            message:   payload.message || '',
            log_text:  payload.logText || '',
          },
        },
      ],
    });
    return true;
  } catch (err) {
    console.warn('[logpilot] Qdrant upsert failed:', err.message);
    return false;
  }
}

/**
 * Semantic search — find logs most similar to the query vector.
 * @param {number[]} queryVector  - Embedded query (384-dim)
 * @param {object}  filters       - { since, until, level, service }
 * @param {number}  limit         - Max results to return
 */
async function search(queryVector, filters = {}, limit = 50) {
  if (!connected || !client) return null; // null = caller should use keyword fallback

  try {
    // Build Qdrant filter conditions
    const must = [];

    if (filters.since) {
      must.push({ key: 'timestamp', range: { gte: filters.since } });
    }
    if (filters.until) {
      must.push({ key: 'timestamp', range: { lte: filters.until } });
    }
    if (filters.level) {
      // For 'error' level, match both 'error' logs AND 5xx status codes
      if (filters.level === 'error') {
        must.push({
          should: [
            { key: 'level',  match: { value: 'error' } },
            { key: 'status', range: { gte: 500 } },
          ],
        });
      } else {
        must.push({ key: 'level', match: { value: filters.level } });
      }
    }
    if (filters.service) {
      must.push({ key: 'service', match: { value: filters.service } });
    }

    const searchParams = {
      vector: queryVector,
      limit,
      with_payload: true,
      score_threshold: 0.3,  // minimum similarity — below this is noise
    };

    if (must.length > 0) {
      searchParams.filter = { must };
    }

    const results = await client.search(COLLECTION_NAME, searchParams);

    return results.map(r => ({
      log_id:   r.id,
      score:    r.score,         // cosine similarity (0-1, higher = more similar)
      ...r.payload,
    }));

  } catch (err) {
    console.warn('[logpilot] Qdrant search failed:', err.message);
    return null; // fallback to keyword search
  }
}

/**
 * Delete all vectors older than a given timestamp (for retention cleanup).
 */
async function deleteOlderThan(timestamp) {
  if (!connected || !client) return;
  try {
    await client.delete(COLLECTION_NAME, {
      filter: { must: [{ key: 'timestamp', range: { lt: timestamp } }] },
    });
  } catch (err) {
    console.warn('[logpilot] Qdrant cleanup failed:', err.message);
  }
}

function isConnected() { return connected; }

module.exports = { connect, upsert, search, deleteOlderThan, isConnected };
