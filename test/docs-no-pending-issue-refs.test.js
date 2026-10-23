// Structural check for the "stale doc findings" class (issue #76): a doc line
// that leans on this repo's own open-issue tracker to describe current state
// — "tracked in #N", "gated on ... #N" — goes stale the moment that issue
// closes, silently, with nothing to re-check it. Two of the three findings in
// #76 were exactly this shape. Docs state the present-tense why; issue/PR
// history belongs to git and GitHub, never paraphrased into doc prose that
// then has to track a decision made elsewhere.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

/** This repo's own issues URL prefix, derived from package.json (never hardcoded). */
function ownIssuesUrlPrefix() {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
  const repoUrl = pkg.repository.url.replace(/\.git$/, '')
  return `${repoUrl}/issues/`
}

/** Every .md file under `dir`, recursively, as paths relative to the repo root. */
function markdownFilesIn(dir) {
  let entries
  try {
    entries = readdirSync(path.join(root, dir), { recursive: true, withFileTypes: true })
  } catch (err) {
    if (err.code === 'ENOENT') return []
    throw err
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => path.relative(root, path.join(e.parentPath ?? e.path, e.name)))
    .sort()
}

// Phrases that present an issue link as describing an open, still-pending
// decision or limitation rather than a settled, present-tense fact.
const PENDING_PHRASE = /\b(tracked in|track(?:ed|ing)? in|gated on|pending on|waiting on)\b/i

test('README.md and docs/**/*.md never cite this repo\'s own issue tracker as the reason something is still pending', () => {
  const issuesPrefix = ownIssuesUrlPrefix()
  const files = ['README.md', ...markdownFilesIn('docs')]
  const offenders = []

  for (const file of files) {
    const text = readFileSync(path.join(root, file), 'utf8')
    text.split('\n').forEach((line, i) => {
      if (line.includes(issuesPrefix) && PENDING_PHRASE.test(line)) {
        offenders.push(`${file}:${i + 1}`)
      }
    })
  }

  assert.deepEqual(
    offenders,
    [],
    `doc line(s) describe current state as pending on this repo's own issue tracker — ` +
      `that goes stale the instant the issue closes. State the current fact instead: ${offenders.join(', ')}`
  )
})
