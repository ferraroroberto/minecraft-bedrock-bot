// Process-level safety net for BedrockX's signalling defects.
//
// This exists because of two verified defects in the pinned BedrockX commit,
// both of which kill the process WITHOUT emitting anything a client listener
// could catch:
//
//   1. `websocket/signal-jsonrpc.js:134` does `this.client.emit("error", …)`,
//      but `this.client` is never assigned anywhere in that class. Any
//      websocket-level error on the NETHERNET_JSONRPC transport — the transport
//      this Realm uses — throws `TypeError: Cannot read properties of undefined`
//      inside a callback. Uncatchable from the client object.
//   2. `createClient.js:7` calls `client.init()` without awaiting or catching
//      it, so a rejection from the signalling connect (15s credentials
//      timeout, or 5 exhausted reconnects) becomes an unhandled rejection.
//
// Design notes, both learned from review:
//
//   - A fault does NOT abandon the in-flight session promise. It calls the
//     session's own finisher, so `runSession` closes its client and settles
//     normally. Racing-and-abandoning would leave the client's listeners and
//     signalling timers alive, and those leaked timers are themselves a source
//     of later faults attributed to the *next* session.
//   - While the supervisor is running, a fault arriving with NO session in
//     flight (i.e. during a backoff sleep) is logged and swallowed, NOT
//     re-thrown. Re-throwing from inside a `process.on('uncaughtException')`
//     handler kills the process — which is exactly the unattended death this
//     module exists to prevent. The stray fault necessarily comes from an
//     already-torn-down client, since the bot is the only async work running.
//   - Outside the supervisor's lifetime there is nothing to protect, so a fault
//     is re-thrown and crashes loudly as it normally would.

/**
 * @param {object} deps
 * @param {object} deps.log
 * @param {NodeJS.EventEmitter} [deps.proc] injectable for tests
 */
export function createFaultGuard({ log, proc = process }) {
  /** Finishers for sessions currently in flight. Normally 0 or 1. */
  const sessionHandlers = new Set()
  let supervising = false

  const onFault = (label) => (err) => {
    const detail = String(err?.stack ?? err?.message ?? err)

    if (sessionHandlers.size > 0) {
      log.error(
        `${label}.absorbed`,
        `${detail} — ending the session (known BedrockX signalling defect, see src/faults.js)`
      )
      // Copy first: each handler removes itself from the set as it settles.
      for (const handler of [...sessionHandlers]) handler(detail)
      return
    }

    if (supervising) {
      // Between attempts. A leaked timer from a torn-down client, not a live
      // session — never let it kill an unattended bot mid-backoff.
      log.error(`${label}.stray`, `${detail} — no session in flight, ignoring (leaked from a closed client)`)
      return
    }

    log.error(`${label}.unhandled`, detail)
    throw err
  }

  const uncaught = onFault('uncaughtException')
  const unhandled = onFault('unhandledRejection')
  proc.on('uncaughtException', uncaught)
  proc.on('unhandledRejection', unhandled)

  return {
    /** Signal shape consumed by runSession — mirrors stopSignal's onStop. */
    faultSignal: {
      onFault(cb) {
        sessionHandlers.add(cb)
        return () => sessionHandlers.delete(cb)
      },
    },
    /** Mark the supervised window, within which stray faults are swallowed. */
    setSupervising(value) {
      supervising = value
    },
    dispose() {
      sessionHandlers.clear()
      supervising = false
      proc.off('uncaughtException', uncaught)
      proc.off('unhandledRejection', unhandled)
    },
  }
}
