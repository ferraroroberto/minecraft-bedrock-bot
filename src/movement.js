// Movement (#17): Bedrock's player_auth_input is fundamentally unlike every
// other action in #14's vocabulary — a client-driven, continuous PER-TICK
// packet asserting the client's own position, not a one-shot command. The
// packet name itself says so ("auth" — the client asserts authority over its
// own position each tick); the server only talks back
// (correct_player_move_prediction) when it disagrees. Silence is the
// PROTOCOL'S OWN success signal for accepted movement, not a gap in world
// modelling to work around — unlike chat (no ack at all) or use_item
// (ambiguous effect), this is how client-authoritative prediction is
// SUPPOSED to work. See src/perform-action.js for how that plays out in the
// outcome-verification design.
//
// Field names read off the pinned BedrockX fork's own protocol.json
// (node_modules/bedrockx/src/protocol/protocol.json, packet_player_auth_input
// and packet_correct_player_move_prediction) — not assumed. BedrockX itself
// has ZERO client-side implementation of player_auth_input (grep across its
// src/ turns up nothing but the protocol.json shape definition) — there is
// nothing to reuse or mirror; this sender is built from the wire format
// alone.
//
// Two assumptions this file makes that are NOT verified against a live
// packet capture — flag as such in any PR touching this file:
//   - Tick cadence: 50ms (20Hz), the standard Minecraft simulation tick
//     rate. Nothing in the pin states the CLIENT's expected send rate for
//     player_auth_input specifically; this is the conventional assumption,
//     not a measured one.
//   - Walk speed: ~0.2154 blocks/tick (Minecraft's normal walking speed,
//     4.317 blocks/s ÷ 20 ticks/s), used only to size the naive step and the
//     tick budget — not a claim about what the server will actually accept.
import { applySelfMove } from './world.js'

export const DEFAULT_TICK_INTERVAL_MS = 50
export const DEFAULT_WALK_SPEED_PER_TICK = 4.317 / 20

/** All input flags false/absent — every conditional sub-shape on the wire
 * (transaction, item_stack_request, the vehicle fields, block_action) is
 * gated by a switch on the matching input_data.* flag with no "false" case
 * and no explicit default in the pin; the COMPILED protodef switch (verified
 * in node_modules/protodef/src/datatypes/compiler-conditional.js) falls
 * through an unmatched case to `default: void` rather than throwing, so
 * omitting those fields entirely here is correct, not a guess.
 */
export function buildPlayerAuthInputPacket({ position, rotation, moveVector, tick, delta }) {
  return {
    name: 'player_auth_input',
    params: {
      pitch: rotation.pitch,
      yaw: rotation.yaw,
      position,
      move_vector: moveVector,
      head_yaw: rotation.yaw,
      input_data: {}, // bitflags: {} writes as all-zero — see writeBitflags in protodef/src/datatypes/utils.js
      input_mode: 'unknown',
      play_mode: 'normal',
      interaction_model: 'classic',
      interact_rotation: { x: 0, y: 0 },
      tick,
      delta,
      analogue_move_vector: moveVector,
      camera_orientation: { x: 0, y: 0, z: 0 },
      raw_move_vector: moveVector,
    },
  }
}

/** One naive straight-line step from `from` toward `to`, clamped to `maxStep` — never overshoots. */
export function stepToward(from, to, maxStep) {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const dz = to.z - from.z
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz)
  if (distance <= maxStep || distance === 0) return { ...to }
  const ratio = maxStep / distance
  return { x: from.x + dx * ratio, y: from.y + dy * ratio, z: from.z + dz * ratio }
}

export function distance3(a, b) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2)
}

/** Yaw/pitch toward `target` from `from`, matching Minecraft's atan2 convention (yaw=0 facing +Z south). */
export function rotationTowards(from, target) {
  const dx = target.x - from.x
  const dy = target.y - from.y
  const dz = target.z - from.z
  const yaw = (Math.atan2(-dx, dz) * 180) / Math.PI
  const horizontalDistance = Math.sqrt(dx * dx + dz * dz)
  const pitch = (-Math.atan2(dy, horizontalDistance) * 180) / Math.PI
  return { pitch, yaw }
}

/**
 * Signed difference between two angles in degrees, normalized into (-180, 180].
 *
 * Yaw is periodic and the server is free to report the SAME direction on the
 * other side of the discontinuity — a requested `-179` coming back corrected
 * as `181` is a 2° disagreement, not a 360° one. A raw subtraction reads it as
 * ~360 and fails a look_at that actually landed (#34).
 */
export function angleDiffDegrees(a, b) {
  const wrapped = ((((a - b + 180) % 360) + 360) % 360) - 180
  // The modulo above maps an exact half-turn to -180; report it as +180 so the
  // result is a true (-180, 180] and |diff| is the same either way round.
  return wrapped === -180 ? 180 : wrapped
}

/** How close counts as "arrived" — Bedrock float positions never land on an exact value. */
export const POSITION_TOLERANCE = 0.35
export const ROTATION_TOLERANCE_DEGREES = 5
/** look_at has no distance to cover — a short fixed burst is enough for the server to see it and, if it disagrees, correct it. */
export const LOOK_AT_TICK_COUNT = 3

