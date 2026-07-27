import test from 'node:test'
import assert from 'node:assert/strict'
import { allPacketNames } from '../src/protocol-packets.js'

test('reads every packet name off the pinned protocol.json, deduplicated', () => {
  const names = allPacketNames()
  assert.equal(new Set(names).size, names.length, 'must already be deduplicated')
  // A handful of names #13's world model depends on, so a re-pin that renames
  // one of these fails this test rather than silently narrowing the recorder.
  for (const expected of ['start_game', 'move_player', 'update_block', 'add_entity', 'text']) {
    assert.ok(names.includes(expected), `expected "${expected}" among the packet names`)
  }
  // 244 as of the pin recorded in package.json; not pinned exactly here since
  // a legitimate re-pin should not have to touch this test, only grow past a
  // sane floor.
  assert.ok(names.length > 100)
})
