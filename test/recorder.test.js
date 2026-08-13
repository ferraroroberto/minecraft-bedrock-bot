import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRecorder, parseExcludeList, DEFAULT_EXCLUDED_PACKETS } from '../src/recorder.js'

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-bot-recorder-'))
  return path.join(dir, 'trace.jsonl')
}

/**
 * A write stream that records every `write` call, so an exclusion can be
 * asserted at the STREAM boundary rather than by reading the file back — the
 * point of the filter (#41) is that the excluded packet is never serialized or
 * handed to I/O at all, which a file-contents assertion alone cannot show.
 */
function fakeFs() {
  const writes = []
  return {
    writes,
    mkdirSync: () => {},
    createWriteStream: () => ({
      write: (chunk) => writes.push(chunk),
      end: (cb) => cb?.(),
    }),
  }
}

test('records inbound and outbound packets as readable JSONL', async () => {
  const filePath = tempFile()
  const recorder = createRecorder({ filePath, now: () => 12345 })

  recorder.recordInbound('start_game', { runtime_entity_id: 7, player_position: { x: 1, y: 64, z: 2 } })
  recorder.recordOutbound('text', { message: 'hello' })
  await recorder.close()

  const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n')
  assert.equal(lines.length, 2)

  const [first, second] = lines.map((line) => JSON.parse(line))
  assert.equal(first.direction, 'inbound')
  assert.equal(first.name, 'start_game')
  assert.equal(first.ts, 12345)
  assert.deepEqual(first.packet.player_position, { x: 1, y: 64, z: 2 })

  assert.equal(second.direction, 'outbound')
  assert.equal(second.name, 'text')
  assert.equal(second.packet.message, 'hello')
})

test('appends across multiple recorders opening the same path, rather than truncating', async () => {
  const filePath = tempFile()
  const first = createRecorder({ filePath })
  first.recordInbound('a', { n: 1 })
  await first.close()

  const second = createRecorder({ filePath })
  second.recordInbound('b', { n: 2 })
  await second.close()

  const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n')
  assert.equal(lines.length, 2)
})

test('redacts a broader set of secret-shaped fields than the three the deny-list originally named', () => {
  // The recorder's own pattern is /token|xuid|xbox|address|session[_-]?id|invite|secret|credential|authoriz/i,
  // plus a case-sensitive /[Nn]etworkId/ for the NetherNet transport id.
  // This test deliberately exercises MORE field-name shapes than that list was
  // written from, so it fails the moment the pattern (or a future rewrite of
  // it) stops catching a variant — not just the three fields #13 started from.
  const filePath = tempFile()
  const recorder = createRecorder({ filePath })

  recorder.recordInbound('player_list', {
    records: [
      {
        username: 'Roberto39764',
        xbox_user_id: 'SECRET_XBOX_USER_ID_VALUE',
        xuid: 'SECRET_XUID_VALUE',
      },
    ],
    accessToken: 'SECRET_ACCESS_TOKEN_VALUE',
    token: 'SECRET_TOKEN_VALUE',
    networkId: 'SECRET_NETWORK_ID_VALUE',
    sessionId: 'SECRET_SESSION_ID_VALUE',
    inviteCode: 'SECRET_INVITE_VALUE',
    clientSecret: 'SECRET_CLIENT_SECRET_VALUE',
    Authorization: 'SECRET_AUTHORIZATION_VALUE',
    // ordinary gameplay data, which must survive unredacted
    position: { x: 1, y: 64, z: 2 },
    health: 18,
  })

  return recorder.close().then(() => {
    const raw = fs.readFileSync(filePath, 'utf8')
    const secretValues = [
      'SECRET_XBOX_USER_ID_VALUE',
      'SECRET_XUID_VALUE',
      'SECRET_ACCESS_TOKEN_VALUE',
      'SECRET_TOKEN_VALUE',
      'SECRET_NETWORK_ID_VALUE',
      'SECRET_SESSION_ID_VALUE',
      'SECRET_INVITE_VALUE',
      'SECRET_CLIENT_SECRET_VALUE',
      'SECRET_AUTHORIZATION_VALUE',
    ]
    for (const secret of secretValues) {
      assert.ok(!raw.includes(secret), `${secret} must not appear in the trace file, but it did`)
    }
    // Not over-redacting: ordinary gameplay fields must still be readable.
    assert.ok(raw.includes('"x":1'))
    assert.ok(raw.includes('"health":18'))
    assert.ok(raw.includes('Roberto39764'))
  })
})

