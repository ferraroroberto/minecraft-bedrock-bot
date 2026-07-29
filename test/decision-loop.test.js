import test from 'node:test'
import assert from 'node:assert/strict'
import { runGoal, resolveActionArgs } from '../src/decision-loop.js'
import { createActionRunner } from '../src/perform-action.js'
import { createFakeWorld } from '../src/fake-world.js'
import { defineGoal, blockAtIs, atPosition } from '../src/goals.js'
import { getBlockAt } from '../src/world.js'
import { createScriptedModel, reply, silentLog, spyPerformAction } from './scripted-model.js'

const REGION = { min: { x: -20, y: 0, z: -20 }, max: { x: 20, y: 128, z: 20 } }
const STONE = 7
const AIR = 0

/** A fake world with one breakable block at (1,64,2) and the bot standing next to it. */
function worldWithBlock(options = {}) {
  return createFakeWorld({ position: { x: 1, y: 65, z: 2 }, blocks: { '1,64,2': STONE }, ...options })
}

function armedRunner(sim, config = {}) {
  return createActionRunner({
    client: sim.client,
    getWorld: sim.getWorld,
    setWorld: sim.setWorld,
    waitForWorld: sim.waitForWorld,
    log: silentLog,
    config: { armed: true, region: REGION, breakWhitelist: new Set([STONE]), ...config },
  }).performAction
}

const breakTheBlock = defineGoal({ description: 'clear the block at 1,64,2', predicate: blockAtIs(1, 64, 2, AIR) })

/**
 * THE invariant of this whole layer: `ok` is the predicate evaluated against
 * world state, never anything the model reported. Asserted in every test below
 * rather than in one place, so no scenario can drift out from under it.
 */
function assertOkIsMeasured(result, sim, goal) {
  assert.equal(result.ok, goal.predicate(sim.getWorld()), 'ok must equal the goal predicate against final world state')
  assert.equal(result.ok, result.verified, 'ok and verified must never disagree')
}

test('A MODEL THAT CLAIMS SUCCESS WITHOUT ACTING FAILS THE RUN', async () => {
  // The single most important test in #15. The model reports the goal done,
  // every time, and never emits a single action. Nothing in the world changes,
  // so the run MUST fail — and must say plainly why.
  const sim = worldWithBlock()
  const spy = spyPerformAction()
  const model = createScriptedModel([reply({ thought: 'I have cleared the block.', actions: [], status: 'done' })])

  const result = await runGoal({
    goal: breakTheBlock,
    model,
    performAction: spy.performAction,
    getWorld: sim.getWorld,
    maxSteps: 6,
    log: silentLog,
  })

  assert.equal(result.ok, false, 'a model claiming success it did not achieve must FAIL')
  assert.equal(result.verified, false)
  assert.equal(result.actionsExecuted, 0)
  assert.equal(spy.calls.length, 0, 'no action was ever executed')
  assert.equal(result.falseSuccessClaims, 2)
  assert.match(result.reason, /claimed the goal was done 2 time\(s\) but world state never confirmed it/)
  assert.equal(result.steps, 2, 'terminates on the repeated false claim rather than burning the whole budget')
  assert.equal(getBlockAt(sim.getWorld(), 1, 64, 2), STONE, 'the world is untouched')
  assertOkIsMeasured(result, sim, breakTheBlock)
})

test('a goal achieved for real is verified from world state, not from the report', async () => {
  const sim = worldWithBlock()
  const model = createScriptedModel([reply({ actions: [{ type: 'break_block', x: 1, y: 64, z: 2, face: 1 }] })])

  const result = await runGoal({
    goal: breakTheBlock,
    model,
    performAction: armedRunner(sim),
    getWorld: sim.getWorld,
    log: silentLog,
  })

  assert.equal(result.ok, true)
  assert.equal(result.steps, 1)
  assert.equal(result.actionsExecuted, 1)
  assert.match(result.reason, /verified from world state/)
  assert.equal(getBlockAt(sim.getWorld(), 1, 64, 2), AIR, 'the fake world itself confirms the block changed')
  assertOkIsMeasured(result, sim, breakTheBlock)
})

