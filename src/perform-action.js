// The performAction gate (#14): the ONE path from a named action to a
// written packet, below the LLM, in code. Order is deliberate and applies to
// every action the same way:
//
//   1. rate limit          — a runaway caller cannot execute thousands of
//                             actions before anyone notices
//   2. build packet(s)      — arg validation (src/actions.js); invalid args
//                             are refused with zero packets written
//   3. region check          — spatial actions only; refused and logged,
//                             never silently clamped (src/safety.js)
//   4. precondition check    — against #13's world model (target exists, is
//                             in reach, the slot holds an item, ...)
//   5. dry-run branch        — default: report what WOULD be written, write
//                             nothing, unless config.armed is explicitly true
//   6. write + verify        — write the packet(s), then confirm the effect
//                             from world state (never "packet written =
//                             success"); an unconfirmable effect reports
//                             failure, not success
//
// Every step is recorded to the audit log, allowed or refused, with why.
import { getBlockAt } from './world.js'
import {
  buildChatPacket,
  buildSelectSlotPacket,
  buildBreakBlockPackets,
  buildPlaceBlockPacket,
  buildUseItemPacket,
  InvalidActionArgsError,
} from './actions.js'
import { checkRegion, checkBreakWhitelist, createRateLimiter } from './safety.js'
import { runMovementStream, DEFAULT_WALK_SPEED_PER_TICK, LOOK_AT_TICK_COUNT } from './movement.js'

export const DEFAULT_OUTCOME_TIMEOUT_MS = 5_000
export const DEFAULT_MAX_REACH = 6

