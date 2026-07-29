// Parsing and validating what the model said (#15, Layer 3).
//
// MODEL OUTPUT IS UNTRUSTED INPUT — the same posture src/safety.js takes for
// inbound chat, for the same reason: it arrives from outside and something
// downstream acts on it. Nothing here trusts the model to have followed
// instructions.
//
// Two behaviours were measured against the hub before this was written
// (#12's probe, restated in #15) and both are designed for rather than
// assumed away:
//
//   - Native tool-calling does NOT work for `claude-*` through the hub: a
//     `tools` array comes back HTTP 200, silently ignored, with no `tool_use`
//     block. So the contract is strict JSON-in-text, and this module is the
//     thing that makes that safe.
//   - The model returned its JSON wrapped in a ```json fence DESPITE being
//     explicitly told not to. So the fence is stripped defensively, and a
//     reply with prose around the object still parses via a balanced-brace
//     extraction. Design for a usually-well-behaved model, not an
//     always-well-behaved one.
//
// A validation failure is never fatal on its own: src/decision-loop.js feeds
// `InvalidModelReplyError.message` back to the model as a repair prompt, a
// bounded number of times. That is why the messages here are written to be
// read BY THE MODEL, not only by a human tailing a log.

/** Statuses the model may report. `done` is a CLAIM, never evidence — see src/decision-loop.js. */
export const REPLY_STATUSES = Object.freeze(['continue', 'done', 'give_up'])

export const DEFAULT_MAX_ACTIONS_PER_REPLY = 4
/** Arg strings longer than this are refused outright rather than truncated — a 10KB "message" is not a typo. */
export const MAX_ARG_STRING_LENGTH = 256
export const MAX_THOUGHT_LENGTH = 500

export class InvalidModelReplyError extends Error {
  constructor(reason) {
    super(reason)
    this.name = 'InvalidModelReplyError'
  }
}

/** Strip one leading ```/```json fence and its closing fence, if present. */
export function stripFence(text) {
  const trimmed = String(text ?? '').trim()
  if (!trimmed.startsWith('```')) return trimmed
  return trimmed
    .replace(/^```[a-zA-Z0-9_-]*[ \t]*\r?\n?/, '')
    .replace(/\r?\n?```[ \t]*$/, '')
    .trim()
}

/**
 * First balanced `{...}` in `text`, honouring string literals so a brace
 * inside a message can't end the object early. Null when there isn't one.
 */
function extractFirstJsonObject(text) {
  const start = text.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) return text.slice(start, i + 1)
  }
  return null
}

/**
 * Text to object. Tries the whole (de-fenced) reply first, then falls back to
 * the first balanced object inside it — which is what rescues a model that
 * wrapped its JSON in an apology.
 * @throws {InvalidModelReplyError}
 */
export function parseModelReply(text) {
  const stripped = stripFence(text)
  if (!stripped) throw new InvalidModelReplyError('reply was empty — reply with a single JSON object and nothing else')
  try {
    return JSON.parse(stripped)
  } catch {
    const candidate = extractFirstJsonObject(stripped)
    if (candidate) {
      try {
        return JSON.parse(candidate)
      } catch (err) {
        throw new InvalidModelReplyError(`reply was not valid JSON (${err.message}) — reply with a single JSON object and nothing else`)
      }
    }
    throw new InvalidModelReplyError('reply contained no JSON object — reply with a single JSON object and nothing else')
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Action args must be flat scalars. The whole vocabulary (src/actions.js)
 * takes numbers, short strings and booleans — nothing nested — so refusing
 * objects and arrays outright removes a whole class of "what does this even
 * mean" input before it can reach the gate.
 */
function validateArgValue(actionType, key, value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new InvalidModelReplyError(`action "${actionType}": "${key}" must be a finite number`)
    return value
  }
  if (typeof value === 'string') {
    if (value.length > MAX_ARG_STRING_LENGTH) {
      throw new InvalidModelReplyError(`action "${actionType}": "${key}" is longer than ${MAX_ARG_STRING_LENGTH} characters`)
    }
    return value
  }
  if (typeof value === 'boolean') return value
  throw new InvalidModelReplyError(
    `action "${actionType}": "${key}" must be a number, string or boolean — nested objects and arrays are not allowed`
  )
}

function validateAction(action, index, actionNames) {
  if (!isPlainObject(action)) throw new InvalidModelReplyError(`actions[${index}] must be an object`)
  if (typeof action.type !== 'string') throw new InvalidModelReplyError(`actions[${index}] is missing a string "type"`)
  if (!actionNames.includes(action.type)) {
    throw new InvalidModelReplyError(
      `actions[${index}]: "${action.type}" is not an available action — choose one of: ${actionNames.join(', ')}`
    )
  }
  const validated = { type: action.type }
  for (const [key, value] of Object.entries(action)) {
    if (key === 'type') continue
    validated[key] = validateArgValue(action.type, key, value)
  }
  return validated
}

function optionalText(value, max) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`
}

/**
 * Structural validation of an already-parsed reply. Ranges and preconditions
 * are NOT re-checked here — src/perform-action.js is the authoritative gate
 * and its refusals carry better reasons than a duplicate schema could. This
 * is deliberately the only place that knows the reply's SHAPE, so there is
 * one source of truth for it.
 * @throws {InvalidModelReplyError}
 */
export function validateReply(reply, { actionNames, maxActions = DEFAULT_MAX_ACTIONS_PER_REPLY }) {
  if (!isPlainObject(reply)) throw new InvalidModelReplyError('reply must be a JSON object')
  if (!REPLY_STATUSES.includes(reply.status)) {
    throw new InvalidModelReplyError(`"status" must be one of: ${REPLY_STATUSES.join(', ')}`)
  }
  if (!Array.isArray(reply.actions)) throw new InvalidModelReplyError('"actions" must be an array (use [] when you have no action to take)')
  if (reply.actions.length > maxActions) {
    throw new InvalidModelReplyError(`"actions" has ${reply.actions.length} entries — at most ${maxActions} are allowed per step`)
  }
  return {
    thought: optionalText(reply.thought, MAX_THOUGHT_LENGTH),
    status: reply.status,
    reason: optionalText(reply.reason, MAX_THOUGHT_LENGTH),
    actions: reply.actions.map((action, index) => validateAction(action, index, actionNames)),
  }
}

/** parse + validate in one call — what the decision loop actually uses. @throws {InvalidModelReplyError} */
export function parseAndValidateReply(text, options) {
  return validateReply(parseModelReply(text), options)
}
