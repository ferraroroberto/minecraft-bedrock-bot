# Project Instructions

Canonical instructions for AI coding agents in this repo. Claude Code reads it as project memory; other agents reach it via the one-line `AGENTS.md` pointer.

> **Scope.** This file owns only what is *specific to a project's shape*, each section gated *"apply only if…"*. **Universal** dev-workflow directives (plan mode, asking, before/while editing, execution, conventions, git, branch & PR pipeline, planning, documentation, senior-dev check) live once in `fleet-config/global-CLAUDE.md` (installed as `~/.claude/CLAUDE.md` / `~/.codex/AGENTS.md`) and are **not** restated here. Test: *"would it apply to a bare repo with no app?"* Yes → global; no → here. Never both — `/context-audit` enforces weekly. (`ferraroroberto/project-scaffolding#68`.)

## Streamlit conventions
*Apply only if this project uses Streamlit.*

- `st.set_page_config(layout="wide", page_title="...")` MUST be the first Streamlit call.
- Use `width="stretch"` (and `width="content"` where appropriate). **Never** introduce new `use_container_width=True` — deprecated; migrate existing uses when you touch that code.
- All mutable state in `st.session_state`. No module-level globals.
- `@st.cache_data` for DataFrames/files; `@st.cache_resource` for DB clients/models.
- Every widget needs a stable, explicit `key=`.
- UI code only in the UI directory (e.g. `app/`); data logic in the non-UI package (e.g. `src/`). Never import `streamlit` from non-UI code.
- User feedback via `st.error()` / `st.warning()` / `st.success()`, not `st.write()`.
- **App layout:** the main file (e.g. `app.py`) handles only page config, shared state, sidebar, routing. Default to native multipage nav — `st.navigation` + `st.Page`, one view per file exposing `render()`. `st.tabs()` for sub-sections *within* a view; a sidebar radio only when asked.
- **Ask before assuming (Streamlit specifics):** `st.session_state` key names & scope; caching strategy (`@st.cache_data` TTL vs `@st.cache_resource`); widget `key=` names & input sources; page placement (new page vs a section in an existing page).

## Web-app visual identity (fleet design system)
*Apply only if this project serves a FastAPI + static PWA web app; Streamlit POC spikes exempt.*

A fleet web app inherits look **and** navigation; it re-authors neither. `fleet-config` owns the *spec* (`design.md` + `design.dark.md`, junctioned into `~/.claude`, plus `/design-sync`); the scaffold owns the *vendored implementation* (`app/webapp/static/_vendored/`).

- **Tokens come from the spec.** Wire CSS custom properties to `~/.claude/design.md` (light) + `~/.claude/design.dark.md` (dark) — colors, typography, spacing, radii — defined in your `:root` / `[data-theme]` blocks pointing at those values. **Don't** copy the spec into your repo; **don't** invent a second accent or per-app palette. `/design-sync` reports drift.
- **Nav is vendored, not re-implemented.** The floating bottom-tab pill (desktop segmented control → mobile pill — the fleet *navigation contract*) comes from `app/webapp/static/_vendored/nav/` (`nav-tabs.js` + `nav-tabs.css` + `nav-tabs.html`): copy the folder **verbatim**, adapt only your markup (which tabs) and the `storageKey`. The nav markup must be a direct `<body>` child and sibling of `<main class="app">`, **never** nested inside the content wrapper/scroller — iOS captures fixed-position descendants of scrollers and anchors them to short-tab content instead of the viewport (`home-automation#232`, real iPhone PWA). Same "copy byte-for-byte, never fork per-app" rule as the tray's `single_instance.py`.
- **`_vendored/` is the UI component channel.** New shared HTML/CSS/JS components live under `app/webapp/static/_vendored/<component>/`, normalized from the best existing fleet implementation. Don't hand-copy a sibling app's snippet — vendor it. Convention: `app/webapp/static/_vendored/README.md`.
- **Don't diverge / don't re-author.** A change to a vendored component or the token contract is made in the scaffold and re-vendored downstream, never forked in a consuming app. (`ferraroroberto/project-scaffolding#79`; aligns `ferraroroberto/fleet-config#178`.)

## UX surface — diff-keyed design-conformance gate
*Apply only if this project serves a FastAPI + static PWA web app; Streamlit POC spikes exempt.*

**Two distinct checks — keep them separate, use both, scoped to the diff.** A *token check* (`/design-sync`-style) diffs CSS custom properties (light + dark) + the nav contract against the spec: static, no browser, **never renders the page** — blind to "nav pushed off-screen / cards overlap". A *visual verification* (`verify`-style) launches the live app, drives the touched view headed, and screenshots — the only check that *sees* the result, and the token-expensive leg.