test('redacts key/cert/signature/hash/bearer-shaped fields — outside the vocabulary the pattern was originally written from', () => {
  // #14 widened SENSITIVE_KEY_PATTERN with key/cert/signature/hash/bearer
  // roots after finding that BedrockX's own auth flow sends a `publicKey`
  // field (client/auth.js:8) — i.e. this client's ECDH handshake already
  // carries key/certificate-shaped fields the original pattern missed. These
  // field names are deliberately NOT in the original three-word deny-list.
  const filePath = tempFile()
  const recorder = createRecorder({ filePath })

  recorder.recordInbound('handshake', {
    apiKey: 'SECRET_API_KEY_VALUE',
    privateKey: 'SECRET_PRIVATE_KEY_VALUE',
    certificate: 'SECRET_CERTIFICATE_VALUE',
    userHash: 'SECRET_USER_HASH_VALUE',
    signature: 'SECRET_SIGNATURE_VALUE',
    bearerToken: 'SECRET_BEARER_VALUE',
    // ordinary gameplay data, which must survive unredacted
    position: { x: 1, y: 64, z: 2 },
    health: 18,
  })

  return recorder.close().then(() => {
    const raw = fs.readFileSync(filePath, 'utf8')
    const secretValues = [
      'SECRET_API_KEY_VALUE',
      'SECRET_PRIVATE_KEY_VALUE',
      'SECRET_CERTIFICATE_VALUE',
      'SECRET_USER_HASH_VALUE',
      'SECRET_SIGNATURE_VALUE',
      'SECRET_BEARER_VALUE',
    ]
    for (const secret of secretValues) {
      assert.ok(!raw.includes(secret), `${secret} must not appear in the trace file, but it did`)
    }
    assert.ok(raw.includes('"x":1'))
    assert.ok(raw.includes('"health":18'))
  })
})

test("#34: an inventory item's snake_case network_id survives — it is the item TYPE id, not NetherNet's", async () => {
  // The whole point of the trace is to become an inventory fixture corpus
  // (README → "World state + packet recorder"). src/observation.js's
  // describeInventory and src/goals.js's itemCountAtLeast both key off
  // `item.network_id`, so redacting it makes every recorded trace useless for
  // the job it was captured to do.
  const filePath = tempFile()
  const recorder = createRecorder({ filePath })

  recorder.recordInbound('inventory_content', {
    window_id: 'inventory',
    input: [{ network_id: 5, count: 3 }, { network_id: 0 }],
    // ...while the NetherNet transport id, camelCase, must still go.
    networkId: 'SECRET_NETHERNET_ID_VALUE',
  })
  await recorder.close()

  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8').trim())
  assert.deepEqual(parsed.packet.input, [{ network_id: 5, count: 3 }, { network_id: 0 }])
  assert.equal(parsed.packet.networkId, '[REDACTED]')
})

test('#23: records a packet carrying a bigint field (varint64 decodes to BigInt) instead of throwing', async () => {
  const filePath = tempFile()
  const recorder = createRecorder({ filePath })

  recorder.recordInbound('start_game', { runtime_entity_id: 7n, player_position: { x: 1, y: 64, z: 2 } })
  await recorder.close()

  const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n')
  assert.equal(lines.length, 1, 'the packet must actually be written, not silently dropped')
  const parsed = JSON.parse(lines[0])
  assert.equal(parsed.packet.runtime_entity_id, '7', 'the bigint is stringified rather than crashing JSON.stringify')
})

