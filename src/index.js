/**
 * logpilot — Zero-config monitoring, NLP log search, and self-healing for Node.js
 *
 * Usage:
 *   const logpilot = require('logpilot');
 *   logpilot.init({ app, healEnabled: true });
 */

const path = require('path');
const fs   = require('fs');
const chalk = require('chalk');

const db             = require('./storage/db');
const { startMetricsCollection } = require('./core/metrics');
const { createMiddleware, logCustom } = require('./core/interceptor');
const { getCircuitBreakerMiddleware, evaluate } = require('./heal/heal-engine');
const { startDashboard }  = require('./dashboard/server');
const { search }          = require('./nlp/search-engine');
const { cleanup }         = require('./storage/db');
const { initEmbedder }    = require('./nlp/embedder');
const vectorStore         = require('./nlp/vector-store');
const { initSplunkService } = require('./integrations/splunk/service');
const { commandIncident, listCommandableIncidents, getPredictiveSearches } = require('./commander/incidentCommander');

let _config = {};
let _initialized = false;
let _healInterval = null;

/**
 * Initialize logpilot
 * @param {object} options
 * @param {object} options.app           - Express app instance
 * @param {boolean} options.healEnabled  - Enable self-healing engine (default: false)
 * @param {boolean} options.dashboard    - Serve dashboard UI (default: true)
 * @param {number}  options.dashboardPort - Port for dashboard (default: 4321)
 * @param {string}  options.configFile   - Path to logpilot.config.js
 * @param {string}  options.storageDir   - Where to store SQLite DB (default: .logpilot/)
 * @param {boolean} options.consoleOutput - Print logs to console (default: true)
 * @param {boolean} options.dryRun       - Simulate heals without executing (default: false)
 */
async function init(options = {}) {
  if (_initialized) {
    console.warn(chalk.yellow('[logpilot] Already initialized. Skipping.'));
    return;
  }
  _initialized = true;

  // ── Load config file if provided ─────────────────────────
  let fileConfig = {};
  const configPath = options.configFile
    ? path.resolve(options.configFile)
    : path.resolve(process.cwd(), 'logpilot.config.js');

  if (fs.existsSync(configPath)) {
    try {
      fileConfig = require(configPath);
      console.log(chalk.cyan('[logpilot]'), chalk.gray(`Loaded config from ${configPath}`));
    } catch (e) {
      console.warn(chalk.yellow('[logpilot] Could not load config file:', e.message));
    }
  }

  _config = {
    healEnabled:   false,
    dashboard:     true,
    dashboardPort: 4321,
    storageDir:    path.resolve(process.cwd(), '.logpilot'),
    consoleOutput: true,
    dryRun:        false,
    semanticSearch: true,
    ...fileConfig,
    ...options,
  };

  // ── Setup storage directory ───────────────────────────────
  if (!fs.existsSync(_config.storageDir)) {
    fs.mkdirSync(_config.storageDir, { recursive: true });
  }

  // ── Register middlewares on Express app ──────────────────
  if (_config.app) {
    // Circuit breaker must be FIRST — before route handlers
    _config.app.use(getCircuitBreakerMiddleware());
    // Interceptor wraps all routes
    _config.app.use(createMiddleware(_config));
    console.log(chalk.cyan('[logpilot]'), chalk.green('✓ Middleware attached to Express app'));
  } else {
    console.warn(chalk.yellow('[logpilot] No Express app provided — HTTP monitoring disabled'));
  }

  // ── Init DB ───────────────────────────────────────────────
  await db.initDB(_config.storageDir);

  // ── Init Splunk service ────────────────────────────────────
  initSplunkService(_config);

  // ── Start metrics collection ──────────────────────────────
  startMetricsCollection(5000);
  console.log(chalk.cyan('[logpilot]'), chalk.green('✓ Metrics collection started'));

  // ── Start dashboard ───────────────────────────────────────
  if (_config.dashboard !== false) {
    startDashboard(_config.dashboardPort, _config);
  }

  // ── Init embedding model (non-blocking) ───────────────────
  // Starts loading in background — keyword search works immediately,
  // semantic search activates once model is ready (~5-10s)
  if (_config.semanticSearch !== false) {
    initEmbedder().catch(() => {});
  }

  // ── Connect to Qdrant (non-blocking) ─────────────────────
  // Falls back to keyword search if Qdrant isn't running
  if (_config.semanticSearch !== false) {
    const qdrantUrl = _config.qdrantUrl || 'http://localhost:6333';
    vectorStore.connect(qdrantUrl).catch(() => {});
  }

  // ── Start self-heal engine ────────────────────────────────
  if (_config.healEnabled) {
    if (_config.dryRun) {
      console.log(chalk.cyan('[logpilot]'), chalk.yellow('⚠ Self-heal engine running in DRY RUN mode'));
    } else {
      console.log(chalk.cyan('[logpilot]'), chalk.green('✓ Self-heal engine ACTIVE'));
    }
    _healInterval = setInterval(() => {
      evaluate(_config).catch(() => {});
    }, 30 * 1000); // evaluate every 30 seconds

    if (_healInterval.unref) _healInterval.unref();
  }

  // ── Scheduled DB cleanup (7-day retention) ────────────────
  const { CronJob } = require('cron');
  new CronJob('0 3 * * *', () => cleanup(7), null, true); // 3am daily

  // ── Banner ────────────────────────────────────────────────
  printBanner();
}

