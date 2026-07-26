# minecraft-bedrock-bot

AI-controllable bot client for Roberto's Minecraft **Bedrock Edition** Realm.

**Current scope — Layer 1 only.** This repo currently proves one thing: an external Node.js process can authenticate as a second Microsoft/Xbox account, join the Realm as an invited member, exchange chat, and read its own position. There is **no LLM wiring, no pathfinding, and no world model yet** — those are tracked as separate future issues once this foundation is proven out.

## Blocking prerequisite

Before running anything here, the bot's Microsoft account must be **invited as a member of the Realm** (Minecraft/Xbox app → Realm → Settings → Invite) **and the invite must be accepted** by signing into Minecraft once as the bot account. This is a manual step outside this repo — nothing here can do it for you.

## Setup

Requires Node.js. Verified on the Windows tower (x64, Node 24) and the Mac Mini at `roberto@192.168.0.14` (Apple Silicon, macOS 26, Node 26.5.0 via Homebrew).

```bash
npm install
cp .env.example .env
# edit .env — leave REALM_ID blank on the very first run
```

`npm install` runs a `postinstall` hook that applies `patches/bedrockx+1.3.4.patch` via [patch-package](https://github.com/ds300/patch-package). **This is required on macOS** — see [Cross-machine setup](#cross-machine-setup) — and is a harmless no-op elsewhere. Never bypass it with `--ignore-scripts`.

## Cross-machine setup

The repo is designed to be brought up from a clean clone on **either** machine. Three things are deliberately *not* shared, and each has a reason:

| Thing | Shared? | Why |
|---|---|---|
| Source code | ✅ via git | Normal. |
| `node_modules/` | ❌ per machine | Contains **platform-specific native binaries** (`@roamhq/wrtc`, and BedrockX's raknet binding). Copying it between Windows and macOS produces exactly the `dlopen` crash the patch exists to avoid. Always `npm install` per host. |
| `.env` | ❌ per machine | Gitignored. Two lines; recreate from `.env.example`. |
| `.secrets/xbox-auth/` | ❌ per machine | Holds **live, reusable Xbox Live tokens**. Each machine does its own one-time device-code sign-in, so credentials never travel and there is no sync machinery to leak, corrupt, or go stale. |

**Only one machine can be connected at a time** — see the `server_id_conflict` note under [Gotchas](#gotchas-worth-knowing). Running on either host is a development convenience, never simultaneous operation.

### Bringing up a new machine

```bash
git clone https://github.com/ferraroroberto/minecraft-bedrock-bot.git
cd minecraft-bedrock-bot
npm install                       # postinstall applies the bedrockx patch
printf 'BOT_USERNAME=Gizmo6082\nREALM_ID=29251526\n' > .env
npm run spike                     # prints a device code; sign in once in any browser
```

### macOS: the BedrockX raknet patch

BedrockX ships two committed prebuilt native binaries — `src/raknet/raknet.node` (Linux x86-64 ELF) and `src/raknet/win-raknet.node` (Windows PE32+) — and `binding.js` picks between exactly those two, falling through to the **Linux** one on any non-`win32` platform. On macOS that `dlopen` fails with `slice is not valid mach-o file` and the process dies at module load, before any network activity.

We never use RakNet (this Realm is NetherNet), so `patches/bedrockx+1.3.4.patch` simply moves the `RakClient` require inside the `case "DEFAULT"` branch where it's actually used — mirroring what BedrockX's own `server.js` already does. The `DEFAULT` (legacy `ip:port`) transport remains unsupported on macOS, which is fine until such a Realm actually appears.

If the pinned BedrockX commit is ever changed, the patch must be regenerated (`npx patch-package bedrockx`). It fails loudly rather than silently no-opping.

### Running over SSH

Non-interactive SSH does **not** get Homebrew on `PATH`, so `node` appears missing:

```bash
ssh roberto@192.168.0.14
export PATH=/opt/homebrew/bin:$PATH   # or use absolute /opt/homebrew/bin/node
cd ~/minecraft-bedrock-bot
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

Stop it with Ctrl-C; it stays connected indefinitely otherwise, reconnecting on its own.

### Supervision

The bot is no longer a straight-line script — it runs a supervised loop that survives the failure modes above unattended.

- **Reconnect backoff** is per-condition. `server_id_conflict` starts at **30s** (the measured session-release window) and escalates 30 → 60 → 120 → 240 → 300s; an ordinary disconnect uses a shorter 5 → 15 → 30 → 60 → 120s ladder; API failures use their own. Jitter is added **upward only** — 30s is an empirical *lower* bound, so jittering below it would reintroduce the kick.
- **The failure streak resets only after a connection has stayed up for 60s**, so a connection that establishes and immediately drops can never turn into a tight loop. After 10 consecutive failures without a stable connection it gives up and exits non-zero rather than looping silently.
- **A single-instance lock** at `.secrets/bot.lock` holds the running PID. A second start on the same machine exits immediately, names the holder, and never touches it. A stale lock left by a `kill -9` is reclaimed automatically. It **cannot** see the Minecraft client signed in as the bot account, or a bot on the *other* machine — `server_id_conflict` handling is the real backstop for those.
- **The client version is resolved from `minecraft-data`** rather than hardcoded, so it cannot announce a version the client can't actually speak. Override deliberately with `MC_VERSION` **and** `PROTOCOL_VERSION` together.

**Exit codes** — so a `launchd`/`systemd` wrapper can tell "restart me" from "give up":

| Code | Meaning |
|---|---|
| `0` | clean shutdown (Ctrl-C / SIGTERM) |
| `1` | terminal failure — expired auth, rejected client version, not a Realm member. Retrying cannot fix it; the log says what to do |
| `2` | another instance holds the lock |
| `3` | gave up after 10 consecutive failures without a stable connection |

Actual daemonization (a `launchd` plist, auto-start at boot, log rotation) is deliberately **not** included — this makes a foreground process survive its own failures and exit legibly, which is exactly the precondition such a wrapper needs.

## Verification

```bash
npm run verify
```

One pass/fail gate, fail-fast: `node --check` over every `.js` in `src/` and `scripts/`, then `node --test` over `test/`. Plain node — no PowerShell, no bash-isms — so it runs identically on both hosts. Run it before shipping anything.

**It is offline by design and does not prove the bot can connect.** A live test is impossible here: it would need an interactive Microsoft sign-in and a per-machine token cache, and since only one connection can exist per Xbox account it would kick the real bot off the Realm (see [Gotchas](#gotchas-worth-knowing)). So a green gate means *"nothing pure is broken"* — **any change to the connect path still needs a manual `npm run spike`** against the live Realm.

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

- **One connection per Xbox account, ever.** A second simultaneous connection as the same account gets an immediate `server_id_conflict` kick — including when the account is signed into the Minecraft client on a console/PC. After killing a bot process the server holds the old session for a while: measured, an **8-second** gap still gets kicked and a **30-second** gap reconnects cleanly. Handled: the supervisor treats `server_id_conflict` as its own condition with a ladder starting at 30s, and a lock file stops two local processes starting at all.
- **The Realms API returns transient `503 Service Unavailable`.** Seen immediately after a fresh device-code sign-in. Note `prismarine-realms` **already retries 5xx itself** — 4 times, 1/2/4/8s ≈ 15s — so a 503 that reaches us has already been failing for ~15s. It does **not** retry `fetch`-level network errors (DNS, socket resets); those throw before its status check, and the supervisor is the only thing handling them. Both are now retried with backoff instead of crashing the process.
- **A rejected client version is a `400`, not a `5xx`** — measured: `400 Bad Request {"errorCode":6020,...}` returned in 247ms, so it burns none of the retry budget. The version gate applies only to `/worlds/{id}/join`; listing Realms accepts any version.
- **BedrockX can kill the process without emitting anything you can catch.** `websocket/signal-jsonrpc.js:134` calls `this.client.emit(...)` where `this.client` is never assigned, so any websocket-level error on the `NETHERNET_JSONRPC` transport throws a `TypeError` inside a callback; and `createClient.js:7` calls `client.init()` without awaiting or catching it, so a signalling failure becomes an unhandled rejection. Neither reaches a `client.on('error')` handler. `src/faults.js` installs the process-level net that turns these into ordinary reconnects.
- **Never call `client.close()` on a client the library already closed.** `close()` nulls `this.nethernet` at `client.js:156` but reads `this.nethernet.signalling` at `:155`, so a second close throws. On a kick the library emits `kick` and then closes itself, so one disconnect arrives as two events.
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

Note that BedrockX pulls in `@roamhq/wrtc`, a native WebRTC binding. It installs from a prebuilt binary on both Windows x64 and Apple Silicon — verified working on the Mac Mini. The macOS problem is BedrockX's *own* raknet binary, not this one; see [the patch](#macos-the-bedrockx-raknet-patch).