function distance(a, b) {
  const dx = a.x - b.x
  const dy = a.y - b.y
  const dz = a.z - b.z
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

function refuse(reason) {
  return { ok: false, refused: true, reason }
}

function heldItemAt(world, hotbarSlot) {
  return world.inventory.windows.inventory?.[hotbarSlot] ?? null
}

// One entry per vocabulary member. `spatial: true` means the action targets
// a block coordinate and is therefore subject to the region check.
const ACTIONS = {
  chat: {
    spatial: false,
    build: (args) => [buildChatPacket({ message: args.message, username: args.username, xuid: args.xuid })],
    precondition: () => ({ ok: true }),
    // Bedrock gives no delivery ack for chat, and #13's world model
    // deliberately does not track chat history (nothing to verify against).
    // This is the one documented exception to "verify from world state, not
    // from the packet being written" — a written chat packet is reported
    // sent, not polled for an outcome.
    verify: async () => true,
  },

  select_slot: {
    spatial: false,
    build: (args) => [buildSelectSlotPacket({ slot: args.slot })],
    precondition: () => ({ ok: true }),
    verify: async (args, { waitForWorld, timeoutMs }) =>
      (await waitForWorld((w) => w.inventory.selectedHotbarSlot === args.slot, timeoutMs)) !== null,
  },

  break_block: {
    spatial: true,
    build: (args) => buildBreakBlockPackets({ runtimeEntityId: args.runtimeEntityId, x: args.x, y: args.y, z: args.z, face: args.face }),
    precondition: (args, world, config) => {
      const before = getBlockAt(world, args.x, args.y, args.z)
      if (before === null) return refuse(`no known block at (${args.x},${args.y},${args.z}) — nothing observed there yet`)
      const whitelisted = checkBreakWhitelist(config.breakWhitelist, before)
      if (!whitelisted.ok) return whitelisted
      if (world.self.position) {
        const d = distance(world.self.position, args)
        const maxReach = config.maxReach ?? DEFAULT_MAX_REACH
        if (d > maxReach) return refuse(`target (${args.x},${args.y},${args.z}) is ${d.toFixed(1)} blocks away — outside max reach ${maxReach}`)
      }
      return { ok: true }
    },
    verify: async (args, { waitForWorld, timeoutMs, worldBefore }) => {
      const before = getBlockAt(worldBefore, args.x, args.y, args.z)
      return (await waitForWorld((w) => getBlockAt(w, args.x, args.y, args.z) !== before, timeoutMs)) !== null
    },
  },

  place_block: {
    spatial: true,
    build: (args, world) =>
      [buildPlaceBlockPacket({
        x: args.x, y: args.y, z: args.z, face: args.face, hotbarSlot: args.hotbarSlot,
        heldItem: heldItemAt(world, args.hotbarSlot),
        playerPosition: world.self.position,
        targetBlockRuntimeId: getBlockAt(world, args.x, args.y, args.z) ?? 0,
      })],
    precondition: (args, world, config) => {
      if (!heldItemAt(world, args.hotbarSlot)) return refuse(`hotbar slot ${args.hotbarSlot} is empty — nothing to place`)
      if (!world.self.position) return refuse('self position is not yet known')
      const d = distance(world.self.position, args)
      const maxReach = config.maxReach ?? DEFAULT_MAX_REACH
      if (d > maxReach) return refuse(`target (${args.x},${args.y},${args.z}) is ${d.toFixed(1)} blocks away — outside max reach ${maxReach}`)
      return { ok: true }
    },
    verify: async (args, { waitForWorld, timeoutMs, worldBefore }) => {
      const before = getBlockAt(worldBefore, args.x, args.y, args.z)
      return (await waitForWorld((w) => getBlockAt(w, args.x, args.y, args.z) !== before, timeoutMs)) !== null
    },
  },

  use_item: {
    spatial: false,
    build: (args, world) =>
      [buildUseItemPacket({ hotbarSlot: args.hotbarSlot, heldItem: heldItemAt(world, args.hotbarSlot), playerPosition: world.self.position })],
    precondition: (args, world) => {
      if (!heldItemAt(world, args.hotbarSlot)) return refuse(`hotbar slot ${args.hotbarSlot} is empty — nothing to use`)
      if (!world.self.position) return refuse('self position is not yet known')
      return { ok: true }
    },
    // use_item's real-world effect (durability, hunger, a consumed stack, ...)
    // is not uniformly observable in #13's world model the way a block
    // change is — there is no single field guaranteed to move. Rather than
    // fabricate a heuristic, this watches the two signals #13 does track that
    // "using an item" could plausibly touch (the held slot's item, and self
    // health/hunger), and reports UNVERIFIED — not success — when neither
    // changes within the timeout. A use_item with no observable effect on
    // this world model legitimately reports failure, per #14's own rule.
    verify: async (args, { waitForWorld, timeoutMs, worldBefore }) => {
      const beforeItem = JSON.stringify(heldItemAt(worldBefore, args.hotbarSlot))
      const beforeHealth = worldBefore.self.health
      const beforeHunger = worldBefore.self.hunger
      const changed = await waitForWorld((w) => {
        if (JSON.stringify(heldItemAt(w, args.hotbarSlot)) !== beforeItem) return true
        if (w.self.health !== beforeHealth) return true
        if (w.self.hunger !== beforeHunger) return true
        return false
      }, timeoutMs)
      return changed !== null
    },
  },

  // move_to/look_at (#17) are STREAMING actions — a per-tick player_auth_input
  // loop, not a fixed packet list — so they carry `stream: true` and skip the
  // one-shot build/verify shape entirely; performAction() branches on it
  // below. `validate` plays build()'s arg-checking role since there is no
  // packet to build up front. look_at is NOT spatial: it rotates the bot, it
  // never moves it, so a look target outside the bounded region is not a
  // movement-safety concern the way a move_to target is.
  move_to: {
    spatial: true,
    stream: true,
    validate: (args) =>
      Number.isFinite(args.x) && Number.isFinite(args.y) && Number.isFinite(args.z)
        ? { ok: true }
        : refuse('move_to: x, y, z must be finite numbers'),
    precondition: (args, world) => (world.self.position ? { ok: true } : refuse('self position is not yet known')),
    estimateTicks: (args, world, config) => {
      const d = distance(world.self.position, args)
      return Math.max(1, Math.ceil(d / (config.moveSpeedPerTick ?? DEFAULT_WALK_SPEED_PER_TICK)) + 2)
    },
    run: (args, world, ctx) => runMovementStream('move_to', { x: args.x, y: args.y, z: args.z }, ctx),
  },

  look_at: {
    spatial: false,
    stream: true,
    validate: (args) =>
      Number.isFinite(args.x) && Number.isFinite(args.y) && Number.isFinite(args.z)
        ? { ok: true }
        : refuse('look_at: x, y, z must be finite numbers'),
    precondition: (args, world) => (world.self.position ? { ok: true } : refuse('self position is not yet known')),
    estimateTicks: () => LOOK_AT_TICK_COUNT,
    run: (args, world, ctx) => runMovementStream('look_at', { x: args.x, y: args.y, z: args.z }, ctx),
  },
}

export const ACTION_NAMES = Object.freeze(Object.keys(ACTIONS))

/**
 * @param {object} deps
 * @param {(name: string, params: object) => void} deps.client            client.write-shaped — only ever called when config.armed
 * @param {() => object} deps.getWorld                                     current #13 world state snapshot
 * @param {(predicate: (world: object) => boolean, timeoutMs: number) => Promise<object|null>} deps.waitForWorld
 *   resolves with the first world state matching predicate, or null on timeout. Owned by the caller (real wiring: subscribe
 *   to world updates in connect.js; tests: a controllable fake) — this module has no opinion on HOW world state is observed.
 * @param {(world: object) => void} [deps.setWorld]  #17: required only for move_to/look_at — applies the mover's own optimistic
 *   self-move (src/world.js applySelfMove) each tick, and is where a real correct_player_move_prediction lands via the SAME
 *   shared state in real wiring. No default: a caller that never uses move_to/look_at never needs it; one that does and
 *   forgets to wire it fails loudly on the first tick rather than silently mis-tracking position.
 * @param {(ms: number) => Promise<void>} [deps.sleep]  #17: the per-tick pacer for move_to/look_at. Defaults to a real setTimeout-based sleep.
 * @param {object} deps.config
 * @param {boolean} [deps.config.armed]             default false = dry-run
 * @param {{min:{x,y,z}, max:{x,y,z}}} [deps.config.region]
 * @param {Set<number>} [deps.config.breakWhitelist]
 * @param {number} [deps.config.maxReach]
 * @param {number} [deps.config.outcomeTimeoutMs]
 * @param {{maxActions:number, windowMs:number}} [deps.config.rateLimit]
 * @param {number} [deps.config.tickIntervalMs]     #17: player_auth_input send cadence, default 50ms/20Hz (unverified — see src/movement.js)
 * @param {number} [deps.config.moveSpeedPerTick]   #17: naive step size per tick, default ~walking speed (see src/movement.js)
 * @param {{record: (entry: object) => void}} [deps.audit]
 * @param {{info?, warn?, error?}} [deps.log]
 * @param {() => number} [deps.now]
 * @param {{tryConsume: () => boolean}} [deps.rateLimiter]                 injectable for tests; built from config.rateLimit otherwise
 */
export function createActionRunner({
  client,
  getWorld,
  waitForWorld,
  setWorld,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  config,
  audit = null,
  log = console,
  now = () => Date.now(),
  rateLimiter = null,
}) {
  const limiter =
    rateLimiter ?? createRateLimiter({ maxActions: config.rateLimit?.maxActions ?? 20, windowMs: config.rateLimit?.windowMs ?? 10_000, now })

  async function performAction(name, args = {}) {
    const record = (entry) => audit?.record?.({ ts: now(), action: name, args, ...entry })

    const spec = ACTIONS[name]
    if (!spec) {
      const result = refuse(`unknown action "${name}"`)
      log.warn?.('action.refused', result.reason)
      record(result)
      return result
    }

    if (!limiter.tryConsume()) {
      const result = refuse('rate limit exceeded')
      log.warn?.('action.refused', `${name}: ${result.reason}`)
      record(result)
      return result
    }

    const worldBefore = getWorld()

    if (spec.stream) {
      const argCheck = spec.validate(args)
      if (!argCheck.ok) {
        log.warn?.('action.refused', argCheck.reason)
        record(argCheck)
        return argCheck
      }

      if (spec.spatial) {
        const regionCheck = checkRegion(config.region, args)
        if (!regionCheck.ok) {
          log.warn?.('action.refused', `${name}: ${regionCheck.reason}`)
          record(regionCheck)
          return regionCheck
        }
      }

      const preCheck = spec.precondition(args, worldBefore, config)
      if (!preCheck.ok) {
        log.warn?.('action.refused', `${name}: ${preCheck.reason}`)
        record(preCheck)
        return preCheck
      }

      if (!config.armed) {
        const estimatedTicks = spec.estimateTicks(args, worldBefore, config)
        const result = { ok: true, dryRun: true, wouldWrite: [`player_auth_input ×~${estimatedTicks}`], estimatedTicks }
        log.info?.('action.dry_run', `${name}: would write ${result.wouldWrite[0]}`)
        record(result)
        return result
      }

      const streamResult = await spec.run(args, worldBefore, { client, getWorld, setWorld, sleep, config, log })
      log.info?.('action.written', `${name}: sent ${streamResult.ticksSent} player_auth_input tick(s)`)
      record(streamResult)
      return streamResult
    }

    let packets
    try {
      packets = spec.build(args, worldBefore)
    } catch (err) {
      const reason = err instanceof InvalidActionArgsError ? err.message : String(err?.message ?? err)
      const result = refuse(reason)
      log.warn?.('action.refused', reason)
      record(result)
      return result
    }

    if (spec.spatial) {
      const regionCheck = checkRegion(config.region, args)
      if (!regionCheck.ok) {
        log.warn?.('action.refused', `${name}: ${regionCheck.reason}`)
        record(regionCheck)
        return regionCheck
      }
    }

    const preCheck = spec.precondition(args, worldBefore, config)
    if (!preCheck.ok) {
      log.warn?.('action.refused', `${name}: ${preCheck.reason}`)
      record(preCheck)
      return preCheck
    }

    if (!config.armed) {
      const result = { ok: true, dryRun: true, wouldWrite: packets.map((p) => p.name) }
      log.info?.('action.dry_run', `${name}: would write ${result.wouldWrite.join(', ')}`)
      record(result)
      return result
    }

    for (const packet of packets) client.write(packet.name, packet.params)
    log.info?.('action.written', `${name}: wrote ${packets.map((p) => p.name).join(', ')}`)

    const timeoutMs = config.outcomeTimeoutMs ?? DEFAULT_OUTCOME_TIMEOUT_MS
    const confirmed = await spec.verify(args, { waitForWorld, timeoutMs, worldBefore })
    const result = confirmed
      ? { ok: true, dryRun: false }
      : { ok: false, timedOut: true, reason: `${name}: effect not confirmed from world state within ${timeoutMs}ms` }
    if (!confirmed) log.warn?.('action.unverified', result.reason)
    record(result)
    return result
  }

  return { performAction }
}
