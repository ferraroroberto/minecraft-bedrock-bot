import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildPlayerAuthInputPacket,
  stepToward,
  distance3,
  rotationTowards,
  runMovementStream,
  angleDiffDegrees,
  POSITION_TOLERANCE,
  ROTATION_TOLERANCE_DEGREES,
  LOOK_AT_TICK_COUNT,
} from '../src/movement.js'
import { createWorldState } from '../src/world.js'

test('buildPlayerAuthInputPacket carries position/rotation/tick/delta with all input flags absent', () => {
  const { name, params } = buildPlayerAuthInputPacket({
    position: { x: 1, y: 64, z: 2 },
    rotation: { pitch: 5, yaw: 90 },
    moveVector: { x: 0, y: 1 },
    tick: 7,
    delta: { x: 0, y: 0, z: 0.2 },
  })
  assert.equal(name, 'player_auth_input')
  assert.deepEqual(params.position, { x: 1, y: 64, z: 2 })
  assert.equal(params.pitch, 5)
  assert.equal(params.yaw, 90)
  assert.equal(params.head_yaw, 90)
  assert.equal(params.tick, 7)
  assert.deepEqual(params.delta, { x: 0, y: 0, z: 0.2 })
  assert.deepEqual(params.input_data, {})
})

test('stepToward never overshoots and lands exactly on target within one step', () => {
  const from = { x: 0, y: 64, z: 0 }
  const to = { x: 10, y: 64, z: 0 }
  const step = stepToward(from, to, 0.2)
  assert.ok(distance3(from, step) <= 0.2 + 1e-9)
  assert.ok(distance3(step, to) < distance3(from, to))

  // Close enough that maxStep would overshoot — must land exactly on target, not past it.
  const nearlyThere = stepToward({ x: 9.9, y: 64, z: 0 }, to, 0.5)
  assert.deepEqual(nearlyThere, to)
})

test('rotationTowards points yaw/pitch at the target', () => {
  const from = { x: 0, y: 64, z: 0 }
  const straightNorth = rotationTowards(from, { x: 0, y: 64, z: -10 })
  assert.ok(Math.abs(straightNorth.pitch) < 1, 'level target — pitch near 0')
  const straightDown = rotationTowards(from, { x: 0, y: 54, z: 0 })
  assert.ok(straightDown.pitch > 45, 'a target 10 blocks straight down should pitch steeply')
})

function makeWorld({ position, rotation = { pitch: 0, yaw: 0 } }) {
  let state = createWorldState()
  state = { ...state, self: { ...state.self, position, rotation } }
  return state
}

function fakeCtx({ world, sleep = async () => {}, log = { info: () => {}, warn: () => {} } }) {
  const written = []
  let current = world
  return {
    written,
    client: { write: (name, params) => written.push({ name, params }) },
    getWorld: () => current,
    setWorld: (w) => { current = w },
    sleep,
    config: {},
    log,
    getCurrent: () => current,
  }
}

test('move_to sends ticks and succeeds once within tolerance, with no correction arriving (the intended silent-success case)', async () => {
  const ctx = fakeCtx({ world: makeWorld({ position: { x: 0, y: 64, z: 0 } }) })
  const result = await runMovementStream('move_to', { x: 1, y: 64, z: 0 }, ctx)
  assert.equal(result.ok, true)
  assert.equal(result.corrected, false)
  assert.ok(result.ticksSent > 0)
  assert.ok(ctx.written.every((w) => w.name === 'player_auth_input'))
  assert.ok(distance3(ctx.getCurrent().self.position, { x: 1, y: 64, z: 0 }) <= POSITION_TOLERANCE)
})

test('move_to accepts a server correction that still lands within tolerance of the target', async () => {
  let tickCount = 0
  const sleep = async () => {
    tickCount += 1
    if (tickCount === 1) {
      // Simulate a correct_player_move_prediction landing right after the first tick.
      ctx.setWorld({ ...ctx.getWorld(), self: { ...ctx.getWorld().self, position: { x: 0.95, y: 64, z: 0 } } })
    }
  }
  const ctx = fakeCtx({ world: makeWorld({ position: { x: 0, y: 64, z: 0 } }), sleep })
  const result = await runMovementStream('move_to', { x: 1, y: 64, z: 0 }, ctx)
  assert.equal(result.ok, true)
  assert.equal(result.corrected, true)
})

