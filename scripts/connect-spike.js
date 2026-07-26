// Connect spike — proves an external Node process can authenticate as a second
// Microsoft/Xbox account, join Roberto's Realm as an invited member, exchange
// chat, and read its own position (issue #1).
//
// Why BedrockX instead of PrismarineJS/bedrock-protocol: this Realm's join
// endpoint returns `networkProtocol: "NETHERNET_JSONRPC"` with a WebRTC network
// ID (a GUID) instead of a legacy `ip:port`. bedrock-protocol 3.57.0 (latest)
// speaks only RakNet for Realms — it does `address.split(':')`, yielding a GUID
// host and a NaN port, then fails the UDP ping. Upstream NetherNet support is
// still unmerged (PRs #533, #735). BedrockX is a fork that implements the
// NetherNet JSON-RPC signalling path, so it can reach a migrated Realm.
import 'dotenv/config'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import authPkg from 'prismarine-auth'
import realmsPkg from 'prismarine-realms'
import bedrockx from 'bedrockx'

const { Authflow, Titles } = authPkg
const { RealmAPI } = realmsPkg
const { createClient } = bedrockx

// Must track the Realms API's accepted client version — it rejects anything else
// with `{"errorCode":6020,"errorMsg":"Unknown client version"}`.
const MC_VERSION = '1.26.30'
const PROTOCOL_VERSION = 1001

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const profilesFolder = path.join(__dirname, '..', '.secrets', 'xbox-auth')

const username = process.env.BOT_USERNAME || 'MinecraftBot'
const realmId = process.env.REALM_ID

// The server appends formatting codes (e.g. "Name§r") to chat source names.
const stripFormatting = (s) => String(s ?? '').replace(/§./g, '')

const authflow = new Authflow(username, profilesFolder, {
  authTitle: Titles.MinecraftNintendoSwitch,
  deviceType: 'Nintendo',
  flow: 'live',
})

const api = RealmAPI.from(authflow, 'bedrock', { minecraftVersion: MC_VERSION })

const realms = await api.getRealms()
if (!realms.length) {
  throw new Error('No Realms found for this account — is the bot invited, and has the invite been accepted?')
}

let realm
if (realmId) {
  realm = realms.find((r) => r.id === Number(realmId))
  if (!realm) throw new Error(`REALM_ID=${realmId} not found among this account's Realms`)
} else {
  console.log(`Found ${realms.length} realm(s) this account can join:`)
  for (const r of realms) console.log(`  - ${r.name} (id: ${r.id})`)
  realm = realms[0]
  console.log(`Using "${realm.name}" — set REALM_ID=${realm.id} in .env for a deterministic connect next time.`)
}

// Raw join response rather than prismarine-realms' getAddress(), which assumes
// the legacy `ip:port` shape and mangles a NetherNet network ID into NaN.
const join = await api.rest.get(`/worlds/${realm.id}/join`)
const transport = join.networkProtocol ?? 'DEFAULT'
console.log(`[realm] "${realm.name}" transport=${transport} region=${join.sessionRegionData?.regionName ?? 'unknown'}`)

const options = {
  authflow,
  username,
  profilesFolder,
  version: MC_VERSION,
  protocolVersion: PROTOCOL_VERSION,
  transport,
}

if (transport === 'DEFAULT') {
  const [host, port] = join.address.split(':')
  Object.assign(options, { host, port: Number(port) })
  console.log(`[realm] address ${host}:${port}`)
} else {
  options.networkId = join.address
  console.log(`[realm] networkId ${join.address}`)
}

const client = createClient(options)

const startedAt = Date.now()
const elapsed = () => `+${((Date.now() - startedAt) / 1000).toFixed(1)}s`

let runtimeEntityId = null
let selfXuid = ''

client.on('session', () => {
  console.log(`[session] ${elapsed()} Xbox Live session established`)
})

// The server's own player roster is the reliable source for our XUID, which
// outgoing chat must carry.
client.on('player_list', (packet) => {
  for (const record of packet.records?.records ?? packet.records ?? []) {
    const name = stripFormatting(record.username ?? record.name)
    if (name.toLowerCase() === username.toLowerCase()) {
      selfXuid = String(record.xbox_user_id ?? record.xuid ?? '')
    }
  }
})

// BedrockX re-emits raw packet names — there is no synthesized `join`/`spawn`
// event and no `client.startGameData`, so position comes off `start_game`.
client.on('start_game', (packet) => {
  runtimeEntityId = packet.runtime_entity_id
  console.log(`[join] ${elapsed()} received start_game — connected to the world`)
  const pos = packet.player_position
  if (pos) {
    console.log(`[position] x=${pos.x} y=${pos.y} z=${pos.z}`)
  } else {
    console.log('[position] no player_position on start_game:', Object.keys(packet).join(', '))
  }
})

client.on('play_status', (packet) => {
  console.log(`[play_status] ${elapsed()} ${packet.status}`)
  if (packet.status !== 'player_spawn') return

  // BedrockX's createClient never sends this (upstream bedrock-protocol does on
  // spawn). Without it the server never treats the player as fully joined and
  // drops the connection within seconds.
  client.write('set_local_player_as_initialized', { runtime_entity_id: runtimeEntityId })
  console.log(`[spawn] ${elapsed()} bot has spawned`)

  sendChat(`${username} has connected.`)
})

function sendChat(message) {
  // Field shape mirrors a real inbound chat packet captured from the server.
  // `category: 'authored'` matters: sending 'message_only' is accepted by the
  // serializer but makes the server drop the connection ~16s later.
  client.write('text', {
    needs_translation: false,
    category: 'authored',
    type: 'chat',
    source_name: username,
    message,
    xuid: selfXuid,
    platform_chat_id: '',
    has_filtered_message: false,
  })
  console.log(`[chat->] ${elapsed()} ${message}`)
}

client.on('text', (packet) => {
  const from = stripFormatting(packet.source_name)
  if (from && from.toLowerCase() !== username.toLowerCase()) {
    console.log(`[chat<-] ${elapsed()} ${from}: ${packet.message}`)
  }
})

client.on('kick', (reason) => {
  console.log(`[kick] ${elapsed()}`, JSON.stringify(reason))
})

client.on('error', (err) => {
  console.log(`[error] ${elapsed()}`, err)
})

client.on('close', (reason) => {
  console.log(`[close] ${elapsed()} connection closed`, reason ?? '')
})

setInterval(() => console.log(`[alive] ${elapsed()} still connected`), 60_000).unref()
