# Setup and machines

How the repo is brought up on a host, why some things are never shared between hosts, and what the dependency patch contains. The short install steps live in the [README](../README.md#setup); this is the reference behind them.

## Cross-machine setup

The repo is designed to be brought up from a clean clone on **either** supported host (the Windows tower and the Apple Silicon Mac Mini). Three things are deliberately *not* shared, and each has a reason:

| Thing | Shared? | Why |
|---|---|---|
| Source code | ✅ via git | Normal. |
| `node_modules/` | ❌ per machine | Contains **platform-specific native binaries** (`@roamhq/wrtc`, and BedrockX's raknet binding). Copying it between Windows and macOS produces exactly the `dlopen` crash the patch exists to avoid. Always `npm install` per host. |
| `.env` | ❌ per machine | Gitignored. Two lines; recreate from `.env.example`. |
| `.secrets/xbox-auth/` | ❌ per machine | Holds **live, reusable Xbox Live tokens**. Each machine does its own one-time device-code sign-in, so credentials never travel and there is no sync machinery to leak, corrupt, or go stale. |

**Only one machine can be connected at a time** — see the `server_id_conflict` note in [Gotchas](gotchas.md). Running on either host is a development convenience, never simultaneous operation.

### Bringing up a new machine

```bash
git clone https://github.com/ferraroroberto/minecraft-bedrock-bot.git
cd minecraft-bedrock-bot
npm install                       # postinstall applies the bedrockx patch
printf 'BOT_USERNAME=<bot-gamertag>\nREALM_ID=<realm-id>\n' > .env
npm run spike                     # prints a device code; sign in once in any browser
```

## What `patches/bedrockx+1.3.4.patch` contains

The pinned fork needs four fixes, all applied by `patch-package` on `postinstall`. The bot cannot connect at all until every one is in place, and each hides behind the one before it. Regenerate with `npx patch-package bedrockx` if the pin ever moves; it fails loudly rather than silently no-opping.

| Fix | File | Why |
|---|---|---|
| Lazy `RakClient` require | `src/client.js` | macOS load crash — see below |
| Sign the identity assertion with the **session** keypair | `src/nethernet/src/client.js`, `src/nethernet.js`, `src/client.js` | upstream signed with a fresh throwaway key, so the Realm refused every offer with `CONNECTERROR 37` |
| 1.26.51 protocol definitions + 2 ported native types | `src/protocol/protocol.json`, `src/datatypes/compiler-minecraft.js` | the bundled definitions were 1.26.30-era; newer packets decoded as `Read error` |
| `response_status_name` on `resource_pack_client_response` | `src/createClient.js` | 1.26.40 added a required field; omitting it throws during serialization and the server kicks with `unexpected_packet` |

The protocol.json portion is vendored data taken verbatim from `minecraft-data`'s `bedrock/<version>/protocol.json` for the version the bot announces (the newest one in the installed `minecraft-data`); the hand-written part of the patch is ~110 lines across five files. `test/version.test.js` asserts the patch is applied, so a missing or failed patch fails the gate rather than a live connect.

When the Realm moves to a new game version:

1. `npm install minecraft-data@^<release>` with the release that lists the new version first in `data/bedrock/common/protocolVersions.json`.
2. Copy `node_modules/minecraft-data/minecraft-data/data/bedrock/<version>/protocol.json` over `node_modules/bedrockx/src/protocol/protocol.json`, then `npx patch-package bedrockx`. Only the protocol.json hunks of the patch should change.
3. Serialize every packet the bot builds (`src/actions.js`, `src/movement.js`, `set_local_player_as_initialized`) against the new definitions. A field that changed shape fails here, not at the server.
4. Move the version pin in `test/version.test.js` (its coupling test then checks the vendored file against the new version on its own), then `npm run spike` against the Realm.

### macOS: the BedrockX raknet patch

BedrockX ships two committed prebuilt native binaries — `src/raknet/raknet.node` (Linux x86-64 ELF) and `src/raknet/win-raknet.node` (Windows PE32+) — and `binding.js` picks between exactly those two, falling through to the **Linux** one on any non-`win32` platform. On macOS that `dlopen` fails with `slice is not valid mach-o file` and the process dies at module load, before any network activity.

RakNet is never used here (this Realm is NetherNet), so the patch moves the `RakClient` require inside the `case "DEFAULT"` branch where it is actually used — mirroring what BedrockX's own `server.js` already does. The `DEFAULT` (legacy `ip:port`) transport remains unsupported on macOS, which is fine until such a Realm actually appears.

`@roamhq/wrtc`, the native WebRTC binding BedrockX pulls in, installs from a prebuilt binary on both Windows x64 and Apple Silicon. The macOS problem is BedrockX's *own* raknet binary, not this one.

## Running over SSH on the Mac Mini

Non-interactive SSH does **not** get Homebrew on `PATH`, so `node` appears missing:

```bash
ssh <user>@<mac-mini-host>
export PATH=/opt/homebrew/bin:$PATH   # or use absolute /opt/homebrew/bin/node
cd minecraft-bedrock-bot
```

To run the bot there, use `screen` (`tmux` is not installed; `screen` keeps the sign-in prompt alive across an SSH hiccup):

```bash
screen -S mcbot
npm run spike
# detach with Ctrl-A D; reattach later with: screen -r mcbot
```
