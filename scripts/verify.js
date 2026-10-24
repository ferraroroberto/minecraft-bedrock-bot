// The repo's single pass/fail verification gate — `npm run verify`.
//
// Four stages, fail-fast:
//   1. `node --check` over every .js under src/ and scripts/ (the byte-compile
//      stage — the Node equivalent of the fleet's `python -m compileall`).
//   2. `node --test` over test/, with explicit file paths rather than a
//      directory arg so discovery behaviour can't shift between Node majors.
//   3. The vendored structure ratchet (scripts/structure_ratchet.py, stdlib
//      Python): file/function/directory growth and the root layout. Needs a
//      Python 3 on PATH or in .venv; only exit 0 passes, so exit 3 (NOT
//      CONFIRMED) and a missing Python both fail rather than skip.
//   4. The vendored instruction ratchet (scripts/instruction_ratchet.py): the
//      prompt-audit lint rules over CLAUDE.md and AGENTS.md. Same Python and
//      same exit rule as stage 3, and it needs Python 3.11+ for tomllib.
//
// Plain node, no shell: it must run identically on the Windows tower and on the
// Mac Mini, which is the production host. That is why there is no
// `verify-before-ship.ps1` here.
//
// Deliberately offline. A green gate means "nothing pure is broken" — it does
// NOT prove the bot can still reach the Realm; that needs a live `npm run
// spike`. See CLAUDE.md → "This repository".
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
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

/**
 * A Python 3 for the structure ratchet: the repo's .venv first, then the PATH
 * names the Windows tower and the Mac Mini each provide. Null when none runs.
 */
function findPython() {
  const candidates = [
    path.join(root, '.venv', 'Scripts', 'python.exe'),
    path.join(root, '.venv', 'bin', 'python'),
    'python3',
    'python',
  ]
  for (const candidate of candidates) {
    if (path.isAbsolute(candidate) && !existsSync(candidate)) continue
    const probe = spawnSync(candidate, ['-c', 'import sys; sys.exit(0 if sys.version_info[0] == 3 else 1)'], {
      cwd: root,
      stdio: 'ignore',
    })
    if (probe.status === 0) return candidate
  }
  return null
}

const sources = [...jsFilesIn('src'), ...jsFilesIn('scripts')]
const tests = jsFilesIn('test').filter((f) => f.endsWith('.test.js'))

console.log(`[verify] node ${process.version} on ${process.platform}`)

console.log(`[verify] stage 1/4 — node --check over ${sources.length} file(s)`)
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
console.log(`[verify] stage 2/4 — node --test over ${tests.length} file(s)`)
if (!run(['--test', '--test-timeout=15000', ...tests])) {
  console.error('[verify] FAILED — tests did not pass')
  process.exit(1)
}

const python = findPython()
if (!python) {
  console.error('[verify] FAILED — no Python 3 on PATH or in .venv; the ratchets cannot run')
  process.exit(1)
}
// Both ratchets are vendored from project-scaffolding and run as their own
// checks, each failing on any exit other than 0.
const ratchets = [
  ['stage 3/4 — structure ratchet', 'structure_ratchet'],
  ['stage 4/4 — instruction ratchet', 'instruction_ratchet'],
]
for (const [label, name] of ratchets) {
  console.log(`[verify] ${label}`)
  const ratchet = spawnSync(python, [`scripts/${name}.py`], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, PYTHONUTF8: '1' },
  })
  if (ratchet.error) throw ratchet.error
  if (ratchet.status !== 0) {
    console.error(`[verify] FAILED — ${name.replace('_', ' ')} exited ${ratchet.status}`)
    process.exit(1)
  }
}

console.log('[verify] OK — offline gate green (does NOT prove Realm connectivity)')
