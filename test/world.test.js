import test from 'node:test'
import assert from 'node:assert/strict'
import { createWorldState, reduce, getBlockAt, WORLD_PACKET_NAMES } from '../src/world.js'

test('join, move, and pick up an item updates position, rotation, and inventory', () => {
  let state = createWorldState()
  state = reduce(state, 'start_game', {
    runtime_entity_id: 7,
    player_position: { x: 1, y: 64, z: 2 },
    rotation: { x: 10, z: 90 }, // vec2f: x=pitch, z=yaw
    player_gamemode: 'survival',
    dimension: 'overworld',
  })
  state = reduce(state, 'move_player', { runtime_id: 7, position: { x: 5, y: 64, z: 2 }, pitch: 15, yaw: 95 })
  state = reduce(state, 'inventory_slot', {
    window_id: 'inventory',
    slot: 0,
    item: { network_id: 5, count: 1 },
  })

  assert.deepEqual(state.self.position, { x: 5, y: 64, z: 2 })
  assert.deepEqual(state.self.rotation, { pitch: 15, yaw: 95 })
  assert.equal(state.self.gamemode, 'survival')
  assert.equal(state.self.dimension, 'overworld')
  assert.deepEqual(state.inventory.windows.inventory[0], { network_id: 5, count: 1 })
})

test('start_game seeds rotation as x=pitch, z=yaw per the vec2f convention', () => {
  // Confirmed against pmmp's StartGamePacket, which reads pitch then yaw as
  // two sequential floats — the same wire order vec2f's {x, z} decodes to.
  let state = createWorldState()
  state = reduce(state, 'start_game', {
    runtime_entity_id: 1,
    player_position: { x: 0, y: 0, z: 0 },
    rotation: { x: 12.5, z: 200 },
  })
  assert.deepEqual(state.self.rotation, { pitch: 12.5, yaw: 200 })
})

test('health and hunger come from update_attributes, matched by attribute name', () => {
  let state = createWorldState()
  state = reduce(state, 'update_attributes', {
    attributes: [
      { name: 'minecraft:health', current: 18 },
      { name: 'minecraft:player.hunger', current: 15 },
      { name: 'minecraft:movement', current: 0.1 }, // an attribute we do not track — must not throw or leak in
    ],
  })
  assert.equal(state.self.health, 18)
  assert.equal(state.self.hunger, 15)
})

test('set_health is not handled — deprecated, unused by the vanilla server', () => {
  const state = createWorldState()
  const next = reduce(state, 'set_health', { health: 20 })
  assert.equal(next, state, 'an unhandled packet name must be a pure no-op, same reference back')
})

test('an entity appears, moves, and is removed', () => {
  let state = createWorldState()
  state = reduce(state, 'add_entity', {
    runtime_id: 42,
    unique_id: 1042,
    entity_type: 'minecraft:cow',
    position: { x: 10, y: 64, z: 10 },
  })
  assert.deepEqual(state.entities.get(42), {
    uniqueId: 1042,
    type: 'minecraft:cow',
    username: null,
    position: { x: 10, y: 64, z: 10 },
  })

  state = reduce(state, 'move_entity', { runtime_entity_id: 42, position: { x: 11, y: 64, z: 10 } })
  assert.deepEqual(state.entities.get(42).position, { x: 11, y: 64, z: 10 })

  // remove_entity's field is entity_id_self, and it is the UNIQUE id (1042),
  // NOT the runtime id (42) every other packet in this test uses. Using the
  // unique id here is the point of the test — matching on 42 would be wrong.
  state = reduce(state, 'remove_entity', { entity_id_self: 1042 })
  assert.equal(state.entities.has(42), false)
})

test('move_entity_delta applies only the flagged axes, leaving the rest untouched', () => {
  let state = createWorldState()
  state = reduce(state, 'add_player', {
    runtime_id: 5,
    unique_id: 500,
    username: 'Roberto39764',
    position: { x: 0, y: 70, z: 0 },
  })
  state = reduce(state, 'move_entity_delta', {
    runtime_entity_id: 5,
    flags: { has_x: true, has_y: false, has_z: true },
    x: 3,
    z: 4,
  })
  assert.deepEqual(state.entities.get(5).position, { x: 3, y: 70, z: 4 })
})

