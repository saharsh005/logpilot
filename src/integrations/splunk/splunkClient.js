require('dotenv').config();

const fetch = require('node-fetch');


let sessionKey = null;
let sessionExpiresAt = 0;

function getSplunkConfig(config = {}) {
  const splunk = config.splunk || {};
  return {
    enabled: splunk.enabled === true || process.env.SPLUNK_ENABLED === 'true',
    host: splunk.host || process.env.SPLUNK_HOST || 'localhost',
    port: splunk.port || process.env.SPLUNK_PORT || 8089,
    username: splunk.username || process.env.SPLUNK_USERNAME,
    password: splunk.password || process.env.SPLUNK_PASSWORD,
    token: splunk.token || process.env.SPLUNK_TOKEN,
    index: splunk.index || process.env.SPLUNK_INDEX || 'logpilot',
    protocol: splunk.protocol || process.env.SPLUNK_PROTOCOL || 'https',
    rejectUnauthorized: splunk.rejectUnauthorized !== false,
  };
}

function getBaseUrl(splunkConfig) {
  return `${splunkConfig.protocol}://${splunkConfig.host}:${splunkConfig.port}`;
}

async function getSplunkClient(config = {}) {
  const splunkConfig = getSplunkConfig(config);
  if (!splunkConfig.enabled) {
    return { enabled: false, reason: 'Splunk integration disabled', config: splunkConfig };
  }

  if (splunkConfig.token) {
    return { enabled: true, authHeader: `Bearer ${splunkConfig.token}`, config: splunkConfig };
  }

  if (!splunkConfig.username || !splunkConfig.password) {
    return { enabled: false, reason: 'Missing Splunk credentials', config: splunkConfig };
  }

  if (sessionKey && Date.now() < sessionExpiresAt) {
    return { enabled: true, authHeader: `Splunk ${sessionKey}`, config: splunkConfig };
  }

  const body = new URLSearchParams({
    username: splunkConfig.username,
    password: splunkConfig.password,
    output_mode: 'json',
  });

  const https = require('https');

  const agent = new https.Agent({
  rejectUnauthorized: false
  });

  const res = await fetch(
    `${getBaseUrl(splunkConfig)}/services/auth/login?output_mode=json`,
    {
      method: 'POST',
      body,
      agent,
      headers: {
        'Content-Type':'application/x-www-form-urlencoded'
      }
    }
  );

  const responseText = await res.text();

  console.log("Splunk Login Status:", res.status);
  console.log("Splunk Login Response:", responseText);

  if (!res.ok) {
    throw new Error(`Splunk login failed (${res.status})`);
  }

  const data = JSON.parse(responseText);

  sessionKey = data.sessionKey;
  sessionExpiresAt = Date.now() + 45 * 60 * 1000;
  return { enabled: true, authHeader: `Splunk ${sessionKey}`, config: splunkConfig };
}

module.exports = { getSplunkClient, getSplunkConfig, getBaseUrl };
