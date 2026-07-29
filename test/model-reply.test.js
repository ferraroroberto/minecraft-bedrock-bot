import test from 'node:test'
import assert from 'node:assert/strict'
import {
  stripFence,
  parseModelReply,
  validateReply,
  parseAndValidateReply,
  InvalidModelReplyError,
  MAX_ARG_STRING_LENGTH,
} from '../src/model-reply.js'
import { ACTION_NAMES } from '../src/perform-action.js'

const OPTIONS = { actionNames: ACTION_NAMES }
const VALID = { thought: 'break it', actions: [{ type: 'break_block', x: 1, y: 64, z: 2, face: 1 }], status: 'continue' }

test('a bare JSON object parses', () => {
  assert.deepEqual(parseModelReply(JSON.stringify(VALID)), VALID)
})

test('a ```json fence is stripped — the measured real-world behaviour', () => {
  assert.deepEqual(parseModelReply('```json\n' + JSON.stringify(VALID) + '\n```'), VALID)
})

test('an unlabelled ``` fence is stripped too', () => {
  assert.deepEqual(parseModelReply('```\n{"status":"done","actions":[]}\n```'), { status: 'done', actions: [] })
})

test('prose around a fenced object still parses', () => {
  const text = 'Sure! Here is my plan:\n```json\n{"status":"done","actions":[]}\n```\nLet me know if that works.'
  assert.deepEqual(parseModelReply(text), { status: 'done', actions: [] })
})

test('prose around a bare object still parses', () => {
  assert.deepEqual(parseModelReply('Here you go: {"status":"done","actions":[]} — done!'), { status: 'done', actions: [] })
})

test('a brace inside a string does not end the object early', () => {
  const parsed = parseModelReply('Reply: {"status":"continue","actions":[{"type":"chat","message":"a } brace"}]}')
  assert.equal(parsed.actions[0].message, 'a } brace')
})

test('an escaped quote inside a string is handled', () => {
  const parsed = parseModelReply('{"status":"continue","actions":[{"type":"chat","message":"say \\"hi\\""}]}')
  assert.equal(parsed.actions[0].message, 'say "hi"')
})

test('an empty reply is rejected with an instruction the model can act on', () => {
  assert.throws(() => parseModelReply('   '), (err) => err instanceof InvalidModelReplyError && /single JSON object/.test(err.message))
})

test('a reply with no JSON at all is rejected', () => {
  assert.throws(() => parseModelReply('I am not going to do that.'), InvalidModelReplyError)
})

test('stripFence leaves unfenced text alone', () => {
  assert.equal(stripFence('  {"a":1}  '), '{"a":1}')
})

test('a missing or unknown status is rejected, naming the allowed values', () => {
  assert.throws(() => validateReply({ actions: [] }, OPTIONS), /must be one of: continue, done, give_up/)
  assert.throws(() => validateReply({ status: 'finished', actions: [] }, OPTIONS), /must be one of/)
})

test('actions must be an array, and the error says what to send instead', () => {
  assert.throws(() => validateReply({ status: 'continue' }, OPTIONS), /"actions" must be an array \(use \[\]/)
})

test('an unknown action type is rejected, and the error lists what IS available', () => {
  assert.throws(
    () => validateReply({ status: 'continue', actions: [{ type: 'detonate' }] }, OPTIONS),
    (err) => /"detonate" is not an available action/.test(err.message) && /break_block/.test(err.message)
  )
})

test('a nested object argument is refused outright', () => {
  assert.throws(
    () => validateReply({ status: 'continue', actions: [{ type: 'move_to', position: { x: 1 } }] }, OPTIONS),
    /nested objects and arrays are not allowed/
  )
})

test('a non-finite number argument is refused', () => {
  // NaN cannot survive JSON, but a hand-built object (or a future parser) can carry one.
  assert.throws(() => validateReply({ status: 'continue', actions: [{ type: 'move_to', x: NaN }] }, OPTIONS), /must be a finite number/)
})

test('an absurdly long string argument is refused rather than truncated', () => {
  const message = 'x'.repeat(MAX_ARG_STRING_LENGTH + 1)
  assert.throws(() => validateReply({ status: 'continue', actions: [{ type: 'chat', message }] }, OPTIONS), /longer than 256 characters/)
})

test('more actions than the per-step cap is refused', () => {
  const actions = Array.from({ length: 5 }, () => ({ type: 'select_slot', slot: 1 }))
  assert.throws(() => validateReply({ status: 'continue', actions }, { ...OPTIONS, maxActions: 4 }), /at most 4 are allowed per step/)
})

test('a validated reply is normalised: thought and reason trimmed, args preserved', () => {
  const validated = parseAndValidateReply(
    JSON.stringify({ thought: '  break it  ', actions: [{ type: 'break_block', x: 1, y: 64, z: 2, face: 1 }], status: 'continue' }),
    OPTIONS
  )
  assert.equal(validated.thought, 'break it')
  assert.equal(validated.reason, null)
  assert.deepEqual(validated.actions, [{ type: 'break_block', x: 1, y: 64, z: 2, face: 1 }])
})
