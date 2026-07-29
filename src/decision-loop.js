// The decision loop (#15, Layer 3) — the actual autonomy test.
//
// Natural-language goal → observation → model → validated actions → execution
// → VERIFICATION FROM WORLD STATE, iterating until the goal's predicate holds,
// the step budget runs out, or the model gives up.
//
// The one invariant everything else exists to serve:
//
//     the returned `ok` is ALWAYS the goal predicate evaluated against world
//     state at the moment the run ends. It is never assigned from anything the
//     model said.
//
// That is why finish() below takes only a REASON, never an outcome — there is
// no code path that can construct a successful result without the predicate
// agreeing, because no caller of finish() is given the opportunity to claim
// one. A model reporting `status: "done"` is treated as a claim to be checked,
// and an unbacked claim is counted and eventually terminates the run as a
// failure that names exactly that.
//
// This module never builds a packet and never touches the client. Every action
// goes through the injected `performAction` (#14's gate), so the safety
// envelope — dry-run by default, bounded region, deny-by-default breaking,
// rate limiting, audit — applies to an LLM-chosen action exactly as it does to
// a hand-written one. A refused action is not an error here: it comes back as
// a failed step and is fed to the model as feedback.
import { ACTION_NAMES } from './perform-action.js'
import { buildObservation } from './observation.js'
import { buildSystemPrompt, buildUserMessage } from './prompt.js'
import { parseAndValidateReply } from './model-reply.js'

export const DEFAULT_MAX_STEPS = 8
/** Extra attempts after a malformed reply, each fed the validation error. Total model calls per step = 1 + this. */
export const DEFAULT_MAX_REPAIR_ATTEMPTS = 2
/** Unbacked `status: "done"` claims tolerated before the run is terminated as a failure. */
export const DEFAULT_MAX_FALSE_SUCCESS_CLAIMS = 2
export const DEFAULT_MAX_ACTIONS_PER_STEP = 4

/**
 * Args the loop supplies itself, overriding anything the model sent for the
 * same key. These identify the bot; letting a model choose its own
 * `runtimeEntityId` would hand it a way to name a DIFFERENT entity, which is
 * exactly the kind of below-the-vocabulary reach the design forbids.
 */
const INJECTED_ARGS = {
  chat: (world, identity) => ({ username: identity.username, xuid: identity.xuid ?? '' }),
  break_block: (world) => ({ runtimeEntityId: world.self.runtimeEntityId }),
}

/** Model-chosen action → the args performAction actually receives. Injected keys always win. */
export function resolveActionArgs(action, world, identity) {
  const { type, ...modelArgs } = action
  return { ...modelArgs, ...(INJECTED_ARGS[type]?.(world, identity) ?? {}) }
}

/**
 * Run one goal to a verified conclusion.
 *
 * @param {object} deps
 * @param {{description: string, predicate: Function}} deps.goal   from src/goals.js defineGoal
 * @param {{complete: (req: {system: string, messages: object[]}) => Promise<string>}} deps.model
 *   injectable — the loop never imports src/model-client.js, which is what keeps the offline gate offline
 * @param {(name: string, args: object) => Promise<object>} deps.performAction   #14's gate
 * @param {() => object} deps.getWorld
 * @param {{username?: string, xuid?: string}} [deps.identity]
 * @param {{region?: object, armed?: boolean}} [deps.config]   descriptive only — the real envelope lives in performAction
 * @returns {Promise<{ok:boolean, verified:boolean, reason:string, steps:number, actionsExecuted:number,
 *                    falseSuccessClaims:number, repairAttempts:number, outcomes:object[]}>}
 */
