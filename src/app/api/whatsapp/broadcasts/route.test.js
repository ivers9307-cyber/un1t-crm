// COMMSFIX.B.7 — POST /api/whatsapp/broadcasts rejects an invalid audience
// filter at save time (mirrors the SMS route test).

import { describe, it, expect, vi, beforeEach } from 'vitest'

let inserted = []
const fakeDb = {
  from: () => ({
    insert: (row) => {
      inserted.push(row)
      return { select: () => ({ single: () => Promise.resolve({ data: { id: 'wa-new', ...row }, error: null }) }) }
    },
  }),
}

vi.mock('@/lib/supabase', () => ({ createServerClient: () => fakeDb }))
vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(async () => ({ id: 'u1', activeLocation: { id: 'loc-1' } })),
  assertLocationAccess: vi.fn(() => null),
  getUserLocationIds: vi.fn(() => ['loc-1']),
}))
vi.mock('@/lib/validate', () => ({
  validateBody: vi.fn(async (req) => ({ ok: true, data: await req.json() })),
}))

import { POST } from './route.js'

function post(body) {
  return POST({ json: async () => body })
}

const base = { name: 'WA blast', template_id: '00000000-0000-0000-0000-00000000000t', location_id: 'loc-1' }

beforeEach(() => { inserted = [] })

describe('whatsapp broadcasts POST — audience filter validated at save time (B7)', () => {
  it('rejects an OR + event filter with a 400 carrying the library message', async () => {
    const res = await post({
      ...base,
      audience_filter: {
        logic: 'or',
        filters: [
          { field: 'event_registration', op: 'eq', value: 'evt-1' },
          { field: 'pipeline_stage_slug', op: 'eq', value: 'member' },
        ],
      },
    })
    expect(res.status).toBe(400)
    expect(inserted).toHaveLength(0)
    const json = await res.json()
    expect(json.error).toMatch(/OR logic is not supported together with tag, event or studio-list filters/)
  })

  it('rejects an unknown field with a 400', async () => {
    const res = await post({
      ...base,
      audience_filter: { logic: 'and', filters: [{ field: 'nope', op: 'eq', value: 'x' }] },
    })
    expect(res.status).toBe(400)
    expect(inserted).toHaveLength(0)
  })

  it('still creates a broadcast with a valid filter', async () => {
    const res = await post({
      ...base,
      audience_filter: { logic: 'and', filters: [{ field: 'glofox_membership_status', op: 'eq', value: 'trial' }] },
    })
    const json = await res.json()
    expect(json.success).toBe(true)
    expect(inserted).toHaveLength(1)
  })
})
