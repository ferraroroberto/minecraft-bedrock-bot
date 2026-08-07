// The fixed action vocabulary (#14): named, schema-validated actions that
// translate into packets — never raw packets exposed upward to a caller.
// Every function here is pure protocol translation: validate input, build the
// wire packet(s). No client, no I/O, no world mutation, no policy decisions —
// those live in src/safety.js (policy) and src/perform-action.js (the gate
// that decides WHETHER to write what this module builds).
//
// Packet field names were read off the pinned BedrockX fork's own
// protocol.json (node_modules/bedrockx/src/protocol/protocol.json), the same
// discipline #13's world.js established for reading packets — applied here to
// writing them. Two things worth flagging explicitly, per #14's own
// instruction to say so plainly rather than imply the actions are proven:
//
//   - `held_item` for place_block/use_item is meant to be the caller's ALREADY
//     -DECODED item object from #13's world model (world.inventory.windows.
//     inventory[hotbarSlot]), echoed back as-is. Bedrock's `Item` type has a
//     deep "default" branch (count/metadata/stack_id/block_runtime_id/extra
//     NBT) once network_id !== 0 that this module makes no attempt to
//     hand-synthesize — reusing a real decoded item sidesteps guessing that
//     shape. When no such item is known, AIR_ITEM (`{ network_id: 0 }`, the
//     protocol's explicit "void payload" case) is used instead.
//   - `face` for use_item's click_air case has no real block face (nothing is
//     targeted) and no authoritative source for this pin was found — see
//     buildUseItemPacket's comment. This is a documented guess, not a
//     verified value.
//
// This repo has already been burned by a packet that serialized perfectly and
// was still semantically wrong (README → the `category: 'message_only'`
// gotcha). A passing packet-shape assertion here is NOT evidence the server
// will accept the action — only a live, explicitly-authorized `npm run spike`
// can prove that.

// The one import here, and deliberately a pure predicate rather than any world
// state: #13's world model is where `runtimeEntityId` comes from (the decision
// loop injects `world.self.runtimeEntityId` verbatim), so the guard below has
// to accept exactly the representations that model stores — `BigInt` included.
import { isIdLike } from './world.js'

const AIR_ITEM = Object.freeze({ network_id: 0 })

export class InvalidActionArgsError extends Error {
  constructor(action, reason) {
    super(`${action}: ${reason}`)
    this.name = 'InvalidActionArgsError'
    this.action = action
  }
}

function must(action, condition, reason) {
  if (!condition) throw new InvalidActionArgsError(action, reason)
}

function isFiniteNumber(n) {
  return typeof n === 'number' && Number.isFinite(n)
}

function isFiniteVec3(v) {
  return Boolean(v) && isFiniteNumber(v.x) && isFiniteNumber(v.y) && isFiniteNumber(v.z)
}

function isIntBlockCoords(x, y, z) {
  return Number.isInteger(x) && Number.isInteger(y) && Number.isInteger(z)
}

/** @returns {{name: string, params: object}} */
export function buildChatPacket({ message, username, xuid }) {
  must('chat', typeof message === 'string' && message.length > 0, 'message must be a non-empty string')
  must('chat', typeof username === 'string' && username.length > 0, 'username is required')
  return {
    name: 'text',
    params: {
      needs_translation: false,
      // 'message_only' serializes fine but gets the connection dropped ~16s
      // later (README → gotchas). 'authored' is load-bearing.
      category: 'authored',
      type: 'chat',
      source_name: username,
      message,
      xuid: xuid ?? '',
      platform_chat_id: '',
      has_filtered_message: false,
    },
  }
}

/** @returns {{name: string, params: object}} */
export function buildSelectSlotPacket({ slot }) {
  must('select_slot', Number.isInteger(slot) && slot >= 0 && slot <= 8, 'slot must be an integer 0-8 (hotbar)')
  return {
    name: 'player_hotbar',
    params: { selected_slot: slot, window_id: 'inventory', select_slot: true },
  }
}

/**
 * player_action start_break/stop_break sequence — #14 scopes break_block down
 * to exactly this, not the full inventory_transaction dance place_block/
 * use_item need.
 * @returns {Array<{name: string, params: object}>}
 */
