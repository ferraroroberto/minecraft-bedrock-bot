// #11: the exit-code contract (src/supervise.js EXIT) is only real if the
// actual OS process exits with that code — a unit test asserting on
// supervise()'s RETURN VALUE never proves that. These spawn the real
// `node scripts/connect-spike.js` entry point as a genuine child process and
// assert on its real exit code, fully offline. Both paths run before any
// network call: version resolution, then the lock check.
//
// The third path (a hung/crashing exit after a LIVE, connected session) is
// not offline-testable — see #11's own "no live Realm connections" carve-out
// and README's BedrockX gotchas for what was measured live instead.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const entryPoint = path.join(projectRoot, 'scripts', 'connect-spike.js')

test('a version-resolution failure is a real, prompt, non-zero process exit (EXIT.TERMINAL_FAILURE)', () => {
  // MC_VERSION with no matching PROTOCOL_VERSION is refused by src/version.js
  // before any lock or network activity — see test/version.test.js. Delete
  // both first rather than relying on `undefined` filtering the key out of
  // the child's env — spawnSync does not guarantee that.
  const env = { ...process.env }
  delete env.MC_VERSION
  delete env.PROTOCOL_VERSION
  env.MC_VERSION = '1.26.30'

  const result = spawnSync(process.execPath, [entryPoint], {
    cwd: projectRoot,
    env,
    timeout: 15_000,
    encoding: 'utf8',
  })
  assert.equal(result.signal, null, 'must exit on its own, not be killed by the test timeout')
  assert.equal(result.status, 1)
})

test('a held lock is a real, prompt, non-zero process exit (EXIT.LOCK_HELD) — never fights the holder', () => {
  const secretsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-bot-secrets-'))
  // This test process is a real, currently-alive PID — exactly what
  // src/lock.js's defaultIsAlive(pid) checks for, so the child sees a live
  // holder rather than a stale lock to reclaim.
  fs.writeFileSync(path.join(secretsDir, 'bot.lock'), String(process.pid))

  try {
    const result = spawnSync(process.execPath, [entryPoint], {
      cwd: projectRoot,
      env: { ...process.env, BOT_SECRETS_DIR: secretsDir },
      timeout: 15_000,
      encoding: 'utf8',
    })
    assert.equal(result.signal, null, 'must exit on its own, not be killed by the test timeout')
    assert.equal(result.status, 2)
    assert.match(result.stdout + result.stderr, /already running/)
    // Never fights the holder — the lock file must be untouched.
    assert.equal(fs.readFileSync(path.join(secretsDir, 'bot.lock'), 'utf8'), String(process.pid))
  } finally {
    fs.rmSync(secretsDir, { recursive: true, force: true })
  }
})
