import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createConnectProbe, CONNECT_STAGES, STAGE_DIAGNOSIS, describeErrorCode } from '../src/probe.js'

/** Collects log lines so a breadcrumb can be asserted on, not just assumed. */
function fakeLog() {
  const lines = []
  const push = (level) => (event, detail) => lines.push(`${level} ${event}${detail ? ` — ${detail}` : ''}`)
  return { lines, info: push('INFO'), warn: push('WARN'), error: push('ERROR') }
}

/**
 * A stand-in for the BedrockX NetherNet stack, shaped like the real one at the
 * three points src/probe.js reaches into: `client.connection.nethernet` (an
 * EventEmitter carrying `signalHandler` and `rtcConnection`) and
 * `client.nethernet.signalling` (the signalling EventEmitter).
 */
function fakeClient({ withInternals = true } = {}) {
  const client = new EventEmitter()
  client.sentSignals = []
  if (!withInternals) return client

  const nethernet = new EventEmitter()
  nethernet.signalHandler = (signal) => client.sentSignals.push(signal)
  nethernet.rtcConnection = {
    iceConnectionState: 'new',
    iceGatheringState: 'new',
    oniceconnectionstatechange: null,
    onicegatheringstatechange: null,
  }
  client.connection = { nethernet }
  client.nethernet = { signalling: new EventEmitter() }
  return client
}

/** Drive the client to the point where the probe has wired the transport. */
function reachSignallingReady(client) {
  client.emit('session')
  client.emit('connect_allowed')
}

const names = () => ['network_settings', 'start_game', 'play_status']

test('a client that never authenticates reports the "created" stage', () => {
  const probe = createConnectProbe({ log: fakeLog(), packetNames: names })
  probe.attach(fakeClient())

  assert.equal(probe.stage, 'created')
  assert.match(probe.describe(), /reached created/)
  assert.match(probe.describe(), /never authenticated/)
})

test('each handshake milestone advances the stage exactly one step', () => {
  const log = fakeLog()
  const client = fakeClient()
  const probe = createConnectProbe({ log, packetNames: names })
  probe.attach(client)

  client.emit('session')
  assert.equal(probe.stage, 'authenticated')

  client.emit('connect_allowed')
  assert.equal(probe.stage, 'signalling_ready')

  client.connection.nethernet.signalHandler({ type: 'CONNECTREQUEST' })
  assert.equal(probe.stage, 'offer_sent')

  client.nethernet.signalling.emit('signal', { type: 'CONNECTRESPONSE' })
  assert.equal(probe.stage, 'answered')

  client.connection.nethernet.emit('connected')
  assert.equal(probe.stage, 'transport_connected')

  client.emit('network_settings', {})
  assert.equal(probe.stage, 'receiving_packets')
})

test('the stage never moves backwards', () => {
  const client = fakeClient()
  const probe = createConnectProbe({ log: fakeLog(), packetNames: names })
  probe.attach(client)

  client.emit('connect_allowed')
  client.connection.nethernet.emit('connected')
  assert.equal(probe.stage, 'transport_connected')

  // A late `session` must not rewind the furthest-reached milestone.
  client.emit('session')
  assert.equal(probe.stage, 'transport_connected')
})

test('every stage has a distinct diagnosis — the whole point of the ladder', () => {
  const diagnoses = CONNECT_STAGES.map((stage) => STAGE_DIAGNOSIS[stage])
  for (const [i, stage] of CONNECT_STAGES.entries()) {
    assert.equal(typeof diagnoses[i], 'string', `${stage} has no diagnosis text`)
    assert.ok(diagnoses[i].length > 20, `${stage}'s diagnosis is too thin to act on`)
  }
  assert.equal(new Set(diagnoses).size, CONNECT_STAGES.length, 'two stages share a diagnosis')
})

