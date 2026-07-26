// Classification of Realms API failures.
//
// `prismarine-realms` throws a plain `Error` whose message is
// `"<status> <statusText> <body>"` and which carries **no `.status` property**
// (measured, issue #7). So classification means parsing that string at one
// chokepoint rather than sprinkling try/catch around call sites.
//
// It also already owns a retry layer, but a narrow one: `execRequest` retries
// **only** `status >= 500 && < 600`, up to `maxRetries` (default 4) with
// 1/2/4/8s backoff ≈ 15s across 5 attempts (rest.js:74-91). Two consequences
// this module exists to encode:
//   - A 5xx that reaches us has ALREADY exhausted ~15s of retrying. It is still
//     retryable, but the outer ladder must be spaced accordingly — not stacked
//     naively, or a "30 second" wait silently becomes minutes.
//   - A `fetch` network error throws *before* the status check, so it is NOT
//     retried internally at all. The outer layer is the only thing handling it.

/** Node/undici error codes that mean "the network moved under us", not "the request was bad". */
const NETWORK_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN',
  'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET',
])

/**
 * @typedef {object} Classification
 * @property {string}  kind      stable identifier for the condition
 * @property {boolean} retryable whether a retry could plausibly succeed
 * @property {string}  message   an actionable, human-readable line for the log
 * @property {number}  [status]  HTTP status, when one was parsed
 */

/**
 * Classify a thrown Realms API error into exactly one condition.
 *
 * Distinct conditions get distinct messages on purpose — a supervisor that logs
 * the same line for a transient 503 and a permanently expired token is useless
 * at 3am.
 *
 * Anything unrecognised is deliberately classified **non-retryable**: failing
 * loud on an unknown condition is safer than looping forever on one we do not
 * understand.
 *
 * @param {unknown} err
 * @param {object} [context]
 * @param {string} [context.tokenCachePath] local token cache, named in the auth message
 * @param {string} [context.clientVersion]   client version we announced
 * @param {number} [context.protocolVersion] protocol number we announced
 * @returns {Classification}
 */
export function classifyRealmsError(err, context = {}) {
  const code = err?.code
  const name = err?.name
  const rawMessage = typeof err?.message === 'string' ? err.message : String(err)

  // Network-level failure: prismarine-realms does NOT retry these, because
  // fetch throws before its status check ever runs.
  if (NETWORK_CODES.has(code) || name === 'FetchError' || name === 'AbortError') {
    return {
      kind: 'network',
      retryable: true,
      message: `network failure reaching the Realms API (${code ?? name}) — will retry`,
    }
  }

  const statusMatch = /^(\d{3})\s/.exec(rawMessage)
  if (!statusMatch) {
    return {
      kind: 'unknown',
      retryable: false,
      message: `unrecognised failure, not retrying: ${rawMessage}`,
    }
  }

  const status = Number(statusMatch[1])
  const body = parseJsonBody(rawMessage)

  if (status === 401 || status === 403) {
    const cache = context.tokenCachePath ?? '.secrets/xbox-auth/'
    return {
      kind: 'auth',
      retryable: false,
      status,
      message:
        `Xbox authentication rejected (HTTP ${status}) — the cached token is expired or revoked. ` +
        `Retrying cannot fix this. Delete ${cache} on THIS machine and re-run to complete a fresh ` +
        `device-code sign-in. (Token caches are per-host and never synced.)`,
    }
  }

  // The version gate. Measured: this is a 400, so it is thrown immediately and
  // burns no retry budget.
  if (body?.errorCode === 6020 || body?.reason === 'unknown_client_version') {
    const version = context.clientVersion ?? 'unknown'
    const protocol = context.protocolVersion ?? 'unknown'
    return {
      kind: 'client_version',
      retryable: false,
      status,
      message:
        `the Realms API rejected client version ${version} (protocol ${protocol}). ` +
        `Minecraft has updated ahead of our minecraft-data/BedrockX pin. ` +
        `Update minecraft-data, and re-pin BedrockX if needed (README → "Why BedrockX"). ` +
        `Retrying will not help until the pin moves.`,
    }
  }

  if (status === 429) {
    return {
      kind: 'rate_limited',
      retryable: true,
      status,
      message: 'the Realms API is rate-limiting us (HTTP 429) — backing off',
    }
  }

  if (status >= 500 && status < 600) {
    return {
      kind: 'realms_5xx',
      retryable: true,
      status,
      message:
        `the Realms API returned HTTP ${status} — transient. Note prismarine-realms has already ` +
        `retried this ~4 times over ~15s, so the service has been failing for a while.`,
    }
  }

  return {
    kind: 'client_error',
    retryable: false,
    status,
    message: `the Realms API rejected the request (HTTP ${status}), not retrying: ${rawMessage}`,
  }
}

/** Pull the JSON object out of a `"<status> <statusText> <body>"` message, if there is one. */
function parseJsonBody(message) {
  const start = message.indexOf('{')
  if (start === -1) return null
  try {
    return JSON.parse(message.slice(start))
  } catch {
    return null
  }
}
