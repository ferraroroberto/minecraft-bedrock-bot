// Block runtime ids and item network ids, READ OFF A REAL SESSION (#45).
//
// The first fixture-derived constants in this repo, and the provenance matters
// as much as the values — hence this header rather than a bare table.
//
// WHY THESE CANNOT BE DERIVED. Two independent reasons, both load-bearing:
//
//   1. This Realm sends block ids as HASHES, not palette indices. start_game
//      carries `block_network_ids_are_hashes`, and every observed id is a full
//      signed 32-bit value (-604749536, 1670228562, ...) rather than a small
//      index. A hash of the canonical block-state NBT is stable across
//      sessions and servers for a given game version — which is what makes
//      committing them worthwhile — but it is not something this repo can
//      compute without re-implementing Mojang's NBT canonicalisation and
//      hashing, and then trusting it. That is the "our encoder agrees with our
//      decoder" trap the README's gotchas already document; a computed id that
//      is subtly wrong looks exactly like a correct one until the bot breaks
//      the wrong block in Roberto's real base.
//   2. #13's world model deliberately does not decode the chunk palette
//      (src/world.js's header), so nothing in this codebase maps an id to a
//      name. There is no lookup to consult even in principle.
//
// So they were MEASURED. `scripts/mine-farm-ids.js` reads them back out of a
// recorded trace, and re-running it against a fresh capture is how these get
// re-confirmed after a game update.
//
// SOURCE TRACE: 2026-08-13, Realm "casa Chiquis" (UKSouth), client 1.26.40 /
// protocol 2168, server engine 1.26.43. Roberto performed the sequence by hand
// at a single wheat plant while the bot observed, unarmed:
//
//   (42,63,39)  block_start_break
//               update_block -> -604749536    the block left behind = AIR
//               update_block -> 1485804093    seeds replanted = growth stage 0
//               update_block -> 1424329270    after 1st bone meal
//               update_block -> 1793178208    after 2nd bone meal
//               update_block -> 1670228562    after 3rd bone meal
//
// WHAT THE LADDER DOES AND DOES NOT ESTABLISH. Bedrock wheat has eight growth
// stages. The capture above walked five ids at one coordinate, so their
// ORDERING is certain (each was observed strictly after the previous, at the
// same block, in response to a known action) but their absolute stage NUMBERS
// are not — bone meal advances a random number of stages per application, so
// the three post-bone-meal ids are three of stages 1-7 without saying which.
//
// That imprecision is harmless HERE, and the reason is worth stating plainly
// rather than leaving to be rediscovered: nothing in this module needs to know
// a stage number. src/safety.js's checkBreakWhitelist is DENY-BY-DEFAULT, so
// the immature stages do not need enumerating to be refused — an id that is
// not MATURE_WHEAT is refused because it is not on the whitelist, whether we
// have ever seen it or not. Enumerating stage 4 buys nothing and would invite
// exactly the kind of guessed constant this header exists to forbid.
//
// The one id that DOES have to be exactly right is MATURE_WHEAT, because it is
// the sole entry on the whitelist: too low and the bot destroys a growing crop
// for no yield, too high and it refuses to harvest anything at all. It was
// therefore confirmed by a separate NEGATIVE test rather than inferred from
// the ladder's position — see its comment below.

/**
 * What a broken block becomes. Observed directly as the result of the
 * `block_start_break` at (42,63,39), so this is measured, not assumed.
 *
 * NOT named `AIR` without qualification: this is "the id the server reported
 * after that block was broken at that position". It is almost certainly plain
 * air, and it recurs constantly throughout the trace, but the capture proves
 * the former and only suggests the latter.
 */
export const AIR = -604749536

/**
 * Wheat immediately after seeds are planted — growth stage 0. Observed as the
 * result of Roberto replanting at (42,63,39) 14.8s after breaking.
 *
 * Used to VERIFY a replant from world state (a seed placement that produced no
 * block change is a failed replant, not a successful one), never to authorise
 * a break.
 */
export const WHEAT_STAGE_0 = 1485804093

/**
 * Fully-grown wheat: the only id the bot is ever allowed to break.
 *
 * CONFIRMED BY NEGATIVE TEST, not by counting bone meals. Being the highest id
 * the ladder REACHED is not the same claim as being the top of the ladder, and
 * "three applications probably max out an eight-stage crop" is not an
 * acceptable basis for the single id that decides whether the bot destroys a
 * growing crop for no yield.
 *
 * Only a negative distinguishes "fully grown" from "as far as we happened to
 * get": bone meal applied to fully-grown wheat is a no-op — no update_block,
 * no particle_crop_growth. A fourth application was made and the trace stayed
 * silent, with the event count at that coordinate holding at 10.
 *
 * Silence is only evidence if the observer was demonstrably awake, so that was
 * checked too rather than assumed — a disconnected session produces identical
 * silence. At the moment of the test the recorder's most recent packet was
 * 0.0s old and still streaming, and move_player put a player at
 * (42.5, 64.6, 38.4), adjacent to the crop, throughout the window.
 *
 * Re-run that same three-part check if this id is ever updated after a game
 * version bump. A ladder that merely stopped being extended proves nothing,
 * and neither does a quiet trace from a bot that had already dropped.
 */
export const MATURE_WHEAT = 1670228562

/**
 * Growth-stage ids observed strictly BETWEEN planting and maturity.
 *
 * Present for diagnostics and for the "an immature stage is refused" test —
 * NOT consulted by the safety envelope, which refuses everything not equal to
 * MATURE_WHEAT regardless of whether it appears here. Incomplete by
 * construction (three of the six intermediate stages), and deliberately so:
 * see this file's header on why enumerating the rest buys nothing.
 */
export const WHEAT_IMMATURE_OBSERVED = Object.freeze([WHEAT_STAGE_0, 1424329270, 1793178208])

/**
 * Item network ids, taken from the server's own `item_registry` packet — the
 * one place on the wire that pairs a name with an id, and therefore exact
 * rather than inferred. 1,976 entries were present; these are the relevant
 * four. Re-read with `npm run mine-farm-ids <trace>`.
 *
 * Note `minecraft:wheat` (337) is the harvested ITEM, while `minecraft:
 * item.wheat` (59) is the crop block's item form — two different ids for two
 * different things, and the legacy block-id range (59, 60) versus item range
 * (291, 337) is how they are told apart.
 */
export const ITEMS = Object.freeze({
  WHEAT: 337,
  WHEAT_SEEDS: 291,
  BONE_MEAL: 414,
  FARMLAND: 60,
})

/**
 * Ids seen toggling at y=62 across 72 positions throughout the source capture
 * (-2108756090: 63 changes, -567203660: 59 changes), consistent with farmland
 * drying and re-wetting near water.
 *
 * UNCONFIRMED, and exported only so the observation is on the record rather
 * than lost. This is a pattern inference, not a controlled observation like
 * the wheat ladder above — no action was performed to produce a known farmland
 * block — so nothing in the safety envelope or the goal predicate reads it.
 * Confirming it takes one hoe applied to one dirt block while recording.
 */
export const FARMLAND_CANDIDATES = Object.freeze([-2108756090, -567203660])

/**
 * The break whitelist for wheat farming: mature wheat and nothing else.
 *
 * A Set because that is what src/safety.js's checkBreakWhitelist takes. Frozen
 * exports elsewhere in this module are plain values; this one is deliberately
 * built fresh per call so a caller cannot mutate a shared whitelist and widen
 * the envelope for every other caller at the same time.
 *
 * @returns {Set<number>}
 */
export function wheatBreakWhitelist() {
  return new Set([MATURE_WHEAT])
}