test('"offer sent, never answered" and "answered, never connected" describe differently', () => {
  // This is the #47 discriminator: both used to print the identical
  // `connect_timeout (no spawn within 60000ms)`.
  const unanswered = createConnectProbe({ log: fakeLog(), packetNames: names })
  const clientA = fakeClient()
  unanswered.attach(clientA)
  reachSignallingReady(clientA)
  clientA.connection.nethernet.signalHandler({ type: 'CONNECTREQUEST' })

  const stalledIce = createConnectProbe({ log: fakeLog(), packetNames: names })
  const clientB = fakeClient()
  stalledIce.attach(clientB)
  reachSignallingReady(clientB)
  clientB.connection.nethernet.signalHandler({ type: 'CONNECTREQUEST' })
  clientB.nethernet.signalling.emit('signal', { type: 'CONNECTRESPONSE' })

  assert.notEqual(unanswered.describe(), stalledIce.describe())
  assert.match(unanswered.describe(), /never answered/)
  assert.match(stalledIce.describe(), /NAT \/ firewall \/ blocked-UDP/)
})

test('wrapping signalHandler observes signals without swallowing them', () => {
  const client = fakeClient()
  const probe = createConnectProbe({ log: fakeLog(), packetNames: names })
  probe.attach(client)
  reachSignallingReady(client)

  const offer = { type: 'CONNECTREQUEST' }
  const candidate = { type: 'CANDIDATEADD', data: 'candidate:1 1 udp' }
  client.connection.nethernet.signalHandler(offer)
  client.connection.nethernet.signalHandler(candidate)

  // The real writer still receives everything — a probe that ate the offer
  // would silently prevent every connection.
  assert.deepEqual(client.sentSignals, [offer, candidate])
  assert.match(probe.describe(), /candidates=1out\/0in/)
})

test('candidate counts distinguish "no local path" from "host never replied"', () => {
  const client = fakeClient()
  const probe = createConnectProbe({ log: fakeLog(), packetNames: names })
  probe.attach(client)
  reachSignallingReady(client)

  client.connection.nethernet.signalHandler({ type: 'CANDIDATEADD' })
  client.connection.nethernet.signalHandler({ type: 'CANDIDATEADD' })
  client.nethernet.signalling.emit('signal', { type: 'CANDIDATEADD' })

  assert.match(probe.describe(), /candidates=2out\/1in/)
})

test('the first inbound packet is named, and its listeners then detach', () => {
  const log = fakeLog()
  const client = fakeClient()
  const probe = createConnectProbe({ log, packetNames: names })
  probe.attach(client)

  assert.equal(client.listenerCount('network_settings'), 1)
  assert.equal(client.listenerCount('start_game'), 1)

  client.emit('network_settings', {})

  assert.match(probe.describe(), /first_packet=network_settings/)
  assert.ok(log.lines.some((l) => l.includes('packets.first') && l.includes('network_settings')))
  // Every per-name listener is gone, so a 450k-packet session pays nothing.
  for (const name of names()) assert.equal(client.listenerCount(name), 0, `${name} listener leaked`)
})

test('a later packet does not overwrite the recorded first one', () => {
  const client = fakeClient()
  const probe = createConnectProbe({ log: fakeLog(), packetNames: names })
  probe.attach(client)

  client.emit('network_settings', {})
  client.emit('start_game', {})

  assert.match(probe.describe(), /first_packet=network_settings/)
})

test('ICE state transitions are recorded and reported', () => {
  const log = fakeLog()
  const client = fakeClient()
  const probe = createConnectProbe({ log, packetNames: names })
  probe.attach(client)
  reachSignallingReady(client)

  const rtc = client.connection.nethernet.rtcConnection
  rtc.iceConnectionState = 'checking'
  rtc.oniceconnectionstatechange()
  rtc.iceGatheringState = 'complete'
  rtc.onicegatheringstatechange()

  assert.match(probe.describe(), /ice=checking/)
  assert.match(probe.describe(), /gathering=complete/)
  assert.ok(log.lines.some((l) => l.includes('rtc.ice — checking')))
})

