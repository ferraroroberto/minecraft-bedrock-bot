# LLM decision loop

The bot can be given a goal in natural language — *"clear the block at 1,64,2"* — and work toward it: observe, decide, act through the safety-gated vocabulary, re-observe, repeat until the goal is satisfied, the step budget runs out, or it gives up (`src/decision-loop.js`).

**The point is not that an LLM can drive the bot. It is that we can tell, mechanically, whether it actually did the thing.** So:

- **Every goal must carry a programmatic success predicate** evaluated against world state (`src/goals.js`). `defineGoal` **throws** without one — it is impossible to start a run whose only evidence of success is the model saying so.
- **The loop's `ok` is the predicate, always.** It is never assigned from anything the model reported. Structurally: the function that builds the result takes a *reason*, never an outcome, so no code path can construct a successful run the predicate did not confirm.
- **`status: "done"` is a claim, not evidence.** If the model says done and the world disagrees, that is counted and logged as a false success claim; on the second one the run terminates as a **failure** naming exactly that. This is the single most important behaviour in this layer, and `test/decision-loop.test.js` asserts it first.
- **Model output is untrusted input** (`src/model-reply.js`) — the same posture as inbound chat. It is fence-stripped, parsed, schema-validated, and range-checked before it can become an action. Invented action names, nested args, and oversized strings are refused before reaching the gate.
- **The safety envelope stays the enforcement point.** Every action goes through `performAction` (see [Action vocabulary + safety envelope](actions-and-safety.md)) — dry-run by default, bounded region, break whitelist, rate limit, audit — so an LLM-chosen action is gated exactly like a hand-written one. A refused action is not a crash: it comes back as a failed step and is fed to the model as feedback, which it can then correct. Identity args (`runtimeEntityId`, `username`, `xuid`) are injected by the loop and **cannot be overridden by the model**, so it can never name a different entity.

The loop is not wired to a live session; it runs offline against the fake world below.

## Measured constraints on the hub

Two constraints shape the implementation, both probed against the hub before the loop was written:

- **Native tool-calling does not work** for `claude-*` through the hub — a `tools` array comes back HTTP 200, silently ignored, no `tool_use` block. So the contract is strict JSON-in-text.
- **An explicit `system` prompt is load-bearing.** Without one the reply comes back in Claude Code's own persona. With one it returns clean structured output — but wrapped in a ` ```json ` fence *despite being told not to*, so the parser strips fences defensively and a schema violation triggers a bounded retry-with-repair that feeds the validation error back.

## The fake world

`src/fake-world.js` is a deterministic in-memory world presenting the same `client.write(name, params)` surface the real client does. It interprets the outbound packets the vocabulary produces, mutates its own state, and **emits synthesized inbound packets through the real reducer** (`src/world.js`) — even the starting state is seeded that way. So the whole loop runs end to end with no Realm, no network and no account, and the world model is exercised for real rather than mocked away.

This is deliberately better than a live test, not a substitute for one: an autonomy test that can only be verified live cannot run deterministically, cannot run in the gate, and quietly stops being run. It also makes the cases that matter cheap to stage — an action that fails, a model that hallucinates a coordinate, a model that claims success having done nothing.

**What it cannot prove:** every rule in it is *our* assumption about server behaviour. It proves the loop is internally consistent, never that the real server agrees — the same "our encoder agrees with our decoder" trap that applies to the world model and the action vocabulary. One assumption is a genuinely open question rather than a simplification: **place**. Outcome verification watches the *clicked* coordinate, so the fake world sets the new block there; a real server may place it on the adjacent face instead. If it does, `perform-action.js` and `fake-world.js` are wrong *together* — exactly the failure a self-consistent simulator cannot catch.

## Checking the hub wiring

```bash
npm run hub-check            # one real call, asserting a schema-valid reply
npm run hub-check -- --goal  # that, plus a full goal driven by the real model
```

Deliberately **not** part of `npm run verify`, so the gate stays offline and hermetic — it must pass on a machine with no hub running. Configure with `LLM_BASE_URL` / `LLM_MODEL` in `.env` (defaults: `http://127.0.0.1:8000`, `claude-haiku-4-5` — the hub has a latest-only policy, so re-read its README before pinning a different id).

**A hub call is not a Realm connection.** It talks to loopback and to a fake world in memory; it never authenticates, never touches the Realms API, and never opens a session, so it does not interact with the standing no-live-Realm rule.
