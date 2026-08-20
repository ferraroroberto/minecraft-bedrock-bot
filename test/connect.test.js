import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { runSession, buildClientOptions, resolveRealm, ClassifiedError } from '../src/connect.js'
import { createRegionWatcher } from '../src/region.js'

const silentLog = { info: () => {}, warn: () => {}, error: () => {} }

/** A logger that keeps its lines, for asserting on what an incident log will say. */
function recordingLog() {
  const lines = []
  const record = (level) => (event, detail) => lines.push(`${level} ${event}${detail ? ` — ${detail}` : ''}`)
  return { lines, info: record('INFO'), warn: record('WARN'), error: record('ERROR') }
}

/** Stand-in for a bedrockx Client, recording how often close() is called. */
class FakeClient extends EventEmitter {
  constructor() {
    super()
    this.closeCalls = 0
    this.written = []
  }

  close() {
    this.closeCalls += 1
    // Mirrors the real library: a second close() on the NetherNet path throws
    // because client.js:156 nulls `this.nethernet` that :155 still reads.
    if (this.closeCalls > 1) throw new TypeError("Cannot read properties of null (reading 'signalling')")
  }

  write(name, params) {
    this.written.push({ name, params })
  }
}

// runSession awaits two API calls before it attaches any handler, so a test
// that emits too early settles nothing and hangs. `ready` resolves the moment
// the client is created ??? handlers attach synchronously right after.
function fakeDeps(client, { region = null, log = silentLog } = {}) {
  let markReady
  const ready = new Promise((resolve) => { markReady = resolve })
  return {
    ready,
    api: {
      getRealms: async () => [{ id: 1, name: 'test realm' }],
      rest: {
        get: async () => ({
          networkProtocol: 'NETHERNET_JSONRPC',
          address: 'guid-here',
          ...(region ? { sessionRegionData: { regionName: region } } : {}),
        }),
      },
    },
    createClient: () => { markReady(); return client },
    authflow: {},
    username: 'Gizmo6082',
    profilesFolder: '/tmp/x',
    version: { version: '1.26.30', protocolVersion: 1001 },
    log,
    context: {},
  }
}

/** Drive a client through a successful spawn. */
function spawn(client) {
  client.emit('start_game', { runtime_entity_id: 7, player_position: { x: 1, y: 2, z: 3 } })
  client.emit('play_status', { status: 'player_spawn' })
}

test('a kick followed by the library close settles ONCE and never double-closes', async () => {
  // The real library emits `kick` and then calls close() itself, so one
  // disconnect arrives as two events. Reconnecting twice would be a bug, and
  // closing twice would throw a TypeError inside the library.
  const client = new FakeClient()
  const deps = fakeDeps(client)
  const session = runSession(deps)
  await deps.ready
  spawn(client)

  client.emit('kick', { reason: 'server_id_conflict', message: 'kicked' })
  client.emit('close', undefined) // what the library does immediately after

  const result = await session
  assert.equal(result.endedBy, 'kick')
  assert.equal(result.reason, 'server_id_conflict')
  assert.equal(result.connected, true)
  assert.equal(client.closeCalls, 0, 'library already closed — we must not close again')
})

test('a kick names the reason as well as the code (#42)', async () => {
  // The live incident logged `kicked — 140` and nothing else, which made the
  // end of a stable 3m10s session impossible to explain afterwards.
  const client = new FakeClient()
  const log = recordingLog()
  const deps = fakeDeps(client, { log })
  const session = runSession(deps)
  await deps.ready
  spawn(client)
  client.emit('kick', { reason: 140 })
  client.emit('close', undefined)

  const result = await session
  assert.equal(result.endedBy, 'kick')
  assert.equal(result.reason, 140, 'the raw reason still reaches the supervisor untouched')
  assert.ok(
    log.lines.some((line) => line === 'WARN kicked — host_disconnected (140)'),
    `expected the named kick reason, got: ${log.lines.join(' | ')}`
  )
})

test('a kick with a code the pinned protocol does not know still logs the code', async () => {
  const client = new FakeClient()
  const log = recordingLog()
  const deps = fakeDeps(client, { log })
  const session = runSession(deps)
  await deps.ready
  spawn(client)
  client.emit('kick', { reason: 99999, message: 'from the future' })
  client.emit('close', undefined)

  await session
  assert.ok(
    log.lines.some((line) => line === 'WARN kicked — 99999 — from the future'),
    `expected a graceful fallback to the bare code, got: ${log.lines.join(' | ')}`
  )
})