test('a TRUE "done" claim is not punished — the predicate agrees, so the run passes', async () => {
  const sim = worldWithBlock()
  const model = createScriptedModel([reply({ actions: [{ type: 'break_block', x: 1, y: 64, z: 2, face: 1 }], status: 'done' })])

  const result = await runGoal({ goal: breakTheBlock, model, performAction: armedRunner(sim), getWorld: sim.getWorld, log: silentLog })

  assert.equal(result.ok, true)
  assert.equal(result.falseSuccessClaims, 0)
  assertOkIsMeasured(result, sim, breakTheBlock)
})

test('a goal already satisfied returns immediately without asking the model', async () => {
  const sim = createFakeWorld({ position: { x: 1, y: 65, z: 2 }, blocks: { '1,64,2': AIR } })
  const model = createScriptedModel([reply({})])

  const result = await runGoal({ goal: breakTheBlock, model, performAction: spyPerformAction().performAction, getWorld: sim.getWorld, log: silentLog })

  assert.equal(result.ok, true)
  assert.equal(result.steps, 0)
  assert.equal(model.callCount, 0)
  assert.match(result.reason, /already satisfied/)
})

test('JSON wrapped in a markdown fence is parsed anyway (the model does this despite being told not to)', async () => {
  const sim = worldWithBlock()
  const fenced = '```json\n' + reply({ actions: [{ type: 'break_block', x: 1, y: 64, z: 2, face: 1 }] }) + '\n```'
  const model = createScriptedModel([fenced])

  const result = await runGoal({ goal: breakTheBlock, model, performAction: armedRunner(sim), getWorld: sim.getWorld, log: silentLog })

  assert.equal(result.ok, true)
  assert.equal(result.repairAttempts, 0, 'a fence is handled by the parser, not by burning a repair attempt')
  assertOkIsMeasured(result, sim, breakTheBlock)
})

test('malformed JSON triggers a bounded repair that feeds the validation error back', async () => {
  const sim = worldWithBlock()
  const model = createScriptedModel(['sorry, I cannot do that', reply({ actions: [{ type: 'break_block', x: 1, y: 64, z: 2, face: 1 }] })])

  const result = await runGoal({ goal: breakTheBlock, model, performAction: armedRunner(sim), getWorld: sim.getWorld, log: silentLog })

  assert.equal(result.ok, true)
  assert.equal(result.repairAttempts, 1)
  assert.equal(model.callCount, 2)
  assert.match(model.calls[1].messages[0].content, /YOUR PREVIOUS REPLY WAS REJECTED/)
  assert.match(model.calls[1].messages[0].content, /no JSON object/)
  assertOkIsMeasured(result, sim, breakTheBlock)
})

test('a model that never emits valid JSON fails cleanly after a bounded number of attempts', async () => {
  const sim = worldWithBlock()
  const spy = spyPerformAction()
  const model = createScriptedModel(['still not json'])

  const result = await runGoal({
    goal: breakTheBlock,
    model,
    performAction: spy.performAction,
    getWorld: sim.getWorld,
    maxRepairAttempts: 2,
    log: silentLog,
  })

  assert.equal(result.ok, false)
  assert.equal(model.callCount, 3, 'one attempt plus exactly two repairs — bounded, never a spin')
  assert.equal(spy.calls.length, 0)
  assert.match(result.reason, /never validated after 3 attempt\(s\)/)
  assertOkIsMeasured(result, sim, breakTheBlock)
})

test('an action refused by the safety envelope becomes a failed step fed back to the model, not a crash', async () => {
  const sim = worldWithBlock()
  const model = createScriptedModel([
    reply({ thought: 'the block is over there somewhere', actions: [{ type: 'break_block', x: 500, y: 64, z: 2, face: 1 }] }),
    reply({ thought: 'that was refused, using the real coordinate', actions: [{ type: 'break_block', x: 1, y: 64, z: 2, face: 1 }] }),
  ])

  const result = await runGoal({ goal: breakTheBlock, model, performAction: armedRunner(sim), getWorld: sim.getWorld, log: silentLog })

  assert.equal(result.ok, true, 'the run recovers rather than dying on a hallucinated coordinate')
  assert.equal(result.steps, 2)
  assert.equal(result.outcomes[0].result.refused, true)
  assert.match(result.outcomes[0].result.reason, /outside the bounded operating region/)
  // The refusal must actually reach the model — otherwise it has no way to correct itself.
  assert.match(model.calls[1].messages[0].content, /outside the bounded operating region/)
  assert.ok(
    !sim.written.some((packet) => packet.params?.position?.x === 500),
    'the refused coordinate never reached the wire — only the corrected step wrote packets'
  )
  assertOkIsMeasured(result, sim, breakTheBlock)
})

