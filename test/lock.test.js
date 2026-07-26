import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { acquireLock, LockHeldError, defaultIsAlive } from '../src/lock.js'

// Real files in a temp dir — offline, fast, and exercises the actual atomic
// `wx` open rather than a mock of it. Liveness is injected so no real process
// is ever signalled.
function tempLockPath(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-lock-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return path.join(dir, 'nested', 'bot.lock')
}

test('acquires a lock and records the pid, creating parent dirs', (t) => {
  const lockPath = tempLockPath(t)
  const handle = acquireLock(lockPath, { pid: 4242, isAlive: () => false })
  assert.equal(fs.readFileSync(lockPath, 'utf8'), '4242')
  handle.release()
  assert.equal(fs.existsSync(lockPath), false)
})

test('a second instance is REFUSED while the holder is alive', (t) => {
  const lockPath = tempLockPath(t)
  acquireLock(lockPath, { pid: 1111, isAlive: () => true })

  let err
  try {
    acquireLock(lockPath, { pid: 2222, isAlive: () => true })
    assert.fail('expected the second instance to be refused')
  } catch (caught) {
    err = caught
  }
  assert.ok(err instanceof LockHeldError)
  assert.equal(err.holderPid, 1111)
  // Must name the holder so the user can act on it.
  assert.match(err.message, /PID 1111/)
  // Never kill the holder — it is probably a legitimately running bot.
  assert.equal(fs.readFileSync(lockPath, 'utf8'), '1111', 'holder lock must be untouched')
})

test('a STALE lock from a dead process is reclaimed without manual cleanup', (t) => {
  const lockPath = tempLockPath(t)
  acquireLock(lockPath, { pid: 1111, isAlive: () => true })
  // Simulates `kill -9` on the holder: the file survives, the process does not.
  const handle = acquireLock(lockPath, { pid: 2222, isAlive: () => false })
  assert.equal(fs.readFileSync(lockPath, 'utf8'), '2222')
  handle.release()
})

test('a garbage lock file is treated as stale, not a permanent deadlock', (t) => {
  const lockPath = tempLockPath(t)
  fs.mkdirSync(path.dirname(lockPath), { recursive: true })
  fs.writeFileSync(lockPath, 'not-a-pid')
  // An unparseable pid can never be matched to a live process, so refusing
  // forever would need manual cleanup on every crash mid-write.
  const handle = acquireLock(lockPath, { pid: 7, isAlive: () => true })
  assert.equal(fs.readFileSync(lockPath, 'utf8'), '7')
  handle.release()
})

test('an empty lock file is reclaimed', (t) => {
  const lockPath = tempLockPath(t)
  fs.mkdirSync(path.dirname(lockPath), { recursive: true })
  fs.writeFileSync(lockPath, '')
  acquireLock(lockPath, { pid: 9, isAlive: () => true }).release()
})

test('release is idempotent', (t) => {
  const lockPath = tempLockPath(t)
  const handle = acquireLock(lockPath, { pid: 5, isAlive: () => false })
  handle.release()
  handle.release()
  assert.doesNotThrow(() => handle.release())
})

test('release never deletes a lock another process has since taken', (t) => {
  const lockPath = tempLockPath(t)
  const mine = acquireLock(lockPath, { pid: 100, isAlive: () => false })
  // Our process died and someone else reclaimed; a late release must not
  // delete THEIR lock and let a third instance in.
  fs.writeFileSync(lockPath, '200')
  mine.release()
  assert.equal(fs.readFileSync(lockPath, 'utf8'), '200')
})

test('re-acquiring our own pid succeeds rather than deadlocking on ourselves', (t) => {
  const lockPath = tempLockPath(t)
  acquireLock(lockPath, { pid: 321, isAlive: () => true })
  assert.doesNotThrow(() => acquireLock(lockPath, { pid: 321, isAlive: () => true }))
})

test('defaultIsAlive reports true for this process and false for an unused pid', () => {
  assert.equal(defaultIsAlive(process.pid), true)
  // 2^22 is above every platform's default pid_max, so it cannot be in use.
  assert.equal(defaultIsAlive(4194304), false)
})

test('an EMPTY lock file is NOT stolen from a live holder mid-write', (t) => {
  // The TOCTOU this closes: acquireLock creates the file with `wx` and writes
  // the PID as a SEPARATE syscall, so a live holder's lock is briefly empty on
  // disk. Treating empty as reclaimable garbage let a second process delete a
  // live lock and connect alongside it — the exact double-connect the lock
  // exists to prevent.
  //
  // The holder is another PROCESS, so its write lands independently of our
  // event loop; `readPid` is injected to model that deterministically (a
  // setTimeout could not fire, since the settle loop blocks synchronously).
  const lockPath = tempLockPath(t)
  fs.mkdirSync(path.dirname(lockPath), { recursive: true })
  fs.writeFileSync(lockPath, '') // holder caught between open and write

  let reads = 0
  const readPid = () => (++reads >= 3 ? 1111 : null) // holder finishes writing

  let err
  try {
    acquireLock(lockPath, { pid: 2222, isAlive: () => true, readPid })
  } catch (caught) {
    err = caught
  }
  assert.ok(err instanceof LockHeldError, 'must refuse, not steal the lock')
  assert.equal(err.holderPid, 1111)
  assert.equal(fs.readFileSync(lockPath, 'utf8'), '', "holder's lock must not be deleted")
})

test('a lock that stays empty IS reclaimed, so a crash mid-write is recoverable', (t) => {
  // The other side of the same coin: if nobody ever writes a PID, the file is
  // genuinely garbage and must not deadlock the bot forever.
  const lockPath = tempLockPath(t)
  fs.mkdirSync(path.dirname(lockPath), { recursive: true })
  fs.writeFileSync(lockPath, '')
  const handle = acquireLock(lockPath, { pid: 3333, isAlive: () => true })
  assert.equal(fs.readFileSync(lockPath, 'utf8'), '3333')
  handle.release()
})
