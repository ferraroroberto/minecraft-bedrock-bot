# Session-end state

Whether a Realm session ended because we were told to stop, because the server still holds our previous session, because a connected session dropped, or because it never connected is one fact. `src/session-end.js` declares it, and `classifySessionEnd(result, { stopRequested })` is the only code that derives it from what `runSession` resolved. `src/supervise.js` reads the answer and compares no `endedBy` or `reason` itself.

## Why it is declared

`runSession` resolves `{endedBy, reason, connected, uptimeMs}` and `reason` is free text whose meaning depends on `endedBy`. Before the state was declared, the supervisor re-derived the mode in three places: stop from two sources (the process signal and the session's own `shutdown` end), the retry ladder from a compare of the reason to the conflict name, and the streak reset from `connected`. That split missed the chat stop command once, and it sent a conflict kick spelled as the code `44` onto the 5 s disconnect ladder, where the server kicks it again.

## The states

| State | Meaning | Backoff ladder | May reset the streak |
|---|---|---|---|
| `stop_requested` | A process signal or the chat stop command ended the session. | none, the supervisor exits cleanly | no |
| `conflict` | The server still holds our previous session. The reason resolves to `server_id_conflict` as a name, as `44` or as `"44"`. | `server_id_conflict` (30 s and up) | when the session had connected |
| `dropped` | The session had connected, then ended for any other reason. | `disconnect` | yes |
| `connect_failed` | The session never spawned. | `disconnect` | no |
| `unknown` | The facts cannot tell a conflict from an ordinary drop: a kick with no reason or one the pinned enum does not know, or an `endedBy` this module has never heard of. The result carries a `why`. | `disconnect` | when the session had connected |

Name resolution reuses the pinned `DisconnectFailReason` table behind `describeDisconnectReason` in `src/disconnect-reasons.js`. A reason that is a name the table knows, a code it maps, or a numeric string of one all resolve the same way. `unknown`, which `src/connect.js` stores for a kick packet with no reason, counts as missing. `error`, `connect_timeout` and `signalling_fault` carry free text, so their reason is never read as a server reason.

The other half of the vocabulary is a failure before any client exists (the Realms API, auth, a rejected client version). There is no session result then, and `classifyRealmsError` in `src/errors.js` already classifies it into a `ClassifiedError.kind`.

## Who reads it

Only `src/supervise.js` today. A new reader of a session result calls `classifySessionEnd` and branches on `SESSION_END`; it does not compare `endedBy` or `reason`. `test/session-end.test.js` has one row per reachable result, including the impossible combinations, and checks that every declared state is produced.

## Declared in `.fleet.toml`

The machine is the `session-end` `[[state_machines]]` entry: module `src/session-end.js`, type `SESSION_END`, derive function `classifySessionEnd`. The conventions ratchet's state rules stop reporting that module and keep reporting any other module that re-spells the five states or writes their flag. The proof marker `state-machine-proof: session-end` sits on the closed-set test in `test/session-end.test.js`.

## Out of scope

`runSession` still resolves the untyped result. Producing a typed outcome inside it touches `src/connect.js` and needs its own live `npm run spike` against the Realm.
