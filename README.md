# minecraft-bedrock-bot

AI-controllable bot client for Roberto's Minecraft **Bedrock Edition** Realm.

**Current scope.** This repo proves that an external Node.js process can authenticate as a second Microsoft/Xbox account, join the Realm as an invited member, supervise its own reconnects, track a queryable world-state snapshot, act through a fixed, safety-gated action vocabulary (chat, select a hotbar slot, break/place a block, use an item, move, look), and drive that vocabulary from an LLM against a natural-language goal whose success is measured from world state. There is **no pathfinding**. The action vocabulary, movement, and the LLM decision loop are **not wired to a live session** — every layer above the connection is a plain API exercised offline. Three pieces already run against a live process: the world-model reducer (a per-session observer wired into `runSession`), the packet recorder (opt-in via `RECORD_PACKETS`), and the chat kill-switch (`bot stop` triggers clean shutdown). Task capabilities (farming, breeding, trading) are Layer 4 and are gated on the operating-model decision in #12.

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

These codes reach the parent process for real: `1` and `2` are covered by an offline regression test that spawns the actual `node scripts/connect-spike.js` entry point and asserts on its real OS exit code (`test/process-exit.test.js`) — not just on `supervise()`'s in-process return value, which a hung process would still report correctly while never actually delivering it (#11). `0` needed a live connect-then-clean-shutdown to verify, since it's the path a live session's own async cleanup can stall — see the `Client.close()` gotcha below.

Actual daemonization (a `launchd` plist, auto-start at boot, log rotation) is deliberately **not** included — this makes a foreground process survive its own failures and exit legibly, which is exactly the precondition such a wrapper needs.

## World state + packet recorder

The bot now tracks a queryable snapshot of what it has observed — its own
position/rotation/gamemode/dimension/health/hunger, inventory contents,
nearby entities, and any block it has seen an `update_block` for
(`src/world.js`). It is fed by a pure, packet-name-keyed reducer
(`reduce(state, packetName, packet)`) wired into `runSession` as a per-session
observer that cannot throw into the connection path — a bad reducer must not
be able to drop the session. Full `level_chunk` (sub-chunk palette) decoding
is a deliberate stretch goal, not part of this layer.

An opt-in packet recorder (`src/recorder.js`, `RECORD_PACKETS` in `.env`,
default off) appends every inbound and outbound packet to a JSONL trace, with
auth-shaped fields (tokens, XUIDs, network/session ids) redacted before
writing. The next time the bot runs live, that trace becomes a real fixture
corpus for this layer and whatever is built on top of it — at no extra cost
and with no extra live run requested. **Any trace committed to this public
repo must be reviewed first** — if you are not confident it carries no bearer
token, XUID, invite code, or other player's identity, keep it gitignored
instead.

**This layer is structurally correct against the pinned protocol definition,
not yet empirically confirmed against a real packet stream.** All field names
were verified against BedrockX's own `protocol.json` (and cross-checked
against pmmp/BedrockProtocol's independent implementation for two cases the
pin's own field names don't make obvious — see `src/world.js`'s header
comment), but no live packets have been decoded by this code yet.

## Action vocabulary + safety envelope

The bot can now act, through a fixed, schema-validated vocabulary — never raw
packets exposed upward — and every action passes through one gate,
`performAction` (`src/perform-action.js`), before anything is written to the
wire:

- **`chat(message)`**, **`select_slot(slot)`** (`player_hotbar`),
  **`break_block(x, y, z, face)`** (`player_action` start/stop-break),
  **`place_block(x, y, z, face, hotbarSlot)`** and **`use_item(hotbarSlot)`**
  (both `inventory_transaction`, reusing the caller's already-decoded item
  from the world model as `held_item` rather than hand-synthesizing one).
  Packet-building lives in `src/actions.js` and is pure — no client, no I/O.
- **The safety envelope is enforced in code, below the LLM, never in a
  prompt** (`src/safety.js`): **dry-run by default** — actions validate, log,
  and report what they *would* write; nothing is armed unless
  `config.armed === true`. A target outside the **bounded operating region**
  is **refused and logged, naming the region — never silently clamped**.
  Block-breaking is **deny-by-default**, allowed only against an explicit
  `breakWhitelist` of `block_runtime_id`s (the world model does not yet
  decode the chunk palette into block names — see "World state" above).
  A fixed-window **rate limiter** caps actions per window. Every decision —
  allowed, refused, or unverified — goes to an **audit log**.
- **An action's outcome is verified from world state, never from "a packet
  was written."** `performAction` writes, then polls the caller-supplied
  `waitForWorld(predicate, timeoutMs)` for the expected change (a block's
  runtime id changing, a hotbar slot updating, an item stack or health/hunger
  moving); a timeout reports **failure**, not success. `chat` is the one
  documented exception — Bedrock gives no delivery ack and the world model
  doesn't track chat history, so a written chat packet is reported sent.
  `use_item`'s effect is not always uniformly observable either; when nothing
  the world model tracks changes, it correctly reports unverified/failure
  rather than guessing.
