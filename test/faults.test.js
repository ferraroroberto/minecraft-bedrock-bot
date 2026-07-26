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

test('a fault during a session drives that session to finish', async () => {
  // BedrockX's signal-jsonrpc.js:134 dereferences an unassigned `this.client`,
  // throwing a TypeError inside a callback no client listener can see.
  const { guard, proc, lines } = setup()
  const ended = []
  guard.faultSignal.onFault(() => ended.push('finished'))
  proc.emit('uncaughtException', new TypeError("Cannot read properties of undefined (reading 'emit')"))
  assert.deepEqual(ended, ['finished'])
  assert.ok(lines.some((l) => l.includes('uncaughtException.absorbed')))
  guard.dispose()
})

test('an unhandled rejection is absorbed the same way', () => {
  // createClient.js:7 calls client.init() without awaiting or catching it.
  const { guard, proc } = setup()
  const ended = []
  guard.faultSignal.onFault(() => ended.push('finished'))
  proc.emit('unhandledRejection', new Error('Signal reconnection failed after max retries'))
  assert.equal(ended.length, 1)
  guard.dispose()
})

test('a session that unsubscribes stops receiving faults', () => {
  const { guard, proc } = setup()
  const ended = []
  const unsubscribe = guard.faultSignal.onFault(() => ended.push('x'))
  unsubscribe()
  guard.setSupervising(true)
  proc.emit('uncaughtException', new Error('after unsubscribe'))
  assert.deepEqual(ended, [], 'a finished session must not be re-finished')
  guard.dispose()
})

test('a STRAY fault between attempts does NOT kill the process', () => {
  // The regression this guards: a leaked timer from a torn-down client firing
  // during a backoff sleep. Re-throwing from inside a process handler would
  // kill the unattended bot — precisely the death this module prevents.
  const { guard, proc, lines } = setup()
  guard.setSupervising(true)
  assert.doesNotThrow(() =>
    proc.emit('uncaughtException', new Error('leaked signalling retry'))
  )
  assert.ok(lines.some((l) => l.includes('uncaughtException.stray')))
  guard.dispose()
})

test('a fault never resolves a session that was not in flight for it', () => {
  // Session A faults and finishes; later, A's leaked work faults again while
  // session B is healthy. B must not be torn down by A's stray fault... and
  // since A unsubscribed on finish, only genuinely-live sessions are notified.
  const { guard, proc } = setup()
  const aEnds = []
  const unsubscribeA = guard.faultSignal.onFault(() => aEnds.push('a'))
  guard.setSupervising(true)
  proc.emit('uncaughtException', new Error('A fails'))
  assert.equal(aEnds.length, 1)
  unsubscribeA() // what runSession's finish() does

  const bEnds = []
  guard.faultSignal.onFault(() => bEnds.push('b'))
  // A's leaked async work throws later. B is live, so B is ended — the honest
  // limit of a process-global signal: it cannot attribute a fault to a client.
  proc.emit('uncaughtException', new Error("A's leaked timer"))
  assert.equal(aEnds.length, 1, 'the finished session must not be notified again')
  assert.equal(bEnds.length, 1)
  guard.dispose()
})

test('outside the supervised window a fault is re-thrown, not swallowed', () => {
  // Absorbing everything globally would hide real bugs.
  const { guard, proc, lines } = setup()
  assert.throws(() => proc.emit('uncaughtException', new Error('a genuine bug')), /a genuine bug/)
  assert.ok(lines.some((l) => l.includes('uncaughtException.unhandled')))
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