function sameVec3(a, b, tolerance) {
  return distance3(a, b) <= tolerance
}

/**
 * Drive the per-tick player_auth_input loop for move_to/look_at, from the
 * FIRST tick to a final, world-state-verified result. This is where #14's
 * "never treat a written packet as success" rule meets a protocol that is
 * DESIGNED around client-asserted position — see this file's header. The
 * loop's own optimistic tick becomes the reported position (applySelfMove);
 * a real correct_player_move_prediction, if the server sends one, always
 * overrides it — and if the corrected position is not actually near the
 * target, that is reported as a failure, not silently accepted.
 *
 * @param {'move_to'|'look_at'} kind
 * @param {{x:number,y:number,z:number}} target
 * @param {object} ctx
 * @param {(name:string, params:object)=>void} ctx.client
 * @param {() => object} ctx.getWorld
 * @param {(world: object) => void} ctx.setWorld
 * @param {(ms:number) => Promise<void>} ctx.sleep
 * @param {object} [ctx.config]
 * @param {{info?,warn?}} [ctx.log]
 * @returns {Promise<{ok:boolean, reason?:string, ticksSent:number, corrected?:boolean}>}
 */
export async function runMovementStream(kind, target, { client, getWorld, setWorld, sleep, config = {}, log = console }) {
  const startWorld = getWorld()
  const startPos = startWorld.self.position
  const startRot = startWorld.self.rotation ?? { pitch: 0, yaw: 0 }
  const tickIntervalMs = config.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS
  const speedPerTick = config.moveSpeedPerTick ?? DEFAULT_WALK_SPEED_PER_TICK

  const isMove = kind === 'move_to'
  const totalDistance = isMove ? distance3(startPos, target) : 0
  const maxTicks = isMove ? Math.max(1, Math.ceil(totalDistance / speedPerTick) + 2) : LOOK_AT_TICK_COUNT
  const targetRotation = isMove ? null : rotationTowards(startPos, target)

  let currentPos = startPos
  let currentRot = startRot
  let ticksSent = 0
  let correctedPosition = null

  for (let i = 0; i < maxTicks; i++) {
    const nextPos = isMove ? stepToward(currentPos, target, speedPerTick) : currentPos
    const nextRot = isMove ? currentRot : targetRotation
    const delta = { x: nextPos.x - currentPos.x, y: nextPos.y - currentPos.y, z: nextPos.z - currentPos.z }
    // move_vector/analogue_move_vector/raw_move_vector encode analog-stick
    // INTENT, not the resulting displacement — this sender drives movement
    // via absolute position + delta instead (a real client would also set
    // move_vector; leaving it zero here is a known simplification, not
    // verified against how a live server scores it).
    const packet = buildPlayerAuthInputPacket({ position: nextPos, rotation: nextRot, moveVector: { x: 0, y: 0 }, tick: i + 1, delta })
    client.write(packet.name, packet.params)
    ticksSent += 1

    currentPos = nextPos
    currentRot = nextRot
    setWorld(applySelfMove(getWorld(), { position: currentPos, rotation: currentRot }))

    await sleep(tickIntervalMs)

    const afterTick = getWorld()
    if (afterTick.self.position && !sameVec3(afterTick.self.position, currentPos, 0.001)) {
      // A real correct_player_move_prediction landed mid-loop and this
      // world's reduce() already applied it (see world.js) — server truth,
      // stop sending ticks toward our own now-stale prediction.
      correctedPosition = afterTick.self.position
      currentPos = afterTick.self.position
      currentRot = afterTick.self.rotation ?? currentRot
      break
    }

    if (isMove && sameVec3(currentPos, target, POSITION_TOLERANCE)) break
  }

  if (isMove) {
    const arrived = sameVec3(currentPos, target, POSITION_TOLERANCE)
    if (!arrived) {
      const reason = correctedPosition
        ? `server corrected position to (${currentPos.x.toFixed(2)},${currentPos.y.toFixed(2)},${currentPos.z.toFixed(2)}), not within ${POSITION_TOLERANCE} of target`
        : `ran out of ticks (${ticksSent}) before reaching target and no correction arrived either`
      log.warn?.('movement.unverified', reason)
      return { ok: false, timedOut: true, reason, ticksSent, corrected: correctedPosition !== null }
    }
    return { ok: true, dryRun: false, ticksSent, corrected: correctedPosition !== null }
  }

  const rotationDiff =
    Math.abs(angleDiffDegrees(currentRot.yaw, targetRotation.yaw)) +
    Math.abs(angleDiffDegrees(currentRot.pitch, targetRotation.pitch))
  if (rotationDiff > ROTATION_TOLERANCE_DEGREES) {
    const reason = `server corrected rotation away from the requested look target (diff ${rotationDiff.toFixed(1)}°)`
    log.warn?.('movement.unverified', reason)
    return { ok: false, timedOut: true, reason, ticksSent, corrected: correctedPosition !== null }
  }
  return { ok: true, dryRun: false, ticksSent, corrected: correctedPosition !== null }
}
