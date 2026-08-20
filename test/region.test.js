import test from 'node:test'
import assert from 'node:assert/strict'
import { createRegionWatcher } from '../src/region.js'

test('the first resolve is never a change', () => {
  const watcher = createRegionWatcher()
  const first = watcher.note('NorthEurope')
  assert.equal(first.changed, false)
  assert.equal(first.previous, null)
  assert.equal(first.current, 'NorthEurope')
})

test('a differing region between attempts is reported with both names (#42)', () => {
  const watcher = createRegionWatcher()
  watcher.note('NorthEurope')
  const flip = watcher.note('UAENorth')
  assert.deepEqual(flip, { changed: true, previous: 'NorthEurope', current: 'UAENorth' })
  // The flip is reported once; retrying into the same region is not news.
  assert.equal(watcher.note('UAENorth').changed, false)
})

test('an unresolved region is not a change and does not forget the last known one', () => {
  // "NorthEurope → unknown" would be noise about our own parsing of the join
  // response, not about the Realm actually moving.
  const watcher = createRegionWatcher()
  watcher.note('NorthEurope')
  assert.equal(watcher.note(undefined).changed, false)
  assert.equal(watcher.current(), 'NorthEurope')
  assert.equal(watcher.note('UAENorth').changed, true)
})
