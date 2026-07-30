// The observation (#15, Layer 3): the bounded, JSON-serialisable view of the
// world that the model is allowed to see.
//
// Pure — world state in, plain object out. Two properties matter and both are
// enforced here rather than hoped for:
//
//   1. BOUNDED. A world model that has observed ten thousand blocks must not
//      turn into a ten-thousand-entry prompt. Entities and blocks are sorted
//      by distance from the bot and capped, and the observation reports the
//      TOTAL alongside the capped list so the model is told plainly that it
//      is seeing a subset rather than silently believing it sees everything.
//   2. NO RAW PACKETS, AND IDS ARE NEVER AUTHORITATIVE. The model never sees
//      a raw packet, but it does see runtime entity/block ids (describeEntities
//      and describeBlocks below include them, and recentOutcomes echoes back
//      whatever args an action ran with). Naming one buys the model nothing:
//      decision-loop.js's INJECTED_ARGS overwrites identity-bearing args
//      (e.g. break_block's runtimeEntityId) with the loop's own values after
//      the model replies, so a model can echo an id back but can never get it
//      obeyed. It sees position, inventory, neighbours, terrain it has
//      already observed, and how its last few actions went.
//
// Numbers are rounded to 2dp: Bedrock float positions carry ~7 significant
// digits of noise that cost tokens and buy the model nothing.
import { distance3 } from './movement.js'

export const DEFAULT_MAX_ENTITIES = 8
export const DEFAULT_MAX_BLOCKS = 24
export const DEFAULT_MAX_OUTCOMES = 5
/** Model-facing text (an action's refusal reason) is truncated to this before it enters a prompt. */
export const MAX_REASON_LENGTH = 200

function round2(n) {
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null
}

function roundVec3(v) {
  return v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)
    ? { x: round2(v.x), y: round2(v.y), z: round2(v.z) }
    : null
}

function truncate(text, max = MAX_REASON_LENGTH) {
  if (typeof text !== 'string') return null
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/** Distance from `from` to `to`, or null when either is unknown — used only for sorting and display. */
function distanceOrNull(from, to) {
  return from && to ? round2(distance3(from, to)) : null
}

function parseBlockKey(key) {
  const [x, y, z] = key.split(',').map(Number)
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) ? { x, y, z } : null
}

/** Non-empty inventory slots only. network_id 0 is the protocol's own "no item" (see src/actions.js AIR_ITEM). */
function describeInventory(inventory) {
  const slots = Array.isArray(inventory.windows?.inventory) ? inventory.windows.inventory : []
  const items = []
  for (let slot = 0; slot < slots.length; slot++) {
    const item = slots[slot]
    if (!item || !Number.isFinite(item.network_id) || item.network_id === 0) continue
    items.push({ slot, networkId: item.network_id, count: Number.isFinite(item.count) ? item.count : null })
  }
  return { selectedHotbarSlot: inventory.selectedHotbarSlot ?? null, items }
}

function describeEntities(entities, selfPosition, maxEntities) {
  const all = []
  for (const [runtimeId, entity] of entities) {
    all.push({
      runtimeId,
      type: entity.type ?? 'unknown',
      username: entity.username ?? null,
      position: roundVec3(entity.position),
      distance: distanceOrNull(selfPosition, entity.position),
    })
  }
  // Unknown-distance entities sort last rather than being dropped — "we have
  // seen it but not where it is" is real information, just lower priority.
  all.sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity))
  return { total: all.length, nearest: all.slice(0, maxEntities) }
}

function describeBlocks(blocks, selfPosition, maxBlocks) {
  const all = []
  for (const [key, runtimeId] of blocks) {
    const position = parseBlockKey(key)
    if (!position) continue
    all.push({ ...position, runtimeId, distance: distanceOrNull(selfPosition, position) })
  }
  all.sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity))
  return { total: all.length, nearest: all.slice(0, maxBlocks) }
}

/**
 * @param {object} world                    a #13 world-state snapshot
 * @param {object} [options]
 * @param {Array<{action:string,args:object,result:object}>} [options.recentOutcomes]  most recent LAST
 * @returns {object} the plain object serialised into the model's prompt
 */
export function buildObservation(
  world,
  {
    recentOutcomes = [],
    maxEntities = DEFAULT_MAX_ENTITIES,
    maxBlocks = DEFAULT_MAX_BLOCKS,
    maxOutcomes = DEFAULT_MAX_OUTCOMES,
  } = {}
) {
  const self = world.self
  const position = roundVec3(self.position)
  return {
    self: {
      position,
      rotation: self.rotation ? { pitch: round2(self.rotation.pitch), yaw: round2(self.rotation.yaw) } : null,
      gamemode: self.gamemode ?? null,
      dimension: self.dimension ?? null,
      health: round2(self.health),
      hunger: round2(self.hunger),
    },
    inventory: describeInventory(world.inventory),
    entities: describeEntities(world.entities, self.position, maxEntities),
    // "blocks we have observed an update_block for" — NOT the terrain. #13
    // deliberately does not decode the chunk palette, so an empty list means
    // "nothing observed yet", never "there is nothing there". Said plainly in
    // the system prompt too, because the difference matters to a planner.
    blocks: describeBlocks(world.blocks, self.position, maxBlocks),
    recentOutcomes: recentOutcomes.slice(-maxOutcomes).map((outcome) => ({
      action: outcome.action,
      args: outcome.args,
      ok: outcome.result?.ok === true,
      refused: outcome.result?.refused === true,
      dryRun: outcome.result?.dryRun === true,
      reason: truncate(outcome.result?.reason ?? null),
    })),
  }
}
