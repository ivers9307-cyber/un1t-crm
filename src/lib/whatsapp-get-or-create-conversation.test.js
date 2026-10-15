// WAHOMESTUDIO.1 — an outbound send (broadcast, sequence, any send that opens a
// thread) to a contact whose home studio has no number files the thread at the
// home studio, stamped with the sending studio's number, so their reply lands
// in the same thread (the webhook files there too). Fictional ids only.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./whatsapp-thread-location', () => ({ numberlessHomeStudio: vi.fn(async () => null) }))
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
      if (op === 'update') { writes.push({ table, op, payload }); return { data: null, error: null } }
      const rows = (state[table] || []).filter((r) => filters.every((f) => f(r)))
      return { data: rows, error: null }
    }
    const b = {
      select: () => b,
      insert: (p) => { op = 'insert'; payload = p; return b },
      update: (p) => { op = 'update'; payload = p; return b },
      eq: (c, v) => { filters.push((r) => r[c] === v); return b },
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

let state
beforeEach(() => {
  vi.clearAllMocks()
  state = {
    whatsapp_conversations: [],
    whatsapp_numbers: [{ id: 'n-still', location_id: STILL, is_active: true, is_default: true }],
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
})