**Each project declares a `## UX surface` block in its own `CLAUDE.md`** — the per-project *instance* the skills read (as `## CI expectations` does for the e2e skip); don't inline these paths into the skill. The block below is a **live** declaration, not a fenced sample: turning the gate on = flip `design spec applies` to `yes` and adapt the paths/views. Keep it under this heading — `ux_surface.py` tolerates the descriptive `— …` suffix, so do **not** add a second `## UX surface` heading (the parser matches this one first and would read nothing).

**The live block for this repo** — edit these lines in place; the skills read exactly them:

- design spec applies: no        # flip to `yes` once this repo serves a FastAPI + static PWA; `no` = gate no-ops
- paths:
  - app/webapp/static/**/*.css
  - app/webapp/templates/**
  - app/webapp/static/**/*.{js,html}
- key views:                     # used only by the `ux-full` whole-app sweep
  - /          (home + bottom nav)
  - /settings

**The gate contract:**
- **Deterministic, diff-keyed — not a per-run LLM judgment.** Trigger is purely: does `git diff <main>...HEAD` intersect the declared `paths`? Yes → gate runs. No → skip silently and **state it** in the finish summary (`no UX surface touched`).
- **Cheap design-aware load at `/issue-start`.** When the picked issue is *likely* to touch the UX surface, read `~/.claude/design.md` + `design.dark.md` into context **before** building. No `/design-sync`, no screenshot at start.
- **Gate at `/issue-finish` (and `/issue-yolo`), only when the diff touched the surface** — two legs:
  - **Token check, fix-now semantics:** compare the touched UX files (CSS custom properties light + dark + the nav contract) to the spec and **fix material drift in this branch before merge** — unlike vanilla `/design-sync`, which files-and-defers a `design-drift` issue (that stays as-is for the periodic sweep).
  - **One screenshot of the touched view** via the `verify` skill, attached to the PR body. Diff-scoped, never a whole-app sweep by default.
- **Manual overrides:** `ux` / `design` forces the gate; `no-ux` skips it; `ux-full` audits the whole app's `key views` — the one expensive path, opt-in only.
- **Materiality bar:** a 1-unit radius/spacing nitpick is not a blocker; a wrong canvas color, a missing dark theme, a hand-rolled nav, or a visibly broken layout is.
- **Keep-the-human-in-control.** The agent always **states** the gate decision (ran / skipped / `ux-full`, plus any drift it fixed) in the finish summary.
- Browser screenshots must go through the `verify` skill's stealth-Chrome launch (real Chrome, no automation infobar, per global `CLAUDE.md`) — never re-inline launch args.

Skill mechanism: `fleet-config` `skills/issue-{start,finish,yolo}/SKILL.md` (`fleet-config#195`); periodic fleet-wide drift sweep is separate (`fleet-config#180`). Decision record `project-scaffolding#83`.

## HTTPS provisioning
*Apply only if this project serves a FastAPI + static PWA web app; Streamlit POC spikes exempt.*

An installed PWA needs HTTPS (Service Workers + Web Push are HTTPS-only); the path is decided by **how the app is reached remotely**.

