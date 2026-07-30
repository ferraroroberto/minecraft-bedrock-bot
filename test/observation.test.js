import test from 'node:test'
import assert from 'node:assert/strict'
import { buildObservation, DEFAULT_MAX_BLOCKS, DEFAULT_MAX_ENTITIES, DEFAULT_MAX_OUTCOMES, MAX_REASON_LENGTH } from '../src/observation.js'
import { createWorldState } from '../src/world.js'

function worldWith(patch = {}) {
  const base = createWorldState()
  return {
    ...base,
    ...patch,
    self: { ...base.self, position: { x: 0, y: 64, z: 0 }, ...(patch.self ?? {}) },
    inventory: { ...base.inventory, ...(patch.inventory ?? {}) },
  }
}

test('the observation exposes exactly the agreed surface — no raw packets, no client handles', () => {
  const observation = buildObservation(worldWith())
  assert.deepEqual(Object.keys(observation), ['self', 'inventory', 'entities', 'blocks', 'recentOutcomes'])
})

test('positions are rounded to 2dp — Bedrock float noise costs tokens and buys nothing', () => {
  const observation = buildObservation(worldWith({ self: { position: { x: 28.7431298, y: 64.6200011, z: 9.0812 } } }))
  assert.deepEqual(observation.self.position, { x: 28.74, y: 64.62, z: 9.08 })
})

test('an unknown position stays null rather than becoming a plausible zero', () => {
  const observation = buildObservation(worldWith({ self: { position: null } }))
  assert.equal(observation.self.position, null)
})

test('blocks are capped, sorted nearest-first, and report the true total', () => {
  const blocks = new Map()
  for (let i = 1; i <= 50; i++) blocks.set(`${i},64,0`, 100 + i)
  const observation = buildObservation(worldWith({ blocks }))

  assert.equal(observation.blocks.total, 50, 'the model is told it is seeing a subset')
  assert.equal(observation.blocks.nearest.length, DEFAULT_MAX_BLOCKS)
  assert.equal(observation.blocks.nearest[0].x, 1, 'nearest first')
  assert.equal(observation.blocks.nearest.at(-1).x, DEFAULT_MAX_BLOCKS)
})

test('entities are capped, sorted nearest-first, and report the true total', () => {
  const entities = new Map()
  for (let i = 1; i <= 20; i++) entities.set(i, { uniqueId: i, type: 'cow', username: null, position: { x: i, y: 64, z: 0 } })
  const observation = buildObservation(worldWith({ entities }))

  assert.equal(observation.entities.total, 20)
  assert.equal(observation.entities.nearest.length, DEFAULT_MAX_ENTITIES)
  assert.equal(observation.entities.nearest[0].distance, 1)
})

test('an entity with no known position sorts last instead of being dropped', () => {
  const entities = new Map([
    [1, { uniqueId: 1, type: 'cow', username: null, position: null }],
    [2, { uniqueId: 2, type: 'pig', username: null, position: { x: 5, y: 64, z: 0 } }],
  ])
  const observation = buildObservation(worldWith({ entities }))

  assert.equal(observation.entities.nearest[0].type, 'pig')
  assert.equal(observation.entities.nearest[1].type, 'cow')
  assert.equal(observation.entities.nearest[1].distance, null)
})

test('only non-empty inventory slots are shown — network_id 0 is the protocol\'s own "no item"', () => {
  const inventory = { windows: { inventory: [{ network_id: 5, count: 3 }, { network_id: 0 }, null, { network_id: 9, count: 1 }] }, selectedHotbarSlot: 3 }
  const observation = buildObservation(worldWith({ inventory }))

  assert.deepEqual(observation.inventory.items, [
    { slot: 0, networkId: 5, count: 3 },
    { slot: 3, networkId: 9, count: 1 },
  ])
  assert.equal(observation.inventory.selectedHotbarSlot, 3)
})

test('recent outcomes are capped to the most recent few', () => {
  const recentOutcomes = Array.from({ length: 12 }, (_, i) => ({ action: 'select_slot', args: { slot: i }, result: { ok: true } }))
  const observation = buildObservation(worldWith(), { recentOutcomes })

  assert.equal(observation.recentOutcomes.length, DEFAULT_MAX_OUTCOMES)
  assert.equal(observation.recentOutcomes.at(-1).args.slot, 11, 'the most recent outcome is kept')
})

test('a refusal reason is carried to the model, truncated rather than unbounded', () => {
  const reason = 'r'.repeat(MAX_REASON_LENGTH + 50)
  const observation = buildObservation(worldWith(), {
    recentOutcomes: [{ action: 'break_block', args: {}, result: { ok: false, refused: true, reason } }],
  })

  const outcome = observation.recentOutcomes[0]
  assert.equal(outcome.ok, false)
  assert.equal(outcome.refused, true)
  assert.equal(outcome.reason.length, MAX_REASON_LENGTH)
  assert.ok(outcome.reason.endsWith('…'))
})

test('#23: an entity keyed by a bigint runtime id (varint64) is stringified, not left to crash JSON.stringify', () => {
  const entities = new Map([[42n, { uniqueId: 1042n, type: 'minecraft:cow', username: null, position: { x: 1, y: 64, z: 0 } }]])
  const observation = buildObservation(worldWith({ entities }))

  assert.equal(observation.entities.nearest[0].runtimeId, '42', 'a bigint id is coerced to a string, not left raw')
  assert.doesNotThrow(() => JSON.stringify(observation), 'a bigint runtime id must not leak into the observation')
})

test('the whole observation stays JSON-serialisable — it goes straight into a prompt', () => {
  const entities = new Map([[1, { uniqueId: 1n, type: 'cow', username: null, position: { x: 1, y: 64, z: 0 } }]])
  const blocks = new Map([['1,64,0', 7]])
  const observation = buildObservation(worldWith({ entities, blocks }))
  assert.doesNotThrow(() => JSON.stringify(observation), 'a BigInt unique id must not leak into the observation')
})
