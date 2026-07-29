import test from 'node:test'
import assert from 'node:assert/strict'
import { defineGoal, atPosition, blockAtIs, itemCountAtLeast, InvalidGoalError } from '../src/goals.js'
import { createFakeWorld } from '../src/fake-world.js'

test('a goal with no success predicate cannot be constructed at all', () => {
  // Enforced, not documented: it must be impossible to start a run whose only
  // available evidence of success is the model saying so.
  assert.throws(
    () => defineGoal({ description: 'harvest the wheat' }),
    (err) => err instanceof InvalidGoalError && /no mechanical way to verify it from world state/.test(err.message)
  )
})

test('a goal with no description is refused too', () => {
  assert.throws(() => defineGoal({ predicate: () => true }), /non-empty natural-language description/)
  assert.throws(() => defineGoal({ description: '   ', predicate: () => true }), /non-empty natural-language description/)
})

test('a valid goal is frozen so it cannot be swapped out mid-run', () => {
  const goal = defineGoal({ description: '  go home  ', predicate: () => true })
  assert.equal(goal.description, 'go home')
  assert.throws(() => {
    goal.predicate = () => false
  }, TypeError)
})

test('atPosition measures against tracked position, within tolerance', () => {
  const world = createFakeWorld({ position: { x: 10, y: 64, z: -5 } }).getWorld()
  assert.equal(atPosition({ x: 10, y: 64, z: -5 })(world), true)
  assert.equal(atPosition({ x: 10.2, y: 64, z: -5 })(world), true, 'float positions never land exactly')
  assert.equal(atPosition({ x: 12, y: 64, z: -5 })(world), false)
})

test('atPosition is false when the position is not known yet — never "probably fine"', () => {
  const world = { self: { position: null } }
  assert.equal(atPosition({ x: 0, y: 0, z: 0 })(world), false)
})

test('blockAtIs is false for a block that was never observed', () => {
  const world = createFakeWorld({ blocks: { '1,64,2': 7 } }).getWorld()
  assert.equal(blockAtIs(1, 64, 2, 7)(world), true)
  assert.equal(blockAtIs(1, 64, 2, 0)(world), false)
  assert.equal(blockAtIs(5, 5, 5, 0)(world), false, 'never seen is not the same as air')
})

test('itemCountAtLeast totals a network id across the inventory', () => {
  const world = createFakeWorld({
    inventory: [{ network_id: 5, count: 3 }, { network_id: 9, count: 1 }, { network_id: 5, count: 4 }],
  }).getWorld()

  assert.equal(itemCountAtLeast(5, 7)(world), true)
  assert.equal(itemCountAtLeast(5, 8)(world), false)
  assert.equal(itemCountAtLeast(9, 1)(world), true)
  assert.equal(itemCountAtLeast(404, 1)(world), false)
})
