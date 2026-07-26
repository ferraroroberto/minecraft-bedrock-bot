import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createFaultGuard } from '../src/faults.js'

// A fake process emitter — never touch the real process handlers in a test.
function setup() {
  const lines = []
  const log = {
    info: (e, d) => lines.push(`INFO ${e} ${d ?? ''}`),
    warn: (e, d) => lines.push(`WARN ${e} ${d ?? ''}`),
    error: (e, d) => lines.push(`ERROR ${e} ${d ?? ''}`),
  }
  const proc = new EventEmitter()
  return { lines, log, proc, guard: createFaultGuard({ log, proc }) }
}

test('a normal session result passes straight through', async () => {
  const { guard } = setup()
  const result = await guard.guard(Promise.resolve({ endedBy: 'close', connected: true }))
  assert.equal(result.endedBy, 'close')
  guard.dispose()
})

test('an uncaught exception mid-session becomes a session end, not a crash', async () => {
  // This is the whole point: BedrockX's signal-jsonrpc.js:134 dereferences an
  // unassigned `this.client`, throwing a TypeError inside a callback that no
  // client listener can see. Without this, the process just dies.
  const { guard, proc, lines } = setup()
  const never = new Promise(() => {})
  const running = guard.guard(never)
  proc.emit('uncaughtException', new TypeError("Cannot read properties of undefined (reading 'emit')"))
  const result = await running
  assert.equal(result.reason, 'signalling_fault')
  assert.equal(result.connected, false)
  assert.ok(lines.some((l) => l.includes('uncaughtException.absorbed')))
  guard.dispose()
})

test('an unhandled rejection mid-session is absorbed the same way', async () => {
  // createClient.js:7 calls client.init() without awaiting or catching it, so
  // a signalling connect rejection surfaces here and nowhere else.
  const { guard, proc } = setup()
  const running = guard.guard(new Promise(() => {}))
  proc.emit('unhandledRejection', new Error('Signal reconnection failed after max retries'))
  assert.equal((await running).reason, 'signalling_fault')
  guard.dispose()
})

test('a fault OUTSIDE a session is re-thrown, not silently swallowed', async () => {
  // Absorbing everything globally would hide real bugs. Only faults during an
  // in-flight session are treated as connection failures.
  const { guard, proc, lines } = setup()
  assert.throws(() => proc.emit('uncaughtException', new Error('a genuine bug')), /a genuine bug/)
  assert.ok(lines.some((l) => l.includes('uncaughtException.unhandled')))
  guard.dispose()
})

test('a fault after a session completes is no longer absorbed', async () => {
  const { guard, proc } = setup()
  await guard.guard(Promise.resolve({ endedBy: 'close' }))
  assert.throws(() => proc.emit('uncaughtException', new Error('later bug')), /later bug/)
  guard.dispose()
})

test('dispose removes the handlers so nothing leaks between runs', () => {
  const { guard, proc } = setup()
  assert.equal(proc.listenerCount('uncaughtException'), 1)
  assert.equal(proc.listenerCount('unhandledRejection'), 1)
  guard.dispose()
  assert.equal(proc.listenerCount('uncaughtException'), 0)
  assert.equal(proc.listenerCount('unhandledRejection'), 0)
})