test('#41: an excluded packet never reaches the write stream, in BOTH directions', async () => {
  const fsImpl = fakeFs()
  const recorder = createRecorder({ filePath: '/trace.jsonl', exclude: ['move_entity_delta'], fsImpl })

  recorder.recordInbound('move_entity_delta', { runtime_entity_id: 7 })
  recorder.recordOutbound('move_entity_delta', { runtime_entity_id: 7 })
  recorder.recordInbound('update_block', { position: { x: 1, y: 2, z: 3 } })
  recorder.recordOutbound('text', { message: 'hello' })
  await recorder.close()

  assert.equal(fsImpl.writes.length, 2, 'only the two non-excluded packets are written')
  const written = fsImpl.writes.map((line) => JSON.parse(line))
  assert.deepEqual(
    written.map((entry) => [entry.direction, entry.name]),
    [
      ['inbound', 'update_block'],
      ['outbound', 'text'],
    ]
  )
  for (const chunk of fsImpl.writes) {
    assert.ok(!chunk.includes('move_entity_delta'), 'the excluded name must not appear in any written chunk')
  }
})

test('#41: the default exclude set drops the three high-frequency entity packets and nothing else', async () => {
  const fsImpl = fakeFs()
  const recorder = createRecorder({ filePath: '/trace.jsonl', fsImpl })

  assert.deepEqual(recorder.excluded, ['set_entity_data', 'move_entity_delta', 'set_entity_motion'])

  // The three that were 91.2% of the first live capture's bytes...
  for (const name of DEFAULT_EXCLUDED_PACKETS) {
    recorder.recordInbound(name, { runtime_entity_id: 7 })
    recorder.recordOutbound(name, { runtime_entity_id: 7 })
  }
  // ...against the signal packets the fixture corpus exists for, which must
  // ALL survive the default filter.
  for (const name of ['level_chunk', 'add_entity', 'update_block', 'update_subchunk_blocks', 'add_item_entity', 'level_event', 'mob_equipment', 'inventory_content']) {
    recorder.recordInbound(name, { n: 1 })
  }
  await recorder.close()

  assert.deepEqual(
    fsImpl.writes.map((line) => JSON.parse(line).name),
    ['level_chunk', 'add_entity', 'update_block', 'update_subchunk_blocks', 'add_item_entity', 'level_event', 'mob_equipment', 'inventory_content']
  )
})

test('#41: an empty exclude list records everything, including the default-excluded packets', async () => {
  const fsImpl = fakeFs()
  const recorder = createRecorder({ filePath: '/trace.jsonl', exclude: [], fsImpl })

  recorder.recordInbound('set_entity_data', { runtime_entity_id: 7 })
  await recorder.close()

  assert.equal(fsImpl.writes.length, 1)
  assert.deepEqual(recorder.excluded, [])
})

test('#41: RECORD_PACKETS_EXCLUDE — unset or blank means the DEFAULT set, not "record everything"', () => {
  // Copying .env.example (which ships the key blank) must not silently re-arm
  // the 2.4 GB-per-20-minutes behaviour the filter exists to stop.
  assert.deepEqual(parseExcludeList(undefined), [...DEFAULT_EXCLUDED_PACKETS])
  assert.deepEqual(parseExcludeList(null), [...DEFAULT_EXCLUDED_PACKETS])
  assert.deepEqual(parseExcludeList(''), [...DEFAULT_EXCLUDED_PACKETS])
  assert.deepEqual(parseExcludeList('   '), [...DEFAULT_EXCLUDED_PACKETS])
})

test('#41: RECORD_PACKETS_EXCLUDE=none is the explicit opt-out; any list replaces the default outright', () => {
  assert.deepEqual(parseExcludeList('none'), [])
  assert.deepEqual(parseExcludeList('  NONE  '), [])

  assert.deepEqual(parseExcludeList('move_entity_delta'), ['move_entity_delta'])
  // Tolerant of the spacing and stray commas a hand-edited .env picks up.
  assert.deepEqual(parseExcludeList(' set_entity_data , Move_Entity_Delta ,, '), ['set_entity_data', 'move_entity_delta'])
})

test('creates missing parent directories', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-bot-recorder-'))
  const filePath = path.join(dir, 'nested', 'deeper', 'trace.jsonl')
  const recorder = createRecorder({ filePath })
  recorder.recordInbound('a', { n: 1 })
  await recorder.close()
  assert.ok(fs.existsSync(filePath))
})
