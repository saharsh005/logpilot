'use strict';

/**
 * SplunkService — central event emitter for all LogPilot subsystems.
 *
 * Phase 11 additions:
 *   - sendTypedEvent() with full schema for each event type
 *   - startup diagnostics: testConnectivity(), validateIndex()
 *   - getFullHealth() for /api/splunk/health endpoint
 *   - Emits: request, error, metric, incident, anomaly, heal,
 *            recovery, rca, postmortem, deployment
 */

const { HECClient, SCHEMA_VERSION } = require('./hec');
const { getSplunkClient, getSplunkConfig } = require('./splunkClient');
const chalk = require('chalk');

let _service = null;

class SplunkService {
  constructor(config = {}) {
    this.config       = config;
    this.splunkConfig = getSplunkConfig(config);
    this.enabled      = this.splunkConfig.enabled === true;

    this.startupDiagnostics = null;  // filled by init()

    if (this.enabled && this.splunkConfig.hecToken) {
      this.hec = new HECClient({
        hecUrl:             this.splunkConfig.hecUrl || `https://${this.splunkConfig.host}:8088`,
        hecToken:           this.splunkConfig.hecToken,
        index:              this.splunkConfig.index   || 'logpilot',
        batchSize:          config.batchSize          || 100,
        flushInterval:      config.flushInterval      || 5000,
        maxQueueSize:       config.maxQueueSize        || 1000,
        maxDLQSize:         config.maxDLQSize          || 500,
        retryAttempts:      config.retryAttempts       || 3,
        rejectUnauthorized: this.splunkConfig.rejectUnauthorized !== false,
      });
    }
  }

  isEnabled() { return this.enabled && !!this.hec; }

  // ── Core send ─────────────────────────────────────────────────────────────

  async sendEvent(type, data) {
    if (!this.isEnabled()) return;
    try {
      await this.hec.send({
        time:  Date.now() / 1000,
        source: 'logpilot',
        event: { type, schema_version: SCHEMA_VERSION, timestamp: Date.now(), ...data },
      });
    } catch (_) {}
  }

  // ── Typed event emitters ──────────────────────────────────────────────────

  sendRequest(data) {
    const { collectMetrics } = require('../../core/metrics');
    const m = collectMetrics();
    return this.sendEvent('request', {
      method:       data.method,
      path:         data.path,
      statusCode:   data.statusCode,
      responseTime: data.responseTime,
      service:      data.service,
      level:        data.level,
      ip:           data.metadata?.ip,
      // ── System snapshot at request time ──────────────────────────────
      cpuLoad:        m.cpuLoad,
      cpuCount:       m.cpuCount,
      memoryPercent:  m.memoryPercent,
      memoryUsedMB:   m.memoryUsedMB,
      totalMemoryMB:  m.totalMemoryMB,
      heapUsedMB:     m.heapUsedMB,
      heapTotalMB:    m.heapTotalMB,
      rssMB:          m.rssMB,
      externalMB:     m.externalMB,
      eventLoopLagMs: m.eventLoopLagMs,
    });
  }

  sendIncident(incident) {
    return this.sendEvent('incident', {
      incidentId:  incident.id,
      title:       incident.title,
      path:        incident.path,
      method:      incident.method,
      statusCode:  incident.status_code,
      severity:    incident.severity,
      rootCause:   incident.root_cause,
      count:       incident.count,
      firstSeen:   incident.first_seen,
      lastSeen:    incident.last_seen,
    });
  }

  sendAnomaly(anomaly) {
    return this.sendEvent('anomaly', {
      type:     anomaly.type,
      path:     anomaly.path,
      value:    anomaly.value,
      severity: anomaly.severity,
      message:  anomaly.message,
    });
  }

  sendHeal(healAction) {
    return this.sendEvent('heal', {
      ruleName:  healAction.rule_name,
      action:    healAction.action,
      path:      healAction.trigger_detail,
      success:   healAction.success,
      notes:     healAction.notes,
    });
  }

