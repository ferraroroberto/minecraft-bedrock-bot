import test from 'node:test'
import assert from 'node:assert/strict'
import { regionFromCorners, observedCellsIn, summarizeFarm, harvestAndReplantGoal } from '../src/farm.js'
import { AIR, MATURE_WHEAT, WHEAT_STAGE_0, WHEAT_IMMATURE_OBSERVED, ITEMS, wheatBreakWhitelist } from '../src/blocks.js'
import { createFakeWorld } from '../src/fake-world.js'
import { createActionRunner } from '../src/perform-action.js'
import { runGoal } from '../src/decision-loop.js'
import { InvalidGoalError } from '../src/goals.js'
import { createScriptedModel, reply, silentLog } from './scripted-model.js'

// The real farm's geometry, as measured in-game on 2026-08-13: farmland at
// y=62, crops at y=63, corners (42,39) and (45,64). The tests use a two-cell
// slice of it so the assertions stay readable.
const REGION = regionFromCorners({ x: 42, y: 62, z: 39 }, { x: 45, y: 64, z: 64 })
const CELL_A = { x: 42, y: 63, z: 39 }
const CELL_B = { x: 43, y: 63, z: 39 }

const SEEDS = { network_id: ITEMS.WHEAT_SEEDS, count: 64, metadata: 0, has_stack_id: false, block_runtime_id: 0 }

/**
 * A fake farm seeded with the REAL measured ids, with the bot standing between
 * the two crop cells and holding seeds in hotbar slot 0.
 *
 * `placedRuntimeIdFor` encodes the one server behaviour this simulation
 * assumes: planting wheat seeds yields a stage-0 wheat block. That assumption
 * is measured, not invented — the source capture recorded exactly that
 * transition at (42,63,39) — but it is still OUR model of the server, per
 * src/fake-world.js's header.
 */
function fakeFarm(blocks) {
  return createFakeWorld({
    position: { x: 42, y: 64, z: 40 },
    inventory: [SEEDS],
    selectedHotbarSlot: 0,
    airRuntimeId: AIR,
    placedRuntimeIdFor: (heldItem) => (heldItem?.network_id === ITEMS.WHEAT_SEEDS ? WHEAT_STAGE_0 : 0),
    blocks,
  })
}

const key = (cell) => `${cell.x},${cell.y},${cell.z}`

test('regionFromCorners normalises corners given in any order', () => {
  const forward = regionFromCorners({ x: 42, y: 62, z: 39 }, { x: 45, y: 64, z: 64 })
  const backward = regionFromCorners({ x: 45, y: 64, z: 64 }, { x: 42, y: 62, z: 39 })
  assert.deepEqual(forward, backward)
  assert.deepEqual(forward.min, { x: 42, y: 62, z: 39 })
  assert.deepEqual(forward.max, { x: 45, y: 64, z: 64 })
})

test('observedCellsIn returns only blocks inside the region', () => {
  const sim = fakeFarm({ [key(CELL_A)]: MATURE_WHEAT, '10,63,10': MATURE_WHEAT })
  const cells = observedCellsIn(sim.getWorld(), REGION)
  assert.equal(cells.length, 1)
  assert.deepEqual(cells[0], { ...CELL_A, runtimeId: MATURE_WHEAT })
})

test('summarizeFarm counts mature and empty cells separately', () => {
  const sim = fakeFarm({ [key(CELL_A)]: MATURE_WHEAT, [key(CELL_B)]: AIR })
  const summary = summarizeFarm(sim.getWorld(), REGION)
  assert.equal(summary.observed, 2)
  assert.equal(summary.mature, 1)
  assert.equal(summary.empty, 1)
  assert.deepEqual(summary.matureCells[0], { ...CELL_A, runtimeId: MATURE_WHEAT })
})

test('an EMPTY observation does not satisfy the goal (#45 vacuous-truth trap)', () => {
  // The bug this exists to prevent: "no observed cell is mature" is trivially
  // true when nothing has been observed, and src/decision-loop.js evaluates
  // the predicate before the first step — so a naive predicate hands back
  // "goal was already satisfied before any action was taken" to a bot that
  // just joined and has seen nothing at all.
  const sim = fakeFarm({})
  const goal = harvestAndReplantGoal({ region: REGION })
  assert.equal(goal.predicate(sim.getWorld()), false)
})

test('the goal is not satisfied while mature wheat remains', () => {
  const sim = fakeFarm({ [key(CELL_A)]: MATURE_WHEAT, [key(CELL_B)]: WHEAT_STAGE_0 })
  assert.equal(harvestAndReplantGoal({ region: REGION }).predicate(sim.getWorld()), false)
})

