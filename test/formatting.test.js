import test from 'node:test'
import assert from 'node:assert/strict'
import { stripFormatting } from '../src/formatting.js'

test('strips the §r reset the server appends to chat source names', () => {
  assert.equal(stripFormatting('Roberto39764§r'), 'Roberto39764')
})

test('leaves an unformatted name untouched', () => {
  assert.equal(stripFormatting('Gizmo6082'), 'Gizmo6082')
})

test('strips codes mid-string and repeated codes', () => {
  assert.equal(stripFormatting('§ahello §lthere§r'), 'hello there')
  assert.equal(stripFormatting('§r§r§rname'), 'name')
})

test('consumes the character after §, whatever it is', () => {
  // The code is `§` + exactly one following character — including one that is
  // not a documented colour/style code.
  assert.equal(stripFormatting('a§§b'), 'ab')
  assert.equal(stripFormatting('§Zx'), 'x')
})

test('returns an empty string for null/undefined rather than throwing', () => {
  // These run inside packet handlers — a throw here drops the connection.
  assert.equal(stripFormatting(null), '')
  assert.equal(stripFormatting(undefined), '')
  assert.equal(stripFormatting(''), '')
})

test('coerces non-string input instead of throwing', () => {
  assert.equal(stripFormatting(1234), '1234')
})
