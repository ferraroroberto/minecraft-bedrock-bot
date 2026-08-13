// Opt-in JSONL packet trace.
//
// Default off (see .env.example RECORD_PACKETS). When enabled, appends one
// line per packet — inbound and outbound, minus the high-frequency entity
// churn `DEFAULT_EXCLUDED_PACKETS` drops (see its comment) — so the next time
// Roberto plays live, that run produces a real fixture corpus for #13 and
// every layer above it, at no extra cost and with no extra live run requested.
//
// Redaction is pattern-based, not a closed list of exact field names — a
// closed deny-list (token/xuid/networkId) would write a field nobody thought
// of to disk in the clear. `SENSITIVE_KEY_PATTERN` matches on SHAPE (does the
// key name look auth-shaped?) so a field the pinned protocol adds later still
// gets caught. Since any captured trace is meant to become a COMMITTED FIXTURE
// in a PUBLIC repo, treat under-redaction as a real risk, not a theoretical
// one — see test/recorder.test.js, which asserts on raw file bytes for a
// broader set of secret-shaped keys than this pattern is built from.
//
// The key/cert/signature/hash/bearer roots were added deliberately, not
// speculatively — BedrockX's own auth flow sends a `publicKey` field
// (node_modules/bedrockx/src/client/auth.js:8, `{ publicKey: client.
// clientX509 }`), i.e. this client's ECDH handshake already carries
// key/certificate-shaped fields the original three-word list did not cover.
import fs from 'node:fs'
import path from 'node:path'

const SENSITIVE_KEY_PATTERN = /token|xuid|xbox|address|session[_-]?id|invite|secret|credential|authoriz|key|cert|signature|hash|bearer/i
// NetherNet's network id is the CAMEL-CASE `networkId` — the transport GUID
// this client connects through (src/connect.js:100, `networkId: join.address`).
// Bedrock's own `network_id` is a completely different, non-secret field: the
// ITEM TYPE id carried on every inventory item. Folding both into one
// case-insensitive `network[_-]?id` alternative redacted every item in a
// recorded trace, so the trace could never serve as the inventory fixture
// corpus this recorder exists to produce — src/observation.js's
// describeInventory and src/goals.js's itemCountAtLeast both key off exactly
// that field (#34). Hence a case-SENSITIVE pattern for the NetherNet sense
// only; `network_id`/`network-id` deliberately fall through unredacted.
const SENSITIVE_CAMEL_KEY_PATTERN = /[Nn]etworkId/
const REDACTED = '[REDACTED]'

// Excluded by DEFAULT — the recorder is unusable without this. The first live
// capture (3m10s on 2026-08-11) wrote 357.6 MB across 449,066 packets, which
// puts a 20-minute farm-demo session at ~2.4 GB and blocked the recording #12
// depends on (#41). A bytes-per-type breakdown of that trace — not a
// packet-count one, since count is not volume: `level_chunk` is only 937
// packets but 17.5 MB of `JSON.stringify`-expanded buffers — says these three
// names are 91.2% of the bytes:
//
//   set_entity_data    189,521 pkts  253.32 MB  70.84%  (1,402 B/pkt)
//   move_entity_delta  195,342 pkts   61.80 MB  17.28%    (332 B/pkt)
//   set_entity_motion   57,341 pkts   11.04 MB   3.09%    (202 B/pkt)
//
// Dropping exactly these takes the same capture to 31.5 MB, of which ~27 MB is
// one-shot registries (`crafting_data`, `item_registry`, `creative_content`,
// `player_list`) and chunk streaming that scales with area explored, not with
// session length. The steady-state remainder is under 1 MB/min.
//
// The list stays deliberately NARROW, and every other name is kept. A filter
// that quietly drops something a later layer needs is a fixture gap discovered
// months later, and re-capturing costs a live Realm session Roberto has to run
// in person. All three are pure per-tick entity churn — position deltas,
// metadata flags and velocity for every mob in render distance — none of which
// any fixture consumer reads: src/world.js keys entities off `add_entity` /
// `remove_entity`, blocks off `update_block` / `update_subchunk_blocks`, and
// inventory off `inventory_content` / `inventory_slot`. Set
// RECORD_PACKETS_EXCLUDE=none to record everything anyway.
export const DEFAULT_EXCLUDED_PACKETS = Object.freeze([
  'set_entity_data',
  'move_entity_delta',
  'set_entity_motion',
])

/**
 * Read the `RECORD_PACKETS_EXCLUDE` env value into a list of packet names.
 *
 * Unset or blank means the documented default set, NOT "record everything" —
 * copying `.env.example` must not silently re-arm the 2.4 GB behaviour. The
 * explicit opt-out is the literal `none` (no Bedrock packet is named that).
 *
 * @param {string | undefined | null} raw
 * @returns {string[]}
 */
export function parseExcludeList(raw) {
  if (raw == null) return [...DEFAULT_EXCLUDED_PACKETS]
  const trimmed = raw.trim()
  if (trimmed === '') return [...DEFAULT_EXCLUDED_PACKETS]
  if (trimmed.toLowerCase() === 'none') return []
  return trimmed
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name !== '')
}

function isSensitiveKey(key) {
  return SENSITIVE_KEY_PATTERN.test(key) || SENSITIVE_CAMEL_KEY_PATTERN.test(key)
}

function redact(value) {
  // varint64/zigzag64/li64 fields decode to `BigInt` (src/world.js's header),
  // which most of a Bedrock packet's ids are — and `JSON.stringify` throws
  // `TypeError: Do not know how to serialize a BigInt`. Stringify it here so
  // the trace still writes instead of silently failing (#23).
  if (typeof value === 'bigint') return value.toString()
  if (Array.isArray(value)) return value.map(redact)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, v] of Object.entries(value)) {
      out[key] = isSensitiveKey(key) ? REDACTED : redact(v)
    }
    return out
  }
  return value
}

/**
 * @param {object} deps
 * @param {string} deps.filePath   appended to, created (with parent dirs) if missing
 * @param {Iterable<string>} [deps.exclude] packet names never written, in EITHER
 *   direction. Defaults to `DEFAULT_EXCLUDED_PACKETS`; pass `[]` for everything.
 * @param {() => number} [deps.now]
 * @param {typeof fs} [deps.fsImpl] injectable for tests
 */
export function createRecorder({
  filePath,
  exclude = DEFAULT_EXCLUDED_PACKETS,
  now = () => Date.now(),
  fsImpl = fs,
}) {
  fsImpl.mkdirSync(path.dirname(filePath), { recursive: true })
  const stream = fsImpl.createWriteStream(filePath, { flags: 'a' })
  // Filtered HERE rather than at connect.js's two hook sites so inbound and
  // outbound cannot drift apart, and so a future third call site inherits it.
  const excluded = new Set(exclude)

  function append(direction, name, packet) {
    if (excluded.has(name)) return
    stream.write(JSON.stringify({ ts: now(), direction, name, packet: redact(packet) }) + '\n')
  }

  return {
    /** The effective exclude set, for the caller to log — a trace read months later must be traceable to what was dropped. */
    excluded: Object.freeze([...excluded]),
    recordInbound: (name, packet) => append('inbound', name, packet),
    recordOutbound: (name, packet) => append('outbound', name, packet),
    /** @returns {Promise<void>} resolves once the stream has flushed and closed. */
    close: () => new Promise((resolve) => stream.end(resolve)),
  }
}
