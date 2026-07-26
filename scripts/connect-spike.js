// Entry point for `npm run spike` (and `npm start`).
//
// Kept at this path so issue #1's acceptance chain stays runnable by the same
// command. What changed in #7: this is no longer a straight-line script that
// dies on the first hiccup — it now runs the supervised loop in src/, which
// reconnects with a backoff that respects the measured session-release window.
//
// Exits non-zero on a terminal, non-retryable failure so a process supervisor
// can tell "give up" from "restart me". See src/supervise.js EXIT.
import { main } from '../src/bot.js'

process.exitCode = await main()
