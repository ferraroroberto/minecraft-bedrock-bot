// The supervisor loop.
//
// Everything it needs is injected, so the whole control flow — including the
// backoff schedule and the give-up path — is unit-testable with fakes and
// without a live Realm (which is unavailable by construction: one connection
// per Xbox account, and connecting from a test would kick the real bot).
import { classifyRealmsError } from './errors.js'
import { formatDuration } from './log.js'

/** Exit codes, so a later `launchd` KeepAlive wrapper can behave sensibly with no further changes. */
export const EXIT = {
  /** Clean shutdown on SIGINT/SIGTERM. */
  OK: 0,
  /** A non-retryable condition: expired auth, rejected client version, no Realm. */
  TERMINAL_FAILURE: 1,
  /** Another instance holds the single-instance lock. */
  LOCK_HELD: 2,
  /** Retried until the streak cap and never got stable. */
  GAVE_UP: 3,
}

/**
 * Loop connect-attempts until told to stop or a terminal condition is hit.
 *
 * @param {object} deps
 * @param {() => Promise<{endedBy: string, reason: string|null, connected: boolean, uptimeMs: number}>} deps.runSession
 * @param {object} deps.backoff        from createBackoff()
 * @param {object} deps.log            from createLogger()
 * @param {(ms: number) => Promise<void>} deps.sleep
 * @param {{ stopped: boolean }} [deps.stopSignal] flipped by SIGINT/SIGTERM
 * @returns {Promise<number>} process exit code
 */
export async function supervise({ runSession, backoff, log, sleep, stopSignal = { stopped: false } }) {
  for (;;) {
    if (stopSignal.stopped) {
      log.info('shutdown', 'stop requested — exiting cleanly')
      return EXIT.OK
    }

    let session
    try {
      log.info('connecting', `attempt ${backoff.consecutiveFailures + 1}`)
      session = await runSession()
    } catch (err) {
      // Failed before a client existed — an API, auth, or version problem.
      const classification = err?.classification ?? classifyRealmsError(err)
      if (!classification.retryable) {
        log.error(`fatal.${classification.kind}`, classification.message)
        return EXIT.TERMINAL_FAILURE
      }
      log.warn(`retryable.${classification.kind}`, classification.message)
      const gaveUp = await backOffOrGiveUp({ kind: 'api', backoff, log, sleep, stopSignal })
      if (gaveUp !== null) return gaveUp
      continue
    }

    if (stopSignal.stopped) {
      log.info('shutdown', 'stop requested — exiting cleanly')
      return EXIT.OK
    }

    // A session that ended. `server_id_conflict` is its own condition: the
    // server is still holding our previous session and a short retry is
    // guaranteed to be kicked again (measured: 8s kicked, 30s clean).
    const conflict = session.reason === 'server_id_conflict'
    const kind = conflict ? 'server_id_conflict' : 'disconnect'

    if (session.connected) {
      const stable = backoff.recordUptime(session.uptimeMs)
      log.warn(
        'disconnected',
        `after ${formatDuration(session.uptimeMs)} via ${session.endedBy}` +
        `${session.reason ? ` (${session.reason})` : ''}${stable ? ' — streak reset, connection had been stable' : ''}`
      )
    } else {
      log.warn('connect.failed', `${session.endedBy}${session.reason ? ` (${session.reason})` : ''}`)
    }

    if (conflict) {
      log.warn(
        'session.conflict',
        'another session holds this Xbox account — the Minecraft client signed in as the bot, ' +
        'or a bot on the other machine. Waiting out the server-side session release.'
      )
    }

    const gaveUp = await backOffOrGiveUp({ kind, backoff, log, sleep, stopSignal })
    if (gaveUp !== null) return gaveUp
  }
}

/**
 * Advance the backoff, log it, and sleep — or return an exit code if we are done.
 * @returns {Promise<number|null>} an exit code to return, or null to keep looping
 */
async function backOffOrGiveUp({ kind, backoff, log, sleep, stopSignal }) {
  const delay = backoff.nextDelay(kind)

  if (backoff.exhausted()) {
    log.error(
      'giving_up',
      `${backoff.consecutiveFailures} consecutive failures without a stable connection ` +
      `(cap ${backoff.maxConsecutiveFailures}) — surfacing the failure instead of looping silently`
    )
    return EXIT.GAVE_UP
  }

  log.info('backoff', `waiting ${formatDuration(delay)} before retry (${kind})`)
  await sleep(delay)
  return stopSignal.stopped ? EXIT.OK : null
}
