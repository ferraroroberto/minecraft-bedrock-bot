// The fake world (#15, Layer 3) — the primary test surface for the decision
// loop, and the reason the whole layer can be verified with no Realm, no
// network and no account.
//
// It presents the same surface the real client does — `client.write(name,
// params)` — interprets the outbound packets #14's vocabulary produces,
// mutates its own state, and then EMITS SYNTHESIZED INBOUND PACKETS THROUGH
// THE REAL REDUCER (src/world.js `reduce`). That last part is deliberate: the
// loop is not handed a hand-written world object, it observes state that was
// built the same way a live session's would be, so Layer 2a is exercised for
// real rather than mocked away. Even the initial state is seeded by feeding
// `start_game` / `inventory_content` / `update_block` through reduce().
//
// WHAT THIS CAN AND CANNOT PROVE. It proves the loop is internally consistent:
// that actions are chosen, gated, executed, and verified from world state, and
// that a lying model fails. It CANNOT prove the real server agrees, because
// every rule below is OUR assumption about server behaviour, not a measured
// one — the same "our encoder agrees with our decoder" trap already documented
// for #13 and #14 in the README. This repo has been burned once by a packet
// that serialized perfectly and was still semantically wrong.
//
// One assumption is worth naming precisely, because it is a real open
// question rather than a simplification: PLACE. #14's own outcome
// verification watches the CLICKED coordinate (src/perform-action.js
// place_block's verify reads args.x/y/z), so this world sets the new block
// there. A real Bedrock server may instead place it on the adjacent face.
// Only a live run can settle that, and if it turns out to be the adjacent
// block then #14's verify and this world are wrong TOGETHER — which is
// exactly the failure mode a self-consistent simulator cannot catch.
import { createWorldState, reduce, getBlockAt } from './world.js'

/** Runtime id a broken block leaves behind. 0 is used as "air" throughout the tests; the real id is unknown until a live run. */
export const DEFAULT_AIR_RUNTIME_ID = 0
/** Runtime id a placed item becomes when the item carries no block_runtime_id of its own. */
export const DEFAULT_PLACED_RUNTIME_ID = 1

const AIR_ITEM = Object.freeze({ network_id: 0 })

function blockKeyOf(position) {
  return `${position.x},${position.y},${position.z}`
}

/**
 * @param {object} [options]
 * @param {object[]} [options.inventory]                       item objects, array index = slot
 * @param {Record<string, number>} [options.blocks]            { "x,y,z": block_runtime_id } already observed
 * @param {object[]} [options.entities]                        [{ runtimeId, uniqueId, type, username, position }]
 * @param {(heldItem: object) => number} [options.placedRuntimeIdFor]
 * @param {(api: object, transactionData: object) => void} [options.useItemEffect]
 *   default: NOTHING happens. Matches reality closely enough to matter — #14 documents that use_item's effect is not
 *   uniformly observable, so the default makes use_item correctly report unverified rather than flattering the loop.
 * @param {(input: {tick: number, position: object}) => object|null} [options.correctionFor]
 *   return a position to make the server disagree with an outbound player_auth_input (correct_player_move_prediction)
 */
