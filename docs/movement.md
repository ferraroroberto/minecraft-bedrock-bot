# Movement

`move_to(x, y, z)` and `look_at(x, y, z)` (`src/movement.js`) go through the same `performAction` gate as every other action (see [Action vocabulary + safety envelope](actions-and-safety.md)) — dry-run by default, the bounded-region check refuses rather than clamps, one rate-limit slot per call regardless of how many ticks it sends, audited the same way. `look_at` is the one action that is **not** spatial: it only rotates the bot, so a look target outside the operating region isn't a movement-safety concern the way a `move_to` target is.

## Why this action is shaped differently

Every other action is one packet (or a short fixed sequence) the caller fires and verifies once. Bedrock's `player_auth_input` is not that — it's the client's continuous, per-tick assertion of its own position, sent every tick the client is connected, not a one-shot command. BedrockX itself has **zero** implementation of it (only the wire shape exists in the pinned `protocol.json`); this sender is built from the protocol definition alone, with nothing to mirror.

## Silence is the success signal

Every other action in the vocabulary follows "never treat a written packet as success" by waiting for an observable world-state change. Movement has none on the happy path: the packet is named `player_auth_input` because the **client asserts** its position each tick, and the server only replies — with `correct_player_move_prediction` — when it **disagrees**. So for `move_to`, "we sent the planned ticks and no correction arrived" *is* the intended positive result, applied to the world model as `applySelfMove` (`src/world.js`) rather than left unconfirmed. A real correction always overrides it; if the corrected position isn't near the target, that is reported as a failure with the server's real position in the reason, never silently accepted.

## Unverified assumptions

Two assumptions are not confirmed against a live packet capture (flag them as such in any change touching `src/movement.js`):

- **Tick cadence: 50ms / 20Hz**, the standard Minecraft simulation tick rate. Nothing in the pin states the client's expected *send* rate for `player_auth_input` specifically — this is the conventional assumption, not a measured one.
- **Walk speed: ~0.2154 blocks/tick** (Minecraft's normal walking speed), used only to size the naive step and the tick budget, not a claim about what the server will accept.

Movement is naive straight-line only — no pathfinding, no obstacle avoidance.
