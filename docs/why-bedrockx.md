# Why BedrockX and not `bedrock-protocol`

The obvious library for this is PrismarineJS's [`bedrock-protocol`](https://github.com/PrismarineJS/bedrock-protocol). **It cannot connect to this Realm.**

Realms have migrated to **NetherNet**, Microsoft's WebRTC-based transport. The Realms API returns:

```json
{ "networkProtocol": "NETHERNET_JSONRPC",
  "address": "<webrtc-network-id-guid>",
  "sessionRegionData": { "regionName": "<region>" } }
```

`address` is a WebRTC network ID, not the legacy `ip:port`. `bedrock-protocol` (3.57.0, the latest when this was written) assumes the old shape — `prismarine-realms`' `getRealmAddress()` does `address.split(':')`, producing a GUID host and a `NaN` port, then fails a RakNet UDP ping with `sendto failed`. It has no NetherNet support at all, and upstream work is unmerged and stalled ([#533](https://github.com/PrismarineJS/bedrock-protocol/pull/533) draft, [#735](https://github.com/PrismarineJS/bedrock-protocol/pull/735) conflicted, [#717](https://github.com/PrismarineJS/bedrock-protocol/issues/717) the matching issue).

[BedrockX](https://github.com/thejfkvis/BedrockX) is a fork that implements the NetherNet JSON-RPC signalling path. It is **pinned to a specific commit** in `package.json` — it is not published to npm, has a single maintainer and no test suite, so an unpinned floating reference would be a supply-chain risk. Re-pin deliberately, not casually. The fixes the pin needs are listed in [Setup and machines](setup-and-machines.md#what-patchesbedrockx134patch-contains).

`prismarine-auth` and `prismarine-realms` are still used directly, for the Microsoft auth flow and the Realms API respectively.
