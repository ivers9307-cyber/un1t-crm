// COMMSFIX.B.7 — PUT /api/sequences/[id] rejects an invalid audience_filter
// at save time. A sequence saved with (e.g.) OR + Segment tag passed cleanly
// before, then contactMatchesSequenceAudience failed closed at every trigger
// evaluation — the sequence silently enrolled NOBODY, forever, with only a
// server log line as evidence.

import { describe, it, expect, vi, beforeEach } from 'vitest'

let updates = []
const fakeDb = {
  from: (table) => ({
    select: () => ({
      eq: () => ({
        single: () => Promise.resolve({
          data: table === 'email_sequences' ? { location_id: 'loc-1', trigger_type: 'manual', webhook_token: null } : null,
          error: null,
        }),
      }),
    }),
    update: (row) => {
      updates.push(row)
      return { eq: () => ({ select: () => ({ single: () => Promise.resolve({ data: { id: 'seq-1', ...row }, error: null }) }) }) }
    },
  }),
}

vi.mock('@/lib/supabase', () => ({ createServerClient: () => fakeDb }))
vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(async () => ({ id: 'u1' })),
  assertLocationAccessOr404: vi.fn(() => null),
}))
vi.mock('@/lib/validate', () => ({
  validateBody: vi.fn(async (req) => ({ ok: true, data: await req.json() })),
}))

import { PUT } from './route.js'

function put(body) {
  return PUT({ json: async () => body }, { params: { id: 'seq-1' } })
}

beforeEach(() => { updates = [] })

describe('sequences PUT — audience filter validated at save time (B7)', () => {
  it('rejects an OR + tag audience_filter with a 400 carrying the library message', async () => {
    const res = await put({
      audience_filter: {
        logic: 'or',
        filters: [
          { field: 'tag', op: 'eq', value: 'hot_lead' },
          { field: 'pipeline_stage_slug', op: 'eq', value: 'new_lead' },
        ],
      },
    })
    expect(res.status).toBe(400)
    expect(updates).toHaveLength(0)
    const json = await res.json()
    expect(json.success).toBe(false)
    expect(json.error).toMatch(/OR logic is not supported together with tag or event filters/)
  })

  it('rejects an unknown field with a 400', async () => {
    const res = await put({
      audience_filter: { logic: 'and', filters: [{ field: 'lead_status', op: 'eq', value: 'x' }] },
    })
    expect(res.status).toBe(400)
    expect(updates).toHaveLength(0)
  })

  it('accepts a valid audience_filter and a null one', async () => {
    const ok = await put({
      audience_filter: { logic: 'and', filters: [{ field: 'pipeline_stage_slug', op: 'eq', value: 'new_lead' }] },
    })
    expect((await ok.json()).success).toBe(true)
    const cleared = await put({ audience_filter: null })
    expect((await cleared.json()).success).toBe(true)
    expect(updates).toHaveLength(2)
  })
})
