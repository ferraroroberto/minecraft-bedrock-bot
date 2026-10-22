// Structural check for #75's audit finding: a Node stream created under
// src/ (the production module tree the supervised bot actually runs) with no
// `'error'` listener turns an async disk/permission failure into an
// `uncaughtException` — which src/faults.js then misattributes to BedrockX
// and uses to end the live session. scripts/ is exempt: those are one-off
// manual CLI tools (`npm run trace-stats`, `npm run mine-farm-ids`) that exit
// on crash anyway, not a long-running production path.
//
// This is a grep-level static check, not an AST one — CLAUDE.md's "No
// linter, no type checker" decision means there is no AST tooling already in
// the dependency tree to build a precise one on top of, and one `.on('error'`
// call anywhere in the same file is exactly the shape src/recorder.js's own
// fix takes. Precision can improve later; the point is a future second
// `createWriteStream`/`createReadStream` call added to src/ without any error
// handling fails the gate instead of waiting for the next audit.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

function jsFilesUnder(dir) {
  return fs
    .readdirSync(path.join(root, dir), { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.js'))
    .map((e) => path.join(e.parentPath ?? e.path, e.name))
}

test("#75: every createWriteStream/createReadStream call under src/ has an 'error' listener in the same file", () => {
  const offenders = []
  for (const file of jsFilesUnder('src')) {
    const contents = fs.readFileSync(file, 'utf8')
    const createsStream = /\.create(Write|Read)Stream\(/.test(contents)
    if (!createsStream) continue
    const handlesError = /\.on\(\s*['"]error['"]/.test(contents)
    if (!handlesError) offenders.push(path.relative(root, file))
  }
  assert.deepEqual(offenders, [], `stream created with no 'error' listener in: ${offenders.join(', ')}`)
})
