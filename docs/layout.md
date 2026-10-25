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

`node --test` files named `<module>.test.js`, the Node convention the `node` shape accepts as is. `scripted-model.js` is a shared helper, not a test. The `comment-doc-refs`, `docs-no-pending-issue-refs`, `process-exit` and `static-stream-error-handling` files are structural checks over the repo itself.

## `scripts/`

`verify.js` is the gate (`npm run verify`). `connect-spike.js`, `llm-hub-check.js`, `trace-stats.js` and `mine-farm-ids.js` are operator tools behind the other npm scripts. `structure_ratchet.py` is the vendored structure ratchet, copied byte-for-byte from project-scaffolding and recorded with its commit in `.fleet.toml` `[vendored]`; change it there, never here. `instruction_ratchet.py` is vendored the same way; it lints `CLAUDE.md` and `AGENTS.md` against `.instruction-ratchet-baseline.json` as the gate's fourth stage. `doc_refs_ratchet.py` is the fifth: it checks the repo paths and relative links the docs name against `.doc-refs-ratchet-baseline.json`. `static_ratchet.py` is the sixth: it checks for duplicated code against `.static-ratchet-baseline.json`. `docs_ratchet.py` is the seventh: it holds `README.md` under its size cap and the docs free of issue-number and changelog markers against `.docs-ratchet-baseline.json`. `comment_ratchet.py` is the eighth: it keeps issue-number references out of code comments against `.comment-ratchet-baseline.json`. `dead_code_ratchet.py` is the ninth: it flags Python definitions that nothing references against `.dead-code-ratchet-baseline.json`. `conventions_ratchet.py` is the tenth: it holds tracked Python to the `no-window` and `no-drive-path` rules against `.conventions-ratchet-baseline.json`. `gate-ratchets.js` lists the ratchet stages `verify.js` runs, so `test/gate-ratchets.test.js` can check each has an enabled `.fleet.toml` table.

## `docs/`

One reference file per feature or protocol topic, indexed from the README.

## Declared exceptions

- **`patches/`** (`extra_roots`): holds `bedrockx+<version>.patch`, which patch-package applies to the pinned BedrockX dependency on `npm install`. The patch is required on macOS, so it ships in the repo; the `node` shape has no folder for patches.

## The ratchet baseline

`.structure-ratchet-baseline.json` records each function already over 100 lines at its current length; none of them may grow, and a new one fails the gate. No file is over 1,000 lines and no directory is past 40 modules. Shrinking a function means lowering its entry with `scripts/structure_ratchet.py --update-baseline`; raising one needs `--allow-additions`, which shows in review.
