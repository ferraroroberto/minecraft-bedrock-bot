// The hub adapter (#15, Layer 3) — the ONLY module in this repo that knows a
// model is reached over HTTP.
//
// Routed through the fleet's local LLM hub with the standard Anthropic SDK, per
// standing fleet policy: the hub owns subprocess management, prompt assembly,
// host routing and observability, and re-implementing a `claude -p` subprocess
// wrapper downstream is explicitly rejected. Nothing here re-derives that
// plumbing; it points the SDK at the hub's base URL and gets out of the way.
//
// TWO DELIBERATE OMISSIONS, both measured (#12's probe, restated in #15):
//
//   - NO `tools` ARRAY. Native tool-calling does not work for `claude-*`
//     through the hub: the array is accepted, silently ignored, and the reply
//     comes back with `stop_reason: "end_turn"` and no `tool_use` block. The
//     contract is strict JSON-in-text instead (src/model-reply.js).
//   - NO DEFAULT-SYSTEM FALLBACK. An explicit `system` is always passed by the
//     caller (src/prompt.js). Without one, a `claude-*` request through the hub
//     answers in Claude Code's own persona.
//
// src/decision-loop.js never imports this file — it takes an injected client
// with a `complete()` method. That is what keeps `npm run verify` offline and
// hermetic: no test in this repo can reach the hub even by accident.
import Anthropic from '@anthropic-ai/sdk'

export const DEFAULT_HUB_BASE_URL = 'http://127.0.0.1:8000'
/**
 * Cheap tier by default — routine decision steps do not need a frontier model.
 * The hub has a LATEST-ONLY policy and rotates ids; re-read its README before
 * pinning a different one rather than trusting this constant to have aged well.
 */
export const DEFAULT_MODEL = 'claude-haiku-4-5'
export const DEFAULT_MAX_TOKENS = 1024

/** The hub authenticates by being on loopback; the SDK just requires the field to be present. */
export const LOCAL_DUMMY_API_KEY = 'local-dummy'

function textFrom(response) {
  const text = (response?.content ?? [])
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
  if (!text) {
    throw new Error(
      `hub returned no text content (stop_reason=${response?.stop_reason ?? 'unknown'}) — ` +
        'if this reply carried a tool_use block instead, the no-tools contract above has changed and needs re-measuring'
    )
  }
  return text
}

/**
 * @param {object} [options]
 * @param {string} [options.model]     hub model id; see DEFAULT_MODEL's note about the latest-only policy
 * @param {object} [options.client]    a pre-built Anthropic-shaped client, for wiring tests that must not construct a real one
 * @returns {{model: string, baseURL: string, complete: (req: {system: string, messages: object[]}) => Promise<string>}}
 */
export function createHubModelClient({
  baseURL = process.env.LLM_BASE_URL || DEFAULT_HUB_BASE_URL,
  model = process.env.LLM_MODEL || DEFAULT_MODEL,
  apiKey = LOCAL_DUMMY_API_KEY,
  maxTokens = DEFAULT_MAX_TOKENS,
  client = null,
} = {}) {
  const anthropic = client ?? new Anthropic({ apiKey, baseURL })
  return {
    model,
    baseURL,
    async complete({ system, messages }) {
      const response = await anthropic.messages.create({ model, max_tokens: maxTokens, system, messages })
      return textFrom(response)
    },
  }
}
