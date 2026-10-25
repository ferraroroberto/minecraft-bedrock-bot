# minecraft-bedrock-bot

AI-controllable bot client for a Minecraft **Bedrock Edition** Realm.

**Current scope.** This repo proves that an external Node.js process can authenticate as a second Microsoft/Xbox account, join the Realm as an invited member, supervise its own reconnects, track a queryable world-state snapshot, act through a fixed, safety-gated action vocabulary (chat, select a hotbar slot, break/place a block, use an item, move, look), and drive that vocabulary from an LLM against a natural-language goal whose success is measured from world state. There is **no pathfinding**. The action vocabulary, movement, and the LLM decision loop are **not wired to a live session** — every layer above the connection is a plain API exercised offline. Three pieces run against a live process: the world-model reducer (a per-session observer wired into `runSession`), the packet recorder (opt-in via `RECORD_PACKETS`), and the chat kill-switch (`bot stop` triggers clean shutdown). The harvest-and-replant wheat-farming goal (`src/farm.js`, [docs/wheat-farming.md](docs/wheat-farming.md)) exists as an offline API like the rest of the action layer, and no further task capability work is planned.

## Blocking prerequisite

Before running anything here, the bot's Microsoft account must be **invited as a member of the Realm** (Minecraft/Xbox app → Realm → Settings → Invite) **and the invite must be accepted** by signing into Minecraft once as the bot account. This is a manual step outside this repo — nothing here can do it for you.

## Setup

Requires Node.js. Verified on the Windows tower (x64, Node 24) and the Mac Mini (Apple Silicon, macOS 26, Node 26.5.0 via Homebrew).

```bash
npm install
cp .env.example .env
# edit .env — leave REALM_ID blank on the very first run
```

`npm install` runs a `postinstall` hook that applies `patches/bedrockx+1.3.4.patch` via [patch-package](https://github.com/ds300/patch-package). **This is required on macOS** and is a harmless no-op elsewhere. Never bypass it with `--ignore-scripts`. Per-machine rules, the patch contents and SSH access: [docs/setup-and-machines.md](docs/setup-and-machines.md).

## Run

```bash
npm run spike
```

On first run a Microsoft device-code sign-in URL and one-time code are printed; complete the sign-in in any browser. The token is cached under `.secrets/xbox-auth/` (gitignored — **never commit it**). Set `REALM_ID` in `.env` from the Realm list the spike prints. Details, supervision, exit codes and how to read the log: [docs/connect-and-supervision.md](docs/connect-and-supervision.md).

`npm run spike` is a long-lived **foreground** process that supervises and reconnects on its own. It has no service port, tray or version endpoint.

**Restart recipe.** Stop it with **Ctrl-C** (or `kill <pid>`, the PID is in `.secrets/bot.lock`) and start it again. Never sweep `node` processes. Wait ~30s between stopping and restarting: the server holds the old session, and a faster restart gets `server_id_conflict` (the supervisor handles it, at the cost of a backoff cycle). A second start on the same machine refuses and names the lock holder; a stale lock from a hard kill is reclaimed automatically.

## Verification

```bash
npm run verify
```

One pass/fail gate, fail-fast: `node --check` over every `.js` in `src/` and `scripts/`, `node --test` over `test/`, then the vendored ratchets (structure, instruction, doc-refs, static, docs) run through a Python 3.11+. The static ratchet needs `npx` and `pip install ruff` into the repo's `.venv`. Plain node — no PowerShell, no bash-isms — so it runs identically on both hosts. Run it before shipping anything.

**It never touches the Realm by design and does not prove the bot can connect.** A live test is impossible here: it would need an interactive Microsoft sign-in and a per-machine token cache, and since only one connection can exist per Xbox account it would kick the real bot off the Realm (see [Gotchas](docs/gotchas.md)). So a green gate means *"nothing pure is broken"* — **any change to the connect path still needs a manual `npm run spike`** against the live Realm.

## Documentation index

- **Why BedrockX and not `bedrock-protocol`** — the library choice, the NetherNet Realm transport, and why BedrockX is pinned by commit: [docs/why-bedrockx.md](docs/why-bedrockx.md). Read before touching the connect path.
- **Gotchas worth knowing** — protocol and library traps that each cost real debugging time (session conflicts, version gates, identity assertion, `Client.close()`): [docs/gotchas.md](docs/gotchas.md).
- **Handshake breadcrumbs** — the stage ladder and log lines that name where a connect stopped; supervision and exit codes: [docs/connect-and-supervision.md](docs/connect-and-supervision.md).
- **World state + packet recorder** — the reducer-fed world snapshot, the opt-in JSONL recorder and its default exclusions: [docs/world-state-and-recorder.md](docs/world-state-and-recorder.md).
- **Action vocabulary + safety envelope** — the fixed action set, dry-run, bounded region, break whitelist, rate limit, audit, world-verified outcomes: [docs/actions-and-safety.md](docs/actions-and-safety.md).
- **Movement** — `move_to`/`look_at` over the continuous `player_auth_input` packet: [docs/movement.md](docs/movement.md).
- **LLM decision loop**, **The fake world**, hub wiring check — goals with programmatic success predicates, untrusted model output, the in-memory simulator: [docs/decision-loop.md](docs/decision-loop.md).
- **Wheat farming: measured block and item ids** — measured ids, the harvest-and-replant goal, and the unseen-farm limitation: [docs/wheat-farming.md](docs/wheat-farming.md).
- **Layout** — where each folder's code goes, the declared `patches/` exception and the structure-ratchet baseline: [docs/layout.md](docs/layout.md).
- **Blocking prerequisite**, cross-machine setup and the macOS raknet patch: this file and [docs/setup-and-machines.md](docs/setup-and-machines.md).
