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
export function acquireLock(lockPath, { pid = process.pid, isAlive = defaultIsAlive } = {}) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true })

  // Two passes at most: the second only ever runs after a stale lock is cleared,
  // so this cannot spin.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(lockPath, 'wx')
      fs.writeSync(fd, String(pid))
      fs.closeSync(fd)
      return makeHandle(lockPath, pid)
    } catch (err) {
      if (err.code !== 'EEXIST') throw err

      const holderPid = readHolderPid(lockPath)

      // An unreadable/garbage lock file can never be matched to a live process,
      // so treat it as stale rather than deadlocking on it forever.
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

  throw new Error(`could not acquire lock at ${lockPath} after reclaiming a stale one`)
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
