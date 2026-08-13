import test from 'node:test'
import assert from 'node:assert/strict'
import {
  AIR,
  MATURE_WHEAT,
  WHEAT_STAGE_0,
  WHEAT_IMMATURE_OBSERVED,
  FARMLAND_CANDIDATES,
  ITEMS,
  wheatBreakWhitelist,
} from '../src/blocks.js'
import { checkBreakWhitelist } from '../src/safety.js'

test('every measured id is distinct', () => {
  // A copy-paste slip between two of these would be invisible in review and
  // catastrophic in effect — MATURE_WHEAT accidentally equal to WHEAT_STAGE_0
  // whitelists a freshly planted crop for breaking.
  const ids = [AIR, MATURE_WHEAT, ...WHEAT_IMMATURE_OBSERVED]
  assert.equal(new Set(ids).size, ids.length, 'two block constants share a value')
})

test('the break whitelist contains the mature stage and nothing else (#45)', () => {
  const whitelist = wheatBreakWhitelist()
  assert.deepEqual([...whitelist], [MATURE_WHEAT])
})

test('breaking mature wheat is allowed', () => {
  assert.equal(checkBreakWhitelist(wheatBreakWhitelist(), MATURE_WHEAT).ok, true)
})

test('breaking ANY immature stage is refused and says why (#45)', () => {
  // The safety criterion doubles as a correctness guard: breaking immature
  // wheat destroys the crop for no yield. Note this passes WITHOUT the
  // immature ids being enumerated anywhere in the whitelist — deny-by-default
  // refuses them for not being present, which is why src/blocks.js does not
  // need to know the six intermediate stage ids to be safe.
  for (const immature of WHEAT_IMMATURE_OBSERVED) {
    const result = checkBreakWhitelist(wheatBreakWhitelist(), immature)
    assert.equal(result.ok, false, `immature stage ${immature} must not be breakable`)
    assert.equal(result.refused, true)
    assert.match(result.reason, /deny-by-default/)
    assert.match(result.reason, new RegExp(String(immature)))
  }
})

test('an id never seen before is refused, not tolerated', () => {
  // The whole point of deny-by-default: a growth stage the capture never
  // reached, or a block from a future game version, refuses without anyone
  // having had to predict it.
  const neverObserved = 123456789
  assert.equal(checkBreakWhitelist(wheatBreakWhitelist(), neverObserved).ok, false)
})

test('air is not breakable', () => {
  assert.equal(checkBreakWhitelist(wheatBreakWhitelist(), AIR).ok, false)
})

test('the whitelist is a fresh Set per call, so one caller cannot widen another', () => {
  const first = wheatBreakWhitelist()
  first.add(999)
  assert.equal(wheatBreakWhitelist().has(999), false, 'the whitelist leaked mutable state between callers')
})

test('item ids are the ones the server registry named (#45)', () => {
  // Read from item_registry, not guessed — see src/blocks.js. Asserted
  // literally so a careless edit to the table fails here rather than in a
  // live session where the bot plants the wrong thing.
  assert.equal(ITEMS.WHEAT, 337)
  assert.equal(ITEMS.WHEAT_SEEDS, 291)
  assert.equal(ITEMS.BONE_MEAL, 414)
})

test('the unconfirmed farmland candidates are kept out of the safety envelope', () => {
  // They are exported for the record only. If one ever ends up whitelisted,
  // the bot would be breaking a block whose identity was never established by
  // a controlled observation.
  const whitelist = wheatBreakWhitelist()
  for (const candidate of FARMLAND_CANDIDATES) {
    assert.equal(whitelist.has(candidate), false, 'an unconfirmed id reached the break whitelist')
  }
})
