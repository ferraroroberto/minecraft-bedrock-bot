// Structural check for the "duplicated sections" class (issue #103, recurring):
// CLAUDE.md and docs/layout.md had each grown their own per-ratchet bullet,
// naming every ratchet by stage ordinal and restating what `.fleet.toml`'s
// per-table comments and `scripts/gate-ratchets.js` already say — four
// hand-kept copies of the same stage list that had already started to drift
// (verify.js said stage 3 needed "a Python 3" while the docs said 3.11+).
// The ordered stage list lives in one place (`scripts/gate-ratchets.js`); what
// each ratchet checks lives in one place (`.fleet.toml`'s per-table comment).
// A doc file may summarise the ratchet names on a single line, but a per-
// ratchet ordinal breakdown ("(stage 4)", "is the fifth") is the duplication
// shape itself, so this fails the instant it comes back.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

// Matches the two ordinal shapes the duplicated bullets used: a parenthesised
// numeric stage ("(stage 4)") and a written ordinal introducing a stage
// ("is the fifth:"). Case-insensitive, since prose varies.
const STAGE_ORDINAL = /\(stage \d+\)|\bis the (?:third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\b/i

const GUARDED_FILES = ['CLAUDE.md', 'README.md', 'docs/layout.md']

test('no doc file restates the per-ratchet stage-ordinal breakdown that scripts/gate-ratchets.js and .fleet.toml already own', () => {
  const offenders = []
  for (const file of GUARDED_FILES) {
    const text = readFileSync(path.join(root, file), 'utf8')
    text.split('\n').forEach((line, i) => {
      if (STAGE_ORDINAL.test(line)) offenders.push(`${file}:${i + 1}`)
    })
  }

  assert.deepEqual(
    offenders,
    [],
    `doc line(s) tag a ratchet with its own stage ordinal — that is the duplicated-section shape ` +
      `this check guards against. Name the ratchets once, on one line, and point at .fleet.toml for ` +
      `per-ratchet detail and scripts/gate-ratchets.js for the ordered list: ${offenders.join(', ')}`
  )
})
