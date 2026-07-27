// Opt-in JSONL packet trace.
//
// Default off (see .env.example RECORD_PACKETS). When enabled, appends one
// line per packet — inbound and outbound — so the next time Roberto plays
// live, that run produces a real fixture corpus for #13 and every layer above
// it, at no extra cost and with no extra live run requested.
//
// Redaction is pattern-based, not a closed list of exact field names — a
// closed deny-list (token/xuid/networkId) would write a field nobody thought
// of to disk in the clear. `SENSITIVE_KEY_PATTERN` matches on SHAPE (does the
// key name look auth-shaped?) so a field the pinned protocol adds later still
// gets caught. Since any captured trace is meant to become a COMMITTED FIXTURE
// in a PUBLIC repo, treat under-redaction as a real risk, not a theoretical
// one — see test/recorder.test.js, which asserts on raw file bytes for a
// broader set of secret-shaped keys than this pattern is built from.
import fs from 'node:fs'
import path from 'node:path'

const SENSITIVE_KEY_PATTERN = /token|xuid|xbox|network[_-]?id|session[_-]?id|invite|secret|credential|authoriz/i
const REDACTED = '[REDACTED]'

function redact(value) {
  if (Array.isArray(value)) return value.map(redact)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, v] of Object.entries(value)) {
      out[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : redact(v)
    }
    return out
  }
  return value
}

/**
 * @param {object} deps
 * @param {string} deps.filePath   appended to, created (with parent dirs) if missing
 * @param {() => number} [deps.now]
 * @param {typeof fs} [deps.fsImpl] injectable for tests
 */
export function createRecorder({ filePath, now = () => Date.now(), fsImpl = fs }) {
  fsImpl.mkdirSync(path.dirname(filePath), { recursive: true })
  const stream = fsImpl.createWriteStream(filePath, { flags: 'a' })

  function append(direction, name, packet) {
    stream.write(JSON.stringify({ ts: now(), direction, name, packet: redact(packet) }) + '\n')
  }

  return {
    recordInbound: (name, packet) => append('inbound', name, packet),
    recordOutbound: (name, packet) => append('outbound', name, packet),
    /** @returns {Promise<void>} resolves once the stream has flushed and closed. */
    close: () => new Promise((resolve) => stream.end(resolve)),
  }
}
