# Wheat farming: measured block and item ids

`src/blocks.js` holds the first fixture-derived constants in this repo — the wheat growth-stage block ids, the air id, and the seed/wheat item ids — and `src/farm.js` turns them into a harvest-and-replant goal predicate over world state. The values matter less than where they came from, so the provenance is written into the module header.

**They cannot be derived, only measured.** This Realm sends block ids as *hashes* rather than palette indices (`block_network_ids_are_hashes` in `start_game`, and every observed id is a full signed 32-bit value like `1670228562`), so there is no table to look them up in — and `src/world.js` deliberately never decodes the chunk palette, so nothing in this codebase maps an id to a name even in principle. Computing the hashes ourselves would mean re-implementing Mojang's NBT canonicalisation and then trusting it, which is the same "our encoder agrees with our decoder" trap the [Gotchas](gotchas.md) document.

So they are read off a live session. `npm run mine-farm-ids <trace.jsonl>` does the reading, and re-running it against a fresh capture is how these get re-confirmed after a game update. It mines the two halves very differently, because the wire gives them away very differently:

- **Items are exact.** The one-shot `item_registry` packet carries the server's whole item table as `{name, runtime_id}` — 1,976 entries — so `minecraft:wheat_seeds` is simply in there. Any trace that got past login already contains it; no experiment needed.
- **Blocks are behavioural.** Nothing on the wire names a block, so the ids come from watching known actions: break a plant and the id left behind is air, replant and the next id is growth stage 0, bone-meal and each application steps the ladder. The script groups every block change by position and prints each position's id sequence in time order, so the ladder falls out directly.

Source capture: client 1.26.40 / protocol 2168, server engine 1.26.43 — one wheat plant at a fixed position:

| Constant | Id | How it was established |
|---|---|---|
| `AIR` | `-604749536` | the block left behind by `block_start_break` |
| `WHEAT_STAGE_0` | `1485804093` | seeds replanted 14.8s later |
| *(intermediate)* | `1424329270`, `1793178208` | 1st and 2nd bone meal |
| `MATURE_WHEAT` | `1670228562` | 3rd bone meal, **then confirmed by a negative test** |

**`MATURE_WHEAT` is the only id that has to be exactly right**, because it is the sole entry on the break whitelist: too low and the bot destroys a growing crop for no yield, too high and it refuses to harvest anything. Being the highest id the ladder *reached* is not the same claim as being the top of the ladder, so it was confirmed the only way a top can be confirmed — a negative. Bone meal on fully-grown wheat is a no-op, so a fourth application was made and the trace stayed silent. Silence is only evidence if the observer was awake, so that was checked too rather than assumed: the recorder's most recent packet was 0.0s old and still streaming, and `move_player` put a player adjacent to the crop throughout. Re-run all three parts of that check if this id is ever updated after a version bump — a ladder that merely stopped being extended proves nothing, and neither does a quiet trace from a bot that had already dropped.

**The immature stages are deliberately not enumerated.** `checkBreakWhitelist` is deny-by-default, so an id that is not `MATURE_WHEAT` is refused whether or not this repo has ever seen it. Listing stage 4 would buy nothing and invite exactly the guessed constant this document exists to forbid. `WHEAT_IMMATURE_OBSERVED` exists for diagnostics and for the refusal test, and nothing in the safety envelope reads it.

## The goal predicate, and what it can honestly claim

`harvestAndReplantGoal({ region })` is satisfied when, inside the region, at least one crop cell has been observed, none of them is mature wheat, and none is empty — harvest *and* replant, both asserted from `world.blocks`, never from the model's report.

That `at least one` is not a formality. "No observed cell is mature" is trivially true when nothing has been observed, and `src/decision-loop.js` evaluates the predicate *before* the first step so an already-satisfied goal costs no model calls — so without the evidence requirement a bot that had just joined, seen nothing and done nothing would be handed `goal was already satisfied before any action was taken`. A false pass produced by the very check meant to make false passes impossible. Requiring evidence can only make a run fail, never falsely pass, which is the same asymmetry the loop applies to a predicate that throws.

## Known limitation: the bot cannot see a farm it did not watch change

`src/world.js` feeds its block map from `update_block` alone. `level_chunk` arrives ~1,000 times a session as a **raw undecoded payload buffer** and is never read. So the bot knows a block only if it observed that block *change*.

The practical consequence is the difference between the feature working and the feature being useful: the bot can harvest a farm it watched grow, but it **cannot walk up to standing wheat that was already there when it joined**. It would consult an empty block map and refuse every break as "no known block observed there yet" — deny-by-default working correctly on no evidence, not a bug in this layer.

Closing that gap means decoding the sub-chunk block storage and its palette; that work is **not planned** ([the decoder issue](https://github.com/ferraroroberto/minecraft-bedrock-bot/issues/49), closed as not planned), so this limitation stands. The measured ids above are what any future decoder would get validated *against*: decode a chunk over the farm and the wheat cells must come back as exactly the ids in the table. That is a cross-check between two independent sources — a decoder agreeing with our own encoder would prove nothing.
