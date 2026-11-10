import test from 'node:test'
import assert from 'node:assert/strict'
import { classifySessionEnd, SESSION_END } from '../src/session-end.js'

const S = SESSION_END
const session = (endedBy, reason, connected) => ({ endedBy, reason, connected, uptimeMs: connected ? 5_000 : 0 })

// One row per reachable result. `kind` is the backoff ladder, `reset` whether
// the uptime may count toward the stability streak.
const ROWS = [
  // Stop requests, by either route.
  ['chat stop command', session('shutdown', 'stop command received via chat', true), {}, S.STOP_REQUESTED, null, false],
  ['signal stop through finish()', session('shutdown', 'stop requested', true), {}, S.STOP_REQUESTED, null, false],
  ['signal stop before connecting', session('shutdown', 'stop requested', false), {}, S.STOP_REQUESTED, null, false],
  ['process signal while a kick was in flight', session('kick', 'server_id_conflict', false), { stopRequested: true }, S.STOP_REQUESTED, null, false],
  ['process signal on a plain close', session('close', null, true), { stopRequested: true }, S.STOP_REQUESTED, null, false],

  // The held previous session, whichever way the reason is spelled.
  ['kick by name', session('kick', 'server_id_conflict', false), {}, S.CONFLICT, 'server_id_conflict', false],
  ['kick by numeric code', session('kick', 44, false), {}, S.CONFLICT, 'server_id_conflict', false],
  ['kick by numeric string', session('kick', '44', false), {}, S.CONFLICT, 'server_id_conflict', false],
  ['conflict after a connected stretch still resets the streak', session('kick', 'server_id_conflict', true), {}, S.CONFLICT, 'server_id_conflict', true],
  ['close carrying the conflict name', session('close', 'server_id_conflict', false), {}, S.CONFLICT, 'server_id_conflict', false],

  // A known kick that is not the conflict is an ordinary drop or failed connect.
  ['known kick, connected', session('kick', 140, true), {}, S.DROPPED, 'disconnect', true],
  ['known kick by name, never connected', session('kick', 'host_disconnected', false), {}, S.CONNECT_FAILED, 'disconnect', false],

  // The facts cannot tell a conflict from a drop.
  ['kick with a code the enum does not know', session('kick', 99999, true), {}, S.UNKNOWN, 'disconnect', true],
  ['kick with an unknown numeric string', session('kick', '99999', false), {}, S.UNKNOWN, 'disconnect', false],
  ['kick with an unknown name', session('kick', 'something_new_from_mojang', true), {}, S.UNKNOWN, 'disconnect', true],
  ['kick with a null reason', session('kick', null, true), {}, S.UNKNOWN, 'disconnect', true],
  ['kick with an empty reason', session('kick', '', false), {}, S.UNKNOWN, 'disconnect', false],
  ['kick with the literal unknown reason', session('kick', 'unknown', false), {}, S.UNKNOWN, 'disconnect', false],
  ['an endedBy this module does not know', session('teleported', null, true), {}, S.UNKNOWN, 'disconnect', true],
  ['an endedBy that is missing', session(undefined, null, false), {}, S.UNKNOWN, 'disconnect', false],

  // Ordinary ends.
  ['close after connecting', session('close', null, true), {}, S.DROPPED, 'disconnect', true],
  ['close with a library reason after connecting', session('close', 'socket closed', true), {}, S.DROPPED, 'disconnect', true],
  ['close before connecting', session('close', null, false), {}, S.CONNECT_FAILED, 'disconnect', false],
  ['client error after connecting', session('error', 'read ECONNRESET', true), {}, S.DROPPED, 'disconnect', true],
  ['client error before connecting', session('error', 'read ECONNRESET', false), {}, S.CONNECT_FAILED, 'disconnect', false],
  ['connect timeout (never spawned)', session('connect_timeout', 'no spawn within 60000ms', false), {}, S.CONNECT_FAILED, 'disconnect', false],
  ['signalling fault before connecting', session('signalling_fault', 'signalling_fault', false), {}, S.CONNECT_FAILED, 'disconnect', false],
  ['signalling fault after connecting', session('signalling_fault', 'signalling_fault', true), {}, S.DROPPED, 'disconnect', true],

  // Impossible combinations: free text is never read as a server reason, and
  // the connected flag alone decides dropped versus connect_failed.
  ['an error whose text is the conflict name', session('error', 'server_id_conflict', false), {}, S.CONNECT_FAILED, 'disconnect', false],
  ['a timeout whose text is the conflict code', session('connect_timeout', '44', false), {}, S.CONNECT_FAILED, 'disconnect', false],
  ['connected flag missing on a close', { endedBy: 'close', reason: null }, {}, S.CONNECT_FAILED, 'disconnect', false],
]

for (const [name, result, signals, state, kind, mayResetStreak] of ROWS) {
  test(`session end: ${name}`, () => {
    const end = classifySessionEnd(result, signals)
    assert.equal(end.state, state)
    assert.equal(end.kind, kind)
    assert.equal(end.mayResetStreak, mayResetStreak)
    assert.equal(typeof end.why === 'string', state === S.UNKNOWN, 'only unknown carries a why')
  })
}

test('every state in the declared set is produced by at least one row', () => {
  const seen = new Set(ROWS.map((row) => row[3]))
  assert.deepEqual([...seen].sort(), Object.values(S).sort())
})

// state-machine-proof: session-end
test('a result is never classified outside the declared set, even from garbage', () => {
  // The declared set is closed: whatever the session result looks like, the
  // supervisor gets one of five states and never has to handle a sixth.
  const garbage = [{}, { endedBy: 5 }, { endedBy: 'kick', reason: {} }, { endedBy: 'close', reason: [44] }]
  for (const result of garbage) {
    assert.ok(Object.values(S).includes(classifySessionEnd(result).state), JSON.stringify(result))
  }
})