test('move_to reports FAILURE, not success, when the server corrects far away from the target', async () => {
  let tickCount = 0
  const sleep = async () => {
    tickCount += 1
    if (tickCount === 1) {
      ctx.setWorld({ ...ctx.getWorld(), self: { ...ctx.getWorld().self, position: { x: -5, y: 64, z: 0 } } })
    }
  }
  const ctx = fakeCtx({ world: makeWorld({ position: { x: 0, y: 64, z: 0 } }), sleep })
  const result = await runMovementStream('move_to', { x: 1, y: 64, z: 0 }, ctx)
  assert.equal(result.ok, false)
  assert.equal(result.timedOut, true)
  assert.match(result.reason, /server corrected position/)
})

test('look_at rotates in place — position never changes — and succeeds with no correction', async () => {
  const ctx = fakeCtx({ world: makeWorld({ position: { x: 0, y: 64, z: 0 } }) })
  const result = await runMovementStream('look_at', { x: 10, y: 64, z: 0 }, ctx)
  assert.equal(result.ok, true)
  assert.equal(result.ticksSent, LOOK_AT_TICK_COUNT)
  assert.deepEqual(ctx.getCurrent().self.position, { x: 0, y: 64, z: 0 })
  assert.ok(Math.abs(ctx.getCurrent().self.rotation.yaw - rotationTowards({ x: 0, y: 64, z: 0 }, { x: 10, y: 64, z: 0 }).yaw) < 0.01)
})

test('#34: angleDiffDegrees normalizes into (-180, 180] so the yaw wrap is not read as a full turn', () => {
  assert.equal(angleDiffDegrees(181, -179), 0, 'same direction, opposite sides of the discontinuity')
  assert.equal(angleDiffDegrees(-179, 181), 0)
  assert.equal(angleDiffDegrees(0, 0), 0)
  assert.equal(angleDiffDegrees(10, 0), 10)
  assert.equal(angleDiffDegrees(-10, 0), -10)
  assert.equal(angleDiffDegrees(370, 5), 5, 'a full extra turn is not a disagreement')
  assert.equal(Math.abs(angleDiffDegrees(180, 0)), 180, 'an exact half-turn is a real 180° disagreement')
  assert.equal(Math.abs(angleDiffDegrees(-180, 0)), 180)
})

/** A look_at whose server correction reports the same direction on the other side of the yaw wrap. */
async function lookAtWithCorrectedRotation({ yawOffset, pitchOffset = 0 }) {
  const start = { x: 0, y: 64, z: 0 }
  const target = { x: 1.745, y: 64, z: -100 } // yaw lands near -179 — right on the wrap
  const wanted = rotationTowards(start, target)
  let tickCount = 0
  const sleep = async () => {
    tickCount += 1
    if (tickCount === 1) {
      const world = ctx.getWorld()
      ctx.setWorld({
        ...world,
        self: {
          ...world.self,
          // Position must also move for the loop to notice a correction at all;
          // look_at only judges the rotation.
          position: { x: start.x + 0.5, y: start.y, z: start.z },
          rotation: { pitch: wanted.pitch + pitchOffset, yaw: wanted.yaw + yawOffset },
        },
      })
    }
  }
  const ctx = fakeCtx({ world: makeWorld({ position: start }), sleep })
  return runMovementStream('look_at', target, ctx)
}

test('#34: look_at accepts a correction that crosses the yaw discontinuity but points the same way', async () => {
  // Requested ~-179°, server reports ~181° — the SAME direction, 2° off. The
  // un-normalized subtraction read that as a ~362° diff and failed a look_at
  // that had actually landed.
  const result = await lookAtWithCorrectedRotation({ yawOffset: 360 + 2 })
  assert.equal(result.ok, true, `expected success, got: ${result.reason}`)
  assert.equal(result.corrected, true)
})

test('#34: look_at still reports FAILURE when the corrected rotation genuinely points elsewhere', async () => {
  const result = await lookAtWithCorrectedRotation({ yawOffset: 360 + ROTATION_TOLERANCE_DEGREES + 25 })
  assert.equal(result.ok, false)
  assert.equal(result.timedOut, true)
  assert.match(result.reason, /server corrected rotation/)
})
