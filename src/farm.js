// Harvest-and-replant as a goal predicate over world state (#45).
//
// This is the domain layer: it composes #13's world model, #14's safety
// envelope and #15's goal contract with the wheat ids measured in
// src/blocks.js. It builds no packets and takes no actions — the loop chooses
// actions, performAction gates them, and this module only ever ANSWERS
// "is the farm in the desired state?" from observed blocks.
//
// THE PREDICATE IS THE POINT, so it is worth being precise about what it can
// honestly assert. #13's world model knows a block only if it watched that
// block CHANGE (src/world.js maps `update_block`; the chunk payload is never
// decoded). So the strongest true statement available is not "the farm is
// clear" — nothing in this codebase can see the whole farm — but:
//
//     every crop cell the bot has OBSERVED inside the region is neither
//     mature wheat nor empty.
//
// Saying that plainly matters more than it might look. A predicate that
// claimed to describe the entire farm would be lying about its own evidence,
// and the one thing #15 exists to prevent is a success claim that outruns what
// was actually verified.
//
// The same limitation is why this goal cannot yet clear a farm that was
// already standing when the bot joined: with nothing observed, there is
// nothing to harvest and nothing to assert. Chunk decoding (#49) is what turns
// this predicate from "the cells I watched" into "the farm".
//
// THE VACUOUS-TRUTH TRAP. "No observed cell is mature wheat" is trivially TRUE
// when nothing has been observed at all — and src/decision-loop.js evaluates
// the predicate BEFORE the first step precisely so an already-satisfied goal
// costs no model calls. A naive predicate therefore returns
// `ok: true, reason: "goal was already satisfied before any action was taken"`
// on a bot that has just joined, seen nothing, and done nothing: a false pass
// produced by the very check meant to make false passes impossible.
//
// Hence `minObservedCells`, and hence its default of 1: the goal additionally
// requires EVIDENCE that the farm was ever observed. Requiring evidence can
// only ever make a run fail, never falsely pass, which is the same asymmetry
// src/decision-loop.js's verify() applies to a throwing predicate.
import { MATURE_WHEAT, AIR } from './blocks.js'
import { defineGoal } from './goals.js'

/**
 * Build an axis-aligned region from two opposite corners, in either order.
 *
 * Takes corners rather than min/max because that is how a farm is actually
 * described by someone standing in it ("this corner to that corner"), and
 * silently mis-ordering min/max would produce a region that excludes
 * everything — a safety envelope that refuses every action looks identical to
 * a bot that is simply broken.
 *
 * @param {{x:number,y:number,z:number}} a
 * @param {{x:number,y:number,z:number}} b
 * @returns {{min:{x,y,z}, max:{x,y,z}}} shaped for src/safety.js checkRegion
 */
export function regionFromCorners(a, b) {
  return {
    min: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), z: Math.min(a.z, b.z) },
    max: { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y), z: Math.max(a.z, b.z) },
  }
}

function contains(region, x, y, z) {
  const { min, max } = region
  return x >= min.x && x <= max.x && y >= min.y && y <= max.y && z >= min.z && z <= max.z
}

/**
 * Every observed block inside `region`, as [{x, y, z, runtimeId}].
 *
 * Reads world.blocks directly rather than through getBlockAt() because the
 * question here is "what has been seen anywhere in this box", which a
 * coordinate-at-a-time lookup cannot answer without knowing the coordinates in
 * advance — and not knowing them is the entire situation.
 *
 * @param {object} world  a #13 world-state snapshot
 * @param {{min:object, max:object}} region
 */
export function observedCellsIn(world, region) {
  const cells = []
  for (const [key, runtimeId] of world.blocks) {
    const [x, y, z] = key.split(',').map(Number)
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue
    if (!contains(region, x, y, z)) continue
    cells.push({ x, y, z, runtimeId })
  }
  return cells
}

/**
 * A structured account of the farm as currently observed — the same numbers
 * the predicate decides on, exposed separately so a failure can be EXPLAINED
 * rather than just reported.
 *
 * Returned as data rather than a log line because both the goal predicate and
 * the human-facing summary need it, and computing it twice from the same world
 * is how the two drift into disagreeing about what happened.
 */
export function summarizeFarm(world, region) {
  const cells = observedCellsIn(world, region)
  const mature = cells.filter((cell) => cell.runtimeId === MATURE_WHEAT)
  const empty = cells.filter((cell) => cell.runtimeId === AIR)
  return { observed: cells.length, mature: mature.length, empty: empty.length, matureCells: mature, emptyCells: empty }
}

/**
 * The harvest-and-replant goal.
 *
 * Satisfied when, inside `region`: at least `minObservedCells` crop cells have
 * been observed, none of them is mature wheat (everything ripe was harvested),
 * and none of them is empty (everything harvested was replanted).
 *
 * Deliberately NOT satisfied by an empty observation — see this file's header
 * on the vacuous-truth trap.
 *
 * @param {object} options
 * @param {{min:object, max:object}} options.region
 * @param {number} [options.minObservedCells=1]
 * @param {string} [options.description]  overrides the generated natural-language description
 * @returns {{description: string, predicate: Function}}  via src/goals.js defineGoal
 */
export function harvestAndReplantGoal({ region, minObservedCells = 1, description } = {}) {
  if (!region?.min || !region?.max) {
    throw new TypeError('harvestAndReplantGoal needs a region — an unbounded wheat harvest is not a thing this bot may do')
  }
  const { min, max } = region
  // Routed through defineGoal rather than returned as a bare object: that is
  // where #15 ENFORCES the description+predicate pairing (it throws without a
  // predicate) and freezes the result. Constructing the same shape by hand
  // here would quietly opt this goal out of the one check that makes a goal a
  // goal.
  return defineGoal({
    description:
      description ??
      `Harvest every fully-grown wheat plant between (${min.x},${min.y},${min.z}) and (${max.x},${max.y},${max.z}), ` +
        'and replant seeds on every cell you clear. Leave no mature wheat standing and no farmland bare.',
    predicate: (world) => {
      const { observed, mature, empty } = summarizeFarm(world, region)
      return observed >= minObservedCells && mature === 0 && empty === 0
    },
  })
}
