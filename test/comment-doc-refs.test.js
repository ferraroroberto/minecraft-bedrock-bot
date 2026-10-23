// Structural check for the "stale doc pointer" class: a source, script, test or
// config comment that sends the reader to `README → "<section>"` or to a
// `docs/<topic>.md` file goes stale silently when the README is split or a doc
// is renamed — nothing re-checks the pointer, and it misleads the next reader
// about where the reasoning lives. This resolves every such pointer against the
// files and headings that actually exist.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const SELF = path.join('test', 'comment-doc-refs.test.js')

/** Every file under `dir` with one of `extensions`, as paths relative to the repo root. */
function filesIn(dir, extensions) {
  return readdirSync(path.join(root, dir), { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && extensions.some((ext) => e.name.endsWith(ext)))
    .map((e) => path.relative(root, path.join(e.parentPath ?? e.path, e.name)))
}

/** Markdown heading texts in `relPath`, ignoring `#` lines inside code fences. */
function headingsOf(relPath) {
  const headings = new Set()
  let inFence = false
  for (const line of readFileSync(path.join(root, relPath), 'utf8').split(/\r?\n/)) {
    if (/^\s*```/.test(line)) inFence = !inFence
    else if (!inFence) {
      const m = /^#{1,6}\s+(.+?)\s*$/.exec(line)
      if (m) headings.add(m[1].replaceAll('`', ''))
    }
  }
  return headings
}

/** File text with line-leading comment markers dropped and lines joined, so a pointer wrapped across comment lines still matches. */
function flattened(relPath) {
  return readFileSync(path.join(root, relPath), 'utf8')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(\/\/|\/\*\*?|\*|#)\s?/, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
}

const scanned = [
  ...filesIn('src', ['.js']),
  ...filesIn('scripts', ['.js']),
  ...filesIn('test', ['.js']),
  '.env.example',
].filter((f) => f !== SELF)

test('README → "<section>" pointers in comments name a heading that exists in README.md', () => {
  const readmeHeadings = headingsOf('README.md')
  const offenders = []
  for (const file of scanned) {
    // A bare "README" is only legitimate as "its README" (an external project's).
    const text = flattened(file).replace(/\bits README\b/g, '')
    for (const m of text.matchAll(/\bREADME(?!\.md)(?:\s*→\s*"([^"]+)")?/g)) {
      if (!m[1]) offenders.push(`${file}: bare "${m[0]}" — name a README → "<section>" or a docs/ file`)
      else if (!readmeHeadings.has(m[1].replaceAll('`', ''))) offenders.push(`${file}: README has no heading "${m[1]}"`)
    }
  }
  assert.deepEqual(offenders, [])
})

test('docs/<topic>.md pointers in comments name a file, and a heading within it, that exist', () => {
  const offenders = []
  for (const file of scanned) {
    for (const m of flattened(file).matchAll(/\b(docs\/[\w./-]+?\.md)(?:\s*→\s*"([^"]+)")?/g)) {
      if (!existsSync(path.join(root, m[1]))) offenders.push(`${file}: ${m[1]} does not exist`)
      else if (m[2] && !headingsOf(m[1]).has(m[2].replaceAll('`', ''))) {
        offenders.push(`${file}: ${m[1]} has no heading "${m[2]}"`)
      }
    }
  }
  assert.deepEqual(offenders, [])
})
