// The repo's single pass/fail verification gate — `npm run verify`.
//
// Two stages, fail-fast:
//   1. `node --check` over every .js under src/ and scripts/ (the byte-compile
//      stage — the Node equivalent of the fleet's `python -m compileall`).
//   2. `node --test` over test/, with explicit file paths rather than a
//      directory arg so discovery behaviour can't shift between Node majors.
//
// Plain node, no shell: it must run identically on the Windows tower and on the
// Mac Mini, which is the production host. That is why there is no
// `verify-before-ship.ps1` here.
//
// Deliberately offline. A green gate means "nothing pure is broken" — it does
// NOT prove the bot can still reach the Realm; that needs a live `npm run
// spike`. See CLAUDE.md → "This repository".
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Every .js file under `dir`, recursively, as paths relative to the repo root. */
function jsFilesIn(dir) {
  let entries
  try {
    entries = readdirSync(path.join(root, dir), { recursive: true, withFileTypes: true })
  } catch (err) {
    if (err.code === 'ENOENT') return []
    throw err
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.js'))
    .map((e) => path.relative(root, path.join(e.parentPath ?? e.path, e.name)))
    .sort()
}

/** Run a node subprocess to completion; return true on exit code 0. */
function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' })
  if (result.error) throw result.error
  return result.status === 0
}

const sources = [...jsFilesIn('src'), ...jsFilesIn('scripts')]
const tests = jsFilesIn('test').filter((f) => f.endsWith('.test.js'))

console.log(`[verify] node ${process.version} on ${process.platform}`)

console.log(`[verify] stage 1/2 — node --check over ${sources.length} file(s)`)
for (const file of sources) {
  if (!run(['--check', file])) {
    console.error(`[verify] FAILED — syntax error in ${file}`)
    process.exit(1)
  }
}

if (!tests.length) {
  // A gate that silently passes with no tests is the rot this exists to prevent.
  console.error('[verify] FAILED — no test files found under test/')
  process.exit(1)
}

// --test-timeout so a test that hangs (an async session that never settles)
// fails loudly instead of wedging the gate until someone kills it.
console.log(`[verify] stage 2/2 — node --test over ${tests.length} file(s)`)
if (!run(['--test', '--test-timeout=15000', ...tests])) {
  console.error('[verify] FAILED — tests did not pass')
  process.exit(1)
}

console.log('[verify] OK — offline gate green (does NOT prove Realm connectivity)')
