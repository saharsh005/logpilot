'use strict';

/**
 * LLM provider abstraction.
 *
 * Supported providers:
 *   - openai   (api.openai.com)
 *   - groq     (api.groq.com/openai/v1)
 *   - ollama   (http://localhost:11434)
 *
 * Config shape (from logpilot config or env):
 *   ai: {
 *     provider: 'openai' | 'groq' | 'ollama',
 *     model: 'gpt-4o-mini' | 'llama3-8b-8192' | 'llama3',
 *     apiKey: process.env.OPENAI_API_KEY,
 *     baseUrl: 'http://localhost:11434',  // ollama only
 *     temperature: 0.2,
 *     maxTokens: 1024,
 *   }
 */

const fetch = (() => {
  try { return require('node-fetch'); }
  catch (_) { return globalThis.fetch; }
})();

// ── Provider configs ────────────────────────────────────────────────────────

const PROVIDERS = {
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    authHeader: apiKey => `Bearer ${apiKey}`,
    endpoint: '/chat/completions',
    buildBody: (model, messages, temp, maxTokens) => ({
      model, messages, temperature: temp, max_tokens: maxTokens,
    }),
    extractContent: data => data.choices?.[0]?.message?.content || '',
  },
  groq: {
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama3-8b-8192',
    authHeader: apiKey => `Bearer ${apiKey}`,
    endpoint: '/chat/completions',
    buildBody: (model, messages, temp, maxTokens) => ({
      model, messages, temperature: temp, max_tokens: maxTokens,
    }),
    extractContent: data => data.choices?.[0]?.message?.content || '',
  },
  ollama: {
    baseUrl: 'http://localhost:11434',
    defaultModel: 'llama3',
    authHeader: () => null,
    endpoint: '/api/chat',
    buildBody: (model, messages, temp) => ({
      model, messages, stream: false,
      options: { temperature: temp },
    }),
    extractContent: data => data.message?.content || '',
  },
};

/**
 * Send a chat completion request.
 *
 * @param {string[]} messages  - array of { role, content }
 * @param {object}   aiConfig  - from logpilot config.ai
 * @returns {Promise<string>}  - assistant message text
 */
async function chat(messages, aiConfig = {}) {
  const providerName = (aiConfig.provider || process.env.LOGPILOT_AI_PROVIDER || 'openai').toLowerCase();
  const provider = PROVIDERS[providerName];
  if (!provider) throw new Error(`Unknown AI provider: ${providerName}`);

  const apiKey = aiConfig.apiKey ||
    process.env.OPENAI_API_KEY ||
    process.env.GROQ_API_KEY ||
    process.env.OLLAMA_API_KEY || '';

  const model = aiConfig.model || provider.defaultModel;
  const temp  = aiConfig.temperature ?? 0.2;
  const maxTokens = aiConfig.maxTokens ?? 1024;
  const baseUrl = aiConfig.baseUrl || provider.baseUrl;

  const headers = { 'Content-Type': 'application/json' };
  const auth = provider.authHeader(apiKey);
  if (auth) headers['Authorization'] = auth;

  const body = provider.buildBody(model, messages, temp, maxTokens);
  const url  = `${baseUrl}${provider.endpoint}`;

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    timeout: 30000,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`LLM error ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  return provider.extractContent(data);
}

/**
 * Check whether an AI config is usable (has a provider + credentials).
 */
function isAIConfigured(aiConfig = {}) {
  const providerName = (aiConfig.provider || process.env.LOGPILOT_AI_PROVIDER || '').toLowerCase();
  if (!providerName) return false;
  if (providerName === 'ollama') return true;  // no key needed
  const key = aiConfig.apiKey || process.env.OPENAI_API_KEY || process.env.GROQ_API_KEY;
  return !!key;
}

module.exports = { chat, isAIConfigured, PROVIDERS };