test('an out-of-order move (before the matching add) is ignored, not fabricated', () => {
  let state = createWorldState()
  // Bedrock re-sends and reorders more than one would like (#13's own
  // warning) — a move for an entity we have never seen add_entity/add_player
  // for must not create a placeholder entity of unknown type.
  state = reduce(state, 'move_entity', { runtime_entity_id: 99, position: { x: 1, y: 1, z: 1 } })
  assert.equal(state.entities.has(99), false)

  state = reduce(state, 'add_entity', { runtime_id: 99, unique_id: 999, entity_type: 'minecraft:villager' })
  // A duplicate add for the same entity must not throw or corrupt state.
  state = reduce(state, 'add_entity', { runtime_id: 99, unique_id: 999, entity_type: 'minecraft:villager' })
  state = reduce(state, 'move_entity', { runtime_entity_id: 99, position: { x: 1, y: 1, z: 1 } })
  assert.deepEqual(state.entities.get(99).position, { x: 1, y: 1, z: 1 })
})

test('update_block is queryable via getBlockAt, and a later update overwrites it', () => {
  let state = createWorldState()
  assert.equal(getBlockAt(state, 0, 63, 0), null)

  state = reduce(state, 'update_block', { position: { x: 0, y: 63, z: 0 }, block_runtime_id: 7 })
  assert.equal(getBlockAt(state, 0, 63, 0), 7)

  state = reduce(state, 'update_block', { position: { x: 0, y: 63, z: 0 }, block_runtime_id: 9 })
  assert.equal(getBlockAt(state, 0, 63, 0), 9)
})

test('mob_equipment only applies to self — another entity\'s equipment is ignored', () => {
  let state = createWorldState()
  state = reduce(state, 'start_game', { runtime_entity_id: 7, player_position: { x: 0, y: 0, z: 0 } })

  state = reduce(state, 'mob_equipment', {
    runtime_entity_id: 999, // not us
    window_id: 'hotbar',
    slot: 0,
    item: { network_id: 1 },
  })
  assert.equal(state.inventory.windows.hotbar, undefined)

  state = reduce(state, 'mob_equipment', {
    runtime_entity_id: 7, // us
    window_id: 'hotbar',
    slot: 0,
    item: { network_id: 1 },
  })
  assert.deepEqual(state.inventory.windows.hotbar[0], { network_id: 1 })
})

test('player_hotbar tracks the selected slot', () => {
  const state = reduce(createWorldState(), 'player_hotbar', { selected_slot: 3, window_id: 'hotbar' })
  assert.equal(state.inventory.selectedHotbarSlot, 3)
})

test('an unknown packet name is a no-op that returns the same state reference', () => {
  const state = createWorldState()
  const next = reduce(state, 'some_future_packet_nobody_has_written_a_reducer_for', { anything: 1 })
  assert.equal(next, state)
})

test('malformed packets — missing or wrong-typed fields — leave state unchanged and never throw', () => {
  const state = createWorldState()
  const attempts = [
    () => reduce(state, 'start_game', {}),
    () => reduce(state, 'start_game', null),
    () => reduce(state, 'start_game', 'not an object'),
    () => reduce(state, 'move_player', { position: 'not a vec3' }),
    () => reduce(state, 'update_block', { position: { x: 0 } }), // missing y, z
    () => reduce(state, 'update_attributes', { attributes: 'not an array' }),
    () => reduce(state, 'add_entity', { runtime_id: 'not a number' }),
    () => reduce(state, 'remove_entity', {}),
    () => reduce(state, WORLD_PACKET_NAMES[0], undefined),
  ]
  for (const attempt of attempts) {
    assert.doesNotThrow(attempt)
    assert.equal(attempt(), state, 'a malformed packet must return the same state reference, not a mutated copy')
  }
})
