# World state + packet recorder

The bot tracks a queryable snapshot of what it has observed — its own position/rotation/gamemode/dimension/health/hunger, inventory contents, nearby entities, and any block it has seen an `update_block` for (`src/world.js`). It is fed by a pure, packet-name-keyed reducer (`reduce(state, packetName, packet)`) wired into `runSession` as a per-session observer that cannot throw into the connection path — a bad reducer must not be able to drop the session. Full `level_chunk` (sub-chunk palette) decoding is a deliberate stretch goal, not part of this layer.

## Packet recorder

An opt-in packet recorder (`src/recorder.js`, `RECORD_PACKETS` in `.env`, default off) appends every inbound and outbound packet to a JSONL trace, with auth-shaped fields (tokens, XUIDs, session ids, addresses, keys/certificates) redacted before writing. Redaction is deliberately case-sensitive for NetherNet's transport id: camelCase `networkId` is redacted, while Bedrock's own snake_case `network_id` — the **item type id** on every inventory item — is not, since redacting it would strip exactly the field this corpus is captured to preserve. A trace from a live run becomes a fixture corpus for this layer and whatever is built on top of it, at no extra cost and with no extra live run.

**Any trace committed to this public repo must be reviewed first** — if you are not confident it carries no bearer token, XUID, invite code, or other player's identity, keep it gitignored instead.

### Default exclusions

**Three packet types are excluded by default**, because unfiltered the recorder is unusable for the sessions it exists to capture. A 3m10s live capture wrote 357.6 MB across 449,066 packets, putting a 20-minute farm demo at roughly 2.4 GB. A bytes-per-type breakdown of that trace (`npm run trace-stats <file>`; bytes rather than counts because count is not volume — `level_chunk` is 937 packets but 17.5 MB) shows why:

| Packet | Packets | Bytes | Share |
|---|---|---|---|
| `set_entity_data` | 189,521 | 253.32 MB | 70.84% |
| `move_entity_delta` | 195,342 | 61.80 MB | 17.28% |
| `set_entity_motion` | 57,341 | 11.04 MB | 3.09% |
| — everything else — | 6,862 | 31.45 MB | 8.79% |

Dropping exactly those three takes the same capture to 31.5 MB, of which ~27 MB is one-shot registries and chunk streaming that scale with area explored rather than session length.

This is not a free trade: `move_entity_delta` **is** read by `reduce()` (`src/world.js`'s `HANDLERS` table) — it is the only mechanism by which a tracked entity's position updates after `add_entity`, and `src/observation.js` feeds that position to the model as each entity's `distance`. Blocks are keyed off `update_block` alone (`update_subchunk_blocks` is a known gap, see below), inventory off `inventory_content`/`inventory_slot`. So the default exclusion trades entity-position replay for 91% of the bytes — a capture intended as an entity-tracking fixture must set `RECORD_PACKETS_EXCLUDE` accordingly (at minimum, dropping `move_entity_delta` from the excluded set costs the 17.28% share back). The list stays deliberately narrow: a filter that quietly drops something a later layer needs is a fixture gap discovered months later, and re-capturing costs a live Realm session the owner has to run in person.

Override with `RECORD_PACKETS_EXCLUDE` in `.env` (a comma-separated list, which replaces the default set outright). **Blank means the default set, not "record everything"** — `.env.example` ships the key blank, and copying it must not silently re-arm the 2.4 GB behaviour; the explicit opt-out is the literal `RECORD_PACKETS_EXCLUDE=none`. The filter lives in `createRecorder` itself, so inbound and outbound cannot drift apart, and the effective exclude set is logged at startup (`recorder — recording packets to … (excluding: …)`) so a trace opened months later is traceable to what it omits.

## What is empirically confirmed

The reducer is confirmed for the packets it has actually seen, not merely structurally correct against the pinned protocol definition. All field names were verified against BedrockX's own `protocol.json` (and cross-checked against pmmp/BedrockProtocol's independent implementation for two cases the pin's own field names don't make obvious — see `src/world.js`'s header comment), and live captures decoded `update_block`, `inventory_slot`/`inventory_content`, `mob_equipment`, `item_registry` and the entity packets cleanly, with zero decode errors across 7,432 packets and 64 types.

That is confirmation for the packets those sessions happened to contain, which is not the same as confirmation of the whole reducer. `update_subchunk_blocks` in particular is a block-change source but is **not** handled by `reduce()` — only `update_block` is — so block changes delivered in a batch are invisible to the world model. No observed farm activity has arrived that way, which is why it has not been chased; it is a real gap, not a settled question.
