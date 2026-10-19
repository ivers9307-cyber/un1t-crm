// WAPHONE.1 — POST /api/whatsapp/conversations/start keys the thread, and
// fills an empty contacts.wa_phone, with the contact's WhatsApp number in the
// stored form (E.164 digits, no '+'): the stored wa_phone, else the phone
// through waPhoneFromPhone (the rule the contacts trigger uses, mig 753). It
// used to store the raw phone minus a leading '+', so a national '087…', a
// landline or a bare foreign number became the contact's wa_phone.
// Fictional ids and numbers only: the repo is public.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(async () => ({ id: 'u1', role: 'manager', locations: [{ id: LOC_ID }] })),
  assertLocationAccess: () => null,
  requireWebWhatsAppInboxAnywhere: () => null,
  requireWebWhatsAppInboxAt: () => null,
}))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

import { POST } from './route.js'
import { createServerClient } from '@/lib/supabase'

const LOC_ID = 'd0000000-0000-4000-8000-000000000004'
const CONTACT_ID = 'b0000000-0000-4000-8000-000000000002'

function stubDb(contact) {
  const writes = []
  return {
    writes,
    from(table) {
      const state = { table, op: 'select', payload: null, filters: [] }
      const b = {
        select: () => b,
        eq: (c, v) => { state.filters.push(['eq', c, v]); return b },
        is: (c, v) => { state.filters.push(['is', c, v]); return b },
        limit: () => b,
        single: () => b,
        maybeSingle: () => b,
        insert: (row) => { state.op = 'insert'; state.payload = row; return b },
        update: (row) => { state.op = 'update'; state.payload = row; return b },
        then: (ok, bad) => {
          let res = { data: null, error: null }
          if (state.op === 'select' && table === 'contacts') res = { data: contact, error: null }
          if (state.op === 'insert' && table === 'whatsapp_conversations') res = { data: { id: 'conv-new' }, error: null }
          if (state.op !== 'select') writes.push({ ...state })
          return Promise.resolve(res).then(ok, bad)
        },
      }
      return b
    },
  }
}

const post = () => POST(new Request('http://x/api/whatsapp/conversations/start', {
  method: 'POST', body: JSON.stringify({ contact_id: CONTACT_ID }), headers: { 'content-type': 'application/json' },
}))

let db
function withContact(fields) {
  db = stubDb({ id: CONTACT_ID, location_id: LOC_ID, ...fields })
  createServerClient.mockReturnValue(db)
}
const convInsert = () => db.writes.find((w) => w.table === 'whatsapp_conversations' && w.op === 'insert')
const contactUpdate = () => db.writes.find((w) => w.table === 'contacts' && w.op === 'update')

beforeEach(() => vi.clearAllMocks())

describe('POST /api/whatsapp/conversations/start — the WhatsApp number', () => {
  it('a national Irish phone keys the thread and fills wa_phone as 353…', async () => {
    withContact({ phone: '087 123 4567', wa_phone: null })
    const res = await post()
    expect((await res.json()).conversation_id).toBe('conv-new')
    expect(convInsert().payload.wa_phone).toBe('353871234567')
    expect(contactUpdate().payload).toEqual({ wa_phone: '353871234567' })
    expect(contactUpdate().filters).toContainEqual(['is', 'wa_phone', null])
  })

  it('a stored wa_phone wins and is not rewritten', async () => {
    withContact({ phone: '087 123 4567', wa_phone: '447700900123' })
    await post()
    expect(convInsert().payload.wa_phone).toBe('447700900123')
    expect(contactUpdate()).toBeUndefined()
  })

  it('a landline or a bare foreign number is refused with a 400, and nothing is written', async () => {
    for (const phone of ['01 555 1234', '34612345678']) {
      withContact({ phone, wa_phone: null })
      const res = await post()
      expect(res.status).toBe(400)
      expect((await res.json()).error).toMatch(/country code/)
      expect(db.writes).toEqual([])
    }
  })

  it('no phone at all is still the old 400', async () => {
    withContact({ phone: null, wa_phone: null })
    const res = await post()
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Contact has no phone number')
  })
})
