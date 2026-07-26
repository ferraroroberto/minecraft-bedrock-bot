// Client version resolution.
//
// These were hardcoded in the spike (`1.26.30` / `1001`), which meant the bot
// would break the day Mojang shipped an update, with an opaque `6020` from the
// Realms API and nothing pointing at the cause.
//
// `minecraft-data` is already in the tree — it is a BedrockX dependency and the
// source of the protocol definitions the client actually speaks. Deriving both
// constants from it means we can never announce a version the client cannot
// speak, which a hardcoded pair can drift into silently.
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/**
 * Resolve the client version to announce.
 *
 * `MC_VERSION` / `PROTOCOL_VERSION` env vars override, for deliberate pinning —
 * if either is set, both are taken from the environment so they cannot end up
 * mismatched (announcing a version string with someone else's protocol number
 * is a confusing failure to debug).
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ version: string, protocolVersion: number, source: string }}
 */
export function resolveVersion(env = process.env) {
  if (env.MC_VERSION || env.PROTOCOL_VERSION) {
    if (!env.MC_VERSION || !env.PROTOCOL_VERSION) {
      throw new Error(
        'MC_VERSION and PROTOCOL_VERSION must be set together — setting only one risks ' +
        'announcing a version string with a mismatched protocol number.'
      )
    }
    const protocolVersion = Number(env.PROTOCOL_VERSION)
    if (!Number.isInteger(protocolVersion)) {
      throw new Error(`PROTOCOL_VERSION must be an integer, got "${env.PROTOCOL_VERSION}"`)
    }
    return { version: env.MC_VERSION, protocolVersion, source: 'env override' }
  }

  const newest = require('minecraft-data').versions.bedrock[0]
  if (!newest?.minecraftVersion || !Number.isInteger(newest.version)) {
    throw new Error('could not read the newest bedrock version from minecraft-data')
  }
  return {
    version: newest.minecraftVersion,
    protocolVersion: newest.version,
    source: 'minecraft-data',
  }
}