- **This is a plain API, not yet wired to anything live.** The LLM decision
  loop that drives it is [its own layer](#llm-decision-loop) and is likewise
  offline; nothing here calls `performAction` from
  `bot.js`/`connect.js` except the one already-live piece, the **chat
  kill-switch**: a player typing the literal `bot stop` in chat (matched
  narrowly — untrusted input, never something an LLM interprets) triggers the
  same clean-shutdown path Ctrl-C uses.
- **Movement (`move_to`/`look_at`) is deliberately not here** — Bedrock's
  `player_auth_input` is a continuous per-tick packet, a different shape of
  problem from the one-shot actions above, and has its own issue (#17).

**All of this is offline-tested and unverified against a live packet
stream**, per the same standing rule as the world model above: field shapes
were read off the pinned `protocol.json`, not confirmed against a real
server. Two specific assumptions worth knowing before an armed run: `use_item`'s
`face` for a no-block-targeted click has no authoritative source in the pin
or in BedrockX's own code (see `src/actions.js`'s comment), and outcome
verification for `use_item` only catches effects the world model already
tracks (held-item stack, health, hunger) — a use with no effect on those three
signals will report as failed even if the server accepted it.

## Movement

`move_to(x, y, z)` and `look_at(x, y, z)` (`src/movement.js`) go through the
same `performAction` gate as every other action (#14) — dry-run by default,
the bounded-region check refuses rather than clamps, one rate-limit slot per
call regardless of how many ticks it sends, audited the same way. `look_at`
is the one action that is **not** spatial: it only rotates the bot, so a look
target outside the operating region isn't a movement-safety concern the way a
`move_to` target is.

**Why this action is shaped differently from the rest of the vocabulary.**
Every other action is one packet (or a short fixed sequence) the caller fires
and verifies once. Bedrock's `player_auth_input` is not that — it's the
client's continuous, per-tick assertion of its own position, sent every tick
the client is connected, not a one-shot command. BedrockX itself has **zero**
implementation of it (confirmed by grep — only the wire shape exists in the
pinned `protocol.json`); this sender is built from the protocol definition
alone, nothing to mirror.

**Silence is the protocol's own success signal here — not a gap in world
modelling to route around.** Every other action in this vocabulary follows
"never treat a written packet as success" by waiting for an observable
world-state change. Movement doesn't get one on the happy path: the packet is
literally named `player_auth_input` because the **client asserts** its
position each tick, and the server only replies — with
`correct_player_move_prediction` — when it **disagrees**. So for `move_to`,
"we sent the planned ticks and no correction arrived" *is* the intended
positive result, applied to the world model as `applySelfMove` (`src/world.js`)
rather than left unconfirmed. A real correction always overrides it; if the
corrected position isn't actually near the target, that's reported as a
failure with the server's real position in the reason, never silently
accepted.

**Two assumptions this makes that are explicitly unverified against a live
packet capture:**
- **Tick cadence: 50ms / 20Hz**, the standard Minecraft simulation tick rate.
  Nothing in the pin states the client's expected *send* rate for
  `player_auth_input` specifically — this is the conventional assumption, not
  a measured one.
- **Walk speed: ~0.2154 blocks/tick** (Minecraft's normal walking speed),
  used only to size the naive step and the tick budget, not a claim about
  what the server will actually accept.

Naive straight-line movement only, per #14's own out-of-scope carve-out — no
pathfinding, no obstacle avoidance.

## LLM decision loop

The bot can now be given a goal in natural language — *"clear the block at
1,64,2"* — and work toward it: observe, decide, act through the safety-gated
vocabulary, re-observe, repeat until the goal is satisfied, the step budget
runs out, or it gives up (`src/decision-loop.js`).

**The point is not that an LLM can drive the bot. It is that we can tell,
mechanically, whether it actually did the thing.** So:

- **Every goal must carry a programmatic success predicate** evaluated against
  world state (`src/goals.js`). `defineGoal` **throws** without one — it is
  impossible to start a run whose only evidence of success is the model saying
  so.
- **The loop's `ok` is the predicate, always.** It is never assigned from
  anything the model reported. Structurally: the function that builds the
  result takes a *reason*, never an outcome, so no code path can construct a
  successful run the predicate did not confirm.
- **`status: "done"` is a claim, not evidence.** If the model says done and the
  world disagrees, that is counted and logged as a false success claim; on the
  second one the run terminates as a **failure** naming exactly that. This is
  the single most important behaviour in this layer, and
  `test/decision-loop.test.js` asserts it first.
- **Model output is untrusted input** (`src/model-reply.js`) — the same posture
  as inbound chat. It is fence-stripped, parsed, schema-validated, and
  range-checked before it can become an action. Invented action names, nested
  args, and oversized strings are refused before reaching the gate.
- **The safety envelope stays the enforcement point.** Every action goes
  through `performAction` (#14) — dry-run by default, bounded region, break
  whitelist, rate limit, audit — so an LLM-chosen action is gated exactly like
  a hand-written one. A refused action is not a crash: it comes back as a
  failed step and is fed to the model as feedback, which it can then correct.
  Identity args (`runtimeEntityId`, `username`, `xuid`) are injected by the
  loop and **cannot be overridden by the model**, so it can never name a
  different entity.

**Two measured constraints shape the implementation**, both probed against the
hub before any of this was written (#12):

- **Native tool-calling does not work** for `claude-*` through the hub — a
  `tools` array comes back HTTP 200, silently ignored, no `tool_use` block. So
  the contract is strict JSON-in-text.
- **An explicit `system` prompt is load-bearing.** Without one the reply comes
  back in Claude Code's own persona. With one it returns clean structured
  output — but it came back wrapped in a ` ```json ` fence *despite being told
  not to*, so the parser strips fences defensively and a schema violation
  triggers a bounded retry-with-repair that feeds the validation error back.

### The fake world

`src/fake-world.js` is a deterministic in-memory world presenting the same
`client.write(name, params)` surface the real client does. It interprets the
outbound packets the vocabulary produces, mutates its own state, and **emits
synthesized inbound packets through the real reducer** (`src/world.js`) — even
the starting state is seeded that way. So the whole loop runs end to end with
no Realm, no network and no account, and Layer 2a is exercised for real rather
than mocked away.

This is deliberately better than a live test, not a substitute for one: an
autonomy test that can only be verified live cannot run deterministically,
cannot run in the gate, and will quietly stop being run. It also makes the
cases that matter cheap to stage — an action that fails, a model that
hallucinates a coordinate, a model that claims success having done nothing.

**What it cannot prove:** every rule in it is *our* assumption about server
behaviour. It proves the loop is internally consistent, never that the real
server agrees — the same "our encoder agrees with our decoder" trap already
noted for the world model and the action vocabulary above. One assumption is a
genuinely open question rather than a simplification: **place**. #14's outcome
verification watches the *clicked* coordinate, so the fake world sets the new
block there; a real server may place it on the adjacent face instead. If it
does, `perform-action.js` and `fake-world.js` are wrong *together* — which is
exactly the failure a self-consistent simulator cannot catch.

### Checking the hub wiring

```bash
npm run hub-check            # one real call, asserting a schema-valid reply
npm run hub-check -- --goal  # that, plus a full goal driven by the real model
```

Deliberately **not** part of `npm run verify`, so the gate stays offline and
hermetic — it must pass on a machine with no hub running. Configure with
`LLM_BASE_URL` / `LLM_MODEL` in `.env` (defaults: `http://127.0.0.1:8000`,
`claude-haiku-4-5` — the hub has a latest-only policy, so re-read its README
before pinning a different id).

**A hub call is not a Realm connection.** It talks to loopback and to a fake
world in memory; it never authenticates, never touches the Realms API, and
never opens a session, so it does not interact with the standing
no-live-Realm rule.

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
- **`Client.close()` fires its signalling socket's teardown without awaiting it, and that teardown is not safe to wait for either.** `client.js:155` calls `this.nethernet.signalling.destroy()` but never awaits the returned promise, and nulls `this.nethernet` on the next line — so by the time `close()` returns, the actual WebSocket close handshake to the NetherNet signalling host (`wss://signal.franchise.minecraft-services.net`) is still in flight, and there is no longer a handle to await it from outside. Measured on the Windows tower (Node 24): after a clean SIGINT shutdown with the connection and lock already released, `process.getActiveResourcesInfo()` showed a lingering `TCPSocketWrap` (the signalling socket) plus timers; left alone, the process did not just hang — it **segfaulted roughly 15 seconds later**, twice in two independent runs, almost certainly from `@roamhq/wrtc`'s native WebRTC teardown finalizing late. This is a second, Windows-specific symptom of the same root cause as the macOS hang originally reported in #11 (which needed `kill -9`). Since neither the socket close nor the native cleanup is ours to fix or safe to await, `scripts/connect-spike.js` exits immediately (`process.exit(code)`) once `main()`'s own state (session, lock, recorder) is confirmed torn down, rather than wait on third-party cleanup that can crash.

## Running it on the Mac Mini

```bash
ssh roberto@192.168.0.14
cd ~/minecraft-bedrock-bot
screen -S mcbot   # tmux isn't installed there; screen keeps the sign-in prompt alive across an SSH hiccup
npm run spike
# detach with Ctrl-A D; reattach later with: screen -r mcbot
```

Note that BedrockX pulls in `@roamhq/wrtc`, a native WebRTC binding. It installs from a prebuilt binary on both Windows x64 and Apple Silicon — verified working on the Mac Mini. The macOS problem is BedrockX's *own* raknet binary, not this one; see [the patch](#macos-the-bedrockx-raknet-patch).