test('a CONNECTERROR from the host is surfaced as a warning, decoded', () => {
  const log = fakeLog()
  const client = fakeClient()
  const probe = createConnectProbe({ log, packetNames: names })
  probe.attach(client)
  reachSignallingReady(client)

  client.nethernet.signalling.emit('signal', { type: 'CONNECTERROR', data: '37' })

  assert.ok(
    log.lines.some((l) => l.startsWith('WARN rtc.connect_error') && l.includes('identity_verification_failed')),
    'the raw code must be decoded in the log line, not left as a bare number'
  )
})

test('an explicit host rejection outranks the stage inference in describe()', () => {
  // #47 in one assertion: the stage ladder would have said "the host never
  // answered", which is wrong — it answered, with a refusal.
  const client = fakeClient()
  const probe = createConnectProbe({ log: fakeLog(), packetNames: names })
  probe.attach(client)
  reachSignallingReady(client)
  client.connection.nethernet.signalHandler({ type: 'CONNECTREQUEST' })
  client.nethernet.signalling.emit('signal', { type: 'CONNECTERROR', data: '37' })

  assert.match(probe.describe(), /rejected by the host: 37 \(identity_verification_failed\)/)
  assert.doesNotMatch(probe.describe(), /never answered/)
})

test('describeErrorCode names known codes and admits ignorance on unknown ones', () => {
  assert.equal(describeErrorCode('37'), '37 (identity_verification_failed)')
  assert.equal(describeErrorCode(0), '0 (none)')
  assert.equal(describeErrorCode(2), '2 (negotiation_timeout)')
  assert.match(describeErrorCode('999'), /unknown code/)
  assert.match(describeErrorCode(undefined), /unknown code/)
})

test('missing BedrockX internals degrade to a warning, never a throw', () => {
  const log = fakeLog()
  const client = fakeClient({ withInternals: false })
  const probe = createConnectProbe({ log, packetNames: names })
  probe.attach(client)

  // A re-pin that changes the internal shape must cost breadcrumbs, not the
  // connection (README → "Why BedrockX and not bedrock-protocol").
  assert.doesNotThrow(() => client.emit('connect_allowed'))
  assert.ok(log.lines.some((l) => l.startsWith('WARN probe.unavailable')))
  assert.equal(probe.stage, 'signalling_ready')
})

test('an unreadable packet name table degrades to a warning', () => {
  const log = fakeLog()
  const probe = createConnectProbe({
    log,
    packetNames: () => {
      throw new Error('mcpe_packet shape changed')
    },
  })

  assert.doesNotThrow(() => probe.attach(fakeClient()))
  assert.ok(log.lines.some((l) => l.includes('probe.unavailable') && l.includes('mcpe_packet shape changed')))
})

test('a throwing observer is caught and never reaches the caller', () => {
  const log = fakeLog()
  const client = fakeClient()
  const probe = createConnectProbe({ log, packetNames: names })
  probe.attach(client)
  reachSignallingReady(client)

  // A signal shaped unlike anything expected must not propagate out of the
  // wrapped signalHandler and abort the real send.
  const hostile = {
    get type() {
      throw new Error('boom')
    },
  }
  assert.doesNotThrow(() => client.connection.nethernet.signalHandler(hostile))
  assert.ok(log.lines.some((l) => l.includes('probe.signal_out.failed') && l.includes('boom')))
  assert.equal(client.sentSignals.length, 1, 'the real writer must still have been called')
})

test('detach removes the packet listeners it attached', () => {
  const client = fakeClient()
  const probe = createConnectProbe({ log: fakeLog(), packetNames: names })
  probe.attach(client)
  probe.detach()

  for (const name of names()) assert.equal(client.listenerCount(name), 0, `${name} listener leaked`)
})
