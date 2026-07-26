// Minecraft text formatting helpers.

/**
 * Strip Minecraft's `§`-prefixed formatting codes from a string.
 *
 * The server appends codes to chat source names (e.g. `Roberto39764§r`), so a
 * naive `source_name === username` comparison silently fails. Two call sites
 * depend on this: XUID discovery off `player_list`, and echo-suppression of the
 * bot's own outgoing chat. A regression here makes the bot either lose its own
 * XUID or start replying to itself.
 *
 * Non-string input (a missing field is `undefined`) yields `''` rather than
 * throwing — these run inside packet handlers where a crash drops the
 * connection.
 *
 * @param {unknown} s
 * @returns {string}
 */
export function stripFormatting(s) {
  return String(s ?? '').replace(/§./g, '')
}
