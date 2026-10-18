// WAHOMESTUDIO.1 — an outbound send (broadcast, sequence, any send that opens a
// thread) to a contact whose home studio has no number files the thread at the
// home studio, stamped with the sending studio's number, so their reply lands
// in the same thread (the webhook files there too). Fictional ids only.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./whatsapp-thread-location', () => ({ numberlessHomeStudio: vi.fn(async () => null) }))
// WAORGNUMBER.1 — the sending number is resolved through the link table
// (getLocationWhatsAppNumberConfig builds its own client): the shared fake
// models it from `state.numbers` / `state.links`.
let state
vi.mock('./supabase', async () => {
  const { fakeWhatsAppDb } = await import('./whatsapp-numbers-fake-db.test-helpers.js')
  return { createServerClient: () => fakeWhatsAppDb(state) }
})
const { link } = await import('./whatsapp-numbers-fake-db.test-helpers.js')
const { getOrCreateConversation } = await import('./whatsapp.js')
const { numberlessHomeStudio } = await import('./whatsapp-thread-location')

const STILL = 'a0000000-0000-4000-8000-000000000001'
const HATCH = 'a0000000-0000-4000-8000-000000000002'

function makeDb(state) {
  const writes = []
  const from = (table) => {
    const filters = []
    let op = 'select'
    let payload = null
    const run = () => {
      if (op === 'insert') {
        const row = { id: `conv-${state.whatsapp_conversations.length + 1}`, ...payload }
        state.whatsapp_conversations.push(row)
        writes.push({ table, op, payload })
        return { data: { id: row.id }, error: null }
      }
      if (op === 'update') {
        writes.push({ table, op, payload })
        if (state.failUpdate) return { data: null, error: { message: state.failUpdate } }
        for (const r of (state[table] || []).filter((row) => filters.every((f) => f(row)))) Object.assign(r, payload)
        return { data: null, error: null }
      }
      const rows = (state[table] || []).filter((r) => filters.every((f) => f(r)))
      return { data: rows, error: null }
    }
    const b = {
      select: () => b,
      insert: (p) => { op = 'insert'; payload = p; return b },
      update: (p) => { op = 'update'; payload = p; return b },
      eq: (c, v) => { filters.push((r) => r[c] === v); return b },
      is: (c, v) => { filters.push((r) => (r[c] ?? null) === v); return b },
      order: () => b,
      limit: () => b,
      single: async () => { const o = run(); return { data: Array.isArray(o.data) ? o.data[0] ?? null : o.data, error: o.error } },
      maybeSingle: async () => { const o = run(); return { data: Array.isArray(o.data) ? o.data[0] ?? null : o.data, error: o.error } },
      then: (res, rej) => Promise.resolve(run()).then(res, rej),
    }
    return b
  }
  return { from, writes }
}

beforeEach(() => {
  vi.clearAllMocks()
  state = {
    whatsapp_conversations: [],
    numbers: [{ id: 'n-still', location_id: STILL, is_active: true, is_default: true }],
  }
})

