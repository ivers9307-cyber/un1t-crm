// COMMSFIX.E.5 — PUT /api/sequences/[id] must refuse to ACTIVATE a
// sequence that can never fire.
//
// The 2026-08-09 audit found two LIVE dunning sequences with
// trigger_type='segment_added' and an EMPTY trigger_config: the segment
// trigger requires trigger_config.segment_id (triggers.js skips any
// sequence without it), so both sat 'active' while enrolling nobody,
// with no signal to the operator. The PUT route validated
// trigger_config as z.unknown() and happily flipped status='active'.
//
// The guard checks EFFECTIVE values (request merged over the stored
// row), so activating via a status-only PUT is caught too.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  assertLocationAccessOr404: (user, locationId) => {
    if (!user) return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), { status: 401 })
    if (!locationId) return null
    const allowed = (user.locations || []).some((l) => l.id === locationId)
    if (!allowed) return new Response(JSON.stringify({ success: false, error: 'Not found' }), { status: 404 })
    return null
  },
}))

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

import { PUT } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

const SEQ_ID  = 'a0000000-0000-0000-0000-000000000001'
const USER_ID = 'b0000000-0000-0000-0000-000000000002'
const LOC_ID  = 'c0000000-0000-0000-0000-000000000003'
const SEG_ID  = 'e0000000-0000-0000-0000-000000000005'

const OWNER = { id: USER_ID, role: 'owner', locations: [{ id: LOC_ID }] }

// PUT reads the sequence row up front (guard + effective-value merge),
// then updates. `row` feeds every select; `updateSpy` captures writes.
function mockDb({ row } = {}) {
  const updateSpy = vi.fn(() => ({
    eq: vi.fn(() => ({
      select: vi.fn(() => ({
        single: vi.fn(async () => ({ data: { id: SEQ_ID, ...row }, error: null })),
      })),
    })),
  }))
  const db = {
    from: vi.fn((table) => {
      if (table !== 'email_sequences') throw new Error(`unexpected table: ${table}`)
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            single: vi.fn(async () => ({ data: row ?? null, error: row ? null : { message: 'not found' } })),
          })),
        })),
        update: updateSpy,
      }
    }),
  }
  return { db, updateSpy }
}

const putReq = (body) => new Request(`http://localhost/api/sequences/${SEQ_ID}`, {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})
const props = { params: { id: SEQ_ID } }

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(OWNER)
})

describe('PUT /api/sequences/[id] — segment-trigger activation guard (COMMSFIX.E.5)', () => {
  it('400s when activating a segment_added sequence whose trigger_config has no segment id', async () => {
    const { db, updateSpy } = mockDb({
      row: { id: SEQ_ID, location_id: LOC_ID, trigger_type: 'segment_added', trigger_config: {}, status: 'draft' },
    })
    createServerClient.mockReturnValue(db)

    const res = await PUT(putReq({ status: 'active' }), props)
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.success).toBe(false)
    expect(json.error).toMatch(/segment/i)
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('400s when the request itself sets segment_added + empty config + active in one PUT', async () => {
    const { db, updateSpy } = mockDb({
      row: { id: SEQ_ID, location_id: LOC_ID, trigger_type: 'manual', trigger_config: {}, status: 'draft' },
    })
    createServerClient.mockReturnValue(db)

    const res = await PUT(putReq({ status: 'active', trigger_type: 'segment_removed', trigger_config: {} }), props)
    expect(res.status).toBe(400)
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('activates normally when the segment id is present (stored or in the request)', async () => {
    const { db, updateSpy } = mockDb({
      row: { id: SEQ_ID, location_id: LOC_ID, trigger_type: 'segment_added', trigger_config: { segment_id: SEG_ID }, status: 'draft' },
    })
    createServerClient.mockReturnValue(db)

    const res = await PUT(putReq({ status: 'active' }), props)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(true)
    expect(updateSpy).toHaveBeenCalledTimes(1)
  })

  it('does not block non-segment triggers or non-activating updates', async () => {
    const { db: db1 } = mockDb({
      row: { id: SEQ_ID, location_id: LOC_ID, trigger_type: 'tag_added', trigger_config: {}, status: 'draft' },
    })
    createServerClient.mockReturnValue(db1)
    expect((await PUT(putReq({ status: 'active' }), props)).status).toBe(200)

    // Saving a segment sequence as a DRAFT with no segment stays allowed —
    // the operator picks the segment later; only ACTIVATION is gated.
    const { db: db2 } = mockDb({
      row: { id: SEQ_ID, location_id: LOC_ID, trigger_type: 'segment_added', trigger_config: {}, status: 'draft' },
    })
    createServerClient.mockReturnValue(db2)
    expect((await PUT(putReq({ name: 'Renamed dunning chase' }), props)).status).toBe(200)
  })
})

// COMMSFIX.B.7 — the sibling guard: an invalid audience_filter is rejected at
// SAVE time. A sequence saved with (e.g.) OR + Segment tag used to pass
// cleanly, then contactMatchesSequenceAudience failed closed at every trigger
// evaluation — enrolling NOBODY, forever, with only a server log line as
// evidence. Ported onto the E.5 harness during the #1310/#1312 rebase: both
// PRs added this file independently, and this harness is the stricter one
// (real Request objects, real location checks).
describe('PUT /api/sequences/[id] — audience filter validated at save time (COMMSFIX.B.7)', () => {
  const ROW = { id: SEQ_ID, location_id: LOC_ID, trigger_type: 'manual', trigger_config: {}, status: 'draft', webhook_token: null }

  it('rejects an OR + tag audience_filter with a 400 carrying the library message', async () => {
    const { db, updateSpy } = mockDb({ row: ROW })
    createServerClient.mockReturnValue(db)

    const res = await PUT(putReq({
      audience_filter: {
        logic: 'or',
        filters: [
          { field: 'tag', op: 'eq', value: 'hot_lead' },
          { field: 'pipeline_stage_slug', op: 'eq', value: 'new_lead' },
        ],
      },
    }), props)

    expect(res.status).toBe(400)
    expect(updateSpy).not.toHaveBeenCalled()
    expect((await res.json()).error).toMatch(/OR logic is not supported together with tag, event or studio-list filters/)
  })

  it('rejects an unknown audience field with a 400 and writes nothing', async () => {
    const { db, updateSpy } = mockDb({ row: ROW })
    createServerClient.mockReturnValue(db)

    const res = await PUT(putReq({
      audience_filter: { logic: 'and', filters: [{ field: 'lead_status', op: 'eq', value: 'x' }] },
    }), props)

    expect(res.status).toBe(400)
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('accepts a valid audience_filter, and null still clears the gate', async () => {
    const { db, updateSpy } = mockDb({ row: ROW })
    createServerClient.mockReturnValue(db)

    const ok = await PUT(putReq({
      audience_filter: { logic: 'and', filters: [{ field: 'pipeline_stage_slug', op: 'eq', value: 'new_lead' }] },
    }), props)
    expect(ok.status).toBe(200)

    const cleared = await PUT(putReq({ audience_filter: null }), props)
    expect(cleared.status).toBe(200)
    expect(updateSpy).toHaveBeenCalledTimes(2)
  })
})
