import test from 'node:test'
import assert from 'node:assert/strict'
import { checkRegion, checkBreakWhitelist, createRateLimiter, createAuditLog, isStopCommand } from '../src/safety.js'

test('checkRegion allows an unbounded region (no config) and a point inside a configured box', () => {
  assert.equal(checkRegion(null, { x: 0, y: 0, z: 0 }).ok, true)
  const region = { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 } }
  assert.equal(checkRegion(region, { x: 5, y: 5, z: 5 }).ok, true)
})

test('checkRegion refuses and NAMES the region — never clamps', () => {
  const region = { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 } }
  const result = checkRegion(region, { x: 50, y: 5, z: 5 })
  assert.equal(result.ok, false)
  assert.equal(result.refused, true)
  assert.match(result.reason, /50,5,5/)
  assert.match(result.reason, /0,0,0/)
  assert.match(result.reason, /10,10,10/)
})

test('checkBreakWhitelist is deny-by-default — no whitelist configured refuses everything', () => {
  assert.equal(checkBreakWhitelist(null, 5).ok, false)
  assert.equal(checkBreakWhitelist(new Set(), 5).ok, false)
})

test('checkBreakWhitelist allows exactly the configured block_runtime_ids', () => {
  const whitelist = new Set([1, 2, 3])
  assert.equal(checkBreakWhitelist(whitelist, 2).ok, true)
  const refusal = checkBreakWhitelist(whitelist, 99)
  assert.equal(refusal.ok, false)
  assert.match(refusal.reason, /99/)
})

test('createRateLimiter refuses the N+1th action within a fixed window', () => {
  let now = 0
  const limiter = createRateLimiter({ maxActions: 3, windowMs: 1000, now: () => now })
  assert.equal(limiter.tryConsume(), true)
  assert.equal(limiter.tryConsume(), true)
  assert.equal(limiter.tryConsume(), true)
  assert.equal(limiter.tryConsume(), false, 'the 4th call within the window must be refused')
})

test('createRateLimiter allows again once the window has rolled past', () => {
  let now = 0
  const limiter = createRateLimiter({ maxActions: 1, windowMs: 1000, now: () => now })
  assert.equal(limiter.tryConsume(), true)
  assert.equal(limiter.tryConsume(), false)
  now = 1001
  assert.equal(limiter.tryConsume(), true)
})

test('createAuditLog records entries in order and returns a snapshot copy', () => {
  const audit = createAuditLog()
  audit.record({ action: 'chat', ok: true })
  audit.record({ action: 'break_block', ok: false })
  assert.equal(audit.entries.length, 2)
  assert.equal(audit.entries[0].action, 'chat')
  audit.entries.push({ action: 'tampered' }) // mutating the snapshot must not affect the log
  assert.equal(audit.entries.length, 2)
})

test('isStopCommand matches only the narrow literal command, not anything an LLM would interpret', () => {
  assert.equal(isStopCommand('bot stop'), true)
  assert.equal(isStopCommand('  Bot Stop  '), true)
  assert.equal(isStopCommand('BOT STOP'), true)
  assert.equal(isStopCommand('please bot stop now'), false)
  assert.equal(isStopCommand('bot, stop mining'), false)
  assert.equal(isStopCommand(''), false)
  assert.equal(isStopCommand(undefined), false)
  assert.equal(isStopCommand(123), false)
})
