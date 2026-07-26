import test from 'node:test'
import assert from 'node:assert/strict'
import { supervise, EXIT } from '../src/supervise.js'
import { createBackoff } from '../src/backoff.js'
import { ClassifiedError } from '../src/connect.js'

// A harness with no timers and no network: `sleep` records the delay instead of
// waiting, so the whole backoff schedule is asserted in microseconds.
function harness({ sessions, backoffOptions, stopWhenDrained = false } = {}) {
  const slept = []
  const lines = []
  const log = {
    info: (e, d) => lines.push(`INFO ${e} ${d ?? ''}`.trim()),
    warn: (e, d) => lines.push(`WARN ${e} ${d ?? ''}`.trim()),
    error: (e, d) => lines.push(`ERROR ${e} ${d ?? ''}`.trim()),
  }
  const queue = [...sessions]
  // Opt-in: stop once the scripted sessions are drained, so a test that ends in
  // a *successful* session terminates naturally. Off by default, because the
  // give-up tests need the loop to reach the failure cap on its own.
  const ownStop = { stopped: false }
  return {
    slept,
    lines,
    log,
    attempts: () => sessions.length - queue.length,
    run: (stopSignal = ownStop) =>
      supervise({
        log,
        stopSignal,
        sleep: async (ms) => { slept.push(ms) },
        backoff: createBackoff({ random: () => 0, ...backoffOptions }),
        runSession: async () => {
          const next = queue.shift()
          if (!next) throw new Error('supervisor asked for more sessions than the test provided')
          if (stopWhenDrained && queue.length === 0) ownStop.stopped = true
          if (next instanceof Error) throw next
          return next
        },
      }),
  }
}

const ended = (over) => ({ endedBy: 'close', reason: null, connected: true, uptimeMs: 0, ...over })

test('a server_id_conflict kick waits at least the measured 30s before retrying', async () => {
  // The load-bearing behaviour of the whole issue: an 8s retry is guaranteed to
  // be kicked again, so a tight loop here would spin forever and look abusive.
  const h = harness({
    sessions: [
      ended({ endedBy: 'kick', reason: 'server_id_conflict', connected: false }),
      ended({ endedBy: 'kick', reason: 'server_id_conflict', connected: false }),
    ],
    backoffOptions: { maxConsecutiveFailures: 2 },
  })
  await h.run()
  assert.ok(h.slept[0] >= 30_000, `first retry was ${h.slept[0]}ms, must be >= 30000`)
  assert.ok(h.lines.some((l) => l.includes('session.conflict')))
})

test('a conflict escalates rather than repeating the same delay', async () => {
  const h = harness({
    sessions: Array.from({ length: 3 }, () =>
      ended({ endedBy: 'kick', reason: 'server_id_conflict', connected: false })
    ),
    backoffOptions: { maxConsecutiveFailures: 3 },
  })
  await h.run()
  assert.deepEqual(h.slept, [30_000, 60_000])
})

test('a generic disconnect uses the shorter ladder, not the conflict one', async () => {
  const h = harness({
    sessions: [ended({ uptimeMs: 1_000 }), ended({ uptimeMs: 1_000 })],
    backoffOptions: { maxConsecutiveFailures: 2 },
  })
  await h.run()
  assert.ok(h.slept[0] < 30_000)
})

test('a non-retryable error exits TERMINAL_FAILURE with zero retries', async () => {
  const authError = new ClassifiedError({
    kind: 'auth', retryable: false, message: 'token expired, delete the cache',
  })
  const h = harness({ sessions: [authError] })
  const code = await h.run()
  assert.equal(code, EXIT.TERMINAL_FAILURE)
  assert.deepEqual(h.slept, [], 'must not retry a condition retrying cannot fix')
  assert.ok(h.lines.some((l) => l.startsWith('ERROR fatal.auth')))
})

test('a rejected client version exits terminally, not in a retry loop', async () => {
  const err = new ClassifiedError({
    kind: 'client_version', retryable: false, message: 'the Realms API rejected client version 1.26.30',
  })
  const code = await harness({ sessions: [err] }).run()
  assert.equal(code, EXIT.TERMINAL_FAILURE)
})

test('a retryable API error backs off and retries', async () => {
  const err = new ClassifiedError({ kind: 'realms_5xx', retryable: true, message: '503' })
  const h = harness({
    sessions: [err, ended({ uptimeMs: 999_999 })],
    backoffOptions: { maxConsecutiveFailures: 5 },
    stopWhenDrained: true,
  })
  assert.equal(await h.run(), EXIT.OK)
  assert.equal(h.attempts(), 2, 'must retry after a retryable failure')
  assert.equal(h.slept.length, 1, 'exactly one backoff between the two attempts')
})

test('an unclassified throw is treated as non-retryable and exits', async () => {
  // Safety property: never loop on a condition we do not understand.
  const h = harness({ sessions: [new Error('something nobody anticipated')] })
  assert.equal(await h.run(), EXIT.TERMINAL_FAILURE)
  assert.deepEqual(h.slept, [])
})

test('gives up after the failure cap instead of looping silently forever', async () => {
  const h = harness({
    sessions: Array.from({ length: 3 }, () => ended({ connected: false })),
    backoffOptions: { maxConsecutiveFailures: 3 },
  })
  assert.equal(await h.run(), EXIT.GAVE_UP)
  assert.ok(h.lines.some((l) => l.startsWith('ERROR giving_up')))
})

test('a flapping connection does NOT reset the streak — the tight-loop guard', async () => {
  // Connects then immediately drops, repeatedly. If short uptime reset the
  // ladder, this would retry every 5s forever.
  const h = harness({
    sessions: Array.from({ length: 4 }, () => ended({ uptimeMs: 500 })),
    backoffOptions: { maxConsecutiveFailures: 4, stabilityWindowMs: 60_000 },
  })
  assert.equal(await h.run(), EXIT.GAVE_UP)
  assert.ok(h.slept[1] > h.slept[0], 'delays must escalate while flapping')
})

test('a connection that stayed up resets the streak', async () => {
  const h = harness({
    sessions: [ended({ uptimeMs: 500 }), ended({ uptimeMs: 3_600_000 }), ended({ uptimeMs: 500 })],
    backoffOptions: { maxConsecutiveFailures: 5, stabilityWindowMs: 60_000 },
  })
  await h.run()
  // The second delay drops back to the FIRST rung because the hour-long session
  // reset the ladder — without the reset it would have escalated to 15s. The
  // third then escalates again, since the streak resumed from the reset.
  assert.deepEqual(h.slept, [5_000, 5_000, 15_000])
  assert.ok(h.lines.some((l) => l.includes('streak reset')))
})

test('a stop signal exits cleanly without another attempt', async () => {
  const h = harness({ sessions: [] })
  assert.equal(await h.run({ stopped: true }), EXIT.OK)
  assert.equal(h.attempts(), 0)
})

test('logs distinct events for a conflict versus a plain disconnect', async () => {
  const conflict = harness({
    sessions: [ended({ endedBy: 'kick', reason: 'server_id_conflict', connected: false })],
    backoffOptions: { maxConsecutiveFailures: 1 },
  })
  await conflict.run()
  const plain = harness({
    sessions: [ended({ endedBy: 'close', connected: false })],
    backoffOptions: { maxConsecutiveFailures: 1 },
  })
  await plain.run()
  assert.ok(conflict.lines.some((l) => l.includes('session.conflict')))
  assert.ok(!plain.lines.some((l) => l.includes('session.conflict')))
})
