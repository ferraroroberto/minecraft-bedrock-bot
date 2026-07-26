import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyRealmsError } from '../src/errors.js'

// prismarine-realms throws exactly this shape: `${status} ${statusText} ${body}`
// with no .status property (rest.js:90).
const realmsError = (status, statusText, body = '') =>
  new Error(`${status} ${statusText} ${body}`.trim())

test('a 401 is auth, never retried, and names the LOCAL token cache', () => {
  const c = classifyRealmsError(realmsError(401, 'Unauthorized'), {
    tokenCachePath: '/Users/roberto/minecraft-bedrock-bot/.secrets/xbox-auth/',
  })
  assert.equal(c.kind, 'auth')
  assert.equal(c.retryable, false)
  // Token caches are per-host and never synced, so a generic path would send
  // someone to the wrong machine.
  assert.match(c.message, /\/Users\/roberto\/.*\.secrets\/xbox-auth\//)
  assert.match(c.message, /device-code/)
})

test('a 403 classifies as auth too', () => {
  assert.equal(classifyRealmsError(realmsError(403, 'Forbidden')).kind, 'auth')
})

test('6020 is client_version, not retried, and says what to actually do', () => {
  // Real body, captured from the live API during the issue #7 probe.
  const err = realmsError(
    400, 'Bad Request',
    '{"errorCode":6020,"errorMsg":"Unknown client version","reason":"unknown_client_version"}'
  )
  const c = classifyRealmsError(err, { clientVersion: '1.26.30', protocolVersion: 1001 })
  assert.equal(c.kind, 'client_version')
  assert.equal(c.retryable, false)
  assert.equal(c.status, 400)
  assert.match(c.message, /1\.26\.30/)
  assert.match(c.message, /protocol 1001/)
  assert.match(c.message, /minecraft-data/)
  // Must not be mistaken for a generic 4xx, which would lose the remedy.
  assert.doesNotMatch(c.message, /^the Realms API rejected the request/)
})

test('5xx is retryable and says the built-in retry already burned ~15s', () => {
  const c = classifyRealmsError(realmsError(503, 'Service Unavailable'))
  assert.equal(c.kind, 'realms_5xx')
  assert.equal(c.retryable, true)
  assert.match(c.message, /15s/)
})

test('429 is its own retryable condition, distinct from 5xx', () => {
  const c = classifyRealmsError(realmsError(429, 'Too Many Requests'))
  assert.equal(c.kind, 'rate_limited')
  assert.equal(c.retryable, true)
})

test('network errors are retryable — prismarine-realms does NOT retry these', () => {
  // fetch throws before execRequest's status check, so the outer layer is the
  // only thing that handles them.
  for (const code of ['ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN']) {
    const err = Object.assign(new Error('request failed'), { code })
    const c = classifyRealmsError(err)
    assert.equal(c.kind, 'network', `${code} should be network`)
    assert.equal(c.retryable, true)
    assert.match(c.message, new RegExp(code))
  }
})

test('a FetchError by name is retryable even without a code', () => {
  const err = Object.assign(new Error('boom'), { name: 'FetchError' })
  assert.equal(classifyRealmsError(err).retryable, true)
})

test('an ordinary 4xx is non-retryable', () => {
  const c = classifyRealmsError(realmsError(404, 'Not Found'))
  assert.equal(c.kind, 'client_error')
  assert.equal(c.retryable, false)
})

test('an unrecognised error fails loud rather than looping forever', () => {
  // The safety property: we never retry a condition we do not understand.
  const c = classifyRealmsError(new Error('something entirely unexpected'))
  assert.equal(c.kind, 'unknown')
  assert.equal(c.retryable, false)
})

test('every condition produces a DISTINCT message', () => {
  const messages = [
    classifyRealmsError(realmsError(401, 'Unauthorized')),
    classifyRealmsError(realmsError(400, 'Bad Request', '{"errorCode":6020}')),
    classifyRealmsError(realmsError(503, 'Service Unavailable')),
    classifyRealmsError(realmsError(429, 'Too Many')),
    classifyRealmsError(realmsError(404, 'Not Found')),
    classifyRealmsError(Object.assign(new Error('x'), { code: 'ECONNRESET' })),
    classifyRealmsError(new Error('mystery')),
  ].map((c) => c.message)
  // "distinct error messages for distinct conditions" — a supervisor logging
  // the same line for a 503 and an expired token is useless at 3am.
  assert.equal(new Set(messages).size, messages.length)
})

test('survives a non-Error throw without crashing the supervisor', () => {
  assert.equal(classifyRealmsError('just a string').kind, 'unknown')
  assert.equal(classifyRealmsError(null).kind, 'unknown')
  assert.equal(classifyRealmsError(undefined).retryable, false)
})
