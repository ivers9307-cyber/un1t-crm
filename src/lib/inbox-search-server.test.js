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
  INBOX_MESSAGE_SEARCH_MIN_LENGTH, INBOX_MESSAGE_SEARCH_CONVERSATION_CAP, INBOX_MESSAGE_SEARCH_ROW_CAP,
  messageSnippet, collapseMessageHits, searchWhatsAppMessageHits,
} from './inbox-search-server.js'
import { ilikeMatches } from './like-escape.test-helpers.js'

describe('INBOX_SEARCH_FIELDS', () => {
  it('covers the two conversation tables with their real denormalised columns', () => {
    expect(INBOX_SEARCH_FIELDS.whatsapp_conversations).toEqual(['wa_phone', 'wa_profile_name', 'last_message_preview'])
    expect(INBOX_SEARCH_FIELDS.instagram_conversations).toEqual(['ig_username', 'customer_name', 'last_message_preview'])
  })

  // INBOX-SPLIT.1 — the inbox is WhatsApp + Instagram only; email moved to
  // /communications/tickets, which searches email_tickets on its own path.
  it('no longer covers email_conversations', () => {
    expect(INBOX_SEARCH_FIELDS.email_conversations).toBeUndefined()
    expect(() => buildInboxSearchOr('email_conversations', 'x', [])).toThrow(/unknown/i)
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
    const s = buildInboxSearchOr('instagram_conversations', 'ankit', [])
    expect(s).toBe(
      'ig_username.ilike.%ankit%,customer_name.ilike.%ankit%,last_message_preview.ilike.%ankit%'
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

// ─── WAMSGSEARCH.1 — WhatsApp message text ──────────────────────────────────

// A PostgREST-shaped stand-in for the whatsapp_messages read: it records the
// calls and applies .in / .not / .ilike / .order / .limit to synthetic rows,
// with ilike as the real LIKE pattern match (ilikeMatches), not lower(a)===lower(b).
function messagesDb(rows, { error = null } = {}) {
  const calls = []
  const db = {
    from: (table) => {
      calls.push(['from', table])
      let out = rows.slice()
      let cap = Infinity
      const chain = {
        select: (cols) => { calls.push(['select', cols]); return chain },
        in: (col, vals) => { calls.push(['in', col, vals]); out = out.filter((r) => vals.includes(r[col])); return chain },
        not: (col, op, val) => { calls.push(['not', col, op, val]); out = out.filter((r) => r[col] != null); return chain },
        ilike: (col, pattern) => { calls.push(['ilike', col, pattern]); out = out.filter((r) => ilikeMatches(pattern, r[col] || '')); return chain },
        order: (col, { ascending }) => { calls.push(['order', col, ascending]); out.sort((a, b) => (a[col] < b[col] ? 1 : -1) * (ascending ? -1 : 1)); return chain },
        limit: (n) => { calls.push(['limit', n]); cap = n; return chain },
        then: (resolve, reject) => Promise.resolve(error ? { data: null, error } : { data: out.slice(0, cap), error: null }).then(resolve, reject),
      }
      return chain
    },
  }
  return { db, calls }
}

const S1 = 'studio-1'
const S2 = 'studio-2'
const msg = (conversation_id, location_id, body, created_at) => ({ conversation_id, location_id, body, created_at })

describe('messageSnippet', () => {
  it('cuts around the first match, case-insensitively, with ellipses', () => {
    const body = `${'a'.repeat(60)} Can I freeze my membership in December? ${'b'.repeat(60)}`
    const snip = messageSnippet(body, 'FREEZE')
    expect(snip.startsWith('…')).toBe(true)
    expect(snip.endsWith('…')).toBe(true)
    expect(snip).toContain('freeze my membership')
    expect(snip.length).toBeLessThan(100)
  })

  it('returns a short body whole and collapses whitespace', () => {
    expect(messageSnippet('Is the\n\nsauna open?', 'sauna')).toBe('Is the sauna open?')
  })
})

describe('collapseMessageHits', () => {
  it('keeps the newest match per conversation, in order, up to the cap', () => {
    const rows = [
      msg('c1', S1, 'newest about towels', '2026-11-03'),
      msg('c2', S1, 'towels please', '2026-11-02'),
      msg('c1', S1, 'older about towels', '2026-11-01'),
    ]
    expect(collapseMessageHits(rows, 'towels')).toEqual([
      { conversation_id: 'c1', snippet: 'newest about towels', matched_at: '2026-11-03' },
      { conversation_id: 'c2', snippet: 'towels please', matched_at: '2026-11-02' },
    ])
    const many = Array.from({ length: 80 }, (_, i) => msg(`c${i}`, S1, 'towels', `2026-11-${String(80 - i).padStart(2, '0')}`))
    expect(collapseMessageHits(many, 'towels')).toHaveLength(INBOX_MESSAGE_SEARCH_CONVERSATION_CAP)
  })
})

describe('searchWhatsAppMessageHits', () => {
  const rows = [
    msg('c1', S1, 'Is 100% of the fee refundable?', '2026-11-05T10:00:00Z'),
    msg('c2', S1, 'I paid 1000 euro', '2026-11-04T10:00:00Z'),
    msg('c3', S2, 'Is 100% of the fee refundable?', '2026-11-06T10:00:00Z'),
    msg('c4', S1, 'my email is a_b@example.test', '2026-11-03T10:00:00Z'),
    msg('c5', S1, 'my email is axb@example.test', '2026-11-02T10:00:00Z'),
    msg(null, S1, 'Is 100% of the fee refundable?', '2026-11-07T10:00:00Z'),
  ]

  it('reads only the given studios, newest first, capped under the 1,000-row ceiling', async () => {
    const { db, calls } = messagesDb(rows)
    const { hits, failed } = await searchWhatsAppMessageHits(db, { q: 'refundable', locationIds: [S1] })
    expect(failed).toBe(false)
    expect(hits.map((h) => h.conversation_id)).toEqual(['c1'])
    expect(calls).toContainEqual(['from', 'whatsapp_messages'])
    expect(calls).toContainEqual(['select', 'conversation_id, body, created_at'])
    expect(calls).toContainEqual(['in', 'location_id', [S1]])
    expect(calls).toContainEqual(['order', 'created_at', false])
    expect(calls).toContainEqual(['limit', INBOX_MESSAGE_SEARCH_ROW_CAP])
    expect(INBOX_MESSAGE_SEARCH_ROW_CAP).toBeLessThan(1000)
  })

  it('treats % and _ in the query literally', async () => {
    const pct = messagesDb(rows)
    const a = await searchWhatsAppMessageHits(pct.db, { q: '100%', locationIds: [S1] })
    expect(a.hits.map((h) => h.conversation_id)).toEqual(['c1'])
    expect(pct.calls).toContainEqual(['ilike', 'body', '%100\\%%'])

    const und = messagesDb(rows)
    const b = await searchWhatsAppMessageHits(und.db, { q: 'a_b@', locationIds: [S1] })
    expect(b.hits.map((h) => h.conversation_id)).toEqual(['c4'])
  })

  it(`searches nothing below ${INBOX_MESSAGE_SEARCH_MIN_LENGTH} characters or with no studio`, async () => {
    const short = messagesDb(rows)
    expect(await searchWhatsAppMessageHits(short.db, { q: ' 10 ', locationIds: [S1] })).toEqual({ hits: [], failed: false })
    expect(short.calls).toEqual([])
    const none = messagesDb(rows)
    expect(await searchWhatsAppMessageHits(none.db, { q: 'refundable', locationIds: [] })).toEqual({ hits: [], failed: false })
    expect(none.calls).toEqual([])
  })

  it('degrades to no hits when the read fails', async () => {
    const { db } = messagesDb(rows, { error: { message: 'timeout' } })
    expect(await searchWhatsAppMessageHits(db, { q: 'refundable', locationIds: [S1] })).toEqual({ hits: [], failed: true })
  })
})

describe('buildInboxSearchOr with message hits', () => {
  it('adds an id.in clause for conversations found by their message text', () => {
    expect(buildInboxSearchOr('whatsapp_conversations', 'towels', [], ['c1', 'c2']))
      .toBe('id.in.(c1,c2),wa_phone.ilike.%towels%,wa_profile_name.ilike.%towels%,last_message_preview.ilike.%towels%')
  })
})
