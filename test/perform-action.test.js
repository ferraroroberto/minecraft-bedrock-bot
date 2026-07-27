import test from 'node:test'
import assert from 'node:assert/strict'
import { createActionRunner } from '../src/perform-action.js'
import { createAuditLog } from '../src/safety.js'

function makeWorld({ position = { x: 0, y: 0, z: 0 }, health = null, hunger = null, inventory = {}, selectedHotbarSlot = null, blocks = new Map() } = {}) {
  return {
    self: { runtimeEntityId: 1, position, rotation: null, gamemode: null, dimension: null, health, hunger },
    inventory: { windows: { inventory }, selectedHotbarSlot },
    entities: new Map(),
    blocks,
  }
}

/** Simulates "the first (and only) world update that arrives before the timeout". */
function waitForWorldResolving(afterWorld) {
  return async (predicate) => (predicate(afterWorld) ? afterWorld : null)
}

async function waitForWorldTimingOut() {
  return null
}

function fakeClient() {
  const written = []
  return { written, write: (name, params) => written.push({ name, params }) }
}

test('dry-run writes zero packets while still reporting a plan', async () => {
  const client = fakeClient()
  const world = makeWorld()
  const { performAction } = createActionRunner({
    client,
    getWorld: () => world,
    waitForWorld: waitForWorldTimingOut,
    config: { armed: false },
  })
  const result = await performAction('select_slot', { slot: 2 })
  assert.equal(result.ok, true)
  assert.equal(result.dryRun, true)
  assert.deepEqual(result.wouldWrite, ['player_hotbar'])
  assert.equal(client.written.length, 0, 'dry-run must write nothing')
})

test('an out-of-region target is refused, and the refusal names the region', async () => {
  const client = fakeClient()
  const world = makeWorld()
  const { performAction } = createActionRunner({
    client,
    getWorld: () => world,
    waitForWorld: waitForWorldTimingOut,
    config: { armed: true, region: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 } }, breakWhitelist: new Set([5]) },
  })
  const result = await performAction('break_block', { runtimeEntityId: 1, x: 50, y: 5, z: 5, face: 1 })
  assert.equal(result.ok, false)
  assert.equal(result.refused, true)
  assert.match(result.reason, /outside the bounded operating region/)
  assert.match(result.reason, /0,0,0/)
  assert.match(result.reason, /10,10,10/)
  assert.equal(client.written.length, 0)
})

test('a non-whitelisted block-break is refused (deny-by-default)', async () => {
  const client = fakeClient()
  const blocks = new Map([['1,64,2', 99]])
  const world = makeWorld({ blocks, position: { x: 1, y: 64, z: 2 } })
  const { performAction } = createActionRunner({
    client,
    getWorld: () => world,
    waitForWorld: waitForWorldTimingOut,
    config: { armed: true, breakWhitelist: new Set([1, 2, 3]) },
  })
  const result = await performAction('break_block', { runtimeEntityId: 1, x: 1, y: 64, z: 2, face: 1 })
  assert.equal(result.ok, false)
  assert.equal(result.refused, true)
  assert.match(result.reason, /not on the break whitelist/)
  assert.equal(client.written.length, 0)
})

test('the rate limiter refuses the N+1th action within a window', async () => {
  const client = fakeClient()
  const world = makeWorld()
  const { performAction } = createActionRunner({
    client,
    getWorld: () => world,
    waitForWorld: waitForWorldTimingOut,
    now: () => 0, // fixed clock: every call lands in the same window
    config: { armed: false, rateLimit: { maxActions: 2, windowMs: 1000 } },
  })
  const first = await performAction('chat', { message: 'one', username: 'Gizmo6082' })
  const second = await performAction('chat', { message: 'two', username: 'Gizmo6082' })
  const third = await performAction('chat', { message: 'three', username: 'Gizmo6082' })
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(third.ok, false)
  assert.equal(third.reason, 'rate limit exceeded')
})

test('select_slot is confirmed from world state, not from the packet being written', async () => {
  const client = fakeClient()
  const worldBefore = makeWorld({ selectedHotbarSlot: 0 })
  const worldAfter = makeWorld({ selectedHotbarSlot: 3 })
  const { performAction } = createActionRunner({
    client,
    getWorld: () => worldBefore,
    waitForWorld: waitForWorldResolving(worldAfter),
    config: { armed: true },
  })
  const result = await performAction('select_slot', { slot: 3 })
  assert.equal(result.ok, true)
  assert.equal(result.dryRun, false)
  assert.equal(client.written.length, 1)
  assert.equal(client.written[0].name, 'player_hotbar')
})