export function buildBreakBlockPackets({ runtimeEntityId, x, y, z, face }) {
  // NOT `Number.isInteger`: `runtime_entity_id` is a varint64 and decodes to a
  // `BigInt` on a real session (`Number.isInteger(7n) === false`), so the old
  // guard would have refused EVERY live break_block — with a message blaming a
  // missing argument rather than its type (#34, same defect class as #23).
  must('break_block', isIdLike(runtimeEntityId), 'runtimeEntityId is required (a number or BigInt entity id)')
  must('break_block', isIntBlockCoords(x, y, z), 'x, y, z must be integer block coordinates')
  must('break_block', Number.isInteger(face) && face >= 0 && face <= 5, 'face must be an integer 0-5 (BlockFace)')
  const position = { x, y, z }
  const resultPosition = { x: 0, y: 0, z: 0 } // unused by us on the way out; the field is mandatory on the wire
  return [
    { name: 'player_action', params: { runtime_entity_id: runtimeEntityId, action: 'start_break', position, result_position: resultPosition, face } },
    { name: 'player_action', params: { runtime_entity_id: runtimeEntityId, action: 'stop_break', position, result_position: resultPosition, face } },
  ]
}

function buildInventoryTransactionPacket({ actionType, blockPosition, face, hotbarSlot, heldItem, playerPosition, clickPosition, blockRuntimeId }) {
  return {
    name: 'inventory_transaction',
    params: {
      transaction: {
        // legacy_request_id 0 + no legacy_transactions: this client never
        // needs the legacy client-side-prediction transaction id scheme.
        legacy: { legacy_request_id: 0, legacy_transactions: null },
        transaction_type: 'item_use',
        // No container-slot actions accompany a bare item-use transaction —
        // that field is for multi-slot inventory moves, out of scope here.
        actions: null,
        transaction_data: {
          action_type: actionType,
          trigger_type: 'player_input',
          block_position: blockPosition,
          face,
          hotbar_slot: hotbarSlot,
          held_item: heldItem,
          player_pos: playerPosition,
          click_pos: clickPosition,
          block_runtime_id: blockRuntimeId,
          client_prediction: 'success',
          client_cooldown_state: 'off',
        },
      },
    },
  }
}

/**
 * inventory_transaction, transaction_type=item_use, action_type=click_block.
 * `face` follows the BlockFace convention used throughout the pin's other
 * face fields (see e.g. break_block above): 0=down, 1=up, 2=north, 3=south,
 * 4=west, 5=east.
 * @returns {{name: string, params: object}}
 */
export function buildPlaceBlockPacket({ x, y, z, face, hotbarSlot, heldItem, playerPosition, targetBlockRuntimeId = 0 }) {
  must('place_block', isIntBlockCoords(x, y, z), 'x, y, z must be integer block coordinates')
  must('place_block', Number.isInteger(face) && face >= 0 && face <= 5, 'face must be an integer 0-5 (BlockFace)')
  must('place_block', Number.isInteger(hotbarSlot) && hotbarSlot >= 0 && hotbarSlot <= 8, 'hotbarSlot must be an integer 0-8')
  must('place_block', isFiniteVec3(playerPosition), 'playerPosition must be a finite {x,y,z} — is self.position known yet?')
  return buildInventoryTransactionPacket({
    actionType: 'click_block',
    blockPosition: { x, y, z },
    face,
    hotbarSlot,
    heldItem: heldItem ?? AIR_ITEM,
    playerPosition,
    clickPosition: { x: 0.5, y: 0.5, z: 0.5 }, // naive: face centre, not aimed at a specific point
    blockRuntimeId: Number.isFinite(targetBlockRuntimeId) ? targetBlockRuntimeId : 0,
  })
}

/**
 * inventory_transaction, transaction_type=item_use, action_type=click_air —
 * using the held item without targeting a block (eating, drinking, etc).
 *
 * `face` and `block_position` are mandatory container fields on the wire even
 * though nothing is targeted. No authoritative source for what a real Bedrock
 * client sends here for click_air was found in the pinned protocol.json or in
 * BedrockX's own source (it ships no client-side use-item helper to copy) —
 * this uses face=0 and the zero vector as an inert placeholder. Flag this as
 * unverified if a live spike ever exercises use_item.
 * @returns {{name: string, params: object}}
 */
export function buildUseItemPacket({ hotbarSlot, heldItem, playerPosition }) {
  must('use_item', Number.isInteger(hotbarSlot) && hotbarSlot >= 0 && hotbarSlot <= 8, 'hotbarSlot must be an integer 0-8')
  must('use_item', isFiniteVec3(playerPosition), 'playerPosition must be a finite {x,y,z} — is self.position known yet?')
  return buildInventoryTransactionPacket({
    actionType: 'click_air',
    blockPosition: { x: 0, y: 0, z: 0 },
    face: 0,
    hotbarSlot,
    heldItem: heldItem ?? AIR_ITEM,
    playerPosition,
    clickPosition: { x: 0, y: 0, z: 0 },
    blockRuntimeId: 0,
  })
}
