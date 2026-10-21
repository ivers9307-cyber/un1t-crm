// ORGCONTACTS.0 (spec §3.2) — the home studio is named for what it does.
import { describe, it, expect } from 'vitest'
import { FIELD_HELP } from './OrgWhatsAppNumbers.jsx'

describe('OrgWhatsAppNumbers copy', () => {
  it('the home studio field says what the home studio decides', () => {
    expect(FIELD_HELP.home_location_id).toBe('Unknown senders, Meta-made templates and chat-opener edits belong to this studio.')
  })
})
