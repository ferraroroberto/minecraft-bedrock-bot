// Layer-1 go/no-go spike: authenticate as the bot's Microsoft account, join
// Roberto's Bedrock Realm, and prove chat + position are reachable. See
// README.md and issue #1 for full scope/verification steps.
import 'dotenv/config'
import bedrock from 'bedrock-protocol'
import path from 'node:path'

const client = bedrock.createClient({
  username: process.env.BOT_USERNAME || 'MinecraftBot',
  realms: process.env.REALM_ID ? { realmId: process.env.REALM_ID } : { pickRealm: (realms) => realms[0] },
  profilesFolder: path.join(process.cwd(), '.secrets', 'xbox-auth'),
  onMsaCode: (data) => {
    console.log('\n=== Sign in to authenticate the bot account ===')
    console.log(data.message)
    console.log('================================================\n')
  },
})

client.on('session', () => console.log('✅ Xbox Live session established'))
client.on('join', () => console.log('✅ Joined the Realm'))
client.on('spawn', () => {
  console.log('✅ Spawned — entity snapshot:', client.entity ?? '(none — check raw packets below)')
})

// Position source is unconfirmed — bedrock-protocol has no documented
// convenience property; log movement-related raw packets until it's clear
// which one carries it (see issue #1 constraints).
client.on('packet', ({ data, name }) => {
  if (/move|position|start_game/i.test(name)) {
    console.log('📦', name, JSON.stringify(data).slice(0, 300))
  }
})

client.on('kick', (reason) => console.error('❌ Kicked:', reason))
client.on('error', (err) => console.error('❌ Error:', err))
