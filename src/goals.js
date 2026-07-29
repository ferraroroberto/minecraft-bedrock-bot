// Goals (#15, Layer 3): a natural-language description paired with a
// PROGRAMMATIC SUCCESS PREDICATE evaluated against world state.
//
// The pairing is the whole point, and it is enforced rather than documented:
// defineGoal THROWS without a predicate. "A goal with no mechanical predicate
// is not a valid goal for this loop" (#15) — so it is impossible to construct
// one and discover at the end of a run that the only available evidence of
// success was the model saying so.
//
// A predicate reads world state and returns a boolean. It never reads the
// model's output, and nothing here gives it a way to.
import { getBlockAt } from './world.js'
import { distance3, POSITION_TOLERANCE } from './movement.js'

export class InvalidGoalError extends Error {
  constructor(reason) {
    super(reason)
    this.name = 'InvalidGoalError'
  }
}

/**
 * @param {{description: string, predicate: (world: object) => boolean}} goal
 * @returns {{description: string, predicate: Function}} frozen
 * @throws {InvalidGoalError}
 */
export function defineGoal({ description, predicate } = {}) {
  if (typeof description !== 'string' || !description.trim()) {
    throw new InvalidGoalError('a goal needs a non-empty natural-language description')
  }
  if (typeof predicate !== 'function') {
    throw new InvalidGoalError(
      `goal "${description}" has no success predicate — a goal with no mechanical way to verify it from world state ` +
        'is not a valid goal for this loop (the model must never be the judge of its own success)'
    )
  }
  return Object.freeze({ description: description.trim(), predicate })
}

/** True when the bot's tracked position is within `tolerance` of (x,y,z). */
export function atPosition({ x, y, z }, tolerance = POSITION_TOLERANCE) {
  return (world) => {
    const position = world.self.position
    return Boolean(position) && distance3(position, { x, y, z }) <= tolerance
  }
}

/** True when the block observed at (x,y,z) has `runtimeId`. Never seen = false, not "probably fine". */
export function blockAtIs(x, y, z, runtimeId) {
  return (world) => getBlockAt(world, x, y, z) === runtimeId
}

/** True when the bot's inventory holds at least `count` of item `networkId` in total. */
export function itemCountAtLeast(networkId, count) {
  return (world) => {
    const slots = Array.isArray(world.inventory.windows?.inventory) ? world.inventory.windows.inventory : []
    let total = 0
    for (const item of slots) {
      if (item && item.network_id === networkId && Number.isFinite(item.count)) total += item.count
    }
    return total >= count
  }
}
