// Pure, packet-in/state-out world model.
//
// No client or network coupling: `reduce(state, name, packet)` takes a plain
// packet object and returns a new state, so it is testable by feeding it
// synthesized packets (test/world.test.js) exactly as it will later receive
// real ones off the wire.
//
// Every field name below was read off the pinned BedrockX fork's own
// protocol.json (node_modules/bedrockx/src/protocol/protocol.json), not
// assumed from Java-edition docs or bedrock-protocol's upstream — per #13's
// own warning, this pin has previously disagreed with both. Two results of
// that check that are NOT what a first guess would produce:
//
//   - `remove_entity`'s field is `entity_id_self`, and it is the entity's
//     UNIQUE id (zigzag64) — the SAME id space as `add_entity`/`add_player`'s
//     `unique_id`, NOT their `runtime_id` (varint64), which is what
//     `move_entity`/`move_entity_delta`/`mob_equipment` key off instead.
//     Two id spaces, easy to conflate, confirmed against pmmp/BedrockProtocol's
//     `RemoveActorPacket` (`actorUniqueId`) since this pin ships no comment
//     saying so.
//   - `set_health` is NOT handled here. It round-trips fine but is documented
//     as unused by the vanilla server; health (and hunger) travel via
//     `update_attributes`'s `minecraft:health` / `minecraft:player.hunger`
//     attribute entries instead (confirmed against the same PMMP source).
//     Handling both speculatively, as an earlier draft of this plan did,
//     would have been exactly the kind of unverified assumption this file
//     exists to avoid.
//
// `add_entity`'s `unique_id` (zigzag64) and `add_player`'s `unique_id` (li64)
// are different wire encodings for the same *kind* of value, and protodef's
// decode of a 64-bit type can legitimately come back as a `bigint` for one and
// a `number` for the other. `idsEqual` below compares by `String(...)` rather
// than `===` for exactly this reason — any single field is internally
// consistent, but comparing IDS ACROSS packet types is not safe with `===`.
//
// This module is not yet empirically confirmed against a real packet stream
// (see #13's own scope note) — only against the pinned protocol definition
// and PMMP's independent implementation.

const HEALTH_ATTRIBUTE = 'minecraft:health'
const HUNGER_ATTRIBUTE = 'minecraft:player.hunger'

/** @returns {object} an empty world state, before any packet has been observed. */
export function createWorldState() {
  return {
    self: {
      runtimeEntityId: null,
      position: null,
      rotation: null, // { pitch, yaw }
      gamemode: null,
      dimension: null,
      health: null,
      hunger: null,
    },
    inventory: {
      windows: {}, // { [windowId]: item[] }, windowId as decoded by the WindowID mapper (e.g. "inventory", "offhand", "armor")
      selectedHotbarSlot: null,
    },
    entities: new Map(), // runtime_id -> { uniqueId, type, username, position }
    blocks: new Map(), // "x,y,z" -> block_runtime_id
  }
}

/** @returns {number|null} the block runtime id last observed at (x,y,z), or null if never seen. */
export function getBlockAt(state, x, y, z) {
  return state.blocks.get(`${x},${y},${z}`) ?? null
}

function idsEqual(a, b) {
  return a != null && b != null && String(a) === String(b)
}

function toVec3(v) {
  return v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)
    ? { x: v.x, y: v.y, z: v.z }
    : null
}

function toBlockKey(v) {
  return v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z) ? `${v.x},${v.y},${v.z}` : null
}

function withSelf(state, patch) {
  return { ...state, self: { ...state.self, ...patch } }
}

function withInventory(state, patch) {
  return { ...state, inventory: { ...state.inventory, ...patch } }
}

function reduceStartGame(state, packet) {
  const position = toVec3(packet.player_position)
  if (!position || !Number.isFinite(packet.runtime_entity_id)) return state
  const rotation =
    packet.rotation && Number.isFinite(packet.rotation.x) && Number.isFinite(packet.rotation.z)
      ? { pitch: packet.rotation.x, yaw: packet.rotation.z } // vec2f: x=pitch, z=yaw — confirmed against pmmp's sequential pitch-then-yaw float read
      : state.self.rotation
  return withSelf(state, {
    runtimeEntityId: packet.runtime_entity_id,
    position,
    rotation,
    gamemode: typeof packet.player_gamemode === 'string' ? packet.player_gamemode : state.self.gamemode,
    dimension: typeof packet.dimension === 'string' ? packet.dimension : state.self.dimension,
  })
}

function reduceMovePlayer(state, packet) {
  const position = toVec3(packet.position)
  if (!position) return state
  const rotation =
    Number.isFinite(packet.pitch) && Number.isFinite(packet.yaw)
      ? { pitch: packet.pitch, yaw: packet.yaw }
      : state.self.rotation
  return withSelf(state, { position, rotation })
}

function reduceUpdateAttributes(state, packet) {
  if (!Array.isArray(packet.attributes)) return state
  const patch = {}
  for (const attr of packet.attributes) {
    if (!attr || !Number.isFinite(attr.current)) continue
    if (attr.name === HEALTH_ATTRIBUTE) patch.health = attr.current
    if (attr.name === HUNGER_ATTRIBUTE) patch.hunger = attr.current
  }
  return Object.keys(patch).length ? withSelf(state, patch) : state
}

function reduceInventoryContent(state, packet) {
  if (typeof packet.window_id !== 'string' || !Array.isArray(packet.input)) return state
  return withInventory(state, { windows: { ...state.inventory.windows, [packet.window_id]: packet.input } })
}

