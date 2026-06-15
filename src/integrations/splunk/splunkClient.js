const fetch = require('node-fetch');
const https = require('https');

let sessionKey = null;
let sessionExpiresAt = 0;

function isLocalEndpoint(value) {
  if (!value) return false;
  try {
    const url = new URL(String(value).includes('://') ? String(value) : `https://${value}`);
    return ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  } catch {
    return false;
  }
}

function resolveRejectUnauthorized(splunk) {
  const explicit =
    splunk.rejectUnauthorized ??
    process.env.SPLUNK_REJECT_TLS ??
    process.env.SPLUNK_REJECT_UNAUTHORIZED;

  if (explicit !== undefined) {
    return explicit !== false && String(explicit).toLowerCase() !== 'false';
  }

  const host = splunk.host || process.env.SPLUNK_HOST || 'localhost';
  const hecUrl = splunk.hecUrl || process.env.SPLUNK_HEC_URL;
  return !(isLocalEndpoint(host) || isLocalEndpoint(hecUrl));
}

function getSplunkConfig(config = {}) {
  const splunk = config.splunk || {};

  return {
    enabled:
      splunk.enabled === true ||
      process.env.SPLUNK_ENABLED === 'true',

    host:
      splunk.host ||
      process.env.SPLUNK_HOST ||
      'localhost',

    port:
      splunk.port ||
      process.env.SPLUNK_PORT ||
      8089,

    username:
      splunk.username ||
      process.env.SPLUNK_USERNAME,

    password:
      splunk.password ||
      process.env.SPLUNK_PASSWORD,

    // HEC token. `token` is a backwards-compatible alias used by older config
    // examples for HEC, not the Splunk REST search API.
    hecToken:
      splunk.hecToken ||
      splunk.token ||
      process.env.SPLUNK_HEC_TOKEN,

    hecUrl:
      splunk.hecUrl ||
      process.env.SPLUNK_HEC_URL,

    // REST search API token. This is intentionally separate from HEC.
    searchToken:
      splunk.searchToken ||
      splunk.restToken ||
      splunk.authToken ||
      process.env.SPLUNK_TOKEN,

    index:
      splunk.index ||
      process.env.SPLUNK_INDEX ||
      'logpilot',

    protocol:
      splunk.protocol ||
      process.env.SPLUNK_PROTOCOL ||
      'https',

    rejectUnauthorized: resolveRejectUnauthorized(splunk),
  };
}

function getBaseUrl(splunkConfig) {
  return `${splunkConfig.protocol}://${splunkConfig.host}:${splunkConfig.port}`;
}

function getAgent(splunkConfig) {
  return splunkConfig.protocol === 'https'
    ? new https.Agent({ rejectUnauthorized: splunkConfig.rejectUnauthorized })
    : undefined;
}

async function getSplunkClient(config = {}) {
  const splunkConfig = getSplunkConfig(config);

  if (!splunkConfig.enabled) {
    return {
      enabled: false,
      reason: 'Splunk integration disabled',
      config: splunkConfig,
    };
  }

  if (splunkConfig.searchToken) {
    return {
      enabled: true,
      authHeader: `Bearer ${splunkConfig.searchToken}`,
      config: splunkConfig,
    };
  }

  if (!splunkConfig.username || !splunkConfig.password) {
    return {
      enabled: false,
      reason: 'Missing Splunk search credentials',
      config: splunkConfig,
    };
  }

  // Reuse cached session
  if (sessionKey && Date.now() < sessionExpiresAt) {
    return {
      enabled: true,
      authHeader: `Splunk ${sessionKey}`,
      config: splunkConfig,
    };
  }

  const body = new URLSearchParams({
    username: splunkConfig.username,
    password: splunkConfig.password,
    output_mode: 'json',
  });

  const res = await fetch(
    `${getBaseUrl(splunkConfig)}/services/auth/login`,
    {
      method: 'POST',
      body,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      agent: getAgent(splunkConfig),
      timeout: 8000,
    }
  );

  if (!res.ok) {
    const errorText = await res.text();

    console.error('Splunk login failed:', {
      status: res.status,
      body: errorText,
    });

    throw new Error(`Splunk login failed (${res.status})`);
  }

  const data = await res.json();

  sessionKey = data.sessionKey;
  sessionExpiresAt = Date.now() + 45 * 60 * 1000;

  console.log('✓ Splunk Search API authenticated');

  return {
    enabled: true,
    authHeader: `Splunk ${sessionKey}`,
    config: splunkConfig,
  };
}

module.exports = { getSplunkClient, getSplunkConfig, getBaseUrl, getAgent, resolveRejectUnauthorized };
