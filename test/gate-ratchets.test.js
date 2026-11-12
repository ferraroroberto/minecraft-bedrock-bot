import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { RATCHETS, ratchetPassed } from '../scripts/gate-ratchets.js'

const fleetToml = readFileSync(new URL('../.fleet.toml', import.meta.url), 'utf8')

/** Names of the `[<x>_ratchet]` tables in .fleet.toml that carry `enabled = true`. */
function enabledRatchetTables() {
  const names = []
  const tableRe = /^\[(\w+_ratchet)\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/gm
  for (const [, name, body] of fleetToml.matchAll(tableRe)) {
    if (/^enabled\s*=\s*true\b/m.test(body)) names.push(name)
  }
  return names
}

test('every enabled ratchet table has a gate stage, and every stage an enabled table', () => {
  assert.deepEqual([...RATCHETS].sort(), enabledRatchetTables().sort())
})

test('every gate ratchet is vendored: the script exists and is declared in [vendored]', () => {
  for (const name of RATCHETS) {
    assert.ok(existsSync(new URL(`../scripts/${name}.py`, import.meta.url)), `scripts/${name}.py is missing`)
    assert.match(fleetToml, new RegExp(String.raw`^${name}\s*=\s*\{[^}]*dest = "scripts/${name}\.py"`, 'm'))
  }
})

test('README.md and CLAUDE.md describe every gate ratchet and the real stage range', () => {
  const claude = readFileSync(new URL('../CLAUDE.md', import.meta.url), 'utf8')
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  for (const name of RATCHETS) {
    const prose = new RegExp(name.replace(/_ratchet$/, '').replaceAll('_', '[-_ ]'))
    assert.match(readme, prose, `README.md does not mention the ${name} stage`)
    assert.match(claude, prose, `CLAUDE.md does not mention the ${name} stage`)
  }
  // Stage 1 is the syntax check and stage 2 the tests; the ratchets follow.
  assert.ok(claude.includes(`stages 3–${RATCHETS.length + 2}`), 'CLAUDE.md states a stale ratchet stage range')
})

test('only exit 0 passes a ratchet stage; exit 3 (NOT CONFIRMED) fails like exit 1', () => {
  assert.equal(ratchetPassed(0), true)
  for (const status of [1, 2, 3, null]) assert.equal(ratchetPassed(status), false, `exit ${status} must fail the gate`)
})
