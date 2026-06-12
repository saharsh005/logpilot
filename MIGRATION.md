# LogPilot — Migration Notes: Agentic Operations Platform

## Summary

LogPilot has been transformed from a self-healing observability package into a full
**Agentic Operations Platform** built on Splunk, with a multi-stage AI investigation
pipeline, rich correlation graph, similar incident search, LLM-powered RCA, MCP
tool integration, and ranked recovery recommendations.

All changes are **fully backward compatible**. Existing users with no Splunk
configuration will see identical behaviour — every new feature degrades gracefully
to local SQLite + deterministic fallback.

---

## What was already implemented (pre-session)

| Phase | Module | Status |
|-------|--------|--------|
| 1 — Splunk HEC + Search  | `src/integrations/splunk/` | ✅ Complete |
| 2 — Evidence Collection  | `src/investigator/evidence/` | ✅ Complete |
| 3 — Correlators (partial)| `src/correlation/IncidentCorrelator.js` + `Log/Metric/GithubCorrelator.js` | ⚠️ Partial |
| 5 — Deterministic RCA    | `src/ai/RootCauseEngine.js` | ✅ Complete (no LLM) |
| 8 — Recovery Verification| `src/recovery/RecoveryVerifier.js` | ✅ Complete |
| 9 — Postmortem           | `src/postmortem/PostmortemGenerator.js` | ✅ Complete |

---

## New files added this session

### Phase 3 — Correlation Graph

| File | Purpose |
|------|---------|
| `src/correlation/graph.js` | `CorrelationGraph` class — typed nodes, weighted edges, confidence scoring |
| `src/correlation/correlator.js` | Builds the full incident graph from all evidence sources |
| `src/correlation/similarity.js` | Jaccard similarity, tokeniser, `scoreIncidentSimilarity()` |

**No breaking changes.** Existing `IncidentCorrelator.buildIncidentContext()` is
unchanged. The new `buildCorrelationGraph(context)` wraps it.

---

### Phase 4 — Similar Incident Search

| File | Purpose |
|------|---------|
| `src/similarity/incident-search.js` | Finds historical incidents by path/cause/title/status, returns ranked results |
| `src/similarity/embeddings.js` | Pure-JS TF-IDF vectoriser + cosine similarity (no external deps) |

**No breaking changes.** New `src/similarity/` directory. Queries existing SQLite
`incident_groups` table — no schema changes.

---

### Phase 5 — AI Investigator

| File | Purpose |
|------|---------|
| `src/agent/reasoning.js` | LLM provider abstraction: OpenAI, Groq, Ollama |
| `src/agent/planner.js` | Hypothesis generation, system/user prompt builders |
| `src/agent/investigator.js` | Full 6-step investigation pipeline, LLM + deterministic fallback |

**No breaking changes.** `investigate(incidentId, config)` is a new async export.
When `config.ai` is absent or provider is unconfigured, it falls back to the
existing `RootCauseEngine.analyzeRootCause()`.

**New config shape (optional):**
```js
logpilot.init({
  app,
  ai: {
    provider: 'openai',        // 'openai' | 'groq' | 'ollama'
    model: 'gpt-4o-mini',      // optional, sensible defaults per provider
    apiKey: process.env.OPENAI_API_KEY,
    temperature: 0.2,
    maxTokens: 1024,
  },
});
```

**Environment variable fallbacks:**
- `LOGPILOT_AI_PROVIDER` — provider name
- `OPENAI_API_KEY` — OpenAI key
- `GROQ_API_KEY` — Groq key

---

### Phase 6 — Splunk MCP Support

| File | Purpose |
|------|---------|
| `src/mcp/tools.js` | 6 Splunk tool handlers: `search_logs`, `find_deployments`, `find_related_incidents`, `get_trace`, `get_metric_history`, `get_heal_history` |
| `src/mcp/mcp-client.js` | Agentic tool-use loop (up to N rounds), calls LLM to decide which tools to invoke |

**No breaking changes.** MCP is opt-in:
```js
logpilot.init({
  app,
  mcp: {
    enabled: true,
    maxToolRounds: 3,   // optional, default 3
  },
});
```

When `mcp.enabled` is not `true`, the module is never loaded and the platform
operates identically to before.

---

### Phase 7 — Recovery Recommendations

| File | Purpose |
|------|---------|
| `src/recovery/recommendations.js` | Generates ranked remediation actions based on metrics, git correlation, and similar incident history |

**No breaking changes.** New module, no changes to existing `RecoveryVerifier`.

**Supported actions:**
- `restart-service`
- `rollback-deployment`
- `scale-replicas`
- `circuit-break`
- `rate-limit`
- `gc` (force garbage collection)
- `heap-snapshot`
- `notify-only`

---

### Phase 10 — Dashboard

| File | Purpose |
|------|---------|
| `src/dashboard/dashboard-ext.js` | New render functions served as static JS (avoids template literal conflicts) |

**New route:** `GET /dashboard-ext.js` — served automatically by the dashboard server.

**New REST endpoints:**

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/incidents/:id/correlation` | GET | Correlation graph for an incident |
| `/api/incidents/:id/similar` | GET | Similar historical incidents |
| `/api/incidents/:id/investigate` | POST | Run full AI investigation pipeline |
| `/api/incidents/:id/recommendations` | GET | Ranked recovery recommendations |
| `/api/incidents/:id/evidence` | GET | Evidence snapshot (Splunk or local) |
| `/api/incidents/:id/recovery` | GET | Recovery verification status |
| `/api/analytics/advanced` | GET | Advanced analytics (MTTR, RCA distribution, categories) |

**New dashboard tabs (incident modal):**

| Tab | Content |
|-----|---------|
| Evidence | Log count, dominant errors, metric peaks, recent heals |
| Correlation | Typed node graph with weighted edge relationships |
| Similar | Historical incidents ranked by similarity score |
| AI RCA | LLM or deterministic root cause + reasoning |
| Actions | Ranked recovery recommendations with confidence |
| Recovery | Resolution status, confidence, error rate |
| Postmortem | Structured report with download |

**New analytics section** (Analysis page):
- Root cause distribution bar chart
- Recovery success rate
- Mean Time To Recovery (MTTR)
- Incident category breakdown

---

## Database schema

**No schema migrations required.** All new data is stored in existing tables:
- `incident_analysis.context_json` — now includes `correlationGraph` and `similar` arrays
- `incident_analysis.rca_json` — now includes `hypotheses`, `source` (`llm` | `deterministic`), `provider`
- `evidence_snapshots` — unchanged

---

## Backward compatibility checklist

- [x] `logpilot.init({ app })` — works identically with no new config
- [x] Splunk remains optional — `config.splunk.enabled` defaults to false
- [x] AI investigation remains optional — falls back to deterministic RCA
- [x] MCP remains optional — `config.mcp.enabled` must be explicitly `true`
- [x] SQLite schema unchanged — no migrations needed
- [x] All existing dashboard tabs preserved
- [x] CommonJS architecture maintained throughout
- [x] No new required npm dependencies (all new code uses Node.js built-ins or already-required packages)
- [x] `node --check` passes on all 15 modified/new files

---

## Running smoke tests

```bash
node src/tests/smoke.js
```

Expected: **37 tests, 0 failures** across Phases 3–7.
