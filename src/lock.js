// Single-instance guard.
//
// Only one connection per Xbox account is possible, ever — a second gets an
// immediate `server_id_conflict` kick. Two bot processes must therefore never
// run at once.
//
// The fleet's named-mutex pattern does NOT apply here: this runs on a Windows
// dev box AND on the macOS production host, and a Windows named mutex is
// meaningless on macOS. An exclusive lock file (`fs.open` with `wx`, which is
// atomic create-or-fail on both platforms) is the portable equivalent.
//
// IMPORTANT — what this guard CANNOT see: the Minecraft client signed into the
// same Xbox account on a console or PC, or a bot running on the *other*
// machine. Neither touches this file. `server_id_conflict` handling in the
// supervisor remains the real backstop; this only stops the local footgun of
// double-starting on one host.
import fs from 'node:fs'
import path from 'node:path'

/** Thrown when another live process already holds the lock. Never kill that process — it is probably legitimately running. */
export class LockHeldError extends Error {
  constructor(holderPid, lockPath) {
    super(
      `another bot instance is already running (PID ${holderPid}, lock ${lockPath}). ` +
      `Only one connection per Xbox account is possible. Stop that process first — ` +
      `this one is exiting rather than fighting it for the session.`
    )
    this.name = 'LockHeldError'
    this.holderPid = holderPid
    this.lockPath = lockPath
  }
}

/**
 * Is a PID currently alive? Signal 0 performs the permission/existence check
 * without delivering a signal.
 *
 * `EPERM` means the process exists but belongs to another user — alive, and
 * emphatically not ours to reclaim.
 */
export function defaultIsAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

/**
 * Acquire the single-instance lock, reclaiming it if the recorded holder is gone.
 *
 * @param {string} lockPath
 * @param {object} [options]
 * @param {number} [options.pid]
 * @param {(pid: number) => boolean} [options.isAlive] injectable for tests
 * @returns {{ release: () => void, path: string }}
 * @throws {LockHeldError} if a live process holds it
 */
export function acquireLock(
  lockPath,
  { pid = process.pid, isAlive = defaultIsAlive, readPid = readHolderPid } = {}
) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true })

  // A few passes: each EEXIST is either refused outright or resolved by
  // reclaiming one stale lock, so this converges rather than spinning.
  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
    try {
      const fd = fs.openSync(lockPath, 'wx')
      try {
        fs.writeSync(fd, String(pid))
      } finally {
        fs.closeSync(fd)
      }
      return makeHandle(lockPath, pid)
    } catch (err) {
      if (err.code !== 'EEXIST') throw err

      const holderPid = readHolderPidSettled(lockPath, readPid)

      if (holderPid !== null && holderPid !== pid && isAlive(holderPid)) {
        throw new LockHeldError(holderPid, lockPath)
      }

      try {
        fs.unlinkSync(lockPath)
      } catch (unlinkErr) {
        // Lost the race to another process reclaiming the same stale lock —
        // re-read on the next pass rather than assuming we won.
        if (unlinkErr.code !== 'ENOENT') throw unlinkErr
      }
    }
  }

  throw new Error(
    `could not acquire lock at ${lockPath} after ${MAX_ACQUIRE_ATTEMPTS} attempts — ` +
    `something is repeatedly recreating it`
  )
}

const MAX_ACQUIRE_ATTEMPTS = 4
/** How long to let a just-created lock file get its PID written before judging it garbage. */
const SETTLE_WINDOW_MS = 250

/**
 * Read the holder PID, tolerating a lock file caught mid-creation.
 *
 * `acquireLock` creates the file with `wx` and writes the PID as a separate
 * syscall, so for a brief moment a LIVE holder's lock is empty on disk. Treating
 * empty as "garbage, reclaim it" would let a second process delete a live
 * holder's lock and acquire alongside it — the exact double-connect the lock
 * exists to prevent. So an empty file is re-read across a short window before
 * being written off; only a file that stays unreadable is genuinely stale.
 */
function readHolderPidSettled(lockPath, readPid) {
  const deadline = Date.now() + SETTLE_WINDOW_MS
  for (;;) {
    const pid = readPid(lockPath)
    if (pid !== null) return pid
    // Gone entirely — the holder released it; nothing to reclaim.
    if (!fs.existsSync(lockPath)) return null
    if (Date.now() >= deadline) return null
    // Synchronous pause: this runs at most once, at startup, before anything
    // is connected, so blocking briefly is simpler and safer than going async.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
  }
}

function readHolderPid(lockPath) {
  try {
    const parsed = Number.parseInt(fs.readFileSync(lockPath, 'utf8').trim(), 10)
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null
  } catch {
    return null
  }
}

function makeHandle(lockPath, pid) {
  let released = false
  return {
    path: lockPath,
    /** Idempotent, and only ever removes a lock file still recording OUR pid. */
    release() {
      if (released) return
      released = true
      if (readHolderPid(lockPath) !== pid) return
      try {
        fs.unlinkSync(lockPath)
      } catch (err) {
        if (err.code !== 'ENOENT') throw err
      }
    },
  }
}
