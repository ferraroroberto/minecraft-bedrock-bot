// Reconnect backoff ladders.
//
// The load-bearing number here is measured, not chosen: after the bot process
// dies the server holds the old Xbox session for a while — a reconnect **8s
// later was still kicked with `server_id_conflict`; 30s reconnected cleanly**
// (issue #1). So `server_id_conflict` is its own condition with its own,
// longer ladder, not a generic failure.

/** Delay ladders in ms, indexed by condition. Attempts past the end reuse the last rung. */
export const LADDERS = {
  // Starts at the measured session-release window and escalates from there.
  server_id_conflict: [30_000, 60_000, 120_000, 240_000, 300_000],
  // A network drop or a plain close — no server-side session to wait out.
  disconnect: [5_000, 15_000, 30_000, 60_000, 120_000],
  // Realms API failures. Note each attempt may itself already cost ~15s inside
  // prismarine-realms' own 5xx retry, so this ladder stays deliberately coarse.
  api: [5_000, 15_000, 45_000, 120_000],
}

const DEFAULT_LADDER = LADDERS.disconnect

/** Jitter is added UPWARD only — see `delayFor`. */
export const JITTER_RATIO = 0.2

/**
 * The delay before attempt number `attempt` (1-based) for a given condition.
 *
 * Jitter is applied **upward only** (`+0…20%`), never symmetrically. That is
 * deliberate: 30s is an empirical *lower bound* on the session-release window,
 * so jittering below a rung would reintroduce the exact `server_id_conflict`
 * the ladder exists to avoid. Spreading later rather than earlier is always safe.
 *
 * @param {string} kind        a key of LADDERS; anything unknown uses the disconnect ladder
 * @param {number} attempt     1-based attempt number
 * @param {() => number} [random] injectable for deterministic tests
 * @returns {number} milliseconds
 */
export function delayFor(kind, attempt, random = Math.random) {
  const ladder = LADDERS[kind] ?? DEFAULT_LADDER
  const index = Math.min(Math.max(attempt, 1), ladder.length) - 1
  const base = ladder[index]
  return Math.round(base * (1 + random() * JITTER_RATIO))
}

/**
 * Failure-streak tracker for the supervisor loop.
 *
 * The streak resets only after a connection has *stayed up* for
 * `stabilityWindowMs` — not merely on connect. Without that, a connection that
 * establishes and immediately drops would reset the ladder every time and turn
 * the supervisor into a tight loop, which is the failure this whole module
 * exists to prevent.
 *
 * @param {object} [options]
 * @param {number} [options.stabilityWindowMs] uptime that counts as "stable"
 * @param {number} [options.maxConsecutiveFailures] give up after this many in a row
 * @param {() => number} [options.random]
 */
export function createBackoff({
  stabilityWindowMs = 60_000,
  maxConsecutiveFailures = 10,
  random = Math.random,
} = {}) {
  let consecutive = 0

  return {
    /** Delay for the next attempt after a failure of `kind`. Advances the streak. */
    nextDelay(kind) {
      consecutive += 1
      return delayFor(kind, consecutive, random)
    },

    /**
     * Report how long the connection that just ended stayed up. Resets the
     * streak only if that clears the stability window.
     * @param {number} uptimeMs
     * @returns {boolean} whether the streak was reset
     */
    recordUptime(uptimeMs) {
      if (uptimeMs >= stabilityWindowMs) {
        consecutive = 0
        return true
      }
      return false
    },

    /** True once the streak has hit the cap — surface the failure instead of looping silently. */
    exhausted() {
      return consecutive >= maxConsecutiveFailures
    },

    get consecutiveFailures() {
      return consecutive
    },

    get maxConsecutiveFailures() {
      return maxConsecutiveFailures
    },
  }
}
