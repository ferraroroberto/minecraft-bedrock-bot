// One connection attempt, start to finish.
//
// The spike did this with top-level `await`, which is unreconnectable by
// construction — hence this function. It resolves when the session ENDS, not
// when it connects, so the supervisor can simply loop on it.
//
// Three BedrockX behaviours this is built around, all verified in source
// (node_modules/bedrockx/src/client.js) rather than assumed:
//
//   1. On a kick the library emits `kick` and then calls `close()` ITSELF
//      (client.js:189-190). So one disconnect surfaces as TWO events, and we
//      must reconnect exactly once.
//   2. `close()` calls `removeAllListeners()` (client.js:152) and then nulls
//      `this.nethernet` (:156) — while :155 still reads `this.nethernet.signalling`.
//      A SECOND close() therefore throws a TypeError. We must never close a
//      client the library has already closed.
//   3. `error` does NOT close the connection (client.js:163 only emits). An
//      error alone leaves a half-dead client, so we close it ourselves — once.
import { classifyRealmsError } from './errors.js'
import { stripFormatting } from './formatting.js'
import { createWorldState, reduce, WORLD_PACKET_NAMES } from './world.js'
import { allPacketNames } from './protocol-packets.js'
import { buildChatPacket } from './actions.js'
import { isStopCommand } from './safety.js'
import { createConnectProbe } from './probe.js'

/** How long to wait for `play_status: player_spawn` before giving up on an attempt. */
export const DEFAULT_CONNECT_TIMEOUT_MS = 60_000

/** An error already classified into a condition, so the supervisor need not re-parse it. */
export class ClassifiedError extends Error {
  constructor(classification, cause) {
    super(classification.message)
    this.name = 'ClassifiedError'
    this.classification = classification
    this.cause = cause
  }
}

/** Run every Realms API call through here so classification lives in exactly one place. */
async function realmsCall(fn, context) {
  try {
    return await fn()
  } catch (err) {
    throw new ClassifiedError(classifyRealmsError(err, context), err)
  }
}

/**
 * Resolve which Realm to join and get its connection details.
 * @returns {{ realm: object, join: object, transport: string }}
 */
export async function resolveRealm({ api, realmId, context }) {
  const realms = await realmsCall(() => api.getRealms(), context)
  if (!realms.length) {
    throw new ClassifiedError({
      kind: 'no_realms',
      retryable: false,
      message:
        'this account is not a member of any Realm — invite the bot account to the Realm and ' +
        'accept the invite by signing into Minecraft once as the bot (README → "Blocking prerequisite")',
    })
  }

  let realm = realms[0]
  if (realmId) {
    realm = realms.find((r) => r.id === Number(realmId))
    if (!realm) {
      throw new ClassifiedError({
        kind: 'realm_not_found',
        retryable: false,
        message:
          `REALM_ID=${realmId} is not among this account's Realms ` +
          `(found: ${realms.map((r) => `${r.name}=${r.id}`).join(', ')})`,
      })
    }
  }

  // The raw join response, not prismarine-realms' getAddress() — that assumes
  // the legacy ip:port shape and mangles a NetherNet network ID into NaN.
  const join = await realmsCall(() => api.rest.get(`/worlds/${realm.id}/join`), context)
  return { realm, join, transport: join.networkProtocol ?? 'DEFAULT' }
}

/** Build the createClient options for either transport. */
export function buildClientOptions({ join, transport, authflow, username, profilesFolder, version }) {
  const options = {
    authflow,
    username,
    profilesFolder,
    version: version.version,
    protocolVersion: version.protocolVersion,
    transport,
  }
  if (transport === 'DEFAULT') {
    // Legacy RakNet. Note the macOS raknet patch (#5) means this path is
    // unsupported on Darwin — fine until such a Realm actually appears.
    const [host, port] = String(join.address).split(':')
    return { ...options, host, port: Number(port) }
  }
  return { ...options, networkId: join.address }
}

