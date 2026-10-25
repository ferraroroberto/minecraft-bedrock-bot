// The vendored ratchets `npm run verify` runs after the tests, in order. One
// list so the gate and test/gate-ratchets.test.js agree on which `.fleet.toml`
// `[<name>]` tables have a stage.
export const RATCHETS = [
  'structure_ratchet',
  'instruction_ratchet',
  'doc_refs_ratchet',
  'static_ratchet',
  'docs_ratchet',
  'comment_ratchet',
  'dead_code_ratchet',
  'conventions_ratchet',
]

/** A ratchet passes only on exit 0; exit 3 (NOT CONFIRMED) fails like exit 1. */
export function ratchetPassed(status) {
  return status === 0
}
