// MIAFEEDBACK.1 — audit 2026-11-15 item 10: the schema passed a zod schema
// (uuidLike) to .regex(), so no rating could ever be saved (0 rows in prod).
// Fictional ids only.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn(), getUserLocationIds: (u) => (u?.locations || []).map((l) => l.id) }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

import { POST } from './route'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

const LOC = 'a0000000-0000-0000-0000-000000000001' // the seeded, non-RFC id uuidLike must accept
const MSG = '11111111-1111-4111-8111-111111111111'

let upserts
function fakeDb(msg) {
  upserts = []
  return {
    from: (table) => {
      if (table === 'agent_message_feedback') return { upsert: (row) => { upserts.push(row); return Promise.resolve({ error: null }) } }
      const q = { select: () => q, eq: () => q, maybeSingle: () => Promise.resolve({ data: msg, error: null }) }
      return q
    },
  }
}
const post = (body) => POST(new Request('http://x.test/api/agent/feedback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))

beforeEach(() => {
  getCurrentUser.mockResolvedValue({ id: 'u1', locations: [{ id: LOC }] })
  createServerClient.mockReturnValue(fakeDb({ id: MSG, conversation_id: 'c1', location_id: LOC, source: 'agent' }))
})

describe('POST /api/agent/feedback', () => {
  it('saves a thumbs-up on an agent reply', async () => {
    const res = await post({ channel: 'whatsapp', message_id: MSG, rating: 'up' })
    expect(res.status).toBe(200)
    expect(upserts).toHaveLength(1)
    expect(upserts[0]).toMatchObject({ message_id: MSG, rating: 'up', created_by: 'u1' })
  })
  it('accepts the seeded non-RFC id shape', async () => {
    createServerClient.mockReturnValue(fakeDb({ id: LOC, conversation_id: 'c1', location_id: LOC, source: 'agent' }))
    expect((await post({ channel: 'instagram', message_id: LOC, rating: 'down', note: 'wrong price' })).status).toBe(200)
  })
  it('401 signed out (ROUTEWRAP.R6)', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await post({ channel: 'whatsapp', message_id: MSG, rating: 'up' })).status).toBe(401)
    expect(upserts).toHaveLength(0)
  })
  it("404 for a message at another studio, nothing saved", async () => {
    createServerClient.mockReturnValue(fakeDb({ id: MSG, conversation_id: 'c1', location_id: 'b0000000-0000-0000-0000-000000000002', source: 'agent' }))
    expect((await post({ channel: 'whatsapp', message_id: MSG, rating: 'up' })).status).toBe(404)
    expect(upserts).toHaveLength(0)
  })
  it('a failed save is a 500 with a fixed message', async () => {
    const db = fakeDb({ id: MSG, conversation_id: 'c1', location_id: LOC, source: 'agent' })
    const from = db.from
    db.from = (t) => (t === 'agent_message_feedback' ? { upsert: () => Promise.resolve({ error: { code: '23505', message: 'duplicate key on agent_message_feedback' } }) } : from(t))
    createServerClient.mockReturnValue(db)
    const res = await post({ channel: 'whatsapp', message_id: MSG, rating: 'up' })
    expect(res.status).toBe(500)
    expect((await res.json()).error).not.toMatch(/agent_message_feedback/)
  })
  it('refuses a message id that is not a uuid', async () => {
    expect((await post({ channel: 'whatsapp', message_id: 'not-an-id', rating: 'up' })).status).toBe(400)
    expect(upserts).toHaveLength(0)
  })
})
