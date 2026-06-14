# Splunk Setup Guide for LogPilot

## Quick start (Docker — fastest for hackathon)

```bash
docker run -d \
  -e SPLUNK_START_ARGS=--accept-license \
  -e SPLUNK_PASSWORD=changeme \
  -p 8000:8000 \   # Splunk Web UI
  -p 8088:8088 \   # HEC endpoint
  -p 8089:8089 \   # REST API
  --name splunk \
  splunk/splunk:latest
```

Wait ~60 seconds for Splunk to start, then open http://localhost:8000 (admin/changeme).

---

## Step 1 — Create the HEC token

1. Go to **Settings → Data Inputs → HTTP Event Collector**
2. Click **New Token**
3. Name: `logpilot`
4. Source type: `_json`
5. Index: create a new index called `logpilot` (or use `main`)
6. Click **Submit** and copy the token

---

## Step 2 — Create the index

1. Go to **Settings → Indexes → New Index**
2. Index name: `logpilot`
3. Leave defaults → Save

---

## Step 3 — Enable HEC globally

1. Go to **Settings → Data Inputs → HTTP Event Collector**
2. Click **Global Settings**
3. Set **All tokens** to **Enabled**
4. **Disable SSL** for local dev (or install self-signed cert)
5. Save

---

## Step 4 — Configure LogPilot

Set environment variables before starting your app:

```bash
export SPLUNK_ENABLED=true
export SPLUNK_HEC_URL=http://localhost:8088
export SPLUNK_HEC_TOKEN=your-token-here
export SPLUNK_INDEX=logpilot
export SPLUNK_HOST=localhost
export SPLUNK_PORT=8089
export SPLUNK_PROTOCOL=http        # use https for production
export SPLUNK_REJECT_TLS=false     # false for self-signed certs
```

Or in `logpilot.config.js`:

```js
module.exports = {
  splunk: {
    enabled:  true,
    hecUrl:   'http://localhost:8088',
    token:    'your-token-here',
    index:    'logpilot',
    host:     'localhost',
    port:     8089,
    protocol: 'http',
    rejectUnauthorized: false,
  },
};
```

---

## Step 5 — Verify connectivity

Start your app and check:

```
GET http://localhost:4321/api/splunk/health
```

Expected response when working:
```json
{
  "enabled": true,
  "hecStatus": { "ok": true },
  "hecHealth": {
    "healthy": true,
    "queueSize": 0,
    "dlqSize": 0,
    "droppedEvents": 0,
    "totalSent": 47
  },
  "startupDiagnostics": {
    "hec": { "ok": true, "latencyMs": 12 }
  }
}
```

---

## Step 6 — Search your events in Splunk

Open Splunk Search (http://localhost:8000) and run:

```spl
index=logpilot | stats count by type
```

You should see event types: `request`, `incident`, `metric`, `heal`, `rca`, `recovery`, `postmortem`.

---

## Event types and sourcetypes

| LogPilot event type | Splunk sourcetype      | Emitted by                  |
|---------------------|------------------------|-----------------------------|
| `request`           | `logpilot:request`     | Every HTTP request          |
| `error`             | `logpilot:error`       | 5xx responses               |
| `incident`          | `logpilot:incident`    | New/updated incident groups |
| `metric`            | `logpilot:metric`      | System metrics (10% sample) |
| `anomaly`           | `logpilot:anomaly`     | Detected anomalies          |
| `heal`              | `logpilot:heal`        | Heal rule executions        |
| `rca`               | `logpilot:rca`         | AI investigation results    |
| `recovery`          | `logpilot:recovery`    | Recovery verification       |
| `postmortem`        | `logpilot:postmortem`  | Generated postmortems       |

---

## Useful SPL queries

**Incident overview:**
```spl
index=logpilot type=incident | stats count by severity rootCause | sort -count
```

**Error rate by endpoint:**
```spl
index=logpilot type=request | eval is_error=if(statusCode>=500,1,0) | stats avg(is_error)*100 as error_rate by path | sort -error_rate
```

**MTTR (mean time to recovery):**
```spl
index=logpilot type=recovery resolved=true | stats avg(eval(checkedAt-incidentId)) as mttr_ms
```

**Heal action effectiveness:**
```spl
index=logpilot type=heal | stats count by action success | sort -count
```

**Recent AI investigations:**
```spl
index=logpilot type=rca | table _time incidentId rootCause confidence category source | sort -_time
```

---

## Production Splunk (non-Docker)

For a real Splunk Enterprise install, use the REST API token approach:

```js
splunk: {
  enabled:  true,
  hecUrl:   'https://splunk.yourcompany.com:8088',
  token:    process.env.SPLUNK_HEC_TOKEN,
  host:     'splunk.yourcompany.com',
  port:     8089,
  protocol: 'https',
  rejectUnauthorized: true,   // true for valid TLS certs
}
```

---

## Troubleshooting

**Events not arriving in Splunk:**
1. Check `/api/splunk/health` — look at `hecStatus.ok` and `lastError`
2. Verify HEC is globally enabled in Splunk settings
3. Confirm the token matches and the index exists
4. Check `dlqSize` — if > 0, events are failing permanently

**SSL errors with self-signed certs:**
Set `rejectUnauthorized: false` in config or `SPLUNK_REJECT_TLS=false` env var.

**Events arriving but wrong index:**
The HEC token's default index overrides the `index` field in the payload.
Make sure the token is allowed to write to `logpilot` index.
