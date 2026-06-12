'use strict';

/**
 * Correlation graph — a lightweight directed graph of incident evidence nodes.
 *
 * Nodes  : { id, type, label, data }
 * Edges  : { from, to, relation, weight }
 * Output : { nodes, edges, confidence }
 */

const RELATION_WEIGHTS = {
  CAUSED_BY:          1.0,
  TRIGGERED:          0.9,
  PRECEDED_BY:        0.8,
  CORRELATED_LOG:     0.7,
  CORRELATED_METRIC:  0.6,
  CORRELATED_DEPLOY:  0.85,
  CORRELATED_HEAL:    0.75,
  SIMILAR_INCIDENT:   0.65,
};

class CorrelationGraph {
  constructor() {
    this.nodes = new Map();  // id → node
    this.edges = [];
  }

  addNode(id, type, label, data = {}) {
    if (!this.nodes.has(id)) {
      this.nodes.set(id, { id, type, label, data });
    }
    return this;
  }

  addEdge(fromId, toId, relation, meta = {}) {
    // Ensure both nodes exist
    if (!this.nodes.has(fromId) || !this.nodes.has(toId)) return this;
    const weight = RELATION_WEIGHTS[relation] ?? 0.5;
    this.edges.push({ from: fromId, to: toId, relation, weight, ...meta });
    return this;
  }

  /**
   * Compute overall graph confidence as a weighted mean of edge weights,
   * clamped to [0, 1].
   */
  computeConfidence() {
    if (this.edges.length === 0) return 0;
    const sum = this.edges.reduce((acc, e) => acc + e.weight, 0);
    return Math.round((sum / this.edges.length) * 100) / 100;
  }

  toJSON() {
    return {
      nodes: Array.from(this.nodes.values()),
      edges: this.edges,
      confidence: this.computeConfidence(),
    };
  }
}

module.exports = { CorrelationGraph, RELATION_WEIGHTS };
