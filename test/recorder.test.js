import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRecorder } from '../src/recorder.js'

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-bot-recorder-'))
  return path.join(dir, 'trace.jsonl')
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
  // The recorder's own pattern is /token|xuid|xbox|network[_-]?id|session[_-]?id|invite|secret|credential|authoriz/i.
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
    network_id: 'SECRET_NETWORK_ID_SNAKE_VALUE',
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
      'SECRET_NETWORK_ID_SNAKE_VALUE',
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

test('creates missing parent directories', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-bot-recorder-'))
  const filePath = path.join(dir, 'nested', 'deeper', 'trace.jsonl')
  const recorder = createRecorder({ filePath })
  recorder.recordInbound('a', { n: 1 })
  await recorder.close()
  assert.ok(fs.existsSync(filePath))
})
