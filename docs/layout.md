# Layout

The repo's shape is `node` (declared in `.fleet.toml`); the structure ratchet checks it on every `npm run verify`.

```
minecraft-bedrock-bot/
├── src/        # every runtime module: flat, one file per concern
├── test/       # node --test files, one <module>.test.js per src module, plus shared helpers
├── scripts/    # operator and gate entry points, run through npm scripts
├── patches/    # patch-package patches applied by npm's postinstall
├── docs/       # per-feature reference and protocol gotchas
├── package.json
└── .fleet.toml # shape, extra_roots, vendored components and the ratchet opt-in
```

## `src/`

A flat folder of ES modules with no subpackages. Each file starts with a header comment saying what it owns.

- **Entry and supervision** — `bot.js` wires the supervised bot together and runs it; `supervise.js` is the reconnect loop; `connect.js` is one connection attempt; `backoff.js`, `lock.js`, `faults.js`, `region.js`, `version.js`, `errors.js` and `disconnect-reasons.js` hold the pure pieces it depends on.
- **Connection diagnostics** — `probe.js` (handshake breadcrumbs), `log.js`, `protocol-packets.js`, `recorder.js` (opt-in packet trace).
- **World model** — `world.js` (packet-in, state-out reducer), `observation.js` (the bounded view the model sees), `blocks.js` (measured ids), `formatting.js`.
- **Actions** — `actions.js` (the fixed vocabulary), `safety.js` (the envelope applied below the model), `perform-action.js` (the single gate from named action to packet), `movement.js`.
- **Decision loop** — `decision-loop.js`, `goals.js`, `farm.js`, `prompt.js`, `model-reply.js`, `model-client.js` (the only module that knows the model is reached over HTTP), `fake-world.js` (the in-memory simulator the tests drive).

A new module goes in `src/` with a name that states what it does, and its test goes in `test/`.

## `test/`

`node --test` files named `<module>.test.js`, the Node convention the `node` shape accepts as is. `scripted-model.js` is a shared helper, not a test. The `comment-doc-refs`, `docs-no-pending-issue-refs`, `no-duplicated-ratchet-stage-breakdown`, `process-exit` and `static-stream-error-handling` files are structural checks over the repo itself.

## `scripts/`

`verify.js` is the gate (`npm run verify`); `gate-ratchets.js` holds the ordered list of ratchet stages it runs, the one place that order lives, so `test/gate-ratchets.test.js` can check each stage has an enabled `.fleet.toml` table. `connect-spike.js`, `llm-hub-check.js`, `trace-stats.js` and `mine-farm-ids.js` are operator tools behind the other npm scripts. Each `<name>_ratchet.py` is a vendored ratchet, copied byte-for-byte from project-scaffolding and recorded with its commit in `.fleet.toml` `[vendored]`; change it there, never here. What each one checks and which baseline file it reads is in `.fleet.toml`'s per-table comment, one per ratchet.

## `docs/`

One reference file per feature or protocol topic, indexed from the README.

## Declared exceptions

- **`patches/`** (`extra_roots`): holds `bedrockx+<version>.patch`, which patch-package applies to the pinned BedrockX dependency on `npm install`. The patch is required on macOS, so it ships in the repo; the `node` shape has no folder for patches.

## The ratchet baseline

`.structure-ratchet-baseline.json` is empty: no function is over 100 lines, no file is over 1,000 lines and no directory is past 40 modules, so any new breach fails the gate. Baselining one needs `--allow-additions`, which shows in review; split the function instead.