  sendRCA(result) {
    return this.sendEvent('rca', {
      incidentId:       result.incidentId,
      rootCause:        result.rootCause,
      confidence:       result.confidence,
      category:         result.category,
      source:           result.source,
      provider:         result.provider,
      hypothesesCount:  result.hypotheses?.length || 0,
      similarCount:     result.similar?.length    || 0,
    });
  }

  sendRecovery(incidentId, result) {
    return this.sendEvent('recovery', {
      incidentId,
      resolved:      result.resolved,
      confidence:    result.confidence,
      errorRate:     result.errorRate,
      totalRequests: result.totalRequests,
      source:        result.source,
    });
  }

  sendPostmortem(incidentId, postmortem) {
    return this.sendEvent('postmortem', {
      incidentId,
      generatedAt: Date.now(),
      length:      postmortem?.length || 0,
    });
  }

  sendDeployment(info) {
    return this.sendEvent('deployment', {
      commitHash:   info.commitHash,
      author:       info.author,
      subject:      info.subject,
      branch:       info.branch,
      changedFiles: info.changedFiles?.length || 0,
    });
  }

  // ── Startup diagnostics ───────────────────────────────────────────────────

  async runStartupDiagnostics() {
    if (!this.enabled) {
      this.startupDiagnostics = { enabled: false, reason: 'Splunk integration disabled' };
      return this.startupDiagnostics;
    }

    const connectivity = this.hec
      ? await this.hec.testConnectivity()
      : { ok: false, reason: 'No HEC token configured' };
    const searchStatus = await this._testSearch();

    this.startupDiagnostics = {
      enabled:       true,
      hec:           connectivity,
      search:        searchStatus,
      index:         this.splunkConfig.index || 'logpilot',
      host:          this.splunkConfig.host,
      checkedAt:     Date.now(),
    };

    return this.startupDiagnostics;
  }

  async _testSearch() {
    try {
      const client = await getSplunkClient(this.config);
      if (!client.enabled) return { ok: false, reason: client.reason };
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  }

  // ── Full health for /api/splunk/health ────────────────────────────────────

  async getFullHealth() {
    const hecHealth = this.hec?.getHealth() || null;

    // Quick connectivity check (non-blocking, cached result if recent)
    let hecStatus = { ok: false, reason: 'not configured' };
    if (this.hec && this.hec.isHealthy) {
      hecStatus = { ok: true };
    } else if (this.hec) {
      hecStatus = { ok: false, reason: hecHealth?.lastError || 'unhealthy' };
    }

    const searchStatus = this.startupDiagnostics?.search || await this._testSearch();

    return {
      enabled:          this.enabled,
      hecStatus,
      hecHealth,
      searchStatus,
      startupDiagnostics: this.startupDiagnostics,
      index:            this.splunkConfig.index,
      host:             this.splunkConfig.host,
      schemaVersion:    SCHEMA_VERSION,
      checkedAt:        Date.now(),
    };
  }

  async flush() { if (this.hec) await this.hec.flush(); }

  async close() { if (this.hec) await this.hec.close(); }
}

// ── Singleton ─────────────────────────────────────────────────────────────

function initSplunkService(config = {}) {
  _service = new SplunkService(config);

  if (_service.isEnabled()) {
    console.log(chalk.cyan('[logpilot]'), chalk.green('✓ Splunk HEC enabled'));
    // Run startup diagnostics in background — don't block init
    setImmediate(() => {
      _service.runStartupDiagnostics().then(diag => {
        if (diag.hec?.ok) {
          console.log(chalk.cyan('[logpilot]'), chalk.green(`✓ Splunk HEC connectivity OK (${diag.hec.latencyMs}ms)`));
        } else {
          const error = diag.hec?.error || diag.hec?.reason || 'unknown';
          const tlsHint = /self-signed|certificate/i.test(error)
            ? ' Set splunk.rejectUnauthorized=false or SPLUNK_REJECT_TLS=false for local Splunk.'
            : '';
          console.warn(chalk.yellow('[logpilot] ⚠ Splunk HEC connectivity failed:'), `${error}${tlsHint}`);
        }
      }).catch(() => {});
    });
  }

  return _service;
}

function getService() { return _service; }

module.exports = { SplunkService, initSplunkService, getService };