test('an unknown action type is rejected at validation and never reaches the gate', async () => {
  const sim = worldWithBlock()
  const spy = spyPerformAction()
  const model = createScriptedModel([reply({ actions: [{ type: 'detonate', x: 1, y: 64, z: 2 }] })])

  const result = await runGoal({ goal: breakTheBlock, model, performAction: spy.performAction, getWorld: sim.getWorld, log: silentLog })

  assert.equal(result.ok, false)
  assert.equal(spy.calls.length, 0, 'an invented action must never reach performAction')
  assert.match(model.calls[0].messages[0].content, /GOAL:/)
  assert.match(model.calls[1].messages[0].content, /"detonate" is not an available action/)
  assertOkIsMeasured(result, sim, breakTheBlock)
})

test('the step budget terminates a loop that is not converging', async () => {
  const sim = worldWithBlock()
  const model = createScriptedModel([reply({ thought: 'fiddling with the hotbar', actions: [{ type: 'select_slot', slot: 3 }] })])

  const result = await runGoal({
    goal: breakTheBlock,
    model,
    performAction: armedRunner(sim),
    getWorld: sim.getWorld,
    maxSteps: 3,
    log: silentLog,
  })

  assert.equal(result.ok, false)
  assert.equal(result.steps, 3)
  assert.equal(result.actionsExecuted, 3)
  assert.match(result.reason, /step budget exhausted after 3 step\(s\)/)
  assertOkIsMeasured(result, sim, breakTheBlock)
})

test('a batch stops at the first failed action rather than compounding a wrong assumption', async () => {
  const sim = worldWithBlock()
  sim.failNext() // the server ignores the break
  const model = createScriptedModel([
    reply({ actions: [{ type: 'break_block', x: 1, y: 64, z: 2, face: 1 }, { type: 'chat', message: 'block cleared!' }] }),
  ])

  const result = await runGoal({
    goal: breakTheBlock,
    model,
    performAction: armedRunner(sim),
    getWorld: sim.getWorld,
    identity: { username: 'Gizmo6082' },
    maxSteps: 1,
    log: silentLog,
  })

  assert.equal(result.ok, false)
  assert.equal(result.actionsExecuted, 1, 'the second action of the batch is never executed')
  assert.equal(result.outcomes.length, 1)
  assert.equal(result.outcomes[0].result.ok, false)
  assert.ok(!sim.written.some((packet) => packet.name === 'text'), 'the premature "block cleared!" chat is never sent')
  assertOkIsMeasured(result, sim, breakTheBlock)
})

test('the model gives up: the run ends, and the verdict is still the predicate', async () => {
  const sim = worldWithBlock()
  const model = createScriptedModel([reply({ actions: [], status: 'give_up', reason: 'I cannot reach the block' })])

  const result = await runGoal({ goal: breakTheBlock, model, performAction: armedRunner(sim), getWorld: sim.getWorld, log: silentLog })

  assert.equal(result.ok, false)
  assert.match(result.reason, /model gave up on step 1: I cannot reach the block/)
  assertOkIsMeasured(result, sim, breakTheBlock)
})

test('a goal predicate that throws is treated as NOT satisfied, never as success', async () => {
  const sim = worldWithBlock()
  const exploding = defineGoal({
    description: 'a goal with a buggy predicate',
    predicate: () => {
      throw new Error('bug in the predicate')
    },
  })
  const model = createScriptedModel([reply({ actions: [], status: 'done' })])

  const result = await runGoal({ goal: exploding, model, performAction: spyPerformAction().performAction, getWorld: sim.getWorld, maxSteps: 2, log: silentLog })

  assert.equal(result.ok, false)
  assert.equal(result.verified, false)
})

test('identity args are injected by the loop and cannot be overridden by the model', async () => {
  // A model choosing its own runtimeEntityId would be naming a DIFFERENT
  // entity — reaching below the action vocabulary, which the design forbids.
  const sim = worldWithBlock({ runtimeEntityId: 1 })
  const model = createScriptedModel([
    reply({ actions: [{ type: 'break_block', x: 1, y: 64, z: 2, face: 1, runtimeEntityId: 999, username: 'Roberto39764' }] }),
  ])

  await runGoal({
    goal: breakTheBlock,
    model,
    performAction: armedRunner(sim),
    getWorld: sim.getWorld,
    identity: { username: 'Gizmo6082', xuid: '123' },
    log: silentLog,
  })

  const action = sim.written.find((packet) => packet.name === 'player_action')
  assert.equal(action.params.runtime_entity_id, 1, 'the world model owns the runtime entity id, not the model')
})