/**
 * Run a single session: connect, stay connected, resolve when it ends.
 *
 * @returns {Promise<{ endedBy: string, reason: string|null, connected: boolean, uptimeMs: number, world: object }>}
 *   Resolves on any *connection-level* end. Rejects with a ClassifiedError only
 *   for failures that happened before a client existed (API/auth/version).
 *   `world` is the accumulated world-state snapshot (src/world.js) as of the
 *   moment the session ended — a fresh createWorldState() per call, since a
 *   reconnect re-joins via a fresh start_game anyway.
 */
export async function runSession({
  api,
  createClient,
  authflow,
  username,
  profilesFolder,
  realmId,
  version,
  log,
  context,
  connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
  stopSignal = null,
  faultSignal = null,
  now = () => Date.now(),
  recorder = null,
  // Always on, not opt-in: the whole point (#47) is that the NEXT unattended
  // failure is diagnosable from the log without anyone having enabled anything
  // first. Injectable only so tests can drive it.
  probe = createConnectProbe({ log }),
}) {
  const { realm, join, transport } = await resolveRealm({ api, realmId, context })
  log.info(
    'realm.resolved',
    `"${realm.name}" transport=${transport} region=${join.sessionRegionData?.regionName ?? 'unknown'}`
  )

  const client = createClient(
    buildClientOptions({ join, transport, authflow, username, profilesFolder, version })
  )

  return await new Promise((resolve) => {
    let settled = false
    let libraryClosed = false
    let connectedAt = null
    let runtimeEntityId = null
    let selfXuid = ''
    let connectTimer = null
    let unsubscribeStop = null
    let unsubscribeFault = null
    let world = createWorldState()

    const finish = (endedBy, reason) => {
      if (settled) return
      settled = true
      clearTimeout(connectTimer)
      unsubscribeStop?.()
      unsubscribeFault?.()
      probe?.detach()
      // Only close if the library has not already done so. A second close()
      // throws a TypeError on the NetherNet path (see the header note).
      if (!libraryClosed) {
        try {
          client.close()
        } catch (err) {
          log.warn('client.close.failed', String(err?.message ?? err))
        }
      }
      resolve({
        endedBy,
        reason: reason ?? null,
        connected: connectedAt !== null,
        uptimeMs: connectedAt === null ? 0 : now() - connectedAt,
        world,
      })
    }

    // The handshake observer (src/probe.js). Attached first, so that its
    // `connect_allowed` listener still runs after BedrockX's own — which is
    // what makes the NetherNet internals reachable at exactly the right moment
    // (see the header note in src/probe.js).
    probe?.attach(client)

    // The world-model observer. reduce() is a pure function that is
    // documented to never throw (src/world.js) — a bad reducer must not be
    // able to drop the connection — so no try/catch is needed at this
    // wiring site itself. Attached per-session, per-name, because BedrockX
    // has no generic `packet` event (client.js:207 emits by raw name only)
    // and `close()` calls removeAllListeners(), so a listener attached
    // outside runSession would silently stop firing after the first
    // reconnect.
    for (const name of WORLD_PACKET_NAMES) {
      client.on(name, (packet) => {
        world = reduce(world, name, packet)
      })
    }

    // The opt-in packet recorder (src/recorder.js). Unlike the reducer, this
    // performs real file I/O, so failures ARE caught here — a full disk must
    // not be able to drop the connection either.
    if (recorder) {
      for (const name of allPacketNames()) {
        client.on(name, (packet) => {
          try {
            recorder.recordInbound(name, packet)
          } catch (err) {
            log.warn('recorder.inbound.failed', String(err?.message ?? err))
          }
        })
      }
      const rawWrite = client.write.bind(client)
      client.write = (name, params) => {
        try {
          recorder.recordOutbound(name, params)
        } catch (err) {
          log.warn('recorder.outbound.failed', String(err?.message ?? err))
        }
        return rawWrite(name, params)
      }
    }

    // Ctrl-C must end a *connected* session immediately. Checking a flag only
    // between attempts would make a healthy bot ignore SIGINT until it happened
    // to disconnect, which on a stable connection is never.
    unsubscribeStop = stopSignal?.onStop?.(() => finish('shutdown', 'stop requested'))

    // A process-level signalling fault ends the session THROUGH finish(), so
    // the client is closed and its timers cleared rather than left leaking.
    unsubscribeFault = faultSignal?.onFault?.(() => finish('signalling_fault', 'signalling_fault'))

    connectTimer = setTimeout(() => {
      if (connectedAt === null) {
        // Never a bare "no spawn within Nms" — that one message covered six
        // different failures and made #47 undiagnosable. describe() names the
        // furthest stage the handshake reached and what stopping there implies.
        finish('connect_timeout', `no spawn within ${connectTimeoutMs}ms — ${probe?.describe() ?? 'no probe attached'}`)
      }
    }, connectTimeoutMs)
    connectTimer.unref?.()

    client.on('session', () => log.info('xbox.session', 'Xbox Live session established'))

    // The server's roster is the reliable source of our own XUID, which
    // outgoing chat must carry.
    client.on('player_list', (packet) => {
      for (const record of packet.records?.records ?? packet.records ?? []) {
        if (stripFormatting(record.username ?? record.name).toLowerCase() === username.toLowerCase()) {
          selfXuid = String(record.xbox_user_id ?? record.xuid ?? '')
        }
      }
    })

    client.on('start_game', (packet) => {
      runtimeEntityId = packet.runtime_entity_id
      const pos = packet.player_position
      log.info('world.joined', pos ? `position x=${pos.x} y=${pos.y} z=${pos.z}` : 'no player_position')
    })

    client.on('play_status', (packet) => {
      if (packet.status !== 'player_spawn') {
        log.info('play_status', packet.status)
        return
      }
      // BedrockX never sends this (upstream bedrock-protocol does). Without it
      // the server never treats the player as fully joined and drops us.
      client.write('set_local_player_as_initialized', { runtime_entity_id: runtimeEntityId })
      connectedAt = now()
      clearTimeout(connectTimer)
      log.info('connected', 'spawned and initialized')
      sendChat(`${username} has connected.`)
    })

    client.on('text', (packet) => {
      const from = stripFormatting(packet.source_name)
      if (from && from.toLowerCase() !== username.toLowerCase()) {
        log.info('chat.in', `${from}: ${packet.message}`)
        // Chat kill-switch (#14): inbound chat is untrusted input — including
        // from a player who is not Roberto — so this matches a narrow literal
        // command only, never something an LLM interprets. finish() is
        // idempotent, so this composes safely with a kick/close arriving
        // around the same time.
        if (isStopCommand(packet.message)) {
          log.warn('chat.stop_command', `${from} sent the stop command — shutting down`)
          finish('shutdown', 'stop command received via chat')
        }
      }
    })

    // kick fires first, then the library closes itself — one disconnect, two
    // events. `finish` is idempotent, so this cannot double-reconnect.
    client.on('kick', (packet) => {
      const reason = packet?.reason ?? 'unknown'
      libraryClosed = true // close() is about to run inside the library
      log.warn('kicked', `${reason}${packet?.message ? ` — ${packet.message}` : ''}`)
      finish('kick', reason)
    })

    client.on('close', (reason) => {
      libraryClosed = true
      finish('close', reason == null ? null : String(reason))
    })

    // An error does NOT close the connection, so we end the session ourselves.
    client.on('error', (err) => {
      log.error('client.error', String(err?.message ?? err))
      finish('error', String(err?.message ?? err))
    })

    function sendChat(message) {
      // chat is now part of the fixed action vocabulary (#14) — the packet
      // shape lives in src/actions.js, not duplicated here.
      const { name, params } = buildChatPacket({ message, username, xuid: selfXuid })
      client.write(name, params)
      log.info('chat.out', message)
    }
  })
}
