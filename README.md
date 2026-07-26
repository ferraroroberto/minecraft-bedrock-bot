# minecraft-bedrock-bot

AI-controllable bot client for Roberto's Minecraft **Bedrock Edition** Realm.

**Current scope — Layer 1 only.** This repo currently proves one thing: an external Node.js process can authenticate as a second Microsoft/Xbox account, join the Realm as an invited member, exchange chat, and read its own position. There is **no LLM wiring, no pathfinding, and no world model yet** — those are tracked as separate future issues once this foundation is proven out.

## Blocking prerequisite

Before running anything here, the bot's Microsoft account must be **invited as a member of the Realm** (Minecraft/Xbox app → Realm → Settings → Invite) **and the invite must be accepted** by signing into Minecraft once as the bot account. This is a manual step outside this repo — nothing here can do it for you.

## Setup

Requires Node.js (this repo currently runs on the Mac Mini at `roberto@192.168.0.14`, which has Node 26.5.0 via Homebrew).

```bash
npm install
cp .env.example .env
# edit .env — leave REALM_ID blank on the very first run
```

## Running the connect spike

```bash
npm run spike
```

On first run, a Microsoft device-code sign-in URL + one-time code is printed — complete that sign-in in **any** browser (not necessarily on the machine running the bot). The resulting Xbox Live token is cached locally under `.secrets/xbox-auth/` (gitignored — **never commit this directory**, it holds live, reusable tokens) so subsequent runs are non-interactive until the token eventually expires.

With `REALM_ID` left blank, the spike lists the bot account's joined/owned Realms and picks the first — note the target Realm's ID from that output and set `REALM_ID` in `.env` for a deterministic connect on future runs.

Expected output:

```
[realm] "casa Chiquis" transport=NETHERNET_JSONRPC region=FranceCentral
[session] +0.5s Xbox Live session established
[play_status] +1.9s login_success
[join] +3.3s received start_game — connected to the world
[position] x=28.74 y=64.62 z=9.08
[play_status] +6.7s player_spawn
[spawn] +6.7s bot has spawned
[chat->] +6.7s Gizmo6082 has connected.
[chat<-] +28.2s Roberto39764: hello there
```

Stop it with Ctrl-C; it stays connected indefinitely otherwise.

## Why BedrockX and not `bedrock-protocol`

The obvious library for this is PrismarineJS's [`bedrock-protocol`](https://github.com/PrismarineJS/bedrock-protocol). **It cannot connect to this Realm.**

Realms have been migrating to **NetherNet**, Microsoft's WebRTC-based transport. The Realms API now returns:

```json
{ "networkProtocol": "NETHERNET_JSONRPC",
  "address": "94944b1c-c5ab-4525-bab6-d015e88d77de",
  "sessionRegionData": { "regionName": "FranceCentral" } }
```

`address` is a WebRTC network ID, not the legacy `ip:port`. `bedrock-protocol` (3.57.0, latest at time of writing) assumes the old shape — `prismarine-realms`' `getRealmAddress()` does `address.split(':')`, producing a GUID host and a `NaN` port, then fails a RakNet UDP ping with `sendto failed`. It has no NetherNet support at all, and upstream work is unmerged and stalled ([#533](https://github.com/PrismarineJS/bedrock-protocol/pull/533) draft, [#735](https://github.com/PrismarineJS/bedrock-protocol/pull/735) conflicted, [#717](https://github.com/PrismarineJS/bedrock-protocol/issues/717) the matching issue).

[BedrockX](https://github.com/thejfkvis/BedrockX) is a fork that implements the NetherNet JSON-RPC signalling path. It is **pinned to a specific commit** in `package.json` — it is not published to npm, has a single maintainer and no test suite, so an unpinned floating reference would be a supply-chain risk. Re-pin deliberately, not casually.

`prismarine-auth` and `prismarine-realms` are still used directly, for the Microsoft auth flow and the Realms API respectively.

## Gotchas worth knowing

These each cost real debugging time; they are not obvious from any documentation.

- **One connection per Xbox account, ever.** A second simultaneous connection as the same account gets an immediate `server_id_conflict` kick — including when the account is signed into the Minecraft client on a console/PC. After killing a bot process, the server needs a few seconds to release the session before a reconnect succeeds.
- **`set_local_player_as_initialized` must be sent on spawn.** BedrockX's `createClient` never sends it (upstream `bedrock-protocol` does). Without it the server never treats the player as fully joined and drops the connection within seconds of spawning.
- **Outgoing chat needs `category: 'authored'`.** Sending `'message_only'` serializes and round-trips perfectly through the protocol definition, but makes the server silently drop the connection ~16 seconds later. The field shape used here mirrors a real inbound chat packet captured off the wire.
- **Chat source names carry formatting codes.** The server appends `§r` (e.g. `Roberto39764§r`), so naive `source_name === username` comparisons fail — strip `§.` first.
- **Position comes off the raw `start_game` packet.** BedrockX re-emits raw packet names; there is no synthesized `spawn` event and no `client.startGameData` convenience property.
- **The Realms API pins a client version.** It rejects anything but the current game version with `{"errorCode":6020,"errorMsg":"Unknown client version"}`, so `MC_VERSION` / `PROTOCOL_VERSION` in the spike must track the live game (currently `1.26.30` / `1001`).

## Running it on the Mac Mini

```bash
ssh roberto@192.168.0.14
cd ~/minecraft-bedrock-bot
screen -S mcbot   # tmux isn't installed there; screen keeps the sign-in prompt alive across an SSH hiccup
npm run spike
# detach with Ctrl-A D; reattach later with: screen -r mcbot
```

Note that BedrockX pulls in `@roamhq/wrtc`, a native WebRTC binding. It installs from a prebuilt binary on Windows x64; the Mac Mini leg is not yet verified.