test('chat identity comes from config, never from the model', async () => {
  const sim = worldWithBlock()
  const goal = defineGoal({ description: 'say hello', predicate: () => false })
  const model = createScriptedModel([reply({ actions: [{ type: 'chat', message: 'hello', username: 'Roberto39764', xuid: 'spoofed' }] })])

  await runGoal({
    goal,
    model,
    performAction: armedRunner(sim),
    getWorld: sim.getWorld,
    identity: { username: 'Gizmo6082', xuid: '123' },
    maxSteps: 1,
    log: silentLog,
  })

  const text = sim.written.find((packet) => packet.name === 'text')
  assert.equal(text.params.source_name, 'Gizmo6082')
  assert.equal(text.params.xuid, '123')
})

test('resolveActionArgs strips type and lets injected identity win', () => {
  const world = { self: { runtimeEntityId: 42 } }
  const args = resolveActionArgs({ type: 'break_block', x: 1, y: 2, z: 3, runtimeEntityId: 999 }, world, {})
  assert.deepEqual(args, { x: 1, y: 2, z: 3, runtimeEntityId: 42 })
})

test('dry-run is the default posture: the loop plans, and nothing is written', async () => {
  const sim = worldWithBlock()
  const performAction = createActionRunner({
    client: sim.client,
    getWorld: sim.getWorld,
    setWorld: sim.setWorld,
    waitForWorld: sim.waitForWorld,
    log: silentLog,
    config: { region: REGION, breakWhitelist: new Set([STONE]) }, // armed omitted = dry run
  }).performAction
  const model = createScriptedModel([reply({ actions: [{ type: 'break_block', x: 1, y: 64, z: 2, face: 1 }] })])

  const result = await runGoal({ goal: breakTheBlock, model, performAction, getWorld: sim.getWorld, maxSteps: 2, log: silentLog })

  assert.equal(result.ok, false, 'a dry run cannot satisfy a world-state predicate — and must not pretend to')
  assert.equal(result.outcomes[0].result.dryRun, true)
  assert.equal(sim.written.length, 0)
  assertOkIsMeasured(result, sim, breakTheBlock)
})

test('every decision and its outcome reaches the audit log', async () => {
  const sim = worldWithBlock()
  const entries = []
  const audit = { record: (entry) => entries.push(entry) }
  const model = createScriptedModel([reply({ thought: 'break it', actions: [{ type: 'break_block', x: 1, y: 64, z: 2, face: 1 }] })])

  await runGoal({ goal: breakTheBlock, model, performAction: armedRunner(sim), getWorld: sim.getWorld, audit, log: silentLog })

  assert.ok(entries.some((entry) => entry.event === 'decided' && entry.thought === 'break it'))
  assert.ok(entries.some((entry) => entry.event === 'finished' && entry.ok === true))
  assert.ok(entries.every((entry) => Number.isFinite(entry.ts)))
})

test('a movement goal is verified from tracked position, not from the model saying it arrived', async () => {
  const sim = createFakeWorld({ position: { x: 0, y: 64, z: 0 } })
  const performAction = createActionRunner({
    client: sim.client,
    getWorld: sim.getWorld,
    setWorld: sim.setWorld,
    waitForWorld: sim.waitForWorld,
    sleep: async () => {},
    log: silentLog,
    config: { armed: true, region: REGION, tickIntervalMs: 0 },
  }).performAction
  const goal = defineGoal({ description: 'stand at 2,64,0', predicate: atPosition({ x: 2, y: 64, z: 0 }) })
  const model = createScriptedModel([reply({ actions: [{ type: 'move_to', x: 2, y: 64, z: 0 }], status: 'done' })])

  const result = await runGoal({ goal, model, performAction, getWorld: sim.getWorld, log: silentLog })

  assert.equal(result.ok, true)
  assert.ok(sim.written.every((packet) => packet.name === 'player_auth_input'))
  assertOkIsMeasured(result, sim, goal)
})
