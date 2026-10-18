// WAORGNUMBER.4 (R3) — a staff send files at the contact's home studio.
// Fictional ids only: the repo is public.
import { describe, it, expect, vi } from 'vitest'

vi.mock('./supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('./whatsapp-config', async (orig) => ({
  ...(await orig()),
  // The sending studio's number (for the stamp); not under test here.
  getLocationWhatsAppNumberConfig: vi.fn(async () => ({ id: 'num-1' })),
}))

import { contactWaPhone, loadSendConversation } from './whatsapp-conversations.js'
import { getOrCreateConversation } from './whatsapp.js'

describe('contactWaPhone', () => {
  it('prefers wa_phone, strips a leading +, null without a phone', () => {
    expect(contactWaPhone({ wa_phone: '353870000001', phone: '+353870000002' })).toBe('353870000001')
    expect(contactWaPhone({ phone: '+353870000002' })).toBe('353870000002')
    expect(contactWaPhone({})).toBeNull()
    expect(contactWaPhone(null)).toBeNull()
  })
})

describe('loadSendConversation', () => {
  const dbReturning = (out) => {
    const b = { select: () => b, eq: () => b, maybeSingle: async () => out }
    return { from: () => b }
  }
  it('returns the thread fields a send reads', async () => {
    const conv = { id: 'c1', window_expires_at: null, location_id: 'loc-home', agent_handed_off_at: null }
    expect(await loadSendConversation(dbReturning({ data: conv, error: null }), 'c1')).toEqual({ ok: true, conversation: conv })
  })
  it('a failed read, a missing row or no id is a 500', async () => {
    expect((await loadSendConversation(dbReturning({ data: null, error: { message: 'x' } }), 'c1')).status).toBe(500)
    expect((await loadSendConversation(dbReturning({ data: null, error: null }), 'c1')).status).toBe(500)
    expect((await loadSendConversation(dbReturning({ data: null, error: null }), null)).status).toBe(500)
  })
})

// The staff composer's filing rule, end to end through getOrCreateConversation
// at contact.location_id, on a filtering fake.
describe('getOrCreateConversation at the contact’s home studio', () => {
  function fakeDb(conversations, locations = []) {
    const inserts = []
    return {
      inserts,
      from: (table) => {
        const rows = table === 'whatsapp_conversations' ? conversations : table === 'locations' ? locations : []
        const filters = []
        let insert = null
        const b = {
          select: () => b,
          eq: (c, v) => { filters.push((r) => r[c] === v); return b },
          in: (c, vs) => { filters.push((r) => vs.includes(r[c])); return b },
          is: (c, v) => { filters.push((r) => (r[c] ?? null) === v); return b },
          order: () => b, limit: () => b,
          insert: (row) => { insert = row; return b },
          update: () => b,
          maybeSingle: async () => ({ data: rows.filter((r) => filters.every((f) => f(r)))[0] ?? null, error: null }),
          single: async () => {
            if (insert) { const row = { id: `new-${inserts.length + 1}`, ...insert }; inserts.push(row); conversations.push(row); return { data: { id: row.id }, error: null } }
            return { data: rows.filter((r) => filters.every((f) => f(r)))[0] ?? null, error: null }
          },
          then: (res, rej) => Promise.resolve({ data: rows.filter((r) => filters.every((f) => f(r))), error: null }).then(res, rej),
        }
        return b
      },
    }
  }
  const contact = { id: 'ct-1', location_id: 'loc-home', wa_phone: '353870000001' }

  it('composer files the thread at the contact’s home studio even when a newer thread exists elsewhere', async () => {
    const db = fakeDb([
      { id: 'c-home', location_id: 'loc-home', wa_phone: '353870000001', contact_id: 'ct-1', last_message_at: '2026-10-01T00:00:00Z' },
      { id: 'c-other', location_id: 'loc-other', wa_phone: '353870000001', contact_id: 'ct-1', last_message_at: '2026-10-17T00:00:00Z' },
    ])
    expect(await getOrCreateConversation(db, contact, contact.location_id)).toBe('c-home')
    expect(db.inserts).toEqual([])
  })

  it('with only a thread at another studio, opens a new one at home', async () => {
    const db = fakeDb([
      { id: 'c-other', location_id: 'loc-other', wa_phone: '353870000001', contact_id: 'ct-1', last_message_at: '2026-10-17T00:00:00Z' },
    ])
    const id = await getOrCreateConversation(db, contact, contact.location_id)
    expect(id).toBe('new-1')
    expect(db.inserts[0]).toMatchObject({ location_id: 'loc-home', contact_id: 'ct-1', wa_phone: '353870000001' })
  })
})
