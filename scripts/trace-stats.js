// Count + byte volume per packet type over a recorded JSONL trace.
//
// `npm run trace-stats .secrets/trace.jsonl`
//
// This is the analysis that chose src/recorder.js's DEFAULT_EXCLUDED_PACKETS
// (#41), and the one to re-run after a capture with the filter active to
// confirm the signal packets — update_block, level_chunk, add_entity,
// inventory_content — all still appear. Bytes, not just counts: count is not
// volume. `level_chunk` was 937 packets and 17.5 MB in the first capture,
// while `move_entity_delta` was 195,342 packets and only 61.8 MB.
//
// Streams line by line: these traces are hundreds of megabytes and must never
// be read into memory whole. The packet name is pulled with a regex rather
// than JSON.parse for the same reason — parsing 449k packet bodies to read one
// field costs minutes, matching costs seconds.
import fs from 'node:fs'
import readline from 'node:readline'

const filePath = process.argv[2]
if (!filePath) {
  console.error('usage: node scripts/trace-stats.js <trace.jsonl>')
  process.exit(2)
}

const NAME_PATTERN = /"name":"([^"]+)"/

const stats = new Map()
let totalBytes = 0
let lines = 0
let unnamed = 0

const input = readline.createInterface({
  input: fs.createReadStream(filePath),
  crlfDelay: Infinity,
})

for await (const line of input) {
  if (line === '') continue
  lines++
  const bytes = Buffer.byteLength(line, 'utf8') + 1 // + the newline
  totalBytes += bytes
  const match = NAME_PATTERN.exec(line)
  const name = match ? match[1] : '<unnamed>'
  if (!match) unnamed++
  const entry = stats.get(name) ?? { count: 0, bytes: 0 }
  entry.count++
  entry.bytes += bytes
  stats.set(name, entry)
}

const mb = (n) => (n / 1024 / 1024).toFixed(2)
console.log(`${filePath}: ${lines} packets, ${mb(totalBytes)} MB, ${stats.size} types, ${unnamed} unnamed`)
console.log('name,count,bytes,mb,pct_bytes,bytes_per_packet')
for (const [name, entry] of [...stats].sort((a, b) => b[1].bytes - a[1].bytes)) {
  const pct = totalBytes === 0 ? 0 : (entry.bytes / totalBytes) * 100
  console.log(
    [name, entry.count, entry.bytes, mb(entry.bytes), pct.toFixed(2), Math.round(entry.bytes / entry.count)].join(',')
  )
}
