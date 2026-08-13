// Mine block/item ids out of a recorded JSONL trace (#45).
//
// `npm run mine-farm-ids .secrets/trace-farm.jsonl`
//
// See README → "Wheat farming: measured block and item ids" for why these ids
// can't be derived from the protocol definition and for the two-mechanism
// story (items exact off `item_registry`, blocks mined behaviourally from the
// growth ladder).
//
// Reads BOTH block-change channels. `update_block` carries one block and calls
// the field `block_runtime_id`; `update_subchunk_blocks` carries a batch and
// calls it `runtime_id`. Mining only the first would silently miss whichever
// channel the server happens to use for crops — the very question a live
// capture is being spent to answer. (This script deliberately reads both;
// src/world.js's `reduce()` does not — see its header and README → "World
// state + packet recorder" for that known gap.)
//
// Streams line by line and pulls the packet name with a regex before parsing:
// these traces run to hundreds of megabytes, and JSON.parse on every line
// costs minutes where a match costs seconds (same discipline as
// scripts/trace-stats.js).
import fs from 'node:fs'
import readline from 'node:readline'

const args = process.argv.slice(2)
const filePath = args.find((a) => !a.startsWith('--'))
if (!filePath) {
  console.error('usage: node scripts/mine-farm-ids.js <trace.jsonl> [--items <regex>] [--near x,y,z] [--radius N] [--min-changes N]')
  process.exit(2)
}

function flag(name, fallback) {
  const prefix = `--${name}=`
  const inline = args.find((a) => a.startsWith(prefix))
  if (inline) return inline.slice(prefix.length)
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] && !args[index + 1].startsWith('--') ? args[index + 1] : fallback
}

// Default to the crop vocabulary #45 needs. Deliberately broader than wheat
// alone (hoe, bone_meal, farmland) so one capture answers the neighbouring
// questions too rather than costing a second live session to re-mine.
const itemPattern = new RegExp(flag('items', 'wheat|seed|farmland|hoe|bone_meal'), 'i')
const near = flag('near', null)?.split(',').map(Number)
const radius = Number(flag('radius', 16))
const minChanges = Number(flag('min-changes', 2))

const NAME_PATTERN = /"name":"([^"]+)"/
const BLOCK_PACKETS = new Set(['update_block', 'update_subchunk_blocks'])

/** Squared distance is enough for a radius filter and avoids a sqrt per block. */
function withinRadius(position) {
  if (!near || near.length !== 3 || near.some((n) => !Number.isFinite(n))) return true
  const [cx, cy, cz] = near
  const dx = position.x - cx
  const dy = position.y - cy
  const dz = position.z - cz
  return dx * dx + dy * dy + dz * dz <= radius * radius
}

/** position key -> { changes: [{ts, id, via}], ids: Set } */
const byPosition = new Map()
/** runtime id -> how many block changes carried it, across every position */
const idFrequency = new Map()
let items = null
let itemRegistrySeen = false
let firstTs = null
let lastTs = null
let blockChanges = 0

function recordChange(ts, position, id, via) {
  if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y) || !Number.isFinite(position.z)) return
  if (!Number.isFinite(id)) return
  if (!withinRadius(position)) return
  blockChanges++
  idFrequency.set(id, (idFrequency.get(id) ?? 0) + 1)
  const key = `${position.x},${position.y},${position.z}`
  const entry = byPosition.get(key) ?? { changes: [], ids: new Set() }
  entry.changes.push({ ts, id, via })
  entry.ids.add(id)
  byPosition.set(key, entry)
}

const input = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity })

for await (const line of input) {
  if (line === '') continue
  const match = NAME_PATTERN.exec(line)
  if (!match) continue
  const name = match[1]
  if (name !== 'item_registry' && !BLOCK_PACKETS.has(name)) continue

  let record
  try {
    record = JSON.parse(line)
  } catch {
    continue // a truncated final line on a hard-killed capture is not fatal
  }
  if (record.ts != null) {
    firstTs ??= record.ts
    lastTs = record.ts
  }

  if (name === 'item_registry') {
    itemRegistrySeen = true
    const states = record.packet?.itemstates
    if (Array.isArray(states)) {
      items = states
        .filter((state) => typeof state?.name === 'string' && itemPattern.test(state.name))
        .map((state) => ({ name: state.name, runtimeId: state.runtime_id }))
        .sort((a, b) => a.runtimeId - b.runtimeId)
    }
    continue
  }

  if (name === 'update_block') {
    recordChange(record.ts, record.packet?.position, record.packet?.block_runtime_id, 'update_block')
    continue
  }

  // update_subchunk_blocks: a batch, and its per-entry field is `runtime_id`.
  for (const block of record.packet?.blocks ?? []) {
    recordChange(record.ts, block?.position, block?.runtime_id, 'update_subchunk_blocks')
  }
}

const duration = firstTs != null && lastTs != null ? ((lastTs - firstTs) / 1000).toFixed(1) : '?'
console.log(`${filePath}: ${blockChanges} block change(s) over ${duration}s across ${byPosition.size} position(s)`)
if (near) console.log(`  (filtered to within ${radius} blocks of ${near.join(',')})`)

console.log('\n== item_registry ==')
if (!itemRegistrySeen) {
  // Worth saying loudly: this packet arrives once, right after login. Its
  // absence means the capture started late or the session never got that far,
  // not that the server has no item table.
  console.log('  NO item_registry packet in this trace — did the capture start before login completed?')
} else if (!items?.length) {
  console.log(`  item_registry present, but nothing matched /${itemPattern.source}/`)
} else {
  console.log('  name,network_id')
  for (const item of items) console.log(`  ${item.name},${item.runtimeId}`)
}

console.log('\n== block id transitions (positions that changed at least ' + minChanges + ' time(s)) ==')
const interesting = [...byPosition.entries()]
  .filter(([, entry]) => entry.changes.length >= minChanges)
  .sort((a, b) => b[1].changes.length - a[1].changes.length)
if (!interesting.length) {
  console.log('  none — no position changed that many times. Was any farm activity actually performed during the capture?')
}
for (const [key, entry] of interesting) {
  const base = entry.changes[0].ts
  const sequence = entry.changes.map((change) => `${change.id}@+${((change.ts - base) / 1000).toFixed(1)}s`).join(' -> ')
  console.log(`  (${key}) ${entry.changes.length} change(s), ${entry.ids.size} distinct: ${sequence}`)
}

console.log('\n== block runtime id frequency ==')
console.log('  block_runtime_id,changes,positions')
const positionsPerId = new Map()
for (const [key, entry] of byPosition) {
  for (const id of entry.ids) positionsPerId.set(id, (positionsPerId.get(id) ?? new Set()).add(key))
}
for (const [id, count] of [...idFrequency].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${id},${count},${positionsPerId.get(id)?.size ?? 0}`)
}