function reduceInventorySlot(state, packet) {
  if (typeof packet.window_id !== 'string' || !Number.isFinite(packet.slot) || !packet.item) return state
  const items = Array.isArray(state.inventory.windows[packet.window_id])
    ? [...state.inventory.windows[packet.window_id]]
    : []
  items[packet.slot] = packet.item
  return withInventory(state, { windows: { ...state.inventory.windows, [packet.window_id]: items } })
}

function reduceMobEquipment(state, packet) {
  // Equipment for another entity (a mob, or another player) is out of scope
  // for this pass — #13 asks for SELF inventory tracking, not nearby entities'.
  if (!idsEqual(packet.runtime_entity_id, state.self.runtimeEntityId)) return state
  if (typeof packet.window_id !== 'string' || !Number.isFinite(packet.slot) || !packet.item) return state
  const items = Array.isArray(state.inventory.windows[packet.window_id])
    ? [...state.inventory.windows[packet.window_id]]
    : []
  items[packet.slot] = packet.item
  return withInventory(state, { windows: { ...state.inventory.windows, [packet.window_id]: items } })
}

function reducePlayerHotbar(state, packet) {
  if (!Number.isFinite(packet.selected_slot)) return state
  return withInventory(state, { selectedHotbarSlot: packet.selected_slot })
}

function reduceAddEntity(state, packet) {
  if (!Number.isFinite(packet.runtime_id)) return state
  const entities = new Map(state.entities)
  entities.set(packet.runtime_id, {
    uniqueId: packet.unique_id ?? null,
    type: typeof packet.entity_type === 'string' ? packet.entity_type : 'unknown',
    username: null,
    position: toVec3(packet.position),
  })
  return { ...state, entities }
}

function reduceAddPlayer(state, packet) {
  if (!Number.isFinite(packet.runtime_id)) return state
  const entities = new Map(state.entities)
  entities.set(packet.runtime_id, {
    uniqueId: packet.unique_id ?? null,
    type: 'player',
    username: typeof packet.username === 'string' ? packet.username : null,
    position: toVec3(packet.position),
  })
  return { ...state, entities }
}

function reduceMoveEntity(state, packet) {
  if (!Number.isFinite(packet.runtime_entity_id)) return state
  const position = toVec3(packet.position)
  const existing = state.entities.get(packet.runtime_entity_id)
  // Out-of-order delivery: a move for an entity we have not seen `add_entity`/
  // `add_player` for yet. Nothing to attach the position to — ignore rather
  // than fabricate a placeholder entity of unknown type.
  if (!existing || !position) return state
  const entities = new Map(state.entities)
  entities.set(packet.runtime_entity_id, { ...existing, position })
  return { ...state, entities }
}

function reduceMoveEntityDelta(state, packet) {
  if (!Number.isFinite(packet.runtime_entity_id)) return state
  const existing = state.entities.get(packet.runtime_entity_id)
  if (!existing?.position) return state
  const flags = packet.flags ?? {}
  const position = {
    x: flags.has_x && Number.isFinite(packet.x) ? packet.x : existing.position.x,
    y: flags.has_y && Number.isFinite(packet.y) ? packet.y : existing.position.y,
    z: flags.has_z && Number.isFinite(packet.z) ? packet.z : existing.position.z,
  }
  const entities = new Map(state.entities)
  entities.set(packet.runtime_entity_id, { ...existing, position })
  return { ...state, entities }
}

function reduceRemoveEntity(state, packet) {
  // entity_id_self is a UNIQUE id, not a runtime id — see the header note.
  if (packet.entity_id_self == null) return state
  let runtimeIdToRemove
  for (const [runtimeId, entity] of state.entities) {
    if (idsEqual(entity.uniqueId, packet.entity_id_self)) {
      runtimeIdToRemove = runtimeId
      break
    }
  }
  if (runtimeIdToRemove === undefined) return state
  const entities = new Map(state.entities)
  entities.delete(runtimeIdToRemove)
  return { ...state, entities }
}

function reduceUpdateBlock(state, packet) {
  const key = toBlockKey(packet.position)
  if (!key || !Number.isFinite(packet.block_runtime_id)) return state
  const blocks = new Map(state.blocks)
  blocks.set(key, packet.block_runtime_id)
  return { ...state, blocks }
}

const HANDLERS = {
  start_game: reduceStartGame,
  move_player: reduceMovePlayer,
  update_attributes: reduceUpdateAttributes,
  inventory_content: reduceInventoryContent,
  inventory_slot: reduceInventorySlot,
  mob_equipment: reduceMobEquipment,
  player_hotbar: reducePlayerHotbar,
  add_entity: reduceAddEntity,
  add_player: reduceAddPlayer,
  move_entity: reduceMoveEntity,
  move_entity_delta: reduceMoveEntityDelta,
  remove_entity: reduceRemoveEntity,
  update_block: reduceUpdateBlock,
}

/** Packet names this reducer understands — connect.js attaches exactly one listener per name. */
export const WORLD_PACKET_NAMES = Object.freeze(Object.keys(HANDLERS))

/**
 * Fold one packet into the world state. Unknown packet names and malformed
 * packets (missing/wrong-typed fields) are no-ops — this must NEVER throw,
 * since a bad reducer must not be able to drop the connection (#13).
 *
 * @param {object} state   from createWorldState() or a prior reduce()
 * @param {string} packetName
 * @param {object} packet
 * @returns {object} a new state (or the same reference, if nothing changed)
 */
export function reduce(state, packetName, packet) {
  const handler = HANDLERS[packetName]
  if (!handler || !packet || typeof packet !== 'object') return state
  try {
    return handler(state, packet) ?? state
  } catch {
    return state
  }
}
