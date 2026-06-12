'use strict';

/**
 * Lightweight TF-IDF embeddings for incident text similarity.
 *
 * No external dependencies — pure JS implementation.
 * Used by the similar incident search as a fallback/complement to
 * structural scoring when external vector stores are unavailable.
 */

const { tokenise } = require('../correlation/similarity');

/**
 * Build a TF-IDF vocabulary from a list of documents (strings).
 */
function buildVocabulary(documents) {
  const df = {};  // document frequency per token
  const processed = documents.map(doc => {
    const tokens = tokenise(doc);
    const unique = new Set(tokens);
    for (const t of unique) {
      df[t] = (df[t] || 0) + 1;
    }
    return tokens;
  });

  const vocab = Object.keys(df);
  const idf = {};
  const N = documents.length;
  for (const term of vocab) {
    idf[term] = Math.log((N + 1) / (df[term] + 1)) + 1;  // smoothed
  }

  return { vocab, idf, processed };
}

/**
 * Compute a TF-IDF vector for a single document given a pre-built vocabulary.
 */
function vectorize(tokens, vocab, idf) {
  const tf = {};
  for (const t of tokens) {
    tf[t] = (tf[t] || 0) + 1;
  }
  const total = tokens.length || 1;
  const vec = vocab.map(term => {
    const termFreq = (tf[term] || 0) / total;
    return termFreq * (idf[term] || 1);
  });
  return vec;
}

/**
 * Cosine similarity between two equal-length vectors.
 */
function cosineSimilarity(vecA, vecB) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dot += vecA[i] * vecB[i];
    normA += vecA[i] ** 2;
    normB += vecB[i] ** 2;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Score a query text against a corpus of incident texts.
 *
 * @param {string} queryText
 * @param {Array<{id, text}>} corpus
 * @returns {Array<{id, score}>} sorted descending
 */
function rankByEmbedding(queryText, corpus) {
  if (!corpus.length) return [];

  const allDocs = [queryText, ...corpus.map(d => d.text)];
  const { vocab, idf, processed } = buildVocabulary(allDocs);

  const queryVec = vectorize(processed[0], vocab, idf);
  const results = corpus.map((item, i) => ({
    id: item.id,
    score: cosineSimilarity(queryVec, vectorize(processed[i + 1], vocab, idf)),
  }));

  return results.sort((a, b) => b.score - a.score);
}

module.exports = { rankByEmbedding, buildVocabulary, vectorize, cosineSimilarity };
