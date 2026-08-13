// Breadcrumbs for the pre-spawn NetherNet handshake.
//
// Why this exists (#47): see README → "Handshake breadcrumbs" — a failed
// connect used to collapse at least six materially different failures into
// one unhelpful log line, leaving a real outage undiagnosable from the log.
//
// The handshake this observes, in order (BedrockX source, not guesswork):
//
//   1. `client/auth.js:39` emits `session` once the franchise multiplayer
//      session token is signed.
//   2. `client.js:52-54` builds the NethernetJSONRPC signalling channel and
//      awaits its `connect()`, which resolves only when the websocket is open
//      AND the TURN credentials have arrived (`signal-jsonrpc.js:34-37` — a
//      15s race). `client.js:75` then emits `connect_allowed`.
//   3. `createClient.js:6` reacts to that by calling `connect()`, which reaches
//      `nethernet/src/client.js:115 createOffer()`. That constructs the
//      RTCPeerConnection and both data channels SYNCHRONOUSLY, then suspends at
//      `await createOffer()` before sending the ConnectRequest signal (:164).
//      So a `connect_allowed` listener registered after BedrockX's own runs
//      late enough to see `rtcConnection`, and early enough to wrap
//      `signalHandler` before the first signal goes out. Both facts matter and
//      both are load-bearing for the wiring below.
//   4. The host answers with a CONNECTRESPONSE signal, candidates are traded,
//      and `nethernet/src/client.js:136` emits `connected` when the RTC
//      connectionState reaches "connected".
//   5. Only then does BedrockX write `request_network_settings`
//      (`client.js:90`) and the packet stream begins.
//
// Everything here is observation only. Like the recorder, a fault in this
// module must never be able to drop a connection, so every callback is
// wrapped — a diagnostic that can kill the thing it diagnoses is worse than no
// diagnostic at all.
import { allPacketNames } from './protocol-packets.js'

/** The handshake milestones, in the order they must occur. */
export const CONNECT_STAGES = Object.freeze([
  'created',
  'authenticated',
  'signalling_ready',
  'offer_sent',
  'answered',
  'transport_connected',
  'receiving_packets',
])

/**
 * NetherNet signalling error codes, as carried in the data field of a
 * CONNECTERROR signal. Minecraft does not document these; the table is
 * transcribed from the `ErrorCode` constants in df-mc/go-nethernet's
 * `signal.go`, the most complete public implementation of this protocol.
 *
 * This is here because the raw wire value is unreadable — #47's root cause
 * arrived as the bare string `37`, and turning that into a name took a
 * source dive that nobody should have to repeat at 2am.
 */
export const NETHERNET_ERROR_CODES = Object.freeze({
  0: 'none',
  1: 'destination_not_logged_in',
  2: 'negotiation_timeout',
  3: 'wrong_transport_version',
  4: 'failed_to_create_peer_connection',
  5: 'ice',
  6: 'connect_request',
  7: 'connect_response',
  8: 'candidate_add',
  9: 'inactivity_timeout',
  10: 'failed_to_create_offer',
  11: 'failed_to_create_answer',
  12: 'failed_to_set_local_description',
  13: 'failed_to_set_remote_description',
  14: 'negotiation_timeout_waiting_for_response',
  15: 'negotiation_timeout_waiting_for_accept',
  16: 'incoming_connection_ignored',
  17: 'signaling_parsing_failure',
  18: 'signaling_unknown_error',
  19: 'signaling_unicast_message_delivery_failed',
  20: 'signaling_broadcast_delivery_failed',
  21: 'signaling_message_delivery_failed',
  22: 'signaling_turn_auth_failed',
  23: 'signaling_fallback_to_best_effort_delivery',
  24: 'no_signaling_channel',
  25: 'not_logged_in',
  26: 'signaling_failed_to_send',
  27: 'relay_server_configuration_result_failure',
  28: 'relay_server_configuration_parsing_error_no_urls',
  29: 'relay_server_configuration_parsing_error_no_creds',
  30: 'relay_server_configuration_parsing_error_no_servers',
  31: 'relay_server_configuration_parsing_error_no_expiration',
  32: 'data_channel_closed',
  33: 'internal_error_json_serialization',
  34: 'invalid_argument',
  35: 'generic_failure',
  37: 'identity_verification_failed',
})