export function createFakeWorld({
  position = { x: 0, y: 64, z: 0 },
  rotation = { pitch: 0, yaw: 0 },
  runtimeEntityId = 1,
  gamemode = 'survival',
  dimension = 'overworld',
  health = 20,
  hunger = 20,
  inventory = [],
  selectedHotbarSlot = 0,
  blocks = {},
  entities = [],
  airRuntimeId = DEFAULT_AIR_RUNTIME_ID,
  placedRuntimeIdFor = (heldItem) => (Number.isFinite(heldItem?.block_runtime_id) ? heldItem.block_runtime_id : DEFAULT_PLACED_RUNTIME_ID),
  useItemEffect = null,
  correctionFor = null,
} = {}) {
  let world = createWorldState()
  const written = []
  const inbound = []
  let suppressedEffects = 0

  /** Feed a synthesized INBOUND packet through the real reducer — the only way this world's state ever changes. */
  function emit(name, packet) {
    inbound.push({ name, packet })
    world = reduce(world, name, packet)
  }

  /**
   * Run one outbound packet's world effect, unless a test asked for the next
   * one to be swallowed. Swallowing is keyed on EFFECTS, not on writes, so
   * failNext() suppresses a whole break (start_break + stop_break writes, one
   * effect) rather than half of it.
   */
  function applyEffect(fn) {
    if (suppressedEffects > 0) {
      suppressedEffects -= 1
      return
    }
    fn()
  }

  function setInventorySlot(slot, item) {
    emit('inventory_slot', { window_id: 'inventory', slot, item })
  }

  function consumeOne(hotbarSlot) {
    const item = world.inventory.windows.inventory?.[hotbarSlot]
    if (!item || !Number.isFinite(item.count)) return
    setInventorySlot(hotbarSlot, item.count > 1 ? { ...item, count: item.count - 1 } : { ...AIR_ITEM })
  }

  const api = { emit, setInventorySlot, getWorld: () => world }

  const OUTBOUND = {
    // Chat has no delivery acknowledgement on Bedrock — #14 documents this as
    // the one action reported sent rather than verified. Recording the write
    // and changing nothing is the faithful behaviour, not a gap.
    text: () => {},

    set_local_player_as_initialized: () => {},

    player_hotbar: (params) => applyEffect(() => emit('player_hotbar', { selected_slot: params.selected_slot })),

    player_action: (params) => {
      if (params.action !== 'stop_break') return // start_break alone changes nothing
      applyEffect(() => {
        // A block never observed is not made to exist here — #14's own
        // precondition refuses that case before it reaches the wire.
        if (getBlockAt(world, params.position.x, params.position.y, params.position.z) === null) return
        emit('update_block', { position: params.position, block_runtime_id: airRuntimeId })
      })
    },

    inventory_transaction: (params) => {
      const data = params?.transaction?.transaction_data
      if (!data) return
      if (data.action_type === 'click_block') {
        applyEffect(() => {
          emit('update_block', { position: data.block_position, block_runtime_id: placedRuntimeIdFor(data.held_item) })
          consumeOne(data.hotbar_slot)
        })
        return
      }
      if (data.action_type === 'click_air') {
        applyEffect(() => useItemEffect?.(api, data))
      }
    },

    // The server only answers a player_auth_input when it DISAGREES (#17).
    // Silence is the success signal, so the default is to stay silent.
    player_auth_input: (params) => {
      if (!correctionFor) return
      const corrected = correctionFor({ tick: params.tick, position: params.position })
      if (corrected) {
        emit('correct_player_move_prediction', {
          prediction_type: 'player',
          position: corrected,
          rotation: { x: params.pitch, y: params.yaw },
        })
      }
    },
  }

  // Seed the starting state THROUGH the reducer, exactly as a real join would.
  emit('start_game', {
    runtime_entity_id: runtimeEntityId,
    player_position: position,
    rotation: { x: rotation.pitch, z: rotation.yaw }, // vec2f: x=pitch, z=yaw (see src/world.js)
    player_gamemode: gamemode,
    dimension,
  })
  const attributes = []
  if (Number.isFinite(health)) attributes.push({ name: 'minecraft:health', current: health })
  if (Number.isFinite(hunger)) attributes.push({ name: 'minecraft:player.hunger', current: hunger })
  if (attributes.length) emit('update_attributes', { attributes })
  emit('inventory_content', { window_id: 'inventory', input: inventory })
  emit('player_hotbar', { selected_slot: selectedHotbarSlot })
  for (const [key, runtimeId] of Object.entries(blocks)) {
    const [x, y, z] = key.split(',').map(Number)
    emit('update_block', { position: { x, y, z }, block_runtime_id: runtimeId })
  }
  for (const entity of entities) {
    const packet = {
      runtime_id: entity.runtimeId,
      unique_id: entity.uniqueId ?? entity.runtimeId,
      position: entity.position,
    }
    if (entity.type === 'player') emit('add_player', { ...packet, username: entity.username ?? 'player' })
    else emit('add_entity', { ...packet, entity_type: entity.type ?? 'unknown' })
  }

  return {
    /** The client surface #14's gate writes to. */
    client: {
      write(name, params) {
        written.push({ name, params })
        OUTBOUND[name]?.(params)
      },
    },

    getWorld: () => world,
    setWorld: (next) => {
      world = next
    },

    /**
     * #14's outcome poll. This world only ever changes SYNCHRONOUSLY inside
     * client.write, so a predicate that is false here can never become true
     * later — returning null immediately is the honest equivalent of "the
     * timeout expired", and it keeps the whole suite free of timers and
     * wall-clock waits.
     */
    waitForWorld: async (predicate) => (predicate(world) ? world : null),

    /** Inject an arbitrary inbound packet (a correction, a health drop, another player arriving). */
    emit,

    /** Make the next `count` world effects be swallowed — a server that ignored the action. */
    failNext(count = 1) {
      suppressedEffects += count
    },

    get written() {
      return written.slice()
    },
    get inbound() {
      return inbound.slice()
    },
  }
}
