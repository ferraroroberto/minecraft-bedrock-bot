// Naming the reason a session was kicked.
//
// #42: a stable 3m10s session ended with `kicked — 140` and nothing else in the
// log. A bare integer is not diagnosable after the fact, and a kick is exactly
// the class of failure that only ever happens live.
//
// The pinned BedrockX protocol.json already carries the `DisconnectFailReason`
// id→name enum the client compiles against, so the names are read off that
// rather than hardcoded — a re-pin (README → "Why BedrockX") then moves the
// table with the protocol instead of silently invalidating a copy of it. Same
// approach, and the same rationale, as src/protocol-packets.js.
//
// Unlike allPacketNames(), nothing here ever throws: this runs inside the kick
// handler, where a throw would cost the very session we are trying to explain.
// A protocol shape change degrades to logging the bare code — which is exactly
// the pre-#42 behaviour — and test/disconnect-reasons.test.js fails the gate so
// the degradation is never discovered live.
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

let cached = null

/**
 * The pinned protocol's DisconnectFailReason table.
 * @returns {Record<string, string>} code → name; empty if the shape ever changes.
 */
export function disconnectReasons() {
  if (cached) return cached
  let mappings = null
  try {
    mappings = require('bedrockx/src/protocol/protocol.json')?.types?.DisconnectFailReason?.[1]?.mappings
  } catch {
    mappings = null
  }
  cached = mappings && typeof mappings === 'object' ? mappings : {}
  return cached
}

/**
 * Render a kick reason as `name (code)` for a log line.
 *
 * BedrockX hands us whichever of the two the protodef mapper produced: the name
 * for a code it knows, the raw number for one it does not. Both directions are
 * resolved so the line always carries as much as is knowable, and falls back to
 * the bare value when the enum has no entry for it.
 *
 * @param {number|string|null|undefined} reason
 * @returns {string} e.g. "host_disconnected (140)", "9999", "unknown"
 */
export function describeDisconnectReason(reason) {
  if (reason === null || reason === undefined || reason === '') return 'unknown'
  const table = disconnectReasons()

  if (typeof reason === 'number' || /^-?\d+$/.test(String(reason))) {
    const code = String(Number(reason))
    const name = table[code]
    return name ? `${name} (${code})` : code
  }

  const name = String(reason)
  const code = Object.keys(table).find((key) => table[key] === name)
  return code === undefined ? name : `${name} (${code})`
}
