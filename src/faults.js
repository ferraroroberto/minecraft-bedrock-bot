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
// So the supervisor cannot rely on `close`/`kick`/`error` alone: without this
// net, a signalling failure is a silent process death mid-session — exactly the
// unattended failure mode #7 exists to eliminate.
//
// This deliberately does NOT swallow faults globally. It only converts a fault
// into a session-ended result while a session is actually in flight; outside
// that window the fault is re-thrown so a genuine bug still crashes loudly.

/**
 * @param {object} deps
 * @param {object} deps.log
 * @param {NodeJS.EventEmitter} [deps.proc] injectable for tests
 * @returns {{ guard: <T>(promise: Promise<T>) => Promise<T|object>, dispose: () => void }}
 */
export function createFaultGuard({ log, proc = process }) {
  /** Set while a session is in flight; null otherwise. */
  let active = null

  const onFault = (label) => (err) => {
    const detail = String(err?.stack ?? err?.message ?? err)
    if (!active) {
      // Nothing in flight — this is not a connection fault we can absorb.
      // Re-throwing preserves normal crash behaviour for real bugs.
      log.error(`${label}.unhandled`, detail)
      throw err
    }
    log.error(
      `${label}.absorbed`,
      `${detail} — treating as a connection failure (known BedrockX signalling defect, see src/faults.js)`
    )
    const settle = active
    active = null
    settle({ endedBy: label, reason: 'signalling_fault', connected: false, uptimeMs: 0 })
  }

  const uncaught = onFault('uncaughtException')
  const unhandled = onFault('unhandledRejection')
  proc.on('uncaughtException', uncaught)
  proc.on('unhandledRejection', unhandled)

  return {
    /** Race a session against a process-level fault. */
    async guard(promise) {
      const faulted = new Promise((resolve) => {
        active = resolve
      })
      try {
        return await Promise.race([promise, faulted])
      } finally {
        active = null
      }
    },
    dispose() {
      proc.off('uncaughtException', uncaught)
      proc.off('unhandledRejection', unhandled)
    },
  }
}
