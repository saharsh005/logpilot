/**
 * Embedding Engine
 * Uses @huggingface/transformers to run all-MiniLM-L6-v2 locally.
 * Converts log messages into 384-dimensional vectors for semantic search.
 *
 * The model downloads once (~25MB) to ~/.cache/huggingface on first run.
 * All inference runs locally — no API keys, no internet after first download.
 */

let embedder = null;
let modelLoading = false;
let modelReady = false;
let modelError = null;

const MODEL_NAME = 'Xenova/all-MiniLM-L6-v2';
const VECTOR_SIZE = 384;

/**
 * Initialize the embedding model.
 * Called once at startup — non-blocking, other features work while it loads.
 */
async function initEmbedder() {
  if (modelReady || modelLoading) return;
  modelLoading = true;

  try {
    const { pipeline } = require('@huggingface/transformers');
    console.log('[logpilot] 📦 Loading embedding model (first run downloads ~25MB)...');
    embedder = await pipeline('feature-extraction', MODEL_NAME, {
      dtype: 'fp32',
    });
    modelReady = true;
    modelLoading = false;
    console.log('[logpilot] ✅ Embedding model ready — semantic search enabled');
  } catch (err) {
    modelError = err.message;
    modelLoading = false;
    console.warn('[logpilot] ⚠ Embedding model failed to load — falling back to keyword search');
    console.warn('[logpilot]  ', err.message);
  }
}

/**
 * Generate embedding vector for a string.
 * Returns Float32Array of length 384, or null if model not ready.
 */
async function embed(text) {
  if (!modelReady || !embedder) return null;

  try {
    // Truncate to avoid token limit (model max: 256 tokens)
    const truncated = text.slice(0, 512);
    const output = await embedder(truncated, { pooling: 'mean', normalize: true });
    // output.data is a Float32Array
    return Array.from(output.data);
  } catch (err) {
    console.warn('[logpilot] Embedding failed:', err.message);
    return null;
  }
}

/**
 * Batch embed multiple texts — more efficient than one at a time.
 */
async function embedBatch(texts) {
  if (!modelReady || !embedder) return texts.map(() => null);

  const results = [];
  for (const text of texts) {
    results.push(await embed(text));
  }
  return results;
}

/**
 * Build a rich text representation of a log entry for embedding.
 * The richer the text, the better the semantic matching.
 */
function buildLogText(entry) {
  const parts = [];
  if (entry.method && entry.path) parts.push(`${entry.method} ${entry.path}`);
  if (entry.statusCode) parts.push(`status ${entry.statusCode}`);
  if (entry.responseTime) parts.push(`response time ${entry.responseTime}ms`);
  if (entry.level) parts.push(`level ${entry.level}`);
  if (entry.service && entry.service !== 'unknown') parts.push(`service ${entry.service}`);
  if (entry.message) parts.push(entry.message);
  if (entry.metadata) {
    try {
      const meta = typeof entry.metadata === 'string' ? JSON.parse(entry.metadata) : entry.metadata;
      if (meta.error) parts.push(meta.error);
      if (meta.code) parts.push(meta.code);
    } catch (e) {}
  }
  return parts.join('. ');
}

function isReady() { return modelReady; }
function getError() { return modelError; }
function getVectorSize() { return VECTOR_SIZE; }

module.exports = { initEmbedder, embed, embedBatch, buildLogText, isReady, getError, getVectorSize };
