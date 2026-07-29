import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSystemPrompt, buildUserMessage, ACTION_DOCS } from '../src/prompt.js'
import { ACTION_NAMES } from '../src/perform-action.js'
import { buildObservation } from '../src/observation.js'
import { createFakeWorld } from '../src/fake-world.js'

const REGION = { min: { x: -20, y: 0, z: -20 }, max: { x: 20, y: 128, z: 20 } }

test('every action in the vocabulary is described to the model', () => {
  // The drift guard: an action added to src/perform-action.js without a doc
  // entry here would otherwise reach the model as a bare name it cannot use.
  for (const name of ACTION_NAMES) {
    assert.ok(ACTION_DOCS[name], `action "${name}" has no entry in ACTION_DOCS`)
    assert.ok(ACTION_DOCS[name].startsWith(`${name} —`), `ACTION_DOCS.${name} should lead with the action name`)
  }
})

test('ACTION_DOCS describes nothing that is not actually available', () => {
  for (const name of Object.keys(ACTION_DOCS)) {
    assert.ok(ACTION_NAMES.includes(name), `ACTION_DOCS documents "${name}", which is not in the vocabulary`)
  }
})

test('the system prompt states the output contract and forbids the fence', () => {
  const prompt = buildSystemPrompt({ actionNames: ACTION_NAMES })
  assert.match(prompt, /single JSON object and nothing else/)
  assert.match(prompt, /No markdown code fence/)
  assert.match(prompt, /"status": "continue" \| "done" \| "give_up"/)
})

test('the system prompt says plainly that a "done" claim is not evidence', () => {
  const prompt = buildSystemPrompt({ actionNames: ACTION_NAMES })
  assert.match(prompt, /decided by a program that inspects the world state, not by what you report/)
  assert.match(prompt, /is a claim, not evidence/)
})

test('the bounded region is named in the prompt when one is configured', () => {
  const prompt = buildSystemPrompt({ actionNames: ACTION_NAMES, region: REGION })
  assert.match(prompt, /\[-20,0,-20\] to \[20,128,20\]/)
  assert.match(prompt, /never clamped/)
})

test('the prompt distinguishes a dry run from an armed run', () => {
  assert.match(buildSystemPrompt({ actionNames: ACTION_NAMES, armed: false }), /DRY RUN/)
  assert.match(buildSystemPrompt({ actionNames: ACTION_NAMES, armed: true }), /ARMED/)
})

test('the prompt explains that observed blocks are not a terrain map', () => {
  const prompt = buildSystemPrompt({ actionNames: ACTION_NAMES })
  assert.match(prompt, /never "there is nothing there"/)
})

test('the user message carries the goal and the serialised observation', () => {
  const observation = buildObservation(createFakeWorld({ position: { x: 1, y: 64, z: 2 } }).getWorld())
  const message = buildUserMessage({ goal: { description: 'go to the farm' }, observation, step: 2, maxSteps: 8 })

  assert.match(message, /GOAL: go to the farm/)
  assert.match(message, /STEP 2 of at most 8/)
  assert.match(message, /"position": \{/)
})

test('a repair prompt tells the model exactly what was wrong with its last reply', () => {
  const observation = buildObservation(createFakeWorld().getWorld())
  const message = buildUserMessage({ goal: { description: 'x' }, observation, lastError: '"status" must be one of: continue, done, give_up' })

  assert.match(message, /YOUR PREVIOUS REPLY WAS REJECTED/)
  assert.match(message, /"status" must be one of/)
  assert.match(message, /correcting exactly that problem/)
})

test('an unfenced user message is produced when there is nothing to repair', () => {
  const observation = buildObservation(createFakeWorld().getWorld())
  const message = buildUserMessage({ goal: { description: 'x' }, observation })
  assert.doesNotMatch(message, /REJECTED/)
})
