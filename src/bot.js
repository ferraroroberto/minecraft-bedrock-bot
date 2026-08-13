// Entry point: wire the supervised bot together and run it.
import 'dotenv/config'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import authPkg from 'prismarine-auth'
import realmsPkg from 'prismarine-realms'
import bedrockx from 'bedrockx'

import { createLogger } from './log.js'
import { createBackoff } from './backoff.js'
import { acquireLock, LockHeldError } from './lock.js'
import { resolveVersion } from './version.js'
import { runSession } from './connect.js'
import { createFaultGuard } from './faults.js'
import { supervise, EXIT } from './supervise.js'
import { createRecorder, parseExcludeList } from './recorder.js'

const { Authflow, Titles } = authPkg
const { RealmAPI } = realmsPkg
const { createClient } = bedrockx

const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
// BOT_SECRETS_DIR exists purely so #11's exit-code regression test can spawn
// a REAL `node scripts/connect-spike.js` child process and drive it into the
// lock-held path without touching this project's real .secrets/bot.lock —
// unset in every normal run.
const secretsDir = process.env.BOT_SECRETS_DIR ? path.resolve(process.env.BOT_SECRETS_DIR) : path.join(projectRoot, '.secrets')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export async function main() {
  const log = createLogger()
  const username = process.env.BOT_USERNAME || 'MinecraftBot'
  const profilesFolder = path.join(secretsDir, 'xbox-auth')
  const lockPath = path.join(secretsDir, 'bot.lock')

  let version
  try {
    version = resolveVersion()
  } catch (err) {
    log.error('fatal.version', String(err?.message ?? err))
    return EXIT.TERMINAL_FAILURE
  }
  log.info('version', `announcing ${version.version} (protocol ${version.protocolVersion}) from ${version.source}`)

  let lock
  try {
    lock = acquireLock(lockPath)
  } catch (err) {
    if (err instanceof LockHeldError) {
      log.error('fatal.lock_held', err.message)
      return EXIT.LOCK_HELD
    }
    throw err
  }
  log.info('lock', `acquired ${lockPath} (pid ${process.pid})`)

  // Listeners let an in-flight session end immediately on Ctrl-C, rather than
  // the flag only being noticed between attempts.
  const stopListeners = new Set()
  const stopSignal = {
    stopped: false,
    onStop(cb) {
      stopListeners.add(cb)
      return () => stopListeners.delete(cb)
    },
  }
  const onSignal = (signal) => () => {
    // Second Ctrl-C should not be ignored, so only the first is graceful.
    if (stopSignal.stopped) process.exit(EXIT.OK)
    stopSignal.stopped = true
    log.info('signal', `${signal} received — closing the connection and exiting`)
    for (const cb of stopListeners) cb()
  }
  const sigint = onSignal('SIGINT')
  const sigterm = onSignal('SIGTERM')
  process.on('SIGINT', sigint)
  process.on('SIGTERM', sigterm)

  const authflow = new Authflow(username, profilesFolder, {
    authTitle: Titles.MinecraftNintendoSwitch,
    deviceType: 'Nintendo',
    flow: 'live',
  })
  const api = RealmAPI.from(authflow, 'bedrock', { minecraftVersion: version.version })

  const context = {
    tokenCachePath: profilesFolder,
    clientVersion: version.version,
    protocolVersion: version.protocolVersion,
  }

  const faultGuard = createFaultGuard({ log })
  const backoff = createBackoff()

  // Opt-in packet trace (see .env.example RECORD_PACKETS), default off. One
  // recorder for the whole process lifetime — not per-session — so a trace
  // spanning several reconnects lands in a single continuous file.
  const recordPath = process.env.RECORD_PACKETS
  const recorder = recordPath
    ? createRecorder({
        filePath: recordPath,
        exclude: parseExcludeList(process.env.RECORD_PACKETS_EXCLUDE),
      })
    : null
  if (recorder) {
    // The exclude set is logged, not just applied: a trace opened months from
    // now is only trustworthy as a fixture corpus if what it omits is on the
    // record (#41).
    const dropped = recorder.excluded.length ? recorder.excluded.join(', ') : 'nothing'
    log.info('recorder', `recording packets to ${recordPath} (excluding: ${dropped})`)
  }

  // Stray faults from torn-down clients are swallowed only inside this window.
  faultGuard.setSupervising(true)
  try {
    return await supervise({
      log,
      sleep,
      backoff,
      stopSignal,
      runSession: () =>
        runSession({
          api,
          createClient,
          authflow,
          username,
          profilesFolder,
          realmId: process.env.REALM_ID,
          version,
          log,
          context,
          stopSignal,
          faultSignal: faultGuard.faultSignal,
          recorder,
        }),
    })
  } finally {
    faultGuard.setSupervising(false)
    faultGuard.dispose()
    process.off('SIGINT', sigint)
    process.off('SIGTERM', sigterm)
    lock.release()
    log.info('lock', 'released')
    await recorder?.close()
    // #11 breadcrumb: everything WE own is torn down at this point. Anything
    // still listed here is third-party async cleanup outside our control
    // (see scripts/connect-spike.js, which force-exits right after this
    // resolves rather than wait on it) — logged only when non-empty so the
    // next incident that isn't this one is still diagnosable from the log.
    const activeResources = process.getActiveResourcesInfo()
    if (activeResources.length) log.info('diagnostic.active_resources', JSON.stringify(activeResources))
  }
}