- **Reached over Tailscale → `tailscale cert` (preferred).** Provision a **real Let's Encrypt leaf** for the tailnet MagicDNS name with `scripts/gen_tailscale_cert.py`: no public DNS name, no HTTP-01/DNS-01 setup, no inbound exposure, and **zero per-device trust steps** (no CA install, no `.mobileconfig`, no iOS Certificate-Trust toggle, no Chrome-restart gotcha). One-time prereq: enable HTTPS in the tailnet admin console (**DNS → HTTPS Certificates**), once per tailnet.
- **Auto-renew on startup is mandatory** — the LE leaf is **~90 days** (vs a self-signed root's 10 years), so a manual re-issue *will* be forgotten. `gen_tailscale_cert.py --check` renews **only** a `.ts.net` cert expiring within ~30 days, **no-ops a self-signed cert**, and never blocks startup on error. Wire `--check` into the **app's own webapp launcher** (e.g. `webapp.bat`), before uvicorn binds — **not** the generic `tray.bat.template`. Reference: `grocery-shopping-automation`'s `webapp.bat`.
- **LAN-only / no Tailscale → self-signed CA (fallback).** `gen_ssl_cert.py` + the per-device trust dance (`certutil -user -addstore Root ca.pem` + the full-Chrome-restart gotcha; iOS `/install-ca` `.mobileconfig` + Certificate-Trust toggle). Correct **only** when there is no tailnet. The in-app `/install-ca` Settings affordance (`#74`) is scoped to this fallback — a `tailscale cert` app does not ship it.
- **Don't diverge.** Full procedure: `docs/app-onboarding.md` §2–§3. (`project-scaffolding#89`.)

## Webapp PWA required surfaces (build-identity footer + Settings/CA-install)
*Apply only if this project serves a FastAPI + static PWA web app; Streamlit POC spikes exempt.*

- **Build-identity footer — `GET /api/version` → `{git_sha, built_at}`.** Capture the values **once at module load** via a hardened `git rev-parse --short HEAD` (`git -C <project-root>`, `stdin=subprocess.DEVNULL` + `creationflags=CREATE_NO_WINDOW` so the windowless tray never flashes a console); render `Build: <sha> · <ts>` as a plain `<p>` **outside every card**. A `/healthz` 200 passes on a stale process, a matching `git_sha` does not — the `/issue-finish` + `/issue-yolo` tray-restart verification **depends on this endpoint existing**. **Auth-gated** (loopback bypasses; the PWA attaches the bearer via the page's `jsonApi`) so a build SHA is never exposed to an unauthenticated remote caller. **Universal** — present regardless of how HTTPS is provisioned.
- **Settings block — a collapsible `⚙️ Settings` `<details>` with an Install-certificate link** to `/install-ca` (the route serving the iOS `.mobileconfig`), plus a short iOS trust how-to beside it. `/install-ca` is **auth-exempt**, so the link is a plain `<a href>` navigation that works over Tailscale without a token — **not** a `jsonApi` fetch. The block's **app-specific** contents (config fields, passkey/WebAuthn, tunnel status) are *not* part of the standard.
- **The CA-install link is conditional on the HTTPS path (ties to `#89`)** — it ships **only** on the self-signed / LAN-only fallback; a `tailscale cert` app **omits or hides** it. The `/api/version` footer stays regardless.
- **Don't diverge.** Documented, not seeded (the scaffold ships no starter FastAPI server); a vendored `_vendored/settings/` component is a future step. Reference implementations: `app-launcher` `app/webapp/routers/misc.py` + its `static/{index.html,main.js}`, and `home-automation`. (`project-scaffolding#74`.)

## Webapp PWA static-asset cache-busting (`CachingStaticFiles` + fleet hash)
*Apply only if this project serves a FastAPI + static PWA web app; Streamlit POC spikes exempt.*

iOS Safari — installed home-screen PWAs especially — heuristic-caches static assets served by a bare Starlette `StaticFiles` mount (only `ETag`/`Last-Modified`, **no explicit `Cache-Control`**): after a deploy + tray restart the device keeps running the **old cached JS/CSS** while `/api/version` reports the new build, and only deleting + re-adding the PWA clears it. A **required convention**, already shipped fleet-wide.

- **One canonical reference, copied — not re-derived:** `home-automation/src/static_versioning.py` + the `CachingStaticFiles(StaticFiles)` subclass (`home-automation/app/webapp/server.py`); adapt nothing but the static dir. Canonical method names: **`BuildInfo.stamp_html` / `stamp_js`** (wrapping `rewrite_index_html` / `rewrite_js_imports`).
- **Fleet hash, not a naive per-file hash** — one SHA-256 over the concatenation of every hashable file's per-file hash, so any edit to any module rotates *every* `?v=` stamp. (The webapp is an ES-module graph `index.html` → `main.js` → imports, so a per-file hash goes stale on transitive edits.)
- **Stamp idempotently, degrade gracefully.** The import/href regexes also capture an existing `?v=…` and replace it, so re-stamping an already-served body is safe; an unreadable static dir or missing file falls back to **unstamped** URLs rather than crashing the page.
- **Per-suffix `Cache-Control`; the shell always revalidates.** `.js`/`.css` → `public, max-age=31536000, immutable` (safe because the fleet hash is the cache key); manifest/icons → `public, max-age=86400`. The **shell** (`index.html` root route) → `Cache-Control: no-cache, must-revalidate`, else a cached shell still points at the old entry module and the hashing buys nothing.
- **Don't diverge.** Reference snippet: `docs/app-onboarding.md` §4. Service workers / offline caching are deliberately **not** used in the fleet. (`project-scaffolding#78`.)

## Windows event-loop pinning (uvicorn)
*Apply only if this project serves a FastAPI + static PWA web app; Streamlit POC spikes exempt.*

- Every uvicorn spawn point (tray subprocess spawn via `manager.py`, a programmatic `uvicorn.run()`, `.bat` launcher scripts, e2e autoboot spawns) must pass a pinned selector-loop factory (`--loop`/`loop=`) — asyncio's default Windows proactor loop wedges the listening socket on any aborted client connection (`app-launcher#388`). Shim: `docs/app-onboarding.md` §1; reference: `app-launcher`'s `app/webapp/event_loop.py` (`selector_loop_factory`).

## Windows console-subprocess suppression (`CREATE_NO_WINDOW`)
*Apply only if this project runs a long-lived Windows process (tray, daemon, GUI) without its own console — e.g. launched via `pythonw` — that shells out to a console-based CLI tool (`docker`, `nvidia-smi`, `git`, `taskkill`, …).*

- Every console-tool subprocess call (`subprocess.run`/`subprocess.Popen`, `asyncio.create_subprocess_exec`) must pass `creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0` — a console-less parent makes Windows allocate a fresh console per child, flashing a window; on a poll loop that reads as malware or a stuck app (`project-scaffolding#13`).
- Centralize behind one small helper (e.g. `_no_window_flag()`) imported everywhere rather than re-inlining the literal per call site — `asyncio.create_subprocess_exec` takes the same flag and is easy to miss vs the sync API.
- A detached long-running child additionally wants `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP` as appropriate.
- Related trap: a `pythonw` child launched without a redirected `stdout`/`stderr` crashes on its first log write — always give it a real target (pipe or file).
- Worked helper: `docs/app-onboarding.md` §1.

## FastAPI + SQLite connection lifecycle (one `get_db` `Depends` dependency)
*Apply only if this project is a FastAPI app backed by SQLite.*

- **One dependency owns the connection.** One `get_db()` connects, sets `row_factory = sqlite3.Row` + `PRAGMA journal_mode=WAL`, then `try: yield / finally: conn.close()`. Handlers take `db: sqlite3.Connection = Depends(get_db)` instead of opening their own — setup (pragmas, row factory, timeout) can't drift between handlers, and the connection closes even when a handler raises. **Acceptance: zero per-handler `sqlite3.connect(...)` calls in the routers.**
- **SQLite + stdlib `sqlite3` stays the fleet default.** This is only about the *lifecycle dependency* — no ORM, no async driver, no connection pooling. (Apps that legitimately need a long-lived single connection — none currently identified — are the documented exception.)
- **Don't diverge.** Canonical `get_db` + `Depends` snippet: `docs/app-onboarding.md` §4. (`project-scaffolding#96`; source instance `whatsapp-radar#100`.)

## GitHub Actions CI conventions
*Apply whenever this project adds a `.github/workflows/` file.*

- **Pin a dated Windows runner:** `runs-on: windows-2025`, never `windows-latest` (GitHub is redirecting it to `windows-2025`, deadline June 2026) — a silently-changing OS image turns a green gate red with no code change.
- **Use Node-24 action majors:** `actions/checkout@v6`, `actions/setup-python@v6`, `actions/upload-artifact@v7` — not `actions/checkout@v4`, `actions/setup-python@v5`, `actions/upload-artifact@v4`, which run on deprecated Node 20 (forced Node 24 from June 16 2026; Node 20 removed September 16 2026). Inputs unchanged, so the bump is drop-in.
- **Trigger once per commit: `push:[main]` + `pull_request:[main]`.** Do **not** trigger `push` on feature branches (`push:` with no `branches:` filter, or `push: branches-ignore: [main]`): while a PR is open, every branch push fires *both* events, running the same gate **twice on the same commit**. `branches-ignore: [main]` also silently *omits* the post-merge `main` gate, so the merge commit is never CI-gated. `concurrency` cannot fix this — `github.ref` differs between the events (`refs/heads/<branch>` vs `refs/pull/<N>/merge`), so they land in separate groups and both survive. The only thing given up (CI on a branch pushed but never PR'd) is a non-loss: `/issue-finish` always pushes and immediately opens the PR.
- Run counts, wrong shape vs this convention: feature-branch push with an open PR **2 → 1** run (`pull_request` `synchronize`); feature-branch push with no PR 1 → 0; merge commit on `main` **0 → 1** (post-merge gate).
- **Sister-repo tracking:** a fleet repo still on the old runner/actions (`#25`) or the duplicate `push`-on-branches trigger (`#38`) carries a pointer issue back to the canonical decision record in `ferraroroberto/project-scaffolding`. Fix before the deprecation deadline, not after.

Canonical pattern:

```yaml
on:
  push:
    branches: [main]          # post-merge integration gate on main only
  pull_request:
    branches: [main]          # validates every feature branch via the PR event

jobs:
  <job>:
    runs-on: windows-2025          # not windows-latest — pin the OS image
    steps:
      - uses: actions/checkout@v6        # Node 24 (not @v4 / Node 20)
      - uses: actions/setup-python@v6    # Node 24 (not @v5 / Node 20)
        with:
          python-version: '3.12'
      # ...
      - uses: actions/upload-artifact@v7 # Node 24 (not @v4 / Node 20)
        with:
          name: <name>
          path: <path>
```

## CI is advisory — `## CI expectations` block + e2e-surface skip rule
*Apply whenever this project has a `.github/workflows/` file **and** a local verification gate.*

**CI is advisory, not a required gate** — fleet e2e workflows run on repos with **no branch protection**, so their checks are not required to merge. The **local gate** (`scripts/verify-before-ship.ps1`, or `pytest + ruff + mypy`) is the contract, and the agent must not treat `gh pr checks --watch` as a mandatory blocking wall.

**CI's only signal beyond the local gate is the e2e suite** — the local gate runs `pytest + ruff + mypy` but skips the Playwright leg (needs browsers + a live webapp), which is also the known-flaky part (browser/PTY input wedging on the slower hosted Windows runner). So a diff touching **none** of the project's e2e surface gains nothing from waiting on CI, while a wedged WebKit browser can block the merge to the `timeout-minutes` cap.

**Each project declares a `## CI expectations` block in its own `CLAUDE.md`** (the per-project *instance* — durations, flaky leg, e2e-surface paths). `/issue-finish` reads it; don't inline these values into the skill. Template (fill the bracketed values):

```markdown
## CI expectations
- Workflow `[.github/workflows/e2e.yml]`, job `[verify-before-ship]`, on every PR. **Advisory, not required** (no branch protection) — the local gate is the contract.
- Typical green: **~[N] min**. Investigate at **>[2N] min**; treat as wedged at **>[~4N] min**.
- Flaky leg: `[the Playwright WebKit/iPhone projection / PTY-input tests]` can wedge on the hosted runner. `timeout-minutes: [30]` caps a wedge. A wedge is a flake, not the diff.
- CI's only signal beyond the local gate is the **e2e suite** (skipped locally). Its e2e surface = `[app/webapp/, app/tray/, tests/e2e/, static assets, …]`. A diff touching **none** of these gains nothing from CI.
```

**What `/issue-finish` does with it:**
- **Skip-the-wait keyed on the e2e surface, not "docs vs code."** Diff touches none of the declared e2e surface + local gate green → merge on local-green and **state it** in the finish summary (e.g. `CI not awaited — store-only diff, no e2e surface touched`).
- **Proactive flake handling.** Read the expected duration from the block; the moment elapsed crosses the *investigate* threshold, stop waiting passively — inspect the run (`gh run view --job`), classify flake vs real failure, and for the *documented* flaky leg cancel + rerun **once** automatically, saying so. A second flake → stop and surface it. **Never** rerun a real (non-flake) failure.
- **Guardrails:** always **state** the CI decision (skip vs wait, plus any rerun) in the finish summary; auto-rerun capped at **once** and only for the documented flaky leg; nothing force-merges (CI being advisory, no `--admin` override is ever needed). **If a repo later adds the `e2e` check as a *required* status check, the skip rule must fall back to watching** — a required check cannot be skipped without `--admin`, and force-merging is out of scope.

Skill mechanism: `fleet-config` `skills/issue-finish/SKILL.md` step 5; sister-repo pointer issues (`whatsapp-radar`, `app-launcher`) track adoption. Making the e2e leg actually stop flaking is a separate per-project fix — this convention makes a flake *cheap*, it does not cure it.

## End-to-end UI testing
*Apply only if this project serves a browser UI (Streamlit, FastAPI, Flask, etc.).*

Two loops, kept deliberately separate. Full reasoning, setup, and bootstrap recipe: the scaffold's `docs/playwright-ui-testing.md`.

### Iterative verification (headed, agent-driven)
Used during active development so the user can watch the agent verify a change.

- Drive the running app via the **Playwright MCP server in `--headed` mode** (Claude Code, Codex CLI). Without MCP support, fall back to a small `playwright` Python script run via Bash with `headless=False`.
- Boot the app **once** on a fixed port (Streamlit default: 8501) and leave it running. Do NOT restart between iterations unless `set_page_config` or top-level imports changed.
- Prefer the a11y `snapshot` tool over `screenshot` — DOM is far cheaper than pixels in tokens. Screenshot only on failure or as final visual confirmation.
- Cap actions per cycle in the prompt (≤ 5 actions, then report). Stop and ask if the page state is unexpected; do not loop blindly.
- Target widgets via their stable `key=` using `page.get_by_role(..., name=...)` or `page.get_by_test_id(...)`.
- Do NOT create files under `tests/e2e/` for verification — it's throwaway, lives in the conversation only. Promotion to a permanent test is a separate, deliberate decision.

### Regression suite (headless, pytest-playwright)
Optional. Lives at `tests/e2e/`. **Don't create the folder until the first regression test is actually justified.**

- Add a test only when all three hold: (1) silent breakage would hurt, (2) it can't be caught by a unit test under `tests/`, (3) the behavior has stabilized.
- Runs via `& .\.venv\Scripts\python.exe -m pytest tests/e2e/` (Windows) / `./.venv/bin/python -m pytest tests/e2e/` (POSIX). No LLM in the loop, zero per-run cost.
- **One shared session fixture boots the app — and any service dependencies** (a separate API process, a worker, a PTY host, …) — once per pytest run. Boot on a fixed or free port; **adopt** an instance already listening rather than spawning a second. Engine-agnostic: `streamlit run`, `uvicorn`, `flask run` are all just the launch command.
- **Isolate anything stateful — never adopt-and-mutate a host that holds the user's live work.** The adopt rule is safe only for a stateless, cheap-to-restart webapp. A host that owns user state or child processes (a session-host, a worker with in-flight jobs, a PTY host) must get the harness's own disposable instance on a **free** port, injected into the dependent process via an env override — never the live fixed port. Litmus test: *is the thing I'm adopting holding work the user would be upset to lose?* If yes, isolate. Same bar, a **destructive test scopes to what it created**: snapshot pre-existing ids before acting, kill only the delta, never `.first` / "whatever's in the list". (app-launcher#260.)
- **Boot failure is a hard failure — never `pytest.skip`.** A suite that skips when the app isn't up reports green on a build it never tested. Skip is fine for the *ad-hoc* "use whatever tray I have running" path; the *pre-ship* path must fail loud.
- Keep the suite small — target < 15 tests total. Tempted to add #20? Delete two first.
- No Page Object Model. Too much ceremony for this size.
- Don't gate commits on e2e. Run on push or in CI, not in pre-commit.
- When you remove a feature, remove its e2e test in the same commit.

### Mobile / phone-first UI testing
*Apply only if the app's primary surface is a phone.*

- Project the regression suite onto **WebKit** with a device-emulation descriptor (Playwright's iPhone / Android descriptors — viewport, user-agent, touch, scale factor). WebKit shares the iOS Safari rendering + JS engine, so it reproduces most "Safari is unhappy" bugs on a Windows/Linux box.
- Make the projection **always-on** — a parametrised `browser_name` / device fixture so every test runs the mobile projection too. An opt-in projection gets forgotten.
- WebKit-on-Windows is *not* real iOS: no iOS shell, no real WKWebView memory limits, no Apple keyboard, no Add-to-Home-Screen container. For residual shell-only bugs, attach PC DevTools to a real phone via `ios-webkit-debug-proxy`. Playwright cannot drive real iOS Safari — only its bundled WebKit and the iOS Simulator on macOS.

## Verification (before declaring a task done)
Examples — adapt to the project's actual tooling.

Windows / PowerShell:
- Syntax: `& .\.venv\Scripts\python.exe -m py_compile <file>`
- Lint (if configured): `ruff check .`
- Tests (if any exist): `& .\.venv\Scripts\python.exe -m pytest`
- Streamlit boot check (UI changes): `& .\.venv\Scripts\python.exe -m streamlit run app/app.py --server.headless true`

POSIX:
- Syntax: `./.venv/bin/python -m py_compile <file>`
- Tests: `./.venv/bin/python -m pytest`

**Pre-ship gate (projects with an e2e suite).** Wire a single project-specific command — e.g. `scripts/verify-before-ship.ps1` — that runs the whole pipeline as one pass/fail: byte-compile → unit `pytest` → e2e suite (auto-booting the app per the harness rule above). Mandatory before any UI-touching change is declared done. One command, can't half-skip. Do **not** substitute a bare `pytest` run that silently skips e2e when no server is up — that is how a regression ships looking green.

## Restart and verify before hand-off
*Apply only if this project runs a long-lived process (dev server, webapp, daemon, tray) without hot-reload.*

- **Restart, then confirm.** After verification — unless the user said otherwise — restart the process so the change is actually live, and check a version/build endpoint or equivalent signal that the running process reflects the new code. A health check is not enough: a stale process passes it. Report the build identifier; never hand off "done" with a stale process serving.
- **Restart safely.** Kill only the specific process for *this* app (identified precisely — listening port / PID / window title), never a blanket process-name kill (`pythonw`, `node`, `python`) that would take down sibling apps or shared services.
- **A 'start' script is usually not a 'restart' script.** Re-running `launch_app.bat` / `tray.bat` / `npm start` while an instance is up typically spawns a duplicate (or silently no-ops if the port is bound). The pattern is **kill-then-start**. Document the project-specific recipe in this repo's own `CLAUDE.md` under `## This repository` — *which* process to kill (port / PID lookup), *which* command relaunches it, *what* signal confirms the new build (e.g. `GET /api/version` returning the current `git_sha`).

**Tray lifecycle** — four gotchas. Canonical `tray.bat` shape + full reasoning: the scaffold's `docs/windows-tray.md`; a copy-to-adapt `tray.bat.template` ships at the scaffold root (replace four `__PLACEHOLDER__` tokens — app name, tray-launch args, tray-match regex, owned ports).

- **#29 — reclaim service ports by PID (orphan-proof), not just `taskkill /T` on the tray subtree.** A tray's service children (webapp, session-host, tunnel) can orphan: they leave the tray's process subtree but keep holding the service port, so the fresh tray can't bind, silently fails, and the orphan serves stale code while the restart *reports success*. `--restart` must, for each fixed loopback port the app **definitively owns**, find the current listener and kill its owning PID, **then** start. Scope the sweep to **this app's `.venv`**, and scope it by the holder's **CommandLine**, *not* its process image path — on Python 3.14 Windows venvs a venv-launched `pythonw.exe` re-execs the base interpreter, so the image path reports the *shared base* interpreter while only the CommandLine carries the `.venv` path; an image-path guard never matches and the reclaim silently no-ops. **Exclude any port mutex-shared with another app** (reclaiming it would kill the sibling's live process). Alongside **#12** (single-instance via a named mutex, not a bound TCP port) and **#13** (`CREATE_NO_WINDOW` when shelling out to console tools); no conflict with #12 — #12 is how you *detect* a running instance, this is how a *restart cleans up* the previous one.
- **The full detect → kill → reclaim → start → verify lifecycle lives in one committed helper, shelled to with `-File` once — never in cmd `for /f` output capture or inline `powershell -Command "…"`** (`project-scaffolding#54`). Both cmd-side forms failed when `tray.bat` is launched **non-interactively** (Git Bash → `cmd /c "tray.bat --restart"`, or a finisher skill's Bash tool), returning empty detection/reclaim data so nothing is killed and `--restart` silently degrades to a plain start — and a plain start *adopts* whatever already serves the port (`WebappManager.start()` → `OWNERSHIP_EXTERNAL`) and reports healthy. Only `--restart`'s reclaim forces new code to load. **Verify by served `git_sha` vs repo `HEAD`, never a `healthz` 200; a mismatch must exit non-zero.**
- **`tray_lifecycle.ps1` is no longer vendored per-app** (`project-scaffolding#153`): every `tray.bat` calls the ONE shared, machine-local copy owned by `fleet-config` at `%USERPROFILE%/.claude/tray/tray_lifecycle.ps1` (exposed by fleet-config's `install.ps1` junction). `tray.bat` still **hard-errors — never no-ops** — if that shared path is missing, naming fleet-config's `install.ps1` as the fix. A tray app still vendors one scaffold file byte-for-byte: `app/tray/single_instance.py`, which ships *with* the app rather than being shelled to.
- **The canonical restart invocation is `tray.bat --restart` — call it, don't hand-roll the kill.** It does the orphan-proof subtree-kill + per-`.venv` port reclaim + start atomically. Automated finishers (`/issue-finish`, `/issue-yolo`) and any agent restart must run it rather than re-deriving a `Get-NetTCPConnection`/`taskkill` sequence — a hand-rolled kill only catches the one listener it happens to find and misses the orphan. The manual port-PID kill is a *fallback* for the rare app with no `--restart`, never the default. Each tray app's own `CLAUDE.md` `## This repository` section names `tray.bat --restart` as its restart command plus the signal confirming the new build is live.
- **#4 — the single-instance guard must hold *in the tray process* (a named mutex), and adopt-or-spawn must be *race-safe*.** The launcher `.bat`'s pre-launch CIM detection is necessary but not sufficient: two near-simultaneous `tray.bat` runs both read the process table before either tray is visible, pass the check, and both survive. Acquire the mutex at the top of `run_tray()`; if already held, exit. Independently, a `WebappManager.start()` that does `status()`-then-`Popen` is check-then-act — two trays that both see "port free" both spawn a duplicate uvicorn (TOCTOU). Serialize the check-then-spawn with a named mutex keyed on the owned port so the loser **adopts** the now-listening service. Both are solved by one byte-identical primitive — `app/tray/single_instance.py` (`SingleInstance` + `cross_process_lock`) — shipped in the scaffold and **vendored verbatim** (only the mutex *names* differ per app). Proven on `whatsapp-radar`.
- **The agent restarts a tray by invoking `tray.bat --restart` fire-and-forget (background/detached), then verifying with a *bounded* poll — never a foreground launch or an unbounded wait.** A tray launcher holds the console it starts in, so a foreground tool call never returns and burns the 10-minute timeout. Poll `GET /api/version` with a **hard timeout and attempt cap** (e.g. ≤30 s) and **fail loud** on a slow/failed boot — assert `git_sha == HEAD` and report the build line. The app's `--restart` owns the what-to-kill/reclaim intelligence (ports, children), so the agent delegates rather than re-derives. A correct restart is **adopt / reclaim / spawn**, classifying children as **owned-and-cycled** (webapp/worker/cloudflared: live *inside* the tray subtree, die + respawn with new code, port in the reclaim list) vs **linked-but-independent** (a session-host + its PTY shells / launched apps: must **survive**). "Must survive" is enforced structurally: linked children are **spawned re-parented out of the tray subtree** via `cmd /c start` — `taskkill /T` walks the parent-child PID tree, so `DETACHED_PROCESS`/`CREATE_NEW_PROCESS_GROUP` do **not** escape it, only re-parenting does (verified empirically) — and the fresh tray **re-adopts** them on start by port/identity. **Safety caveat:** until a tray with linked children is detach-compliant, `--restart` still kills those children — that tray's `CLAUDE.md` flags this and the agent confirms first. Mirrored in `/issue-finish` and the global restart skill (`project-scaffolding#35`).

**Propagation freeze.** A vendored-component fix does **not** fan out until the scaffold's own gate is green — for the tray helper that includes the behavioral e2e harness `tests/e2e/test_tray_lifecycle_behavior.py`, which drives the real detect → kill → reclaim → start → verify lifecycle end to end against the canonical file (resolved via `resolve_tray_lifecycle_path()`), not just structural/grep asserts. If a **second** bug surfaces in the same vendored component **within the same day**, propagation freezes entirely — harden and soak at source (no partial re-vendor), then ship one cumulative wave once stable. (Motivating cascade: `project-scaffolding` #144 → #145/#146 → #147/#148 → #149/#150.) Vendored channels are the web-app UI components (`app/webapp/static/_vendored/`) and, for tray apps, `app/tray/single_instance.py`; channel rule ("does it ship with the app?") in `app/webapp/static/_vendored/README.md`, ownership story in `docs/windows-tray.md`. UI-component propagation is never a hand-filed per-repo issue — the trigger criteria for the batched `/propagate-vendored` run live in that README's "Rules".

---

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
- **No CI, deliberately.** CI is advisory in this fleet and its only documented signal beyond the local gate is an e2e suite — which this repo cannot have (the credential / `server_id_conflict` wall above). It would duplicate the gate and add nothing. If it is ever added, follow the pinned shape in "GitHub Actions CI conventions" above, with `actions/setup-node@v6`, and write a `## CI expectations` block at that point — not before.
- **No packet-serialization round-trip tests.** The repo's own evidence says false confidence: the `category: 'message_only'` bug round-tripped through the protocol definition *perfectly* and still made the server drop the connection ~16 s later. The real failure modes here are server-side semantics only a live connection reveals.

### Restart recipe: a foreground CLI, **not** a tray

`npm run spike` is long-lived (it supervises and reconnects, #7) but is still a **foreground process with no service port, no tray, and no `/api/version` endpoint**. The scaffold's tray lifecycle — `tray.bat --restart`, orphan-proof port reclaim by PID, the named-mutex guard — does **not** apply and must not be hand-rolled here. There is no port to reclaim.

To restart: stop it with **Ctrl-C** (or `kill <pid>`, where the PID is in `.secrets/bot.lock`) and start it again. Never a blanket `node`/`taskkill` sweep — that would take down unrelated Node processes on the machine.

The single-instance lock makes this safe: a second start refuses immediately and names the holder rather than fighting it for the one available Xbox session, and a stale lock from a hard kill is reclaimed automatically. **Wait ~30s between stopping and restarting** — the server holds the old session, and a faster restart gets `server_id_conflict` (the supervisor handles this correctly, it just costs a backoff cycle).
