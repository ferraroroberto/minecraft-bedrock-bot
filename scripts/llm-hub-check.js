// Manual hub-integration check (#15) — `npm run hub-check`.
//
// DELIBERATELY NOT PART OF `npm run verify`. The gate is offline and hermetic:
// it must pass on a machine with no hub running, so nothing in test/ may make a
// network call. This script is the separate, human-triggered proof that the
// wiring to the local hub actually works.
//
// A hub call is NOT a Realm connection. This never authenticates, never touches
// the Realms API, and never opens a session — it talks to 127.0.0.1 and to a
// fake world in memory. It does not interact with the standing no-live-Realm
// rule in any way.
//
//   npm run hub-check           one real call, asserting a schema-valid reply
//   npm run hub-check -- --goal that, plus one full goal driven end to end
//                               against src/fake-world.js by the REAL model
//
// Exits non-zero on any failure so it reads the same as the gate does.
import 'dotenv/config'
import { createHubModelClient } from '../src/model-client.js'
import { buildSystemPrompt, buildUserMessage } from '../src/prompt.js'
import { parseAndValidateReply } from '../src/model-reply.js'
import { buildObservation } from '../src/observation.js'
import { ACTION_NAMES, createActionRunner } from '../src/perform-action.js'
import { createFakeWorld } from '../src/fake-world.js'
import { defineGoal, blockAtIs } from '../src/goals.js'
import { runGoal } from '../src/decision-loop.js'

const STONE = 7
const AIR = 0
const REGION = { min: { x: -20, y: 0, z: -20 }, max: { x: 20, y: 128, z: 20 } }

const log = {
  info: (event, message) => console.log(`[${event}] ${message}`),
  warn: (event, message) => console.warn(`[${event}] ${message}`),
  error: (event, message) => console.error(`[${event}] ${message}`),
}

function fakeWorld() {
  return createFakeWorld({ position: { x: 1, y: 65, z: 2 }, blocks: { '1,64,2': STONE }, inventory: [{ network_id: 5, count: 4 }] })
}

/** One real call to the hub, asserting the reply parses and validates. */
async function checkOneCall(model) {
  const sim = fakeWorld()
  const goal = defineGoal({ description: 'break the block at 1,64,2', predicate: blockAtIs(1, 64, 2, AIR) })
  const system = buildSystemPrompt({ actionNames: ACTION_NAMES, region: REGION, armed: false })
  const content = buildUserMessage({ goal, observation: buildObservation(sim.getWorld()), step: 1, maxSteps: 1 })

  console.log(`[hub] POST ${model.baseURL} model=${model.model}`)
  const text = await model.complete({ system, messages: [{ role: 'user', content }] })
  console.log(`[hub] raw reply:\n${text}\n`)

  const reply = parseAndValidateReply(text, { actionNames: ACTION_NAMES })
  console.log(`[hub] parsed OK — status=${reply.status} actions=${JSON.stringify(reply.actions)}`)
  return reply
}

/** The whole loop, real model, fake world — no Realm, no network beyond loopback. */
async function checkFullGoal(model) {
  const sim = fakeWorld()
  const { performAction } = createActionRunner({
    client: sim.client,
    getWorld: sim.getWorld,
    setWorld: sim.setWorld,
    waitForWorld: sim.waitForWorld,
    log,
    config: { armed: true, region: REGION, breakWhitelist: new Set([STONE]) },
  })
  const goal = defineGoal({ description: 'break the block at 1,64,2', predicate: blockAtIs(1, 64, 2, AIR) })

  const result = await runGoal({ goal, model, performAction, getWorld: sim.getWorld, identity: { username: 'Gizmo6082' }, maxSteps: 4, log })

  console.log(`\n[goal] ok=${result.ok} steps=${result.steps} actions=${result.actionsExecuted} — ${result.reason}`)
  if (!result.ok) throw new Error(`the real model did not achieve the goal against the fake world: ${result.reason}`)
  return result
}

const wantsGoal = process.argv.includes('--goal')
const model = createHubModelClient()

try {
  await checkOneCall(model)
  if (wantsGoal) await checkFullGoal(model)
  console.log('\n[hub-check] OK — hub wiring works. This proves NOTHING about the real Realm or the real server.')
  process.exit(0)
} catch (err) {
  console.error(`\n[hub-check] FAILED — ${String(err?.message ?? err)}`)
  console.error('[hub-check] is the local hub up? Expected an Anthropic-shaped POST /v1/messages on the base URL above.')
  process.exit(1)
}
