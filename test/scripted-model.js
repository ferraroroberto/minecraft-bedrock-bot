// A deterministic stand-in for the hub client (#15).
//
// The decision loop takes its model as an injected dependency precisely so the
// suite can drive it with a scripted one — no network, no hub, no account, and
// the same reply every run. Test-only, so it lives here rather than in src/.
//
// Replies REPEAT THE LAST ENTRY once the script runs out, which is what makes
// "a model that says the same wrong thing forever" a one-line fixture.

/**
 * @param {string[]|((request: object, callNumber: number) => string)} replies
 * @returns {{complete: Function, calls: object[], callCount: number}}
 */
export function createScriptedModel(replies) {
  const calls = []
  return {
    calls,
    get callCount() {
      return calls.length
    },
    async complete(request) {
      calls.push(request)
      if (typeof replies === 'function') return replies(request, calls.length)
      if (!replies.length) throw new Error('createScriptedModel: no replies scripted')
      return replies[Math.min(calls.length - 1, replies.length - 1)]
    },
  }
}

/** JSON.stringify with the decision loop's reply shape, so tests read as intent rather than as punctuation. */
export function reply({ thought = 'thinking', actions = [], status = 'continue', reason } = {}) {
  return JSON.stringify({ thought, actions, status, ...(reason ? { reason } : {}) })
}

/** A log that records nothing — keeps `node --test` output readable. */
export const silentLog = { info() {}, warn() {}, error() {} }

/** Records every performAction call without executing anything. */
export function spyPerformAction(result = { ok: true, dryRun: true }) {
  const calls = []
  return {
    calls,
    performAction: async (name, args) => {
      calls.push({ name, args })
      return typeof result === 'function' ? result(name, args) : result
    },
  }
}