describe('getOrCreateConversation — WAHOMESTUDIO.1', () => {
  it('a numberless-home contact gets a new thread at the home studio, stamped with the sender’s number', async () => {
    numberlessHomeStudio.mockResolvedValueOnce(HATCH)
    const db = makeDb(state)
    const id = await getOrCreateConversation(db, { id: 'k1', wa_phone: '15555550100', location_id: HATCH }, STILL)
    expect(state.whatsapp_conversations[0]).toMatchObject({ id, location_id: HATCH, contact_id: 'k1', whatsapp_number_id: 'n-still' })
    expect(numberlessHomeStudio).toHaveBeenCalledWith(db, { id: 'k1', wa_phone: '15555550100', location_id: HATCH }, STILL)
  })

  it('stamps the number switched on at the sending studio, whatever its home (WAORGNUMBER.1)', async () => {
    // The organisation number is homed at Hatch but switched on at Still only.
    state.numbers = [{ id: 'n-org', location_id: HATCH, is_active: true }]
    state.links = [link(STILL, 'n-org')]
    numberlessHomeStudio.mockResolvedValueOnce(HATCH)
    await getOrCreateConversation(makeDb(state), { id: 'k1', wa_phone: '15555550100', location_id: HATCH }, STILL)
    expect(state.whatsapp_conversations[0]).toMatchObject({ location_id: HATCH, whatsapp_number_id: 'n-org' })
  })

  it('a number homed at the sending studio but switched off there is not stamped (WAORGNUMBER.1)', async () => {
    state.links = []
    numberlessHomeStudio.mockResolvedValueOnce(HATCH)
    await getOrCreateConversation(makeDb(state), { id: 'k1', wa_phone: '15555550100', location_id: HATCH }, STILL)
    expect(state.whatsapp_conversations[0].whatsapp_number_id ?? null).toBeNull()
  })

  it('an unreadable sending number files the thread unstamped, logged (never thrown)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    state.faults = { location_whatsapp_numbers: { message: 'boom' } }
    numberlessHomeStudio.mockResolvedValueOnce(HATCH)
    await getOrCreateConversation(makeDb(state), { id: 'k1', wa_phone: '15555550100', location_id: HATCH }, STILL)
    expect(state.whatsapp_conversations[0].whatsapp_number_id ?? null).toBeNull()
    expect(errSpy).toHaveBeenCalledWith('[whatsapp] getOrCreateConversation: sending number lookup failed', STILL, expect.stringContaining('boom'))
    errSpy.mockRestore()
  })

  it('reuses the home studio’s existing thread', async () => {
    state.whatsapp_conversations.push({ id: 'conv-hatch', location_id: HATCH, wa_phone: '15555550100', contact_id: 'k1' })
    numberlessHomeStudio.mockResolvedValueOnce(HATCH)
    expect(await getOrCreateConversation(makeDb(state), { id: 'k1', wa_phone: '15555550100' }, STILL)).toBe('conv-hatch')
  })

  it('an existing thread at the sending studio is still reused, with no home lookup', async () => {
    state.whatsapp_conversations.push({ id: 'conv-still', location_id: STILL, wa_phone: '15555550100', contact_id: 'k1' })
    expect(await getOrCreateConversation(makeDb(state), { id: 'k1', wa_phone: '15555550100', location_id: HATCH }, STILL)).toBe('conv-still')
    expect(numberlessHomeStudio).not.toHaveBeenCalled()
  })

  it('any other contact: a new thread at the sending studio, no stamp written by this path', async () => {
    await getOrCreateConversation(makeDb(state), { id: 'k2', wa_phone: '15555550101', location_id: STILL }, STILL)
    expect(state.whatsapp_conversations[0]).toMatchObject({ location_id: STILL })
    expect(state.whatsapp_conversations[0]).not.toHaveProperty('whatsapp_number_id')
  })

  // F4 (R3 completeness) — a home thread opened before WAHOMESTUDIO.1 (or by a
  // path that did not stamp) gets the sending studio's number, so the reply
  // into it resolves (getConversationNumberConfig). Logged, never thrown.
  it('an existing UNSTAMPED home thread is stamped with the sending studio’s default active number', async () => {
    state.whatsapp_conversations.push({ id: 'conv-hatch', location_id: HATCH, wa_phone: '15555550100', contact_id: 'k1', whatsapp_number_id: null })
    numberlessHomeStudio.mockResolvedValueOnce(HATCH)
    const db = makeDb(state)
    expect(await getOrCreateConversation(db, { id: 'k1', wa_phone: '15555550100' }, STILL)).toBe('conv-hatch')
    expect(state.whatsapp_conversations[0].whatsapp_number_id).toBe('n-still')
    expect(db.writes).toEqual([{ table: 'whatsapp_conversations', op: 'update', payload: { whatsapp_number_id: 'n-still' } }])
  })

  it('an existing home thread that is already stamped is left alone', async () => {
    state.whatsapp_conversations.push({ id: 'conv-hatch', location_id: HATCH, wa_phone: '15555550100', contact_id: 'k1', whatsapp_number_id: 'n-other' })
    numberlessHomeStudio.mockResolvedValueOnce(HATCH)
    const db = makeDb(state)
    expect(await getOrCreateConversation(db, { id: 'k1', wa_phone: '15555550100' }, STILL)).toBe('conv-hatch')
    expect(state.whatsapp_conversations[0].whatsapp_number_id).toBe('n-other')
    expect(db.writes).toEqual([])
  })

  it('a failed stamp on the existing home thread is logged and the thread is still returned', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    state.whatsapp_conversations.push({ id: 'conv-hatch', location_id: HATCH, wa_phone: '15555550100', contact_id: 'k1', whatsapp_number_id: null })
    state.failUpdate = 'boom'
    numberlessHomeStudio.mockResolvedValueOnce(HATCH)
    expect(await getOrCreateConversation(makeDb(state), { id: 'k1', wa_phone: '15555550100' }, STILL)).toBe('conv-hatch')
    expect(errSpy).toHaveBeenCalledWith('[whatsapp] getOrCreateConversation: number stamp on the home thread failed', 'conv-hatch', 'boom')
    errSpy.mockRestore()
  })
})
