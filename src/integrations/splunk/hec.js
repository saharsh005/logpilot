'use strict';

/**
 * HEC Client — production-hardened HTTP Event Collector for Splunk.
 *
 * Improvements over v1:
 *   - Dead-letter queue (DLQ) for permanently failed events
 *   - Backpressure: drops oldest events when queue is full, increments droppedEvents counter
 *   - Event versioning: schema_version field on every payload
 *   - Full health stats: lastFlushAt, lastSuccessAt, droppedEvents, dlqSize
 *   - Startup connectivity check: testConnectivity()
 *   - Graceful shutdown: close() drains queue before returning
 *   - Per-event sourcetype routing based on event.event.type
 */

const fetch = require('node-fetch');
const https = require('https');

const SCHEMA_VERSION = '2';

const SOURCETYPE_MAP = {
  request:    'logpilot:request',
  error:      'logpilot:error',
  metric:     'logpilot:metric',
  incident:   'logpilot:incident',
  anomaly:    'logpilot:anomaly',
  heal:       'logpilot:heal',
  recovery:   'logpilot:recovery',
  rca:        'logpilot:rca',
  postmortem: 'logpilot:postmortem',
  deployment: 'logpilot:deployment',
};

class HECClient {
  constructor(config = {}) {
    this.hecUrl           = config.hecUrl  || 'http://localhost:8088';
    this.hecToken         = config.hecToken || '';
    this.batchSize        = config.batchSize       || 100;
    this.flushInterval    = config.flushInterval   || 5000;
    this.maxQueueSize     = config.maxQueueSize     || 1000;
    this.maxDLQSize       = config.maxDLQSize       || 500;
    this.retryAttempts    = config.retryAttempts    || 3;
    this.rejectUnauthorized = config.rejectUnauthorized !== false;
    this.index            = config.index || 'logpilot';

    this.queue = [];
    this.dlq   = [];   // dead-letter queue

    // Health counters
    this.isHealthy          = true;
    this.droppedEvents      = 0;
    this.totalSent          = 0;
    this.lastFlushAt        = null;
    this.lastSuccessAt      = null;
    this.lastError          = null;
    this.consecutiveFailures = 0;

    this.flushTimer = null;
    this._startFlushTimer();
  }

  /**
   * Enqueue a single HEC event.
   * Applies schema versioning, sourcetype routing, and backpressure.
   */
  send(event) {
    if (!this.hecToken) return Promise.resolve();

    if (!event.time) event.time = Date.now() / 1000;
    event.source     = event.source     || 'logpilot';
    event.index      = event.index      || this.index;
    event.sourcetype = SOURCETYPE_MAP[event.event?.type] || event.sourcetype || 'logpilot:generic';

    // Stamp schema version
    if (event.event) event.event.schema_version = SCHEMA_VERSION;

    // Backpressure: drop oldest when queue is full
    if (this.queue.length >= this.maxQueueSize) {
      this.queue.shift();
      this.droppedEvents++;
    }

    this.queue.push(event);

    if (this.queue.length >= this.batchSize) {
      return this.flush();
    }
    return Promise.resolve();
  }

  async flush() {
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0, this.batchSize);
    this.lastFlushAt = Date.now();
    return this._sendBatch(batch);
  }

  async _sendBatch(batch, attempt = 0) {
    if (!this.hecToken) return;

    try {
      const body = batch.map(e => JSON.stringify(e)).join('\n');

      const agent = this.hecUrl.startsWith('https')
        ? new https.Agent({ rejectUnauthorized: this.rejectUnauthorized })
        : undefined;

      const res = await fetch(`${this.hecUrl}/services/collector`, {
        method:  'POST',
        headers: {
          Authorization:  `Splunk ${this.hecToken}`,
          'Content-Type': 'application/json',
        },
        body,
        agent,
        timeout: 8000,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HEC ${res.status}: ${text.slice(0, 120)}`);
      }

      this.isHealthy           = true;
      this.lastSuccessAt        = Date.now();
      this.consecutiveFailures  = 0;
      this.totalSent           += batch.length;

    } catch (err) {
      this.isHealthy    = false;
      this.lastError    = err.message;
      this.consecutiveFailures++;

      if (attempt < this.retryAttempts) {
        const delay = Math.pow(2, attempt) * 200;  // 200ms, 400ms, 800ms
        await new Promise(r => setTimeout(r, delay));
        return this._sendBatch(batch, attempt + 1);
      }

      // Move to DLQ after exhausting retries
      if (this.dlq.length + batch.length <= this.maxDLQSize) {
        this.dlq.push(...batch);
      } else {
        // DLQ also full — count as dropped
        this.droppedEvents += batch.length;
      }
    }
  }

  /**
   * Retry all DLQ events. Call periodically or on health recovery.
   */
  async retryDLQ() {
    if (this.dlq.length === 0) return;
    const batch = this.dlq.splice(0);
    return this._sendBatch(batch);
  }

  /**
   * Test HEC connectivity. Returns { ok, latencyMs, error }.
   */
  async testConnectivity() {
    if (!this.hecToken) return { ok: false, error: 'No HEC token configured' };

    const start = Date.now();
    try {
      const agent = this.hecUrl.startsWith('https')
        ? new https.Agent({ rejectUnauthorized: this.rejectUnauthorized })
        : undefined;

      // Send a minimal health-check event
      const res = await fetch(`${this.hecUrl}/services/collector`, {
        method:  'POST',
        headers: {
          Authorization:  `Splunk ${this.hecToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          time:       Date.now() / 1000,
          source:     'logpilot',
          sourcetype: 'logpilot:healthcheck',
          index:      this.index,
          event: { type: 'healthcheck', schema_version: SCHEMA_VERSION, ts: Date.now() },
        }),
        agent,
        timeout: 5000,
      });

      const latencyMs = Date.now() - start;
      if (res.ok) {
        this.isHealthy   = true;
        this.lastSuccessAt = Date.now();
        return { ok: true, latencyMs };
      }
      const text = await res.text().catch(() => '');
      return { ok: false, latencyMs, error: `HTTP ${res.status}: ${text.slice(0, 80)}` };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - start, error: err.message };
    }
  }

  _startFlushTimer() {
    this.flushTimer = setInterval(() => {
      this.flush().catch(() => {});
      // Periodically retry DLQ (every 5 flush cycles)
      if (Math.random() < 0.2 && this.dlq.length > 0) {
        this.retryDLQ().catch(() => {});
      }
    }, this.flushInterval);
    if (this.flushTimer.unref) this.flushTimer.unref();
  }

  /**
   * Graceful shutdown — drains queue then closes flush timer.
   */
  async close() {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    // Drain queue (up to 3 flush rounds)
    for (let i = 0; i < 3 && this.queue.length > 0; i++) {
      await this.flush().catch(() => {});
    }
  }

  getHealth() {
    return {
      healthy:             this.isHealthy,
      queueSize:           this.queue.length,
      dlqSize:             this.dlq.length,
      droppedEvents:       this.droppedEvents,
      totalSent:           this.totalSent,
      consecutiveFailures: this.consecutiveFailures,
      lastFlushAt:         this.lastFlushAt,
      lastSuccessAt:       this.lastSuccessAt,
      lastError:           this.lastError,
    };
  }
}

module.exports = { HECClient, SCHEMA_VERSION, SOURCETYPE_MAP };
