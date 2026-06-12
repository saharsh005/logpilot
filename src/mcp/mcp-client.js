'use strict';

/**
 * MCP Client (Phase 6)
 *
 * Implements a lightweight Model-Context-Protocol client that wraps
 * the Splunk tool set so the AI Investigator can decide which tools
 * to call as part of its investigation loop.
 *
 * This is fully optional — the platform works without MCP.
 * Enable via config:
 *
 *   logpilot.init({
 *     app,
 *     mcp: { enabled: true, maxToolRounds: 3 },
 *   });
 */

const { chat, isAIConfigured } = require('../agent/reasoning');
const { getToolDefinitions, executeTool } = require('./tools');

const DEFAULT_MAX_ROUNDS = 3;

/**
 * Run a tool-augmented investigation using the LLM + MCP tools.
 *
 * The LLM is given the tool list and decides which tools to call.
 * We run up to maxToolRounds agentic loops, then ask for final output.
 *
 * @param {object} initialContext  - base incident context string for the LLM
 * @param {object} aiConfig        - config.ai
 * @param {object} mcpConfig       - config.mcp
 * @param {object} logpilotConfig  - full config (forwarded to tool handlers)
 * @returns {Promise<{ toolCalls, evidence, finalPrompt }>}
 */
async function runMCPInvestigation(initialContext, aiConfig, mcpConfig = {}, logpilotConfig = {}) {
  if (!isAIConfigured(aiConfig)) {
    return { toolCalls: [], evidence: {}, finalPrompt: initialContext };
  }

  const maxRounds = mcpConfig.maxToolRounds || DEFAULT_MAX_ROUNDS;
  const tools = getToolDefinitions();
  const toolListText = tools
    .map(t => `- ${t.name}(${Object.keys(t.params).join(', ')}): ${t.description}`)
    .join('\n');

  const systemPrompt = `You are an SRE agent investigating an incident.
You have access to these Splunk tools (respond with JSON to call them):
${toolListText}

To call a tool, respond ONLY with JSON:
{"tool": "<name>", "params": {<key>: <value>}}

When you have enough evidence, respond with:
{"done": true, "summary": "<summary of findings>"}

Do not add any text outside the JSON object.`;

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `Investigate this incident:\n\n${initialContext}` },
  ];

  const toolCalls = [];
  const evidence = {};

  for (let round = 0; round < maxRounds; round++) {
    let raw;
    try {
      raw = await chat(messages, { ...aiConfig, maxTokens: 512 });
    } catch (err) {
      break;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw.replace(/```(?:json)?/g, '').trim());
    } catch (_) {
      break;  // non-JSON → LLM is done
    }

    // LLM signals done
    if (parsed.done) {
      evidence.summary = parsed.summary;
      break;
    }

    // LLM wants to call a tool
    if (parsed.tool) {
      let result;
      try {
        result = await executeTool(parsed.tool, parsed.params || {}, logpilotConfig);
      } catch (err) {
        result = { error: err.message };
      }

      toolCalls.push({ tool: parsed.tool, params: parsed.params, result });
      evidence[parsed.tool] = result;

      // Append tool result to conversation
      messages.push({ role: 'assistant', content: raw });
      messages.push({
        role: 'user',
        content: `Tool result for ${parsed.tool}:\n${JSON.stringify(result, null, 2)}\n\nContinue investigation or call another tool.`,
      });
    } else {
      break;
    }
  }

  return {
    toolCalls,
    evidence,
    finalPrompt: messages[messages.length - 1].content,
  };
}

/**
 * Check whether MCP is enabled in the config.
 */
function isMCPEnabled(config = {}) {
  return config.mcp?.enabled === true;
}

module.exports = { runMCPInvestigation, isMCPEnabled };
