// The repo's single pass/fail verification gate — `npm run verify`.
//
// Fail-fast stages:
//   1. `node --check` over every .js under src/ and scripts/ (the byte-compile
//      stage — the Node equivalent of the fleet's `python -m compileall`).
//   2. `node --test` over test/, with explicit file paths rather than a
//      directory arg so discovery behaviour can't shift between Node majors.
//   3. The vendored structure ratchet (scripts/structure_ratchet.py, stdlib
//      Python): file/function/directory growth and the root layout. Needs a
//      Python 3.11+ on PATH or in .venv; only exit 0 passes, so exit 3 (NOT
//      CONFIRMED) and a missing Python both fail rather than skip.
//   4. The vendored instruction ratchet (scripts/instruction_ratchet.py): the
//      prompt-audit lint rules over CLAUDE.md and AGENTS.md. Same Python and
//      same exit rule as stage 3, and it needs Python 3.11+ for tomllib.
//   5. The vendored doc-refs ratchet (scripts/doc_refs_ratchet.py): a repo path
//      or relative link that README.md, CLAUDE.md or docs/ names and that no
//      longer exists. Same Python and exit rule as stages 3 and 4.
//   6. The vendored static ratchet (scripts/static_ratchet.py): duplicated code
//      (jscpd through npx) and ruff's unused-name and bug rules. Same exit rule,
//      plus Node's `npx` and `python -m ruff` must work on the gate host.
//   7. The vendored docs ratchet (scripts/docs_ratchet.py): README.md size and
//      the issue-number and changelog markers in README.md and docs/. Same
//      Python and exit rule as the other ratchets.
//   8. The vendored comment ratchet (scripts/comment_ratchet.py): issue-number
//      references in the comments of product code. Same Python and exit rule.
//   9. The vendored dead-code ratchet (scripts/dead_code_ratchet.py): Python
//      functions, classes and methods that nothing references. Same Python and
//      exit rule; it has nothing of its own to scan while the repo's code is JS.
//  10. The vendored conventions ratchet (scripts/conventions_ratchet.py): the
//      no-window and no-drive-path rules over tracked Python. Same Python and
//      exit rule, and likewise nothing of its own to scan while the code is JS.
//
// Plain node, no shell: it must run identically on the Windows tower and on the
// Mac Mini, which is the production host. That is why there is no
// `verify-before-ship.ps1` here.
//
// Never touches the Realm (offline apart from the first `npx` fetch of jscpd).
// A green gate means "nothing pure is broken" — it does NOT prove the bot can
// still reach the Realm; that needs a live `npm run spike`. See CLAUDE.md → "This repository".
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { RATCHETS, ratchetPassed } from './gate-ratchets.js'

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
 * A Python 3.11+ for the ratchets (they `import tomllib` at module load): the repo's .venv first, then the PATH
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
    const probe = spawnSync(candidate, ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)'], {
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

console.log(`[verify] stage 1/${RATCHETS.length + 2} — node --check over ${sources.length} file(s)`)
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
console.log(`[verify] stage 2/${RATCHETS.length + 2} — node --test over ${tests.length} file(s)`)
if (!run(['--test', '--test-timeout=15000', ...tests])) {
  console.error('[verify] FAILED — tests did not pass')
  process.exit(1)
}

const python = findPython()
if (!python) {
  console.error('[verify] FAILED — no Python 3.11+ on PATH or in .venv; the ratchets cannot run')
  process.exit(1)
}
// Every ratchet is vendored from project-scaffolding and run as its own check.
const ratchets = RATCHETS.map((name, i) => [`stage ${i + 3}/${RATCHETS.length + 2} — ${name.replace(/_/g, ' ')}`, name])
for (const [label, name] of ratchets) {
  console.log(`[verify] ${label}`)
  const ratchet = spawnSync(python, [`scripts/${name}.py`], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, PYTHONUTF8: '1' },
  })
  if (ratchet.error) throw ratchet.error
  if (!ratchetPassed(ratchet.status)) {
    console.error(`[verify] FAILED — ${name.replaceAll('_', ' ')} exited ${ratchet.status}`)
    process.exit(1)
  }
}

console.log('[verify] OK — offline gate green (does NOT prove Realm connectivity)')