test('break_block is confirmed by the targeted block actually changing', async () => {
  const client = fakeClient()
  const worldBefore = makeWorld({ blocks: new Map([['1,64,2', 5]]), position: { x: 1, y: 64, z: 2 } })
  const worldAfter = makeWorld({ blocks: new Map([['1,64,2', 0]]), position: { x: 1, y: 64, z: 2 } })
  const { performAction } = createActionRunner({
    client,
    getWorld: () => worldBefore,
    waitForWorld: waitForWorldResolving(worldAfter),
    config: { armed: true, breakWhitelist: new Set([5]) },
  })
  const result = await performAction('break_block', { runtimeEntityId: 1, x: 1, y: 64, z: 2, face: 1 })
  assert.equal(result.ok, true)
  assert.equal(client.written.length, 2, 'start_break + stop_break')
})

test('break_block times out and reports FAILURE, not success, when the block never changes', async () => {
  const client = fakeClient()
  const worldBefore = makeWorld({ blocks: new Map([['1,64,2', 5]]), position: { x: 1, y: 64, z: 2 } })
  const { performAction } = createActionRunner({
    client,
    getWorld: () => worldBefore,
    waitForWorld: waitForWorldTimingOut,
    config: { armed: true, breakWhitelist: new Set([5]) },
  })
  const result = await performAction('break_block', { runtimeEntityId: 1, x: 1, y: 64, z: 2, face: 1 })
  assert.equal(result.ok, false)
  assert.equal(result.timedOut, true)
  assert.match(result.reason, /not confirmed from world state/)
})

test('place_block is refused when the hotbar slot is empty — nothing to place', async () => {
  const client = fakeClient()
  const world = makeWorld({ position: { x: 0, y: 0, z: 0 } })
  const { performAction } = createActionRunner({
    client,
    getWorld: () => world,
    waitForWorld: waitForWorldTimingOut,
    config: { armed: true },
  })
  const result = await performAction('place_block', { x: 1, y: 0, z: 0, face: 1, hotbarSlot: 0 })
  assert.equal(result.ok, false)
  assert.equal(result.refused, true)
  assert.match(result.reason, /empty/)
  assert.equal(client.written.length, 0)
})

test('an unconfirmable use_item reports FAILURE, not success, when nothing observable changes', async () => {
  const client = fakeClient()
  const item = { network_id: 1, count: 5 }
  const worldBefore = makeWorld({ inventory: { 0: item }, position: { x: 0, y: 0, z: 0 } })
  const { performAction } = createActionRunner({
    client,
    getWorld: () => worldBefore,
    waitForWorld: waitForWorldResolving(worldBefore), // nothing changed — predicate never true
    config: { armed: true },
  })
  const result = await performAction('use_item', { hotbarSlot: 0 })
  assert.equal(result.ok, false)
  assert.equal(result.timedOut, true)
})

test('use_item is confirmed when the held stack visibly changes (e.g. consumed)', async () => {
  const client = fakeClient()
  const worldBefore = makeWorld({ inventory: { 0: { network_id: 1, count: 5 } }, position: { x: 0, y: 0, z: 0 } })
  const worldAfter = makeWorld({ inventory: { 0: { network_id: 1, count: 4 } }, position: { x: 0, y: 0, z: 0 } })
  const { performAction } = createActionRunner({
    client,
    getWorld: () => worldBefore,
    waitForWorld: waitForWorldResolving(worldAfter),
    config: { armed: true },
  })
  const result = await performAction('use_item', { hotbarSlot: 0 })
  assert.equal(result.ok, true)
})

test('an unknown action name is refused, not thrown', async () => {
  const client = fakeClient()
  const { performAction } = createActionRunner({
    client,
    getWorld: () => makeWorld(),
    waitForWorld: waitForWorldTimingOut,
    config: { armed: true },
  })
  const result = await performAction('teleport_to_spawn', {})
  assert.equal(result.ok, false)
  assert.equal(result.refused, true)
  assert.match(result.reason, /unknown action/)
})

test('invalid args are refused with zero packets written, before any policy check runs', async () => {
  const client = fakeClient()
  const { performAction } = createActionRunner({
    client,
    getWorld: () => makeWorld(),
    waitForWorld: waitForWorldTimingOut,
    config: { armed: true },
  })
  const result = await performAction('select_slot', { slot: 42 })
  assert.equal(result.ok, false)
  assert.equal(result.refused, true)
  assert.match(result.reason, /select_slot/)
  assert.equal(client.written.length, 0)
})

