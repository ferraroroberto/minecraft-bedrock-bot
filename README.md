# minecraft-bedrock-bot

AI-controllable bot client for Roberto's Minecraft **Bedrock Edition** Realm.

**Current scope — Layer 1 only.** This repo currently proves one thing: an external Node.js process can authenticate as a second Microsoft/Xbox account, join the Realm as an invited member, exchange chat, and read its own position. There is **no LLM wiring, no pathfinding, and no world model yet** — those are tracked as separate future issues once this foundation is proven out.

## Blocking prerequisite

Before running anything here, the bot's Microsoft account must be **invited as a member of the Realm** (Minecraft/Xbox app → Realm → Settings → Invite). This is a manual step outside this repo — nothing here can do it for you.

## Development vs. deployment

Active development and testing happen on Roberto's Windows box (`E:\automation\minecraft-bedrock-bot`), where this repo shows up alongside the rest of the fleet's projects. A second clone lives on the Mac Mini (`roberto@192.168.0.14`, always-on) as the intended **production** host once this is stable — code isn't actively edited there; it's updated with a `git pull` once a change is verified from the dev machine.

## Setup

Requires Node.js (present on both the Windows dev machine and the Mac Mini, which has Node 26.5.0 via Homebrew).

```bash
npm install
cp .env.example .env
# edit .env — leave REALM_ID blank on the very first run
```

## Running the connect spike

```bash
npm run spike
```

On first run, `bedrock-protocol` prints a Microsoft device-code sign-in URL + one-time code — complete that sign-in in **any** browser (not necessarily on the machine running the bot). The resulting Xbox Live token is cached locally under `.secrets/xbox-auth/` (gitignored — **never commit this directory**, it holds live, reusable tokens) so subsequent runs are non-interactive until the token eventually expires.

With `REALM_ID` left blank, the spike uses `pickRealm`, which lists the bot account's own joined/owned Realms — note the ID of the target Realm from that output and set `REALM_ID` in `.env` for a deterministic, non-interactive connect on future runs.

Console output walks through: Xbox Live session established → joined the Realm → spawned → a logged position (exact source logged as raw packets, since `bedrock-protocol` has no guaranteed convenience property for this — see the code comment in `scripts/connect-spike.js`).

## Running it on the Mac Mini (production, once verified)

```bash
ssh roberto@192.168.0.14
cd ~/minecraft-bedrock-bot
git pull
screen -S mcbot   # tmux isn't installed there; screen keeps the sign-in prompt alive across an SSH hiccup
npm run spike
# detach with Ctrl-A D; reattach later with: screen -r mcbot
```

## Known risk

Upstream `bedrock-protocol` issues [#473](https://github.com/PrismarineJS/bedrock-protocol/issues/473) and [#474](https://github.com/PrismarineJS/bedrock-protocol/issues/474) report friction specifically when a bot joins a Realm as an **invited member** rather than its owner (intermittent "Server sent broken packet" kicks). The connect spike exists to surface this early — see the tracking issue for the go/no-go outcome.
