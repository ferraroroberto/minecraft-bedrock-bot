# Connect spike, supervision and handshake breadcrumbs

What `npm run spike` does, how it survives failure unattended, and how to read its log. Entry point: `scripts/connect-spike.js`.

## Running the connect spike

```bash
npm run spike
```

On first run, a Microsoft device-code sign-in URL + one-time code is printed — complete that sign-in in **any** browser (not necessarily on the machine running the bot). The resulting Xbox Live token is cached locally under `.secrets/xbox-auth/` (gitignored — **never commit this directory**, it holds live, reusable tokens) so subsequent runs are non-interactive until the token expires.

With `REALM_ID` left blank, the spike lists the bot account's joined/owned Realms and picks the first — note the target Realm's ID from that output and set `REALM_ID` in `.env` for a deterministic connect on future runs.

A successful run's log looks like the "healthy connect" block under [Handshake breadcrumbs](#handshake-breadcrumbs); that block mirrors `src/log.js`'s real output format.

Stop it with Ctrl-C; it stays connected indefinitely otherwise, reconnecting on its own.

## Supervision

The bot runs a supervised loop that survives the failure modes unattended.

- **Reconnect backoff** is per-condition. `server_id_conflict` starts at **30s** (the measured session-release window) and escalates 30 → 60 → 120 → 240 → 300s; an ordinary disconnect uses a shorter 5 → 15 → 30 → 60 → 120s ladder; API failures use their own. Jitter is added **upward only** — 30s is an empirical *lower* bound, so jittering below it would reintroduce the kick.
- **The failure streak resets only after a connection has stayed up for 60s**, so a connection that establishes and immediately drops can never turn into a tight loop. After 10 consecutive failures without a stable connection it gives up and exits non-zero rather than looping silently.
- **A single-instance lock** at `.secrets/bot.lock` holds the running PID. A second start on the same machine exits immediately, names the holder, and never touches it. A stale lock left by a `kill -9` is reclaimed automatically. It **cannot** see the Minecraft client signed in as the bot account, or a bot on the *other* machine — `server_id_conflict` handling is the real backstop for those.
- **The client version is resolved from `minecraft-data`** rather than hardcoded, so it cannot announce a version the client can't actually speak. Override deliberately with `MC_VERSION` **and** `PROTOCOL_VERSION` together. This controls only what is *announced* — see the three version gates in [Gotchas](gotchas.md).

## Handshake breadcrumbs

Without instrumentation, a failed connect produces one line, `connect_timeout (no spawn within 60000ms)`, for six materially different failures. `src/probe.js` observes the NetherNet handshake and names the stage the connection actually reached, so an unattended failure is diagnosable from the log alone. It is always on — there is no flag to remember — and self-removes its per-packet listeners after the first packet, so a 450k-packet session pays nothing for it.

A healthy connect reads:

```
INFO  signalling.ready — signalling websocket open and TURN credentials received
INFO  rtc.offer_sent — WebRTC offer sent to the Realm host
INFO  rtc.candidate_out — first local ICE candidate gathered
INFO  rtc.answered — the Realm host answered our offer
INFO  rtc.ice — checking
INFO  rtc.ice — completed
INFO  rtc.connected — WebRTC transport connected — waiting for the server to speak first
INFO  packets.first — first inbound packet: network_settings
INFO  play_status — login_success
INFO  world.joined — position x=<x> y=<y> z=<z>
INFO  connected — spawned and initialized
```

Read it by **where it stops**. The stage ladder is `created → authenticated → signalling_ready → offer_sent → answered → transport_connected → receiving_packets`, and a timeout reports the furthest one reached plus what stopping there implies — for example *"reached `offer_sent` … our offer was sent and the Realm host never answered"*. Lines worth knowing by sight:

- **`rtc.connect_error`** — the host actively refused, with a decoded NetherNet error code (`37 (identity_verification_failed)`). An explicit refusal outranks the stage guess in the timeout summary. Minecraft documents none of these codes; the table in `src/probe.js` is transcribed from [`df-mc/go-nethernet`](https://github.com/df-mc/go-nethernet).
- **`packets.first`** — if this is `play_status` rather than `network_settings`, the server rejected the protocol version before replying; expect an `outdated_client` kick next.
- **`kicked`** — the disconnect reason named from the pinned protocol's `DisconnectFailReason` enum, with the raw code kept beside it (`host_disconnected (140)`); a code the pin does not know degrades to the bare number.
- **`realm.region_changed`** — the Realm resolved to a different region than the previous attempt (`NorthEurope → UAENorth`). An observation only: it does not steer retries. It exists because several consecutive ~60s failures into a flipped region otherwise go unremarked.

## Exit codes

So a `launchd`/`systemd` wrapper can tell "restart me" from "give up":

| Code | Meaning |
|---|---|
| `0` | clean shutdown (Ctrl-C / SIGTERM) |
| `1` | terminal failure — expired auth, rejected client version, not a Realm member. Retrying cannot fix it; the log says what to do |
| `2` | another instance holds the lock |
| `3` | gave up after 10 consecutive failures without a stable connection |

These codes reach the parent process for real: `1` and `2` are covered by an offline regression test that spawns the actual `node scripts/connect-spike.js` entry point and asserts on its real OS exit code (`test/process-exit.test.js`) — not just on `supervise()`'s in-process return value, which a hung process would still report correctly while never actually delivering it. `0` can only be verified by a live connect followed by a clean shutdown, since it is the path a live session's own async cleanup can stall — see the `Client.close()` gotcha in [Gotchas](gotchas.md).

Actual daemonization (a `launchd` plist, auto-start at boot, log rotation) is deliberately **not** included — the spike makes a foreground process survive its own failures and exit legibly, which is exactly the precondition such a wrapper needs.