// #17: move_to/look_at are STREAMING actions through the SAME performAction
// gate — a mutable world (getWorld/setWorld pair) and a fast fake sleep, so
// the tick loop runs in-process without real waiting.
function fakeMutableWorld(initial) {
  let current = initial
  return { getWorld: () => current, setWorld: (w) => { current = w }, getCurrent: () => current }
}
const fastSleep = async () => {}

test('move_to dry-run writes zero packets and reports an estimated tick count', async () => {
  const client = fakeClient()
  const { getWorld, setWorld } = fakeMutableWorld(makeWorld({ position: { x: 0, y: 64, z: 0 } }))
  const { performAction } = createActionRunner({
    client, getWorld, setWorld, sleep: fastSleep, waitForWorld: waitForWorldTimingOut, config: { armed: false },
  })
  const result = await performAction('move_to', { x: 5, y: 64, z: 0 })
  assert.equal(result.ok, true)
  assert.equal(result.dryRun, true)
  assert.ok(result.estimatedTicks > 0)
  assert.equal(client.written.length, 0)
})

test('move_to honours the #14 envelope: an out-of-region target is refused, and the refusal names the region — never clamped', async () => {
  const client = fakeClient()
  const { getWorld, setWorld } = fakeMutableWorld(makeWorld({ position: { x: 0, y: 64, z: 0 } }))
  const { performAction } = createActionRunner({
    client, getWorld, setWorld, sleep: fastSleep, waitForWorld: waitForWorldTimingOut,
    config: { armed: true, region: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 } } },
  })
  const result = await performAction('move_to', { x: 50, y: 5, z: 5 })
  assert.equal(result.ok, false)
  assert.equal(result.refused, true)
  assert.match(result.reason, /outside the bounded operating region/)
  assert.equal(client.written.length, 0)
})

test('move_to is armed-and-confirmed end to end through performAction, and moves world state via the shared getWorld/setWorld pair', async () => {
  const client = fakeClient()
  const { getWorld, setWorld, getCurrent } = fakeMutableWorld(makeWorld({ position: { x: 0, y: 64, z: 0 } }))
  const { performAction } = createActionRunner({
    client, getWorld, setWorld, sleep: fastSleep, waitForWorld: waitForWorldTimingOut, config: { armed: true },
  })
  const result = await performAction('move_to', { x: 1, y: 64, z: 0 })
  assert.equal(result.ok, true)
  assert.ok(client.written.length > 0)
  assert.ok(client.written.every((w) => w.name === 'player_auth_input'))
  assert.ok(Math.abs(getCurrent().self.position.x - 1) < 0.4)
})

test('look_at is not spatial — a look target outside the bounded region is NOT refused, since it only rotates the bot', async () => {
  const client = fakeClient()
  const { getWorld, setWorld } = fakeMutableWorld(makeWorld({ position: { x: 0, y: 64, z: 0 } }))
  const { performAction } = createActionRunner({
    client, getWorld, setWorld, sleep: fastSleep, waitForWorld: waitForWorldTimingOut,
    config: { armed: true, region: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 } } },
  })
  const result = await performAction('look_at', { x: 999, y: 64, z: 999 })
  assert.equal(result.ok, true)
})

test('move_to and look_at each consume exactly one rate-limit slot per call, not one per tick', async () => {
  const client = fakeClient()
  const { getWorld, setWorld } = fakeMutableWorld(makeWorld({ position: { x: 0, y: 64, z: 0 } }))
  const { performAction } = createActionRunner({
    client, getWorld, setWorld, sleep: fastSleep, waitForWorld: waitForWorldTimingOut,
    now: () => 0, config: { armed: true, rateLimit: { maxActions: 1, windowMs: 1000 } },
  })
  const first = await performAction('move_to', { x: 1, y: 64, z: 0 })
  const second = await performAction('look_at', { x: 1, y: 64, z: 0 })
  assert.equal(first.ok, true, 'a multi-tick move_to must still be exactly one rate-limit consumption')
  assert.equal(second.ok, false)
  assert.equal(second.reason, 'rate limit exceeded')
})

test('every decision — allowed, refused, or unverified — is written to the audit log with why', async () => {
  const client = fakeClient()
  const audit = createAuditLog()
  const world = makeWorld()
  const { performAction } = createActionRunner({
    client,
    getWorld: () => world,
    waitForWorld: waitForWorldTimingOut,
    audit,
    config: { armed: false },
  })
  await performAction('select_slot', { slot: 1 })
  await performAction('select_slot', { slot: 99 })
  assert.equal(audit.entries.length, 2)
  assert.equal(audit.entries[0].action, 'select_slot')
  assert.equal(audit.entries[0].ok, true)
  assert.equal(audit.entries[1].ok, false)
  assert.ok(audit.entries[1].reason)
})
