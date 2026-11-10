// What a finished Realm session means, declared once.
//
// `runSession` resolves `{endedBy, reason, connected, uptimeMs}`, where `reason`
// is free text whose meaning depends on `endedBy`. The supervisor needs three
// decisions out of that: stop or retry, which backoff ladder, and whether the
// failure streak may reset. `classifySessionEnd` is the only place those are
// derived, so a new reader of a session result calls it instead of comparing
// `endedBy` or `reason` itself (docs/session-end-state.md).
//
// This is one half of the end-state vocabulary. The other half is a failure
// before any client exists (the Realms API, auth, a rejected client version):
// there is no session result, and `classifyRealmsError` in src/errors.js
// already classifies it into a `ClassifiedError.kind`.
import { disconnectReasons } from './disconnect-reasons.js'

/** The closed set of ways a session can have ended. */
export const SESSION_END = Object.freeze({
  /** We were told to stop (signal or chat command): exit, do not reconnect. */
  STOP_REQUESTED: 'stop_requested',
  /** The server still holds our previous session; only a long wait clears it. */
  CONFLICT: 'conflict',
  /** The session had connected, then ended for any other reason. */
  DROPPED: 'dropped',
  /** The session never spawned. */
  CONNECT_FAILED: 'connect_failed',
  /** The facts cannot tell a conflict from an ordinary drop. */
  UNKNOWN: 'unknown',
})

/** The backoff ladders a retry can use (keys of LADDERS in src/backoff.js). */
const KIND = Object.freeze({ CONFLICT: 'server_id_conflict', DISCONNECT: 'disconnect' })

/** The enum name the server sends for a held previous session. */
const CONFLICT_NAME = 'server_id_conflict'

/** What src/connect.js stores for a kick packet that carried no reason, also an enum entry. */
const NO_REASON = 'unknown'

/** Session ends whose `reason` is a server disconnect reason (a name or a code). */
const SERVER_REASON_ENDS = new Set(['kick', 'close'])

/** Session ends whose `reason` is free text: not a server reason, never a conflict. */
const FREE_TEXT_ENDS = new Set(['error', 'connect_timeout', 'signalling_fault'])

/**
 * The enum name for a server disconnect reason given as a name, a number or a
 * numeric string, or null when the reason is missing or not in the pinned enum.
 * @param {number|string|null|undefined} reason
 * @returns {string|null}
 */
function reasonName(reason) {
  if (reason === null || reason === undefined || reason === '' || reason === NO_REASON) return null
  const table = disconnectReasons()
  if (typeof reason === 'number' || /^-?\d+$/.test(String(reason))) {
    return table[String(Number(reason))] ?? null
  }
  const name = String(reason)
  // The name alone is enough, so a protocol re-pin that empties the table
  // cannot turn the one reason the bot already handles into an unknown.
  return name === CONFLICT_NAME || Object.values(table).includes(name) ? name : null
}

/**
 * Derive the end state of a session and what the supervisor does about it.
 *
 * @param {{endedBy: string, reason: number|string|null, connected: boolean}} result what runSession resolved
 * @param {{stopRequested?: boolean}} [signals] the process-level stop signal
 * @returns {{state: string, kind: string|null, mayResetStreak: boolean, why: string|null}}
 *   `kind` is the backoff ladder (null when stopping); `mayResetStreak` is true
 *   when the session connected, so the uptime may count as stable; `why` says
 *   what could not be told apart, for the `unknown` state only.
 */
export function classifySessionEnd(result, { stopRequested = false } = {}) {
  // A chat stop command ends the session with `shutdown` but never flips the
  // process signal, so the session's own end counts as a stop request too.
  if (stopRequested || result.endedBy === 'shutdown') {
    return { state: SESSION_END.STOP_REQUESTED, kind: null, mayResetStreak: false, why: null }
  }

  const connected = result.connected === true
  const ended = (state, kind, why = null) => ({ state, kind, mayResetStreak: connected, why })

  if (SERVER_REASON_ENDS.has(result.endedBy)) {
    const name = reasonName(result.reason)
    if (name === CONFLICT_NAME) return ended(SESSION_END.CONFLICT, KIND.CONFLICT)
    // A kick that names no reason, or one the pinned enum does not know, may
    // still be the held-session conflict; a plain close with no reason is just
    // the connection ending.
    if (result.endedBy === 'kick' && name === null) {
      return ended(SESSION_END.UNKNOWN, KIND.DISCONNECT, 'kick reason missing or not in the pinned enum')
    }
  } else if (!FREE_TEXT_ENDS.has(result.endedBy)) {
    return ended(SESSION_END.UNKNOWN, KIND.DISCONNECT, `unrecognised endedBy ${JSON.stringify(result.endedBy)}`)
  }

  return connected ? ended(SESSION_END.DROPPED, KIND.DISCONNECT) : ended(SESSION_END.CONNECT_FAILED, KIND.DISCONNECT)
}
