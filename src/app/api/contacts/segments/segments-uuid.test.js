// SEGSAVE.1 — saving a segment must work at UN1T Stillorgan.
//
// Operator-reported 2026-08-09: "Save as segment" on /contacts returned
// "Invalid request body" for every attempt. Root cause is not the filter or
// the name — it is the LOCATION ID.
//
// Zod 4's z.string().uuid() enforces the RFC 4122 version digit (1-8).
// Stillorgan's seeded id is a0000000-0000-0000-0000-000000000001, whose
// version digit is 0, so the strict validator rejects it while Postgres
// stores and queries it happily. src/lib/validate.js documents this exact
// trap and exports `uuidLike` for it; CLAUDE.md makes it an invariant
// ("uuidLike — Postgres-permissive, NOT z.string().uuid()"). This route
// used the strict one.
//
// Consequence: the save has NEVER worked at the only live location, which is
// why contact_segments is empty estate-wide. Every other location's id is a
// real v4 and passes, so the bug was invisible anywhere but production.
//
// These tests pin the id shape, not the plumbing.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const STILLORGAN = 'a0000000-0000-0000-0000-000000000001'  // version digit 0
const HATCH      = '28c78d6b-f7b3-4edf-8c7c-840bd047b3f4'  // ordinary v4

let inserted = []

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(async () => ({ id: 'u1', activeLocation: { id: STILLORGAN } })),
  assertLocationAccess: vi.fn(() => null),
}))

vi.mock('@/lib/supabase', () => ({
  createServerClient: () => ({
    from: () => ({
      insert: (row) => {
        inserted.push(row)
        return {
          select: () => ({
            single: async () => ({ data: { id: 'seg-1', ...row }, error: null }),
          }),
        }
      },
    }),
  }),
}))

import { POST } from './route.js'

const req = (body) => new Request('http://localhost/api/contacts/segments', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

const FILTER = {
  logic: 'and',
  filters: [{ field: 'glofox_membership_state', op: 'eq', value: 'locked' }],
}

beforeEach(() => { inserted = [] })

describe('POST /api/contacts/segments — location id shape (SEGSAVE.1)', () => {
  it('accepts Stillorgan, whose seeded id has a non-RFC version digit', async () => {
    const res = await POST(req({ name: 'Overdue — arrears', filter: FILTER, location_id: STILLORGAN }))

    expect(res.status).toBe(200)
    expect((await res.json()).success).toBe(true)
    expect(inserted).toHaveLength(1)
    expect(inserted[0].location_id).toBe(STILLORGAN)
  })

  it('still accepts an ordinary v4 location id', async () => {
    const res = await POST(req({ name: 'Hatch members', filter: FILTER, location_id: HATCH }))
    expect(res.status).toBe(200)
  })

  it('still rejects a location_id that is not UUID-shaped at all', async () => {
    const res = await POST(req({ name: 'Bad', filter: FILTER, location_id: 'not-a-uuid' }))
    expect(res.status).toBe(400)
    expect(inserted).toHaveLength(0)
  })

  it('saves the arrears filter unchanged, so the segment can drive a dunning trigger', async () => {
    await POST(req({ name: 'Overdue — arrears', filter: FILTER, location_id: STILLORGAN }))
    expect(inserted[0].filter).toEqual(FILTER)
  })
})
