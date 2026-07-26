import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveVersion } from '../src/version.js'

test('defaults to the newest bedrock version in minecraft-data', () => {
  const resolved = resolveVersion({})
  assert.equal(resolved.source, 'minecraft-data')
  assert.match(resolved.version, /^\d+\.\d+\.\d+$/)
  assert.ok(Number.isInteger(resolved.protocolVersion))
})

test('the resolved default matches what the Realms API currently accepts', () => {
  // Guard against a minecraft-data bump silently changing what we announce.
  // If this fails, the pin moved — re-probe the live API before adjusting it.
  const resolved = resolveVersion({})
  assert.equal(resolved.version, '1.26.30')
  assert.equal(resolved.protocolVersion, 1001)
})

test('env vars override for deliberate pinning', () => {
  const resolved = resolveVersion({ MC_VERSION: '1.99.0', PROTOCOL_VERSION: '2000' })
  assert.equal(resolved.version, '1.99.0')
  assert.equal(resolved.protocolVersion, 2000)
  assert.equal(resolved.source, 'env override')
})

test('setting only one of the pair is refused', () => {
  // Announcing a version string with someone else's protocol number is a
  // miserable failure to debug, so make it impossible rather than likely.
  assert.throws(() => resolveVersion({ MC_VERSION: '1.99.0' }), /must be set together/)
  assert.throws(() => resolveVersion({ PROTOCOL_VERSION: '2000' }), /must be set together/)
})

test('a non-integer PROTOCOL_VERSION is refused', () => {
  assert.throws(
    () => resolveVersion({ MC_VERSION: '1.99.0', PROTOCOL_VERSION: 'latest' }),
    /must be an integer/
  )
})
