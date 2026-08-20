import test from 'node:test'
import assert from 'node:assert/strict'
import { describeDisconnectReason, disconnectReasons } from '../src/disconnect-reasons.js'

test('the DisconnectFailReason table is readable off the pinned protocol.json', () => {
  // describeDisconnectReason() degrades to the bare code rather than throwing
  // inside the kick handler, so THIS is the test that has to fail loudly if a
  // re-pin ever changes the shape it reads.
  const table = disconnectReasons()
  assert.ok(Object.keys(table).length > 100, 'expected the full enum, not a stub')
  assert.equal(table['44'], 'server_id_conflict')
})

test('a known kick code logs the name alongside the code (#42)', () => {
  // The live incident: a stable 3m10s session ended with a bare `140`.
  assert.equal(describeDisconnectReason(140), 'host_disconnected (140)')
  assert.equal(describeDisconnectReason('140'), 'host_disconnected (140)')
})

test('an unknown kick code falls back to the bare code', () => {
  // A protocol Mojang has moved on from must still produce a usable line.
  assert.equal(describeDisconnectReason(99999), '99999')
})

test('a reason the mapper already named carries its code too', () => {
  assert.equal(describeDisconnectReason('server_id_conflict'), 'server_id_conflict (44)')
  assert.equal(describeDisconnectReason('something_new_from_mojang'), 'something_new_from_mojang')
})

test('a missing reason says so instead of printing undefined', () => {
  assert.equal(describeDisconnectReason(null), 'unknown')
  assert.equal(describeDisconnectReason(undefined), 'unknown')
})
