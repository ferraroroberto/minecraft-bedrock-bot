// The full packet-name table the pinned BedrockX fork can decode, read
// straight off its own protocol.json rather than hardcoded.
//
// BedrockX has no generic `packet` event — every packet is emitted by its own
// raw name (`client.js:207`, `this.emit(des.data.name, des.data.params)`), so
// "record every inbound packet" (#13) means attaching one `client.on(name, …)`
// per name BedrockX can ever emit. This reads that name list from the same
// `mcpe_packet` id→name mapping the library's own (de)serializer compiles
// against, so a re-pin (README → "Why BedrockX") can never silently narrow
// the recorder's coverage without also changing what BedrockX itself speaks.
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/** @returns {string[]} every packet name the pinned protocol defines (244 as of the current pin). */
export function allPacketNames() {
  const protocol = require('bedrockx/src/protocol/protocol.json')
  const mappings = protocol?.types?.mcpe_packet?.[1]?.[0]?.type?.[1]?.mappings
  if (!mappings || typeof mappings !== 'object') {
    throw new Error(
      'could not read the packet name table off bedrockx/src/protocol/protocol.json — ' +
      'the mcpe_packet type shape changed; update allPacketNames() for the new pin'
    )
  }
  return [...new Set(Object.values(mappings))]
}
