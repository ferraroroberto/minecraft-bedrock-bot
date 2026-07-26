import test from 'node:test'
import assert from 'node:assert/strict'
import { delayFor, createBackoff, LADDERS, JITTER_RATIO } from '../src/backoff.js'

const noJitter = () => 0
const maxJitter = () => 1

test('the first server_id_conflict delay is never below the measured 30s window', () => {
  // THE load-bearing assertion of this module. Measured in issue #1: a
  // reconnect at 8s was still kicked; 30s reconnected cleanly.
  for (const random of [noJitter, maxJitter, () => 0.5, Math.random]) {
    assert.ok(delayFor('server_id_conflict', 1, random) >= 30_000)
  }
})

test('jitter is upward only, never downward', () => {
  // Downward jitter on a measured LOWER bound would reintroduce the very
  // server_id_conflict the ladder exists to avoid.
  for (const kind of Object.keys(LADDERS)) {
    for (let attempt = 1; attempt <= LADDERS[kind].length; attempt += 1) {
      const base = LADDERS[kind][attempt - 1]
      assert.ok(delayFor(kind, attempt, noJitter) === base)
      assert.ok(delayFor(kind, attempt, maxJitter) <= base * (1 + JITTER_RATIO))
      assert.ok(delayFor(kind, attempt, Math.random) >= base)
    }
  }
})

test('delays escalate monotonically', () => {
  const delays = [1, 2, 3, 4, 5].map((n) => delayFor('server_id_conflict', n, noJitter))
  assert.deepEqual(delays, [30_000, 60_000, 120_000, 240_000, 300_000])
})

test('attempts past the ladder clamp to the last rung, they do not grow forever', () => {
  const last = LADDERS.server_id_conflict.at(-1)
  assert.equal(delayFor('server_id_conflict', 99, noJitter), last)
  assert.equal(delayFor('server_id_conflict', 1000, noJitter), last)
})

test('attempt 0 or negative is treated as the first attempt, not an array underflow', () => {
  assert.equal(delayFor('disconnect', 0, noJitter), LADDERS.disconnect[0])
  assert.equal(delayFor('disconnect', -5, noJitter), LADDERS.disconnect[0])
})

test('a generic disconnect uses a shorter ladder than a session conflict', () => {
  // They are genuinely different conditions: one waits out a server-side
  // session, the other does not.
  assert.ok(delayFor('disconnect', 1, noJitter) < delayFor('server_id_conflict', 1, noJitter))
})

test('an unknown kind falls back to the disconnect ladder instead of throwing', () => {
  assert.equal(delayFor('something-new', 1, noJitter), LADDERS.disconnect[0])
})

test('the failure streak advances across attempts', () => {
  const b = createBackoff({ random: noJitter })
  assert.equal(b.nextDelay('server_id_conflict'), 30_000)
  assert.equal(b.nextDelay('server_id_conflict'), 60_000)
  assert.equal(b.nextDelay('server_id_conflict'), 120_000)
  assert.equal(b.consecutiveFailures, 3)
})

test('a SHORT-lived connection does not reset the streak', () => {
  // The tight-loop guard: a connect that immediately drops must not hand the
  // supervisor a fresh 5s ladder every time.
  const b = createBackoff({ stabilityWindowMs: 60_000, random: noJitter })
  b.nextDelay('disconnect')
  b.nextDelay('disconnect')
  assert.equal(b.recordUptime(3_000), false)
  assert.equal(b.consecutiveFailures, 2)
  assert.equal(b.nextDelay('disconnect'), LADDERS.disconnect[2])
})

test('a connection that clears the stability window resets the streak', () => {
  const b = createBackoff({ stabilityWindowMs: 60_000, random: noJitter })
  b.nextDelay('disconnect')
  b.nextDelay('disconnect')
  assert.equal(b.recordUptime(60_000), true)
  assert.equal(b.consecutiveFailures, 0)
  assert.equal(b.nextDelay('disconnect'), LADDERS.disconnect[0])
})

test('the streak exhausts so a permanently broken condition surfaces', () => {
  const b = createBackoff({ maxConsecutiveFailures: 3, random: noJitter })
  assert.equal(b.exhausted(), false)
  b.nextDelay('disconnect')
  b.nextDelay('disconnect')
  assert.equal(b.exhausted(), false)
  b.nextDelay('disconnect')
  assert.equal(b.exhausted(), true)
})

test('a stable reconnect clears an almost-exhausted streak', () => {
  const b = createBackoff({ maxConsecutiveFailures: 3, stabilityWindowMs: 10_000, random: noJitter })
  b.nextDelay('disconnect')
  b.nextDelay('disconnect')
  b.recordUptime(20_000)
  assert.equal(b.exhausted(), false)
  assert.equal(b.consecutiveFailures, 0)
})
