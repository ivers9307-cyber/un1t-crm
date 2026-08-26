// COMMSFIX.B.7 — POST /api/sms/broadcasts rejects an invalid audience
// filter (OR+tag, unknown field) at save time with the
// InvalidAudienceFilterError message, instead of parking a broadcast whose
// audience can never resolve.

import { describe, it, expect, vi, beforeEach } from 'vitest'

let inserted = []
const fakeDb = {
  from: () => ({
    insert: (row) => {
      inserted.push(row)
      return { select: () => ({ single: () => Promise.resolve({ data: { id: 'bc-new', ...row }, error: null }) }) }
    },
  }),
}

vi.mock('@/lib/supabase', () => ({ createServerClient: () => fakeDb }))
vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(async () => ({ id: 'u1', activeLocation: { id: 'loc-1' } })),
  assertLocationAccess: vi.fn(() => null),
  getUserLocationIds: vi.fn(() => ['loc-1']),
}))
vi.mock('@/lib/permissions', () => ({ hasPermission: vi.fn(() => true) }))
vi.mock('@/lib/validate', () => ({
  validateBody: vi.fn(async (req) => ({ ok: true, data: await req.json() })),
}))

import { POST } from './route.js'

function post(body) {
  return POST({ json: async () => body })
}

const base = { name: 'Blast', body: 'Hi {{first_name}}', location_id: 'loc-1' }

beforeEach(() => { inserted = [] })

describe('sms broadcasts POST — audience filter validated at save time (B7)', () => {
  it('rejects an OR + tag filter with a 400 carrying the library message', async () => {
    const res = await post({
      ...base,
      audience_filter: {
        logic: 'or',
        filters: [
          { field: 'tag', op: 'eq', value: 'hot_lead' },
          { field: 'pipeline_stage_slug', op: 'eq', value: 'new_lead' },
        ],
      },
    })
    expect(res.status).toBe(400)
    expect(inserted).toHaveLength(0)
    const json = await res.json()
    expect(json.success).toBe(false)
    expect(json.error).toMatch(/OR logic is not supported together with tag, event or studio-list filters/)
  })

  it('rejects an unknown field with a 400', async () => {
    const res = await post({
      ...base,
      audience_filter: { logic: 'and', filters: [{ field: 'lead_status', op: 'eq', value: 'x' }] },
    })
    expect(res.status).toBe(400)
    expect(inserted).toHaveLength(0)
  })

  it('still creates a broadcast with a valid filter', async () => {
    const res = await post({
      ...base,
      audience_filter: { logic: 'and', filters: [{ field: 'glofox_membership_type', op: 'neq', value: 'time' }] },
    })
    const json = await res.json()
    expect(json.success).toBe(true)
    expect(inserted).toHaveLength(1)
  })
})