function printBanner() {
  console.log('\n' + chalk.cyan('  ██╗      ██████╗  ██████╗ ██████╗ ██╗██╗      ██████╗ ████████╗'));
  console.log(chalk.cyan('  ██║     ██╔═══██╗██╔════╝ ██╔══██╗██║██║     ██╔═══██╗╚══██╔══╝'));
  console.log(chalk.cyan('  ██║     ██║   ██║██║  ███╗██████╔╝██║██║     ██║   ██║   ██║   '));
  console.log(chalk.cyan('  ██║     ██║   ██║██║   ██║██╔═══╝ ██║██║     ██║   ██║   ██║   '));
  console.log(chalk.cyan('  ███████╗╚██████╔╝╚██████╔╝██║     ██║███████╗╚██████╔╝   ██║   '));
  console.log(chalk.cyan('  ╚══════╝ ╚═════╝  ╚═════╝ ╚═╝     ╚═╝╚══════╝ ╚═════╝   ╚═╝   '));
  console.log(chalk.gray('  Zero-config monitoring · NLP search · Self-healing\n'));
}

/**
 * Manually log a message
 * @param {'info'|'warn'|'error'} level
 * @param {string} message
 * @param {object} metadata
 */
function log(level, message, metadata = {}) {
  logCustom(level, message, metadata);
}

/**
 * Run a plain-English log search
 * @param {string} query - e.g. "payment errors last night"
 */
function query(queryStr) {
  return search(queryStr);
}

/**
 * Get current system metrics snapshot
 */
function metrics() {
  const { getCurrentMetrics } = require('./core/metrics');
  return getCurrentMetrics();
}

/**
 * Get logpilot status
 */
function status() {
  return {
    initialized: _initialized,
    healEnabled: _config.healEnabled,
    dashboardPort: _config.dashboardPort,
    dryRun: _config.dryRun,
    stats: db.getStats(),
    metrics: metrics(),
  };
}

function incidents(options = {}) {
  return listCommandableIncidents(_config, options);
}

function command(incidentId, options = {}) {
  return commandIncident(incidentId, _config, options);
}

function predictions() {
  return getPredictiveSearches(_config);
}

// ── Phase 12: Graceful shutdown ──────────────────────────────────────────

async function shutdown(signal = 'SIGTERM') {
  const chalk = require('chalk');
  console.log(chalk.cyan('[logpilot]'), chalk.yellow(`Graceful shutdown (${signal})…`));

  // Stop heal engine
  if (_healInterval) { clearInterval(_healInterval); _healInterval = null; }

  // Flush and close Splunk HEC — drain any queued events before exit
  try {
    const { getService } = require('./integrations/splunk/service');
    const splunk = getService();
    if (splunk?.isEnabled()) {
      console.log(chalk.cyan('[logpilot]'), chalk.gray('Flushing Splunk HEC queue…'));
      await splunk.close();
      console.log(chalk.cyan('[logpilot]'), chalk.green('✓ Splunk HEC flushed'));
    }
  } catch (e) {}

  // Persist SQLite to disk
  try { db.persistDB(); } catch (e) {}

  console.log(chalk.cyan('[logpilot]'), chalk.green('✓ Shutdown complete'));
}

// Auto-register signal handlers (idempotent)
let _shutdownRegistered = false;
function _registerShutdownHandlers() {
  if (_shutdownRegistered) return;
  _shutdownRegistered = true;
  const handle = sig => async () => {
    await shutdown(sig).catch(() => {});
    process.exit(0);
  };
  process.once('SIGTERM', handle('SIGTERM'));
  process.once('SIGINT',  handle('SIGINT'));
}

module.exports = { init, log, query, metrics, status, incidents, command, predictions, shutdown };
