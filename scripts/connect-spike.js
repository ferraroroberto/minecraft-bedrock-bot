// Entry point for `npm run spike`.
//
// Kept at this path so issue #1's acceptance chain stays runnable by the same
// command. What changed in #7: this is no longer a straight-line script that
// dies on the first hiccup — it now runs the supervised loop in src/, which
// reconnects with a backoff that respects the measured session-release window.
//
// Exits non-zero on a terminal, non-retryable failure so a process supervisor
// can tell "give up" from "restart me". See src/supervise.js EXIT.
import { main } from '../src/bot.js'

const code = await main()

// #11: by the time main() resolves, everything WE own is already torn down
// (session ended, lock released, recorder flushed) — main()'s own finally
// block guarantees it. What can still be outstanding afterward is
// third-party async cleanup we neither own nor can safely wait on:
// bedrockx's Client.close() fires its signalling socket's destroy() without
// awaiting it (node_modules/bedrockx/src/client.js:155), and @roamhq/wrtc's
// native WebRTC teardown runs asynchronously after that. Measured on this
// host: leaving those to finish on their own doesn't just hang the event
// loop (matching the macOS symptom in #11) — it can SEGFAULT ~15s later
// during the native cleanup (see README's BedrockX gotchas). Waiting for
// cleanup we can't control and can't safely await is worse than not
// waiting, so this exits immediately with the real code rather than risk
// the hang or the crash. `process.exit()` can in principle truncate
// not-yet-flushed stdout, but every log line above this point was already
// written and awaited across `main()`'s own async steps, so that risk is
// theoretical here, not the common case a bare `console.log` immediately
// before `process.exit()` would have.
process.exit(code)