/** Render a CONNECTERROR payload as `37 (identity_verification_failed)`. */
export function describeErrorCode(raw) {
  const text = String(raw ?? '').trim()
  // Guard the empty string explicitly: Number('') is 0, which would render a
  // MISSING code as the reassuring `0 (none)`. An absent code is unknown.
  const code = text === '' ? Number.NaN : Number(text)
  const name = NETHERNET_ERROR_CODES[code]
  if (!Number.isInteger(code) || !name) {
    return `${text === '' ? 'no detail' : text} (unknown code — see df-mc/go-nethernet signal.go)`
  }
  return `${code} (${name})`
}

/**
 * What it means to have got *no further* than each stage. This is the payload
 * that makes a timeout actionable: the stage names where we stopped, the help
 * text names what that implies.
 */
export const STAGE_DIAGNOSIS = Object.freeze({
  created:
    'nothing was observed at all — the client never authenticated, so suspect auth or the token cache',
  authenticated:
    'signed in, but the signalling websocket never became ready — no TURN credentials arrived within ' +
    "BedrockX's 15s window, so suspect signal.franchise.minecraft-services.net or the network path to it",
  signalling_ready:
    'signalling was ready but our WebRTC offer was never sent — suspect BedrockX/@roamhq/wrtc, not the network',
  offer_sent:
    'our offer was sent and the Realm host never answered — the host is not listening on the session we ' +
    'joined, or the signalling message never reached it',
  answered:
    'the host answered but the WebRTC transport never connected — the classic NAT / firewall / blocked-UDP ' +
    'signature (see README → "Gotchas worth knowing")',
  transport_connected:
    'the transport connected but the server sent nothing back — the handshake stalled before network_settings',
  receiving_packets:
    'packets were flowing but spawn never completed — suspect the login/resource-pack exchange, not the transport',
})

/**
 * Observe one connection attempt's handshake.
 *
 * @param {object} deps
 * @param {object} deps.log
 * @param {() => string[]} [deps.packetNames] injectable for tests
 * @returns {{ attach: (client: object) => void, detach: () => void, stage: string, describe: () => string }}
 */
