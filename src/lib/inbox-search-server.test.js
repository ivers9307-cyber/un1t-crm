// INBOX-SEARCH.1 — server-side unified-inbox search (the pure parts).
//
// Each channel's list route caps at the latest 50 conversations and the
// UI's "Search people & messages" only filtered THOSE client-side, so
// ~96% of the ~1,178 prod WhatsApp threads were unsearchable (external
// review 2026-07-25, P1). The routes now accept ?q= and OR together
// (a) conversations whose own denormalised fields match and (b)
// conversations linked to contacts whose name/phone/email match.
// PostgREST can't reliably filter on embedded resources (CLAUDE.md
// invariant), hence the two-step contact-id lookup instead of a naive
// filter on the contacts embed.

import { describe, it, expect } from 'vitest'
import {
  INBOX_SEARCH_FIELDS,
  escapeIlikeTerm,
  buildInboxSearchOr,
} from './inbox-search-server.js'

describe('INBOX_SEARCH_FIELDS', () => {
  it('covers the three conversation tables with their real denormalised columns', () => {
    expect(INBOX_SEARCH_FIELDS.whatsapp_conversations).toEqual(['wa_phone', 'wa_profile_name', 'last_message_preview'])
    expect(INBOX_SEARCH_FIELDS.instagram_conversations).toEqual(['ig_username', 'customer_name', 'last_message_preview'])
    expect(INBOX_SEARCH_FIELDS.email_conversations).toEqual(['counterpart_email', 'counterpart_name', 'subject', 'last_message_preview'])
  })
})

describe('escapeIlikeTerm', () => {
  it('backslash-escapes ilike wildcards', () => {
    expect(escapeIlikeTerm('100%_off')).toBe('100\\%\\_off')
  })

  it('strips PostgREST or-syntax structural characters (commas, parens)', () => {
    expect(escapeIlikeTerm('smith, john (gym)')).toBe('smith john gym')
  })

  it('collapses the whitespace left behind by stripping', () => {
    expect(escapeIlikeTerm('a , b')).toBe('a b')
  })
})

describe('buildInboxSearchOr', () => {
  it('ORs contact_id.in with an ilike per channel field', () => {
    const s = buildInboxSearchOr('whatsapp_conversations', 'ankit', ['id-1', 'id-2'])
    expect(s).toBe(
      'contact_id.in.(id-1,id-2),wa_phone.ilike.%ankit%,wa_profile_name.ilike.%ankit%,last_message_preview.ilike.%ankit%'
    )
  })

  it('omits the contact_id clause when no contacts matched', () => {
    const s = buildInboxSearchOr('email_conversations', 'ankit', [])
    expect(s).toBe(
      'counterpart_email.ilike.%ankit%,counterpart_name.ilike.%ankit%,subject.ilike.%ankit%,last_message_preview.ilike.%ankit%'
    )
  })

  it('escapes the term inside the ilike patterns', () => {
    const s = buildInboxSearchOr('instagram_conversations', '50%', [])
    expect(s).toContain('ig_username.ilike.%50\\%%')
  })

  it('throws on an unknown table (fail loud at dev time, not silently unfiltered)', () => {
    expect(() => buildInboxSearchOr('contacts', 'x', [])).toThrow(/unknown/i)
  })
})
