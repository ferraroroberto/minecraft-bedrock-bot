import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildChatPacket,
  buildSelectSlotPacket,
  buildBreakBlockPackets,
  buildPlaceBlockPacket,
  buildUseItemPacket,
  InvalidActionArgsError,
} from '../src/actions.js'

test('buildChatPacket carries category:authored — message_only gets the connection dropped', () => {
  const { name, params } = buildChatPacket({ message: 'hello', username: 'Gizmo6082', xuid: '123' })
  assert.equal(name, 'text')
  assert.equal(params.category, 'authored')
  assert.equal(params.message, 'hello')
  assert.equal(params.source_name, 'Gizmo6082')
  assert.equal(params.xuid, '123')
})

test('buildChatPacket refuses an empty message', () => {
  assert.throws(() => buildChatPacket({ message: '', username: 'u' }), InvalidActionArgsError)
})

test('buildSelectSlotPacket targets the inventory window and asks the server to select', () => {
  const { name, params } = buildSelectSlotPacket({ slot: 3 })
  assert.equal(name, 'player_hotbar')
  assert.deepEqual(params, { selected_slot: 3, window_id: 'inventory', select_slot: true })
})

test('buildSelectSlotPacket refuses a slot outside the hotbar range', () => {
  assert.throws(() => buildSelectSlotPacket({ slot: 9 }), InvalidActionArgsError)
  assert.throws(() => buildSelectSlotPacket({ slot: -1 }), InvalidActionArgsError)
  assert.throws(() => buildSelectSlotPacket({ slot: 1.5 }), InvalidActionArgsError)
})

test('buildBreakBlockPackets emits start_break then stop_break at the same position/face', () => {
  const packets = buildBreakBlockPackets({ runtimeEntityId: 7, x: 1, y: 64, z: 2, face: 1 })
  assert.equal(packets.length, 2)
  assert.equal(packets[0].params.action, 'start_break')
  assert.equal(packets[1].params.action, 'stop_break')
  for (const p of packets) {
    assert.equal(p.name, 'player_action')
    assert.equal(p.params.runtime_entity_id, 7)
    assert.deepEqual(p.params.position, { x: 1, y: 64, z: 2 })
    assert.equal(p.params.face, 1)
  }
})

test('buildBreakBlockPackets refuses non-integer coordinates and an out-of-range face', () => {
  assert.throws(() => buildBreakBlockPackets({ runtimeEntityId: 7, x: 1.5, y: 64, z: 2, face: 1 }), InvalidActionArgsError)
  assert.throws(() => buildBreakBlockPackets({ runtimeEntityId: 7, x: 1, y: 64, z: 2, face: 6 }), InvalidActionArgsError)
  assert.throws(() => buildBreakBlockPackets({ x: 1, y: 64, z: 2, face: 1 }), InvalidActionArgsError, 'runtimeEntityId is required')
})

test('buildPlaceBlockPacket wraps an inventory_transaction item_use/click_block with the held item echoed back', () => {
  const heldItem = { network_id: 5, count: 1, metadata: 0, has_stack_id: 0, block_runtime_id: 0 }
  const { name, params } = buildPlaceBlockPacket({
    x: 1, y: 64, z: 2, face: 1, hotbarSlot: 0, heldItem, playerPosition: { x: 1.5, y: 64, z: 2.5 }, targetBlockRuntimeId: 9,
  })
  assert.equal(name, 'inventory_transaction')
  assert.equal(params.transaction.transaction_type, 'item_use')
  assert.equal(params.transaction.transaction_data.action_type, 'click_block')
  assert.deepEqual(params.transaction.transaction_data.block_position, { x: 1, y: 64, z: 2 })
  assert.equal(params.transaction.transaction_data.face, 1)
  assert.equal(params.transaction.transaction_data.hotbar_slot, 0)
  assert.deepEqual(params.transaction.transaction_data.held_item, heldItem)
  assert.equal(params.transaction.transaction_data.block_runtime_id, 9)
  assert.equal(params.transaction.legacy.legacy_request_id, 0)
  assert.equal(params.transaction.actions, null)
})

test('buildPlaceBlockPacket defaults held_item to the air item and refuses missing player position', () => {
  const withoutHeldItem = buildPlaceBlockPacket({ x: 0, y: 0, z: 0, face: 0, hotbarSlot: 0, playerPosition: { x: 0, y: 0, z: 0 } })
  assert.deepEqual(withoutHeldItem.params.transaction.transaction_data.held_item, { network_id: 0 })

  assert.throws(() => buildPlaceBlockPacket({ x: 0, y: 0, z: 0, face: 0, hotbarSlot: 0, playerPosition: null }), InvalidActionArgsError)
  assert.throws(() => buildPlaceBlockPacket({ x: 0, y: 0, z: 0, face: 6, hotbarSlot: 0, playerPosition: { x: 0, y: 0, z: 0 } }), InvalidActionArgsError)
  assert.throws(() => buildPlaceBlockPacket({ x: 0, y: 0, z: 0, face: 0, hotbarSlot: 9, playerPosition: { x: 0, y: 0, z: 0 } }), InvalidActionArgsError)
})

test('buildUseItemPacket wraps an inventory_transaction item_use/click_air with no block target', () => {
  const heldItem = { network_id: 12, count: 3, metadata: 0, has_stack_id: 0, block_runtime_id: 0 }
  const { name, params } = buildUseItemPacket({ hotbarSlot: 2, heldItem, playerPosition: { x: 1, y: 64, z: 2 } })
  assert.equal(name, 'inventory_transaction')
  assert.equal(params.transaction.transaction_data.action_type, 'click_air')
  assert.equal(params.transaction.transaction_data.hotbar_slot, 2)
  assert.deepEqual(params.transaction.transaction_data.held_item, heldItem)
  assert.deepEqual(params.transaction.transaction_data.player_pos, { x: 1, y: 64, z: 2 })
})

test('buildUseItemPacket refuses an out-of-range hotbar slot and a non-finite player position', () => {
  assert.throws(() => buildUseItemPacket({ hotbarSlot: 9, playerPosition: { x: 0, y: 0, z: 0 } }), InvalidActionArgsError)
  assert.throws(() => buildUseItemPacket({ hotbarSlot: 0, playerPosition: { x: NaN, y: 0, z: 0 } }), InvalidActionArgsError)
})
