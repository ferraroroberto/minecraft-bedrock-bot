// The safety envelope (#14): policy primitives applied to every action BELOW
// the LLM, in code — never "the prompt asks the model to be careful". This is
// Roberto's real survival base; a hallucinated coordinate must become a
// refused action, not a hope that the model behaves.
//
// Every function here is a pure predicate or a small stateful primitive
// (rate limiter). No packets, no client, no world coupling — src/actions.js
// owns protocol translation, src/perform-action.js owns wiring these into the
// performAction gate in the right order.

/**
 * Bounded operating region check. Refuses and names the region — never
 * clamps. Clamping would turn a clear bug (a hallucinated coordinate) into a
 * plausible-looking WRONG action, which defeats the point of the envelope.
 * @param {{min:{x,y,z}, max:{x,y,z}}|null|undefined} region  null/undefined = unbounded (not recommended; callers should always configure one for live use)
 * @param {{x:number, y:number, z:number}} target
 * @returns {{ok:true}|{ok:false, refused:true, reason:string}}
 */
export function checkRegion(region, target) {
  if (!region) return { ok: true }
  const { min, max } = region
  const inside =
    target.x >= min.x && target.x <= max.x &&
    target.y >= min.y && target.y <= max.y &&
    target.z >= min.z && target.z <= max.z
  if (inside) return { ok: true }
  return {
    ok: false,
    refused: true,
    reason:
      `(${target.x},${target.y},${target.z}) is outside the bounded operating region ` +
      `[${min.x},${min.y},${min.z}]–[${max.x},${max.y},${max.z}]`,
  }
}

/**
 * Block-breaking is deny-by-default (#14): an unconfigured or empty
 * whitelist allows nothing. The whitelist is keyed on `block_runtime_id`
 * (the raw id #13's world model stores) rather than a block name — #13's
 * world model deliberately does not decode the chunk palette
 * (src/world.js's header note), so a name-based whitelist is not available
 * yet without that stretch goal.
 * @param {Set<number>|null|undefined} whitelist
 * @param {number} blockRuntimeId
 */
export function checkBreakWhitelist(whitelist, blockRuntimeId) {
  if (whitelist && whitelist.has(blockRuntimeId)) return { ok: true }
  return {
    ok: false,
    refused: true,
    reason: `block_runtime_id ${blockRuntimeId} is not on the break whitelist (deny-by-default)`,
  }
}

/**
 * Fixed-window rate limiter so a runaway caller cannot execute thousands of
 * actions before anyone notices.
 * @param {{maxActions:number, windowMs:number, now?: () => number}} opts
 */
export function createRateLimiter({ maxActions, windowMs, now = () => Date.now() }) {
  const timestamps = []
  return {
    /** @returns {boolean} true if this call is allowed (and is now counted) */
    tryConsume() {
      const t = now()
      while (timestamps.length && t - timestamps[0] >= windowMs) timestamps.shift()
      if (timestamps.length >= maxActions) return false
      timestamps.push(t)
      return true
    },
  }
}

/** In-memory audit log: every action, its args, whether it was allowed, and why. */
export function createAuditLog() {
  const entries = []
  return {
    record(entry) {
      entries.push(entry)
    },
    get entries() {
      return entries.slice()
    },
  }
}

const STOP_COMMAND = 'bot stop'

/**
 * Chat kill-switch matcher. Inbound chat is untrusted input — including from
 * a player who is not Roberto, and including a message the Layer 3 goal path
 * (src/decision-loop.js, src/prompt.js, src/observation.js,
 * src/model-reply.js, src/goals.js) would otherwise ask an LLM to interpret
 * — so this matches a narrow literal command only, never something an LLM
 * parses or reasons about. That asymmetry is deliberate: `bot stop` stays a
 * narrow literal precisely because the goal path landing beside it in
 * src/connect.js's inbound 'text' handler is LLM-interpreted.
 * @param {string} message
 */
export function isStopCommand(message) {
  return typeof message === 'string' && message.trim().toLowerCase() === STOP_COMMAND
}
