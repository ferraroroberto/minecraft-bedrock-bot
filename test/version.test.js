import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { resolveVersion } from '../src/version.js'

const require = createRequire(import.meta.url)

test('defaults to the newest bedrock version in minecraft-data', () => {
  const resolved = resolveVersion({})
  assert.equal(resolved.source, 'minecraft-data')
  assert.match(resolved.version, /^\d+\.\d+\.\d+$/)
  assert.ok(Number.isInteger(resolved.protocolVersion))
})

test('the resolved default matches what the Realms API currently accepts', () => {
  // Guard against a minecraft-data bump silently changing what we announce.
  // If this fails, the pin moved — re-probe the live API before adjusting it.
  // Last verified live against the Realm on 2026-10-26 (#97): connected,
  // spawned and closed cleanly on this pair.
  const resolved = resolveVersion({})
  assert.equal(resolved.version, '1.26.51')
  assert.equal(resolved.protocolVersion, 2193)
})

test('the vendored protocol definitions match the version we announce (#47)', () => {
  // The invariant whose absence cost #47 two hours. `resolveVersion()` decides
  // what we ANNOUNCE, but BedrockX serializes with its own bundled
  // protocol.json — two independent things that must describe one version.
  // When the Realm moved to 1.26.40 they silently diverged: the announced
  // version was accepted and then every packet failed to decode.
  //
  // The patch vendors minecraft-data's protocol.json verbatim, so the two must
  // be identical. This fails here, not against a live Realm, when patches/
  // did not apply or a minecraft-data bump was not followed by regenerating it.
  const { version } = resolveVersion({})
  const vendored = require('bedrockx/src/protocol/protocol.json')
  const announced = require('minecraft-data')(`bedrock_${version}`).protocol
  assert.deepStrictEqual(
    vendored,
    announced,
    `bedrockx's protocol.json is not minecraft-data's ${version} definitions — is patches/bedrockx+1.3.4.patch ` +
      'applied (npm ci), and was it regenerated after the last minecraft-data bump? (docs/setup-and-machines.md)'
  )
})

test('the ported native protocol types are registered (#47)', () => {
  // 1.26.40's definitions use two native types the pinned fork never shipped.
  // Without them the compiler throws before a single packet is decoded, so
  // assert they are present rather than discover it on the next Realm update.
  const compiled = require('bedrockx/src/datatypes/compiler-minecraft')
  for (const name of ['maybeIncompleteArray', 'optionalOnRemaining']) {
    assert.ok(compiled.Read[name], `Read.${name} missing — patches/ not applied?`)
    assert.ok(compiled.Write[name], `Write.${name} missing — patches/ not applied?`)
    assert.ok(compiled.SizeOf[name], `SizeOf.${name} missing — patches/ not applied?`)
  }
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
