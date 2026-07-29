// The prompts (#15, Layer 3). Pure string building — no client, no state.
//
// The system prompt is load-bearing for a reason measured on the hub, not a
// stylistic one: without an explicit `system`, a `claude-*` request through
// the hub comes back in Claude Code's OWN persona (offering to "enter a
// worktree", ~25k cached input tokens of a foreign system prompt). With one,
// the same request returns clean structured output. See #12's probe.
//
// Everything this prompt says about safety is DESCRIPTIVE. The envelope is
// enforced in code, below the model, by src/safety.js and
// src/perform-action.js — telling the model about it only makes its feedback
// loop shorter when an action is refused. If this file and the envelope ever
// disagree, the envelope wins and the model finds out by being refused.

/**
 * What each action does and what args it takes, in the model's terms.
 * Keyed by the SAME names src/perform-action.js exports as ACTION_NAMES —
 * test/prompt.test.js asserts every one of those has an entry here, so an
 * action added to the vocabulary cannot silently go undocumented to the model.
 */
export const ACTION_DOCS = Object.freeze({
  chat: 'chat — say something in game chat. Args: message (string).',
  select_slot: 'select_slot — select a hotbar slot. Args: slot (integer 0-8).',
  break_block:
    'break_block — break the block at a coordinate. Args: x, y, z (integers), face (integer 0-5: 0=down, 1=up, 2=north, 3=south, 4=west, 5=east).',
  place_block:
    'place_block — place the item from a hotbar slot at a coordinate. Args: x, y, z (integers), face (integer 0-5), hotbarSlot (integer 0-8).',
  use_item: 'use_item — use the item held in a hotbar slot (eat, drink, ...). Args: hotbarSlot (integer 0-8).',
  move_to: 'move_to — walk in a naive straight line to a coordinate. There is no pathfinding: obstacles are not avoided. Args: x, y, z (numbers).',
  look_at: 'look_at — turn to face a coordinate. Does not move the bot. Args: x, y, z (numbers).',
})

/** Args the loop fills in itself; the model must not supply them and cannot override them (src/decision-loop.js). */
const INJECTED_ARGS_NOTE =
  'Never include "username", "xuid" or "runtimeEntityId" — those identify the bot and are filled in automatically. ' +
  'Values you supply for them are ignored.'

function describeRegion(region) {
  if (!region) return 'No bounded operating region is configured for this run.'
  const { min, max } = region
  return (
    `You may only target coordinates inside the bounded operating region ` +
    `[${min.x},${min.y},${min.z}] to [${max.x},${max.y},${max.z}]. ` +
    `Anything outside it is refused outright — never clamped to the edge, never partially applied.`
  )
}

/**
 * @param {object} options
 * @param {string[]} options.actionNames             from src/perform-action.js ACTION_NAMES
 * @param {{min:object,max:object}|null} [options.region]
 * @param {boolean} [options.armed]                  false = dry-run: actions validate and log but write no packets
 * @param {number} [options.maxActionsPerStep]
 */
export function buildSystemPrompt({ actionNames, region = null, armed = false, maxActionsPerStep = 4 }) {
  const vocabulary = actionNames.map((name) => `- ${ACTION_DOCS[name] ?? `${name} — (no description available)`}`).join('\n')
  return [
    'You control a Minecraft Bedrock bot. You are given a goal and an observation of the world, and you choose the next actions.',
    '',
    'OUTPUT CONTRACT',
    'Reply with a single JSON object and nothing else. No prose before or after it. No markdown code fence.',
    'Schema:',
    '{"thought": "<one short sentence>", "actions": [{"type": "<action>", ...args}], "status": "continue" | "done" | "give_up", "reason": "<why, if give_up>"}',
    `At most ${maxActionsPerStep} actions per reply. Use an empty array when you have no action to take.`,
    '',
    'ACTIONS AVAILABLE',
    vocabulary,
    INJECTED_ARGS_NOTE,
    '',
    'HOW SUCCESS IS MEASURED',
    'Whether the goal is achieved is decided by a program that inspects the world state, not by what you report.',
    'Setting status "done" is a claim, not evidence. If you claim the goal is done and the world does not agree, the run is recorded as a failure.',
    'Never claim "done" for something you have not actually made happen.',
    '',
    'SAFETY',
    describeRegion(region),
    armed
      ? 'This run is ARMED: your actions are really written to the server.'
      : 'This run is a DRY RUN: actions are validated and logged, but no packets are sent, so the world will not actually change.',
    'Breaking blocks is deny-by-default and only allowed for specifically permitted block types.',
    'Actions are rate limited. An action that is refused comes back to you as a failed step with the reason — read it and adapt rather than repeating the same action.',
    '',
    'READING THE OBSERVATION',
    'observation.blocks lists ONLY blocks the bot has actually observed change. It is not a map of the terrain: an empty list means "nothing observed yet", never "there is nothing there".',
    'observation.entities and observation.blocks are capped to the nearest few; each reports a "total" so you can tell when you are seeing a subset.',
  ].join('\n')
}

/**
 * @param {object} options
 * @param {{description: string}} options.goal
 * @param {object} options.observation           from src/observation.js
 * @param {string|null} [options.lastError]      a validation error from YOUR previous reply, fed back for repair
 */
export function buildUserMessage({ goal, observation, lastError = null, step = 1, maxSteps = 1 }) {
  const parts = [
    `GOAL: ${goal.description}`,
    `STEP ${step} of at most ${maxSteps}.`,
    '',
    'OBSERVATION:',
    JSON.stringify(observation, null, 2),
  ]
  if (lastError) {
    parts.push(
      '',
      'YOUR PREVIOUS REPLY WAS REJECTED:',
      lastError,
      'Reply again with a single valid JSON object, correcting exactly that problem.'
    )
  }
  return parts.join('\n')
}