test('the goal is not satisfied while a harvested cell is left bare', () => {
  // Harvest without replant is a half-done job, and the predicate says so.
  const sim = fakeFarm({ [key(CELL_A)]: AIR, [key(CELL_B)]: WHEAT_STAGE_0 })
  assert.equal(harvestAndReplantGoal({ region: REGION }).predicate(sim.getWorld()), false)
})

test('the goal IS satisfied once every observed cell is replanted', () => {
  const sim = fakeFarm({ [key(CELL_A)]: WHEAT_STAGE_0, [key(CELL_B)]: WHEAT_STAGE_0 })
  assert.equal(harvestAndReplantGoal({ region: REGION }).predicate(sim.getWorld()), true)
})

test('an immature crop left standing is fine — it is not what the goal is about', () => {
  // Growing wheat is not a failure state: the goal asks that nothing MATURE is
  // left standing and nothing is left bare. A predicate that demanded every
  // cell be stage 0 would fail forever on a farm that grows between steps.
  const sim = fakeFarm({ [key(CELL_A)]: WHEAT_IMMATURE_OBSERVED[1], [key(CELL_B)]: WHEAT_STAGE_0 })
  assert.equal(harvestAndReplantGoal({ region: REGION }).predicate(sim.getWorld()), true)
})

test('minObservedCells can demand more evidence before believing the farm is done', () => {
  const sim = fakeFarm({ [key(CELL_A)]: WHEAT_STAGE_0 })
  assert.equal(harvestAndReplantGoal({ region: REGION, minObservedCells: 2 }).predicate(sim.getWorld()), false)
  assert.equal(harvestAndReplantGoal({ region: REGION, minObservedCells: 1 }).predicate(sim.getWorld()), true)
})

test('a goal without a region is refused outright', () => {
  assert.throws(() => harvestAndReplantGoal({}), /needs a region/)
})

test('the goal goes through defineGoal, so the #15 contract still applies', () => {
  const goal = harvestAndReplantGoal({ region: REGION })
  assert.equal(Object.isFrozen(goal), true, 'defineGoal freezes its result — this goal bypassed it')
  assert.match(goal.description, /42,62,39/)
  assert.throws(() => harvestAndReplantGoal({ region: REGION, description: '   ' }), InvalidGoalError)
})

test('the loop harvests and replants end-to-end, verified from world state (#45)', async () => {
  // The acceptance criterion in full: a model drives the real action gate
  // against a fake world seeded with the REAL measured ids, and success is
  // decided by the predicate reading world state — never by the model's claim.
  const sim = fakeFarm({ [key(CELL_A)]: MATURE_WHEAT, [key(CELL_B)]: MATURE_WHEAT })
  const goal = harvestAndReplantGoal({ region: REGION })

  const { performAction } = createActionRunner({
    client: sim.client,
    getWorld: sim.getWorld,
    setWorld: sim.setWorld,
    waitForWorld: sim.waitForWorld,
    log: silentLog,
    config: { armed: true, region: REGION, breakWhitelist: wheatBreakWhitelist() },
  })

  const harvestThen = (cell) => [
    { type: 'break_block', x: cell.x, y: cell.y, z: cell.z, face: 1 },
    { type: 'place_block', x: cell.x, y: cell.y, z: cell.z, face: 1, hotbarSlot: 0 },
  ]
  const model = createScriptedModel([
    reply({ thought: 'clear and replant the first cell', actions: harvestThen(CELL_A) }),
    reply({ thought: 'clear and replant the second cell', actions: harvestThen(CELL_B), status: 'done' }),
  ])

  const result = await runGoal({
    goal,
    model,
    performAction,
    getWorld: sim.getWorld,
    identity: { username: 'Gizmo6082' },
    config: { region: REGION, armed: true },
    log: silentLog,
  })

  assert.equal(result.ok, true, `goal not verified: ${result.reason}`)
  assert.equal(result.ok, goal.predicate(sim.getWorld()), 'ok must equal the predicate against final world state')
  assert.equal(result.falseSuccessClaims, 0)

  const summary = summarizeFarm(sim.getWorld(), REGION)
  assert.equal(summary.mature, 0, 'mature wheat was left standing')
  assert.equal(summary.empty, 0, 'a cell was harvested but never replanted')
  assert.equal(summary.observed, 2)
})

