# Project Instructions

Canonical instructions for AI coding agents working in this repository. Claude Code reads this file directly as project memory. Other agents (Cursor, Codex, etc.) reach it via the one-line `AGENTS.md` pointer.

## This repository

Node.js (ESM) client that authenticates a second Microsoft/Xbox account and joins Roberto's Minecraft Bedrock Realm via **[BedrockX](https://github.com/thejfkvis/BedrockX)**, pinned by commit in `package.json`. Not `bedrock-protocol` — that library **cannot connect to this Realm at all**: the Realm has migrated to NetherNet (`NETHERNET_JSONRPC`) and `bedrock-protocol` speaks only RakNet for Realms. Read README → "Why BedrockX and not `bedrock-protocol`" before touching the connect path. `README.md` has setup, layout, usage, and the hard-won protocol gotchas.

Two hosts: the Windows tower (dev) and the Mac Mini at `roberto@192.168.0.14` (Apple Silicon, the intended unattended **production** host). Anything added here must run on both.

### Verification

**The gate is `npm run verify`.** One command, fail-fast, two stages: `node --check` over every `.js` under `src/` and `scripts/` (byte-compile), then `node --test` over `test/`. It must exit 0 before anything ships.

**The gate is offline and can never be an integration test.** Reaching the Realm needs a live Realm, an invited Microsoft account, an interactive device-code sign-in, and a per-machine token cache that by design never leaves the host — and there is only **one connection per Xbox account, ever**, so a test that connected would kick the real bot with `server_id_conflict`. A green gate means *"nothing pure is broken"*, **not** *"the bot can still reach the Realm"*. **Any change to the connect path still needs a manual `npm run spike` against the live Realm**, with the bot account signed out everywhere else. Never report a connect-path change verified on the gate alone.

Decisions recorded so they are not re-litigated (rationale in issue #8):

- **Test runner: `node --test`**, not vitest — zero new dependencies, native ESM, no config. The three fleet repos on vitest all test browser-side DOM modules, which doesn't transfer to a headless CLI. It weighs more here: the dependency tree already carries a single-maintainer GitHub fork (BedrockX) pinned by commit plus a `patch-package` hook, so new dev dependencies are real supply-chain surface.
- **No linter, no type checker.** `node --check` already covers the parse-level ground `ruff` covers in Python; `mypy --strict` has no worthwhile equivalent in plain JS. Revisit when `src/` outgrows a handful of modules.
- **No `scripts/verify-before-ship.ps1`.** PowerShell is unrunnable on the Mac Mini, the host that matters most. `/issue-finish` reads the gate command from this file, so `npm run verify` is fully compatible.
- **No CI, deliberately.** CI is advisory in this fleet and its only documented signal beyond the local gate is an e2e suite — which this repo cannot have (the credential / `server_id_conflict` wall above). It would duplicate the gate and add nothing. If it is ever added, follow the fleet's GitHub Actions CI conventions (pinned `windows-2025` runner, Node-24 action majors, one-trigger-per-commit) and write a `## CI expectations` block at that point — not before.
- **No packet-serialization round-trip tests.** The repo's own evidence says false confidence: the `category: 'message_only'` bug round-tripped through the protocol definition *perfectly* and still made the server drop the connection ~16 s later. The real failure modes here are server-side semantics only a live connection reveals.

### Restart recipe: a foreground CLI, **not** a tray

`npm run spike` is long-lived (it supervises and reconnects, #7) but is still a **foreground process with no service port, no tray, and no `/api/version` endpoint**. The scaffold's tray lifecycle — `tray.bat --restart`, orphan-proof port reclaim by PID, the named-mutex guard — does **not** apply and must not be hand-rolled here. There is no port to reclaim.

To restart: stop it with **Ctrl-C** (or `kill <pid>`, where the PID is in `.secrets/bot.lock`) and start it again. Never a blanket `node`/`taskkill` sweep — that would take down unrelated Node processes on the machine.

The single-instance lock makes this safe: a second start refuses immediately and names the holder rather than fighting it for the one available Xbox session, and a stale lock from a hard kill is reclaimed automatically. **Wait ~30s between stopping and restarting** — the server holds the old session, and a faster restart gets `server_id_conflict` (the supervisor handles this correctly, it just costs a backoff cycle).