export async function runGoal({
  goal,
  model,
  performAction,
  getWorld,
  identity = {},
  config = {},
  maxSteps = DEFAULT_MAX_STEPS,
  maxRepairAttempts = DEFAULT_MAX_REPAIR_ATTEMPTS,
  maxFalseSuccessClaims = DEFAULT_MAX_FALSE_SUCCESS_CLAIMS,
  maxActionsPerStep = DEFAULT_MAX_ACTIONS_PER_STEP,
  log = console,
  audit = null,
  now = () => Date.now(),
}) {
  const outcomes = []
  let steps = 0
  let actionsExecuted = 0
  let falseSuccessClaims = 0
  let repairAttempts = 0

  const record = (entry) => audit?.record?.({ ts: now(), scope: 'decision_loop', goal: goal.description, ...entry })

  /**
   * The only judge of success. A predicate that throws is a bug in the GOAL,
   * not evidence of anything — it is logged loudly and counts as "not
   * satisfied", which can only ever make the run fail, never falsely pass.
   */
  const verify = () => {
    try {
      return goal.predicate(getWorld()) === true
    } catch (err) {
      log.error?.('loop.predicate_threw', `goal predicate threw (${String(err?.message ?? err)}) — treating the goal as NOT satisfied`)
      return false
    }
  }

  // Takes a reason, never an outcome: `ok` cannot be claimed, only measured.
  const finish = (reason) => {
    const verified = verify()
    const result = { ok: verified, verified, reason, steps, actionsExecuted, falseSuccessClaims, repairAttempts, outcomes }
    log[verified ? 'info' : 'warn']?.(verified ? 'loop.verified' : 'loop.failed', reason)
    record({ event: 'finished', ok: verified, reason, steps, actionsExecuted, falseSuccessClaims })
    return result
  }

  const system = buildSystemPrompt({
    actionNames: ACTION_NAMES,
    region: config.region ?? null,
    armed: config.armed === true,
    maxActionsPerStep,
  })

  /** One model turn, with bounded repair. @returns {object|null} a validated reply, or null when it never validated. */
  const askModel = async (observation) => {
    let lastError = null
    for (let attempt = 0; attempt <= maxRepairAttempts; attempt++) {
      const content = buildUserMessage({ goal, observation, lastError, step: steps, maxSteps })
      const text = await model.complete({ system, messages: [{ role: 'user', content }] })
      try {
        return parseAndValidateReply(text, { actionNames: ACTION_NAMES, maxActions: maxActionsPerStep })
      } catch (err) {
        lastError = err.message
        repairAttempts += 1
        log.warn?.('loop.invalid_reply', `step ${steps}: ${lastError}`)
        record({ event: 'invalid_reply', step: steps, error: lastError })
      }
    }
    log.error?.('loop.unrepairable_reply', `step ${steps}: model output never validated — last error: ${lastError}`)
    return null
  }

  if (verify()) return finish('goal was already satisfied before any action was taken')

  while (steps < maxSteps) {
    steps += 1

    const observation = buildObservation(getWorld(), { recentOutcomes: outcomes })
    const reply = await askModel(observation)
    if (!reply) return finish(`model output never validated after ${maxRepairAttempts + 1} attempt(s) on step ${steps}`)

    record({ event: 'decided', step: steps, thought: reply.thought, status: reply.status, actions: reply.actions })
    if (reply.thought) log.info?.('loop.thought', `step ${steps}: ${reply.thought}`)

    if (reply.status === 'give_up') {
      return finish(`model gave up on step ${steps}: ${reply.reason ?? 'no reason given'}`)
    }

    for (const action of reply.actions) {
      const args = resolveActionArgs(action, getWorld(), identity)
      const result = await performAction(action.type, args)
      actionsExecuted += 1
      outcomes.push({ step: steps, action: action.type, args, result })
      if (!result.ok) {
        // Later actions in a batch were planned assuming this one worked, so
        // running them now would compound a wrong assumption. Stop, and let
        // the model see the failure in the next observation.
        log.warn?.('loop.action_failed', `step ${steps}: ${action.type} — ${result.reason ?? 'no reason given'}`)
        break
      }
    }

    if (verify()) return finish(`goal verified from world state after ${steps} step(s)`)

    if (reply.status === 'done') {
      falseSuccessClaims += 1
      // THE failure mode this whole layer exists to catch: a model reporting
      // success it did not achieve. Counted, logged, and terminal once it
      // repeats — never quietly accepted, and never allowed to set `ok`.
      log.warn?.(
        'loop.false_success_claim',
        `step ${steps}: model reported the goal done, but the world does not confirm it (claim ${falseSuccessClaims}/${maxFalseSuccessClaims})`
      )
      record({ event: 'false_success_claim', step: steps, claim: falseSuccessClaims })
      if (falseSuccessClaims >= maxFalseSuccessClaims) {
        return finish(
          `model claimed the goal was done ${falseSuccessClaims} time(s) but world state never confirmed it ` +
            `(${actionsExecuted} action(s) executed)`
        )
      }
    }
  }

  return finish(`step budget exhausted after ${maxSteps} step(s) without the goal being verified from world state`)
}