export function createConnectProbe({ log, packetNames = allPacketNames }) {
  let stageIndex = 0
  let client = null
  let rtc = null
  let iceState = 'unknown'
  let gatheringState = 'unknown'
  let firstPacket = null
  let connectError = null
  const counts = { candidatesOut: 0, candidatesIn: 0 }
  /** name → listener, so every one of them can be removed on the first packet. */
  const packetListeners = new Map()

  const mark = (stage) => {
    const next = CONNECT_STAGES.indexOf(stage)
    if (next > stageIndex) stageIndex = next
  }

  // A probe defect must never reach the connection. Same rule the recorder
  // wiring follows in src/connect.js.
  const guard =
    (event, fn) =>
    (...args) => {
      try {
        return fn(...args)
      } catch (err) {
        log.warn(`probe.${event}.failed`, String(err?.message ?? err))
      }
    }

  function observeOutboundSignal(signal) {
    if (signal?.type === 'CONNECTREQUEST') {
      mark('offer_sent')
      log.info('rtc.offer_sent', 'WebRTC offer sent to the Realm host')
      return
    }
    if (signal?.type === 'CANDIDATEADD') {
      counts.candidatesOut += 1
      // Only the first is worth a line; the rest are a count. Zero of these is
      // itself the finding — it means no usable local network path was found.
      if (counts.candidatesOut === 1) log.info('rtc.candidate_out', 'first local ICE candidate gathered')
    }
  }

  function observeInboundSignal(signal) {
    switch (signal?.type) {
      case 'CONNECTRESPONSE':
        mark('answered')
        log.info('rtc.answered', 'the Realm host answered our offer')
        break
      case 'CANDIDATEADD':
        counts.candidatesIn += 1
        if (counts.candidatesIn === 1) log.info('rtc.candidate_in', 'first remote ICE candidate received')
        break
      case 'CONNECTERROR':
        connectError = describeErrorCode(signal?.data)
        log.warn('rtc.connect_error', `the Realm host rejected our offer: ${connectError}`)
        break
      default:
        break
    }
  }

  /**
   * Wire the NetherNet internals. Reachable only from `connect_allowed` — see
   * the header note on why that moment is both late enough and early enough.
   */
  function attachTransport() {
    const nethernet = client?.connection?.nethernet
    if (!nethernet) {
      log.warn(
        'probe.unavailable',
        'client.connection.nethernet is missing — the pinned BedrockX shape changed, ' +
          'so handshake breadcrumbs are unavailable for this attempt (update src/probe.js)'
      )
      return
    }

    // Outbound signals: wrap rather than replace. BedrockX assigns this at
    // client.js:57, before connect_allowed, so `inner` is always the real
    // writer by the time we get here.
    const inner = nethernet.signalHandler
    if (typeof inner === 'function') {
      nethernet.signalHandler = (signal) => {
        guard('signal_out', observeOutboundSignal)(signal)
        return inner(signal)
      }
    }

    // Inbound signals: the signalling channel is a plain EventEmitter and
    // BedrockX's own 'signal' listener (client.js:59) is unaffected by ours.
    const signalling = client?.nethernet?.signalling
    signalling?.on?.('signal', guard('signal_in', observeInboundSignal))

    nethernet.on?.(
      'connected',
      guard('connected', () => {
        mark('transport_connected')
        log.info('rtc.connected', 'WebRTC transport connected — waiting for the server to speak first')
      })
    )
    nethernet.on?.(
      'disconnect',
      guard('disconnect', (_id, reason) => log.warn('rtc.disconnect', String(reason ?? 'unknown')))
    )

    // ICE/signalling state. BedrockX owns `onicecandidate` and
    // `onconnectionstatechange` (nethernet/src/client.js:123,131) — these three
    // are untouched by it, so assigning them clobbers nothing.
    const conn = nethernet.rtcConnection ?? null
    rtc = conn
    if (!conn) {
      log.warn('probe.unavailable', 'rtcConnection not yet created at connect_allowed — ICE states unavailable')
      return
    }
    // Captured, not read off the mutable `rtc`: closing the client fires one
    // last state change AFTER detach(), and reading a nulled reference there
    // logged a spurious probe failure on every single attempt.
    conn.oniceconnectionstatechange = guard('ice_state', () => {
      iceState = conn.iceConnectionState
      log.info('rtc.ice', iceState)
    })
    conn.onicegatheringstatechange = guard('ice_gathering', () => {
      gatheringState = conn.iceGatheringState
      log.info('rtc.ice_gathering', gatheringState)
    })
  }

  /**
   * The first inbound packet of ANY kind. BedrockX has no generic `packet`
   * event (client.js:207 emits by raw name), so this is one listener per name —
   * all of them removed the moment the first packet lands, which is why the
   * steady-state cost of this probe on a 450k-packet session is zero.
   */
  function attachFirstPacket() {
    let names
    try {
      names = packetNames()
    } catch (err) {
      log.warn('probe.unavailable', `packet name table unreadable: ${String(err?.message ?? err)}`)
      return
    }
    for (const name of names) {
      const handler = guard('first_packet', () => {
        firstPacket = name
        mark('receiving_packets')
        log.info('packets.first', `first inbound packet: ${name}`)
        // Self-removing: the question this answers ("did anything arrive at
        // all?") is answered forever by the first packet.
        detachPacketListeners()
      })
      packetListeners.set(name, handler)
      client.on(name, handler)
    }
  }

  function detachPacketListeners() {
    for (const [name, handler] of packetListeners) client?.off?.(name, handler)
    packetListeners.clear()
  }

  return {
    /** Wire every observation point onto a freshly-created client. */
    attach(target) {
      client = target
      client.on('session', guard('session', () => mark('authenticated')))
      client.on(
        'connect_allowed',
        guard('connect_allowed', () => {
          mark('signalling_ready')
          log.info('signalling.ready', 'signalling websocket open and TURN credentials received')
          attachTransport()
        })
      )
      attachFirstPacket()
    },

    detach() {
      detachPacketListeners()
      // Unhook rather than drop the reference — the peer connection outlives
      // this call by one close-triggered state change.
      if (rtc) {
        rtc.oniceconnectionstatechange = null
        rtc.onicegatheringstatechange = null
      }
      rtc = null
    },

    /** The furthest milestone reached, as a `CONNECT_STAGES` name. */
    get stage() {
      return CONNECT_STAGES[stageIndex]
    },

    /**
     * A one-line, self-explaining account of where the handshake stopped —
     * the payload that makes a `connect_timeout` diagnosable from the log alone.
     */
    describe() {
      const stage = CONNECT_STAGES[stageIndex]
      const facts = [
        `ice=${iceState}`,
        `gathering=${gatheringState}`,
        `candidates=${counts.candidatesOut}out/${counts.candidatesIn}in`,
        `first_packet=${firstPacket ?? 'none'}`,
      ]
      // An explicit rejection outranks the stage guess: if the host told us
      // WHY, say that instead of inferring from where we stopped.
      if (connectError) return `rejected by the host: ${connectError} [${facts.join(' ')}]`
      return `reached ${stage} [${facts.join(' ')}] — ${STAGE_DIAGNOSIS[stage]}`
    },
  }
}