test('a region change between attempts gets its own warn naming both regions (#42)', async () => {
  // Every attempt already logged its region; nothing compared one attempt with
  // the previous, so three ~60s failures into a flipped region went unremarked.
  const regionWatcher = createRegionWatcher()

  const first = new FakeClient()
  const firstLog = recordingLog()
  const firstDeps = fakeDeps(first, { region: 'NorthEurope', log: firstLog })
  const firstSession = runSession({ ...firstDeps, regionWatcher })
  await firstDeps.ready
  first.emit('close', 'kicked')
  await firstSession
  assert.ok(
    !firstLog.lines.some((line) => line.includes('realm.region_changed')),
    'the first resolve has nothing to compare against'
  )

  const second = new FakeClient()
  const secondLog = recordingLog()
  const secondDeps = fakeDeps(second, { region: 'UAENorth', log: secondLog })
  const secondSession = runSession({ ...secondDeps, regionWatcher })
  await secondDeps.ready
  second.emit('close', 'gone')
  await secondSession

  const changed = secondLog.lines.find((line) => line.includes('realm.region_changed'))
  assert.ok(changed, `expected a region-change warning, got: ${secondLog.lines.join(' | ')}`)
  assert.match(changed, /^WARN /)
  assert.match(changed, /NorthEurope/)
  assert.match(changed, /UAENorth/)
})

test('a bare close (no kick) settles once', async () => {
  const client = new FakeClient()
  const deps = fakeDeps(client)
  const session = runSession(deps)
  await deps.ready
  spawn(client)
  client.emit('close', 'connection lost')
  client.emit('close', 'again') // duplicate emissions must not matter
  const result = await session
  assert.equal(result.endedBy, 'close')
  assert.equal(result.reason, 'connection lost')
  assert.equal(client.closeCalls, 0)
})

test('an error DOES close the client, because the library does not', async () => {
  // client.js:163 only emits — the connection is left half-dead otherwise.
  const client = new FakeClient()
  const deps = fakeDeps(client)
  const session = runSession(deps)
  await deps.ready
  spawn(client)
  client.emit('error', new Error('deserialize failed'))
  const result = await session
  assert.equal(result.endedBy, 'error')
  assert.equal(client.closeCalls, 1, 'we must close it ourselves — exactly once')
})

test('spawning sends set_local_player_as_initialized and the greeting', async () => {
  // Without the initialize packet the server drops us within seconds.
  const client = new FakeClient()
  const deps = fakeDeps(client)
  const session = runSession(deps)
  await deps.ready
  spawn(client)
  client.emit('close')
  await session
  assert.ok(client.written.some((w) => w.name === 'set_local_player_as_initialized'))
  const chat = client.written.find((w) => w.name === 'text')
  // 'message_only' serializes fine but makes the server drop us ~16s later.
  assert.equal(chat.params.category, 'authored')
})

test('a stop signal ends a CONNECTED session immediately', async () => {
  // Otherwise Ctrl-C on a healthy bot waits for a disconnect that never comes.
  const client = new FakeClient()
  const listeners = new Set()
  const stopSignal = { stopped: false, onStop: (cb) => (listeners.add(cb), () => listeners.delete(cb)) }
  const deps = fakeDeps(client)
  const session = runSession({ ...deps, stopSignal })
  await deps.ready
  spawn(client)
  for (const cb of listeners) cb()
  const result = await session
  assert.equal(result.endedBy, 'shutdown')
  assert.equal(client.closeCalls, 1)
})

test('a connect that never spawns times out instead of hanging forever', async () => {
  const client = new FakeClient()
  const session = runSession({ ...fakeDeps(client), connectTimeoutMs: 10 })
  const result = await session
  assert.equal(result.endedBy, 'connect_timeout')
  assert.equal(result.connected, false)
  assert.equal(result.uptimeMs, 0)
})

test('a connect timeout names the handshake stage it stopped at (#47)', async () => {
  // The bug this guards: one undifferentiated `no spawn within Nms` covered
  // six distinct failures, so a real outage could not be diagnosed from the
  // log at all. The reason string must carry the probe's account.
  const client = new FakeClient()
  const deps = fakeDeps(client)
  const session = runSession({ ...deps, connectTimeoutMs: 10 })
  await deps.ready
  client.emit('session')

  const result = await session
  assert.equal(result.endedBy, 'connect_timeout')
  assert.match(result.reason, /no spawn within 10ms/)
  assert.match(result.reason, /reached authenticated/)
  assert.match(result.reason, /signalling websocket never became ready/)
})