test('the loop runs UNARMED without touching the world, and correctly fails the goal', async () => {
  // Dry-run is the default, and this asserts the two halves that matter: no
  // packet changed anything, and the goal honestly reports NOT done rather
  // than passing because the actions "succeeded".
  const sim = fakeFarm({ [key(CELL_A)]: MATURE_WHEAT, [key(CELL_B)]: MATURE_WHEAT })
  const goal = harvestAndReplantGoal({ region: REGION })

  const { performAction } = createActionRunner({
    client: sim.client,
    getWorld: sim.getWorld,
    setWorld: sim.setWorld,
    waitForWorld: sim.waitForWorld,
    log: silentLog,
    config: { armed: false, region: REGION, breakWhitelist: wheatBreakWhitelist() },
  })

  const model = createScriptedModel([
    reply({ actions: [{ type: 'break_block', x: CELL_A.x, y: CELL_A.y, z: CELL_A.z, face: 1 }], status: 'done' }),
  ])

  const result = await runGoal({
    goal, model, performAction, getWorld: sim.getWorld,
    identity: { username: 'Gizmo6082' }, config: { region: REGION, armed: false },
    maxSteps: 3, log: silentLog,
  })

  assert.equal(result.ok, false, 'a dry run must never satisfy the goal')
  assert.equal(sim.written.length, 0, 'dry-run wrote packets to the client')
  assert.equal(summarizeFarm(sim.getWorld(), REGION).mature, 2, 'the world changed during a dry run')
  assert.ok(result.falseSuccessClaims > 0, 'the model claimed done — that claim must have been counted and rejected')
})

test('the loop cannot break an immature crop even when the model asks it to (#45)', async () => {
  // CELL_B is left mature on purpose: with only the immature crop standing the
  // goal is ALREADY satisfied (nothing mature, nothing bare) and the loop
  // returns before calling the model at all. Leaving real work undone is what
  // gets the model a turn — and mirrors the realistic mistake, a model
  // reaching for a crop that is not ripe yet while ripe ones remain.
  const immature = WHEAT_IMMATURE_OBSERVED[1]
  const sim = fakeFarm({ [key(CELL_A)]: immature, [key(CELL_B)]: MATURE_WHEAT })
  const goal = harvestAndReplantGoal({ region: REGION })
  assert.equal(goal.predicate(sim.getWorld()), false, 'the fixture must leave the goal unsatisfied')

  const refusals = []
  const { performAction } = createActionRunner({
    client: sim.client,
    getWorld: sim.getWorld,
    setWorld: sim.setWorld,
    waitForWorld: sim.waitForWorld,
    log: { ...silentLog, warn: (event, detail) => refusals.push(`${event} ${detail}`) },
    config: { armed: true, region: REGION, breakWhitelist: wheatBreakWhitelist() },
  })

  const model = createScriptedModel([
    reply({ actions: [{ type: 'break_block', x: CELL_A.x, y: CELL_A.y, z: CELL_A.z, face: 1 }] }),
  ])

  await runGoal({
    goal, model, performAction, getWorld: sim.getWorld,
    identity: { username: 'Gizmo6082' }, config: { region: REGION, armed: true },
    maxSteps: 2, log: silentLog,
  })

  assert.equal(sim.getWorld().blocks.get(key(CELL_A)), immature, 'an immature crop was destroyed')
  assert.ok(
    refusals.some((line) => line.includes('action.refused') && line.includes('deny-by-default')),
    `the refusal must be logged, not silent — saw: ${JSON.stringify(refusals)}`
  )
})

test('a cell outside the farm region is refused even if it holds mature wheat', async () => {
  // The region is the guard against a hallucinated coordinate reaching a real
  // block in Roberto's base. Mature wheat somewhere else is still not ours.
  const sim = createFakeWorld({
    position: { x: 0, y: 65, z: 0 },
    inventory: [SEEDS],
    airRuntimeId: AIR,
    blocks: { '0,64,1': MATURE_WHEAT },
  })

  const refusals = []
  const { performAction } = createActionRunner({
    client: sim.client,
    getWorld: sim.getWorld,
    setWorld: sim.setWorld,
    waitForWorld: sim.waitForWorld,
    log: { ...silentLog, warn: (event, detail) => refusals.push(`${event} ${detail}`) },
    config: { armed: true, region: REGION, breakWhitelist: wheatBreakWhitelist() },
  })

  const result = await performAction('break_block', { runtimeEntityId: 1, x: 0, y: 64, z: 1, face: 1 })
  assert.equal(result.refused, true)
  assert.match(result.reason, /outside the bounded operating region/)
  assert.equal(sim.getWorld().blocks.get('0,64,1'), MATURE_WHEAT, 'a block outside the region was broken')
})
