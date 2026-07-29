import test from 'node:test'
import assert from 'node:assert/strict'
import { createFakeWorld, DEFAULT_PLACED_RUNTIME_ID } from '../src/fake-world.js'
import { getBlockAt } from '../src/world.js'
import { buildBreakBlockPackets, buildPlaceBlockPacket, buildSelectSlotPacket, buildUseItemPacket } from '../src/actions.js'

function write(sim, packet) {
  sim.client.write(packet.name, packet.params)
}

test('the starting state is seeded THROUGH the real reducer, not hand-written', () => {
  const sim = createFakeWorld({
    position: { x: 3, y: 64, z: -7 },
    inventory: [{ network_id: 5, count: 2 }],
    blocks: { '1,64,2': 7 },
    entities: [{ runtimeId: 9, type: 'player', username: 'Roberto39764', position: { x: 4, y: 64, z: -7 } }],
  })
  const world = sim.getWorld()

  assert.deepEqual(world.self.position, { x: 3, y: 64, z: -7 })
  assert.equal(world.self.health, 20)
  assert.equal(getBlockAt(world, 1, 64, 2), 7)
  assert.deepEqual(world.inventory.windows.inventory, [{ network_id: 5, count: 2 }])
  assert.equal(world.entities.get(9).username, 'Roberto39764')
  // Every one of those arrived as an inbound packet, exactly as a live join would.
  assert.ok(sim.inbound.some((entry) => entry.name === 'start_game'))
  assert.ok(sim.inbound.some((entry) => entry.name === 'update_block'))
})

test('breaking a block emits update_block, and only on stop_break', () => {
  const sim = createFakeWorld({ blocks: { '1,64,2': 7 } })
  const [start, stop] = buildBreakBlockPackets({ runtimeEntityId: 1, x: 1, y: 64, z: 2, face: 1 })

  write(sim, start)
  assert.equal(getBlockAt(sim.getWorld(), 1, 64, 2), 7, 'start_break alone changes nothing')

  write(sim, stop)
  assert.equal(getBlockAt(sim.getWorld(), 1, 64, 2), 0)
})

test('breaking a block that was never observed does not conjure one into existence', () => {
  const sim = createFakeWorld()
  const [, stop] = buildBreakBlockPackets({ runtimeEntityId: 1, x: 9, y: 9, z: 9, face: 1 })
  write(sim, stop)
  assert.equal(getBlockAt(sim.getWorld(), 9, 9, 9), null)
})

test('placing a block sets the target coordinate and consumes one item', () => {
  const sim = createFakeWorld({ inventory: [{ network_id: 5, count: 2 }] })
  write(
    sim,
    buildPlaceBlockPacket({ x: 1, y: 64, z: 2, face: 1, hotbarSlot: 0, heldItem: { network_id: 5, count: 2 }, playerPosition: { x: 1, y: 65, z: 2 } })
  )

  assert.equal(getBlockAt(sim.getWorld(), 1, 64, 2), DEFAULT_PLACED_RUNTIME_ID)
  assert.deepEqual(sim.getWorld().inventory.windows.inventory[0], { network_id: 5, count: 1 })
})

test('placing the last of a stack empties the slot', () => {
  const sim = createFakeWorld({ inventory: [{ network_id: 5, count: 1 }] })
  write(
    sim,
    buildPlaceBlockPacket({ x: 1, y: 64, z: 2, face: 1, hotbarSlot: 0, heldItem: { network_id: 5, count: 1 }, playerPosition: { x: 1, y: 65, z: 2 } })
  )
  assert.deepEqual(sim.getWorld().inventory.windows.inventory[0], { network_id: 0 })
})

test('selecting a hotbar slot round-trips through player_hotbar', () => {
  const sim = createFakeWorld()
  write(sim, buildSelectSlotPacket({ slot: 4 }))
  assert.equal(sim.getWorld().inventory.selectedHotbarSlot, 4)
})

test('use_item changes nothing by default — matching #14\'s "not uniformly observable" note', () => {
  const sim = createFakeWorld({ inventory: [{ network_id: 5, count: 1 }] })
  const before = sim.getWorld()
  write(sim, buildUseItemPacket({ hotbarSlot: 0, heldItem: { network_id: 5, count: 1 }, playerPosition: { x: 0, y: 64, z: 0 } }))
  assert.equal(sim.getWorld(), before, 'no state change at all, so use_item correctly reports unverified')
})

test('a use_item effect can be injected when a test needs one', () => {
  const sim = createFakeWorld({
    inventory: [{ network_id: 5, count: 1 }],
    useItemEffect: (api, data) => api.setInventorySlot(data.hotbar_slot, { network_id: 0 }),
  })
  write(sim, buildUseItemPacket({ hotbarSlot: 0, heldItem: { network_id: 5, count: 1 }, playerPosition: { x: 0, y: 64, z: 0 } }))
  assert.deepEqual(sim.getWorld().inventory.windows.inventory[0], { network_id: 0 })
})

test('chat is recorded but has no world effect — Bedrock gives no delivery ack', () => {
  const sim = createFakeWorld()
  const before = sim.getWorld()
  sim.client.write('text', { message: 'hello' })
  assert.equal(sim.getWorld(), before)
  assert.equal(sim.written.length, 1)
})

test('failNext swallows one EFFECT, not one write — a two-packet break stays whole', () => {
  const sim = createFakeWorld({ blocks: { '1,64,2': 7 } })
  sim.failNext()
  for (const packet of buildBreakBlockPackets({ runtimeEntityId: 1, x: 1, y: 64, z: 2, face: 1 })) write(sim, packet)

  assert.equal(getBlockAt(sim.getWorld(), 1, 64, 2), 7, 'the server ignored the break')
  assert.equal(sim.written.length, 2, 'both packets were still written')
})

test('player_auth_input is silent by default — silence is the protocol\'s success signal', () => {
  const sim = createFakeWorld()
  const before = sim.getWorld()
  sim.client.write('player_auth_input', { tick: 1, position: { x: 1, y: 64, z: 0 }, pitch: 0, yaw: 0 })
  assert.equal(sim.getWorld(), before)
})

test('a scripted disagreement comes back as correct_player_move_prediction and wins', () => {
  const sim = createFakeWorld({ correctionFor: ({ tick }) => (tick === 1 ? { x: 99, y: 64, z: 99 } : null) })
  sim.client.write('player_auth_input', { tick: 1, position: { x: 1, y: 64, z: 0 }, pitch: 0, yaw: 0 })
  assert.deepEqual(sim.getWorld().self.position, { x: 99, y: 64, z: 99 }, 'server truth overrides our own optimistic tick')
})

test('waitForWorld resolves immediately or reports the timeout — never a wall-clock wait', async () => {
  const sim = createFakeWorld({ blocks: { '1,64,2': 7 } })
  assert.ok(await sim.waitForWorld((world) => getBlockAt(world, 1, 64, 2) === 7))
  assert.equal(await sim.waitForWorld(() => false), null)
})