test('runSession attaches a real probe by default, without opt-in', async () => {
  // Always-on is the point: the next unattended failure must be diagnosable
  // without anyone having remembered to enable anything.
  const client = new FakeClient()
  const deps = fakeDeps(client)
  const session = runSession({ ...deps, connectTimeoutMs: 10 })
  await deps.ready
  const result = await session
  assert.match(result.reason, /reached created/)
})

test('an empty realm list is a clear, non-retryable error', async () => {
  const err = await resolveRealm({ api: { getRealms: async () => [] } }).catch((e) => e)
  assert.ok(err instanceof ClassifiedError)
  assert.equal(err.classification.retryable, false)
  assert.match(err.message, /invite/)
})

test('an unknown REALM_ID lists what was actually found', async () => {
  const api = { getRealms: async () => [{ id: 5, name: 'casa' }] }
  const err = await resolveRealm({ api, realmId: '999' }).catch((e) => e)
  assert.equal(err.classification.kind, 'realm_not_found')
  assert.match(err.message, /casa=5/)
})

test('the resolved session carries the accumulated world state (#13)', async () => {
  const client = new FakeClient()
  const deps = fakeDeps(client)
  const session = runSession(deps)
  await deps.ready
  spawn(client)
  client.emit('close', 'done')
  const result = await session
  assert.equal(result.world.self.runtimeEntityId, 7)
  assert.deepEqual(result.world.self.position, { x: 1, y: 2, z: 3 })
})

test('an injected recorder observes packets without affecting the connection, and a recorder failure cannot drop the session', async () => {
  const client = new FakeClient()
  const calls = []
  const recorder = {
    recordInbound: (name, packet) => {
      calls.push(['in', name, packet])
      if (name === 'play_status') throw new Error('disk full') // must not propagate
    },
    recordOutbound: (name, packet) => calls.push(['out', name, packet]),
  }
  const deps = fakeDeps(client)
  const session = runSession({ ...deps, recorder })
  await deps.ready
  spawn(client)
  client.emit('close', 'done')
  const result = await session

  assert.equal(result.endedBy, 'close', 'a throwing recorder must not break the connection path')
  assert.ok(calls.some(([dir, name]) => dir === 'in' && name === 'start_game'))
  assert.ok(calls.some(([dir, name, packet]) => dir === 'out' && name === 'text' && packet.category === 'authored'))
})

test('another player typing the stop command triggers shutdown (#14 kill-switch)', async () => {
  const client = new FakeClient()
  const deps = fakeDeps(client)
  const session = runSession(deps)
  await deps.ready
  spawn(client)
  client.emit('text', { source_name: 'Roberto39764§r', message: 'bot stop' })
  const result = await session
  assert.equal(result.endedBy, 'shutdown')
  assert.equal(result.reason, 'stop command received via chat')
  assert.equal(client.closeCalls, 1)
})

test('ordinary chat that merely contains "stop" does not trigger the kill-switch', async () => {
  const client = new FakeClient()
  const deps = fakeDeps(client)
  const session = runSession(deps)
  await deps.ready
  spawn(client)
  client.emit('text', { source_name: 'Roberto39764§r', message: 'please stop mining that' })
  client.emit('close', 'unrelated disconnect')
  const result = await session
  assert.equal(result.endedBy, 'close')
  assert.equal(result.reason, 'unrelated disconnect')
})

test('NetherNet options carry networkId, legacy options split host:port', () => {
  const base = { authflow: {}, username: 'u', profilesFolder: '/p', version: { version: '1.26.30', protocolVersion: 1001 } }
  const nether = buildClientOptions({ ...base, transport: 'NETHERNET_JSONRPC', join: { address: 'a-guid' } })
  assert.equal(nether.networkId, 'a-guid')
  assert.equal(nether.host, undefined)

  // The bug that made bedrock-protocol unusable: splitting a GUID gives a NaN port.
  const legacy = buildClientOptions({ ...base, transport: 'DEFAULT', join: { address: '1.2.3.4:19132' } })
  assert.equal(legacy.host, '1.2.3.4')
  assert.equal(legacy.port, 19132)
})
