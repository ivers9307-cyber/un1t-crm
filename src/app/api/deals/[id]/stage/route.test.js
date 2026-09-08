// WAITLIST.2 — POST /api/deals/[id]/stage, the session-authed manual move.
//
// PUT /api/deals/[id] already resolves a location-scoped stage and fires the
// STAGETRIG.1 sequence trigger, but it is gated by authenticateApiKey() — a
// Bearer API key, the n8n integration path. A browser cannot call it, so it
// cannot back drag-drop. This is its session-authed sibling, modelled on the
// Cold button's route (/api/contacts/[id]/pipeline-status).
//
// Coverage:
//   - no session                        → 401
//   - no `pipeline` permission          → 403
//   - malformed / unknown deal id       → 404 (never 403 — ids stay unguessable)
//   - deal outside the caller locations → 404
//   - a DERIVED pipeline                → 400 pipeline_is_derived  ← the fence
//   - a stage on ANOTHER pipeline       → 400 unknown_stage_for_pipeline
//   - a real manual move                → 200, writes stage_id, fires the
//                                         sequence trigger, logs the audit row
//   - a move to the stage it is in      → 200 no-op, no write, no trigger
//   - a failed write                    → 500, and nothing downstream runs
//   - a throwing sequence trigger       → still 200 (the move is already saved)
//
// The derived refusal is what keeps FUNNEL.1's guarantee true: a manual move on
// a classifier-owned board would be silently reverted by the next classify
// pass, which is the exact failure drag-drop was removed to prevent.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  // Real shape, not a stub: the 404-not-403 answer is the thing under test.
  assertLocationAccessOr404: (user, locationId) => {
    if (!user) return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), { status: 401 })
    if (!locationId) return null
    const allowed = (user.locations || []).some((l) => l.id === locationId)
    if (!allowed) return new Response(JSON.stringify({ success: false, error: 'Not found' }), { status: 404 })
    return null
  },
}))

vi.mock('@/lib/permissions', () => ({ hasPermission: vi.fn(() => true) }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn(() => Promise.resolve({ logged: true })) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/sequences/triggers', () => ({
  triggerSequencesForDealPlacement: vi.fn(async () => {}),
}))

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { logAuditEvent } from '@/lib/audit'
import { triggerSequencesForDealPlacement } from '@/lib/sequences/triggers'

// uuidLike is Postgres-permissive, but use well-formed ids anyway.
const DEAL_ID    = '11111111-1111-4111-8111-111111111111'
const STAGE_OLD  = '22222222-2222-4222-8222-222222222222'
const STAGE_NEW  = '33333333-3333-4333-8333-333333333333'
const STAGE_GYM  = '44444444-4444-4444-8444-444444444444'
const LOC_ID     = 'a0000000-0000-0000-0000-000000000001'
const OTHER_LOC  = 'b0000000-0000-0000-0000-000000000002'
const WAITLIST   = 'd0000000-0000-0000-0000-00000000000a'   // Hatch's manual waitlist board
const GYM_BOARD  = 'e0000000-0000-0000-0000-00000000000b'   // Hatch's derived acquisition board

const STAFF = {
  id: 'u-1', role: 'staff', full_name: 'Sarah Coach', email: 'sarah@un1t.ie',
  locations: [{ id: LOC_ID }],
}

const WAITLIST_STAGES = {
  [STAGE_OLD]: { id: STAGE_OLD, slug: 'waitlist_new_enquiry', pipeline_id: WAITLIST },
  [STAGE_NEW]: { id: STAGE_NEW, slug: 'waitlist_no_answer',   pipeline_id: WAITLIST },
  // A column on Hatch's OTHER board — the card must never be parkable here.
  [STAGE_GYM]: { id: STAGE_GYM, slug: 'converted',            pipeline_id: GYM_BOARD },
}

const MANUAL_DEAL = {
  id: DEAL_ID, location_id: LOC_ID, contact_id: 'c-1',
  stage_id: STAGE_OLD, pipeline_id: WAITLIST,
}

/**
 * Chainable double. `stages` is keyed by id and the pipeline_stages lookup
 * HONOURS an .eq('pipeline_id', …) filter, so the same-board fence is exercised
 * for real rather than faked by handing back null.
 */
function makeDb({ deal = MANUAL_DEAL, stages = WAITLIST_STAGES, pipeline, updateError = null } = {}) {
  const writes = []
  return {
    writes,
    from(table) {
      const filters = {}
      const q = {
        select: () => q,
        eq: (col, val) => { filters[col] = val; return q },
        limit: () => q,
        maybeSingle: async () => {
          if (table === 'deals') return { data: deal ?? null, error: null }
          if (table === 'pipelines') return { data: pipeline ?? null, error: null }
          if (table === 'pipeline_stages') {
            const row = stages[filters.id] || null
            if (row && filters.pipeline_id !== undefined && row.pipeline_id !== filters.pipeline_id) {
              return { data: null, error: null }
            }
            return { data: row, error: null }
          }
          throw new Error(`unexpected table ${table}`)
        },
        update(payload) {
          writes.push({ table, payload })
          return { eq: async () => ({ error: updateError }) }
        },
      }
      return q
    },
  }
}

const req = (body) => new Request(`http://localhost/api/deals/${DEAL_ID}/stage`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})
const props = { params: Promise.resolve({ id: DEAL_ID }) }

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(STAFF)
  hasPermission.mockReturnValue(true)
})

describe('POST /api/deals/[id]/stage — the guard chain', () => {
  it('401s an anonymous caller', async () => {
    getCurrentUser.mockResolvedValue(null)
    createServerClient.mockReturnValue(makeDb({ pipeline: { id: WAITLIST, mode: 'manual', key: 'waitlist' } }))
    const res = await POST(req({ stage_id: STAGE_NEW }), props)
    expect(res.status).toBe(401)
  })

  it('403s a user without the pipeline permission', async () => {
    hasPermission.mockReturnValue(false)
    createServerClient.mockReturnValue(makeDb({ pipeline: { id: WAITLIST, mode: 'manual', key: 'waitlist' } }))
    const res = await POST(req({ stage_id: STAGE_NEW }), props)
    expect(res.status).toBe(403)
  })

  it('404s a malformed deal id without touching the database', async () => {
    createServerClient.mockReturnValue(makeDb({ pipeline: { id: WAITLIST, mode: 'manual', key: 'waitlist' } }))
    const res = await POST(req({ stage_id: STAGE_NEW }), { params: Promise.resolve({ id: 'not-a-uuid' }) })
    expect(res.status).toBe(404)
  })

  it('404s an unknown deal id — never 403, so ids cannot be enumerated', async () => {
    createServerClient.mockReturnValue(makeDb({ deal: null }))
    const res = await POST(req({ stage_id: STAGE_NEW }), props)
    expect(res.status).toBe(404)
  })

  it('404s a deal at a location the caller cannot see', async () => {
    const db = makeDb({
      deal: { ...MANUAL_DEAL, location_id: OTHER_LOC },
      pipeline: { id: WAITLIST, mode: 'manual', key: 'waitlist' },
    })
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ stage_id: STAGE_NEW }), props)
    expect(res.status).toBe(404)
    expect(db.writes).toEqual([])
  })

  it('400s a body with no stage_id', async () => {
    createServerClient.mockReturnValue(makeDb({ pipeline: { id: WAITLIST, mode: 'manual', key: 'waitlist' } }))
    const res = await POST(req({}), props)
    expect(res.status).toBe(400)
  })
})

// The fence. FUNNEL.1 removed drag-drop from the derived board because the
// nightly classifier overwrites a manual move — so accepting one here would
// hand the operator a card that walks back overnight, which is worse than
// refusing the move outright.
describe('POST /api/deals/[id]/stage — a DERIVED board is read-only', () => {
  it('refuses to move a deal on a derived pipeline', async () => {
    const db = makeDb({
      deal: { ...MANUAL_DEAL, pipeline_id: GYM_BOARD, stage_id: STAGE_GYM },
      stages: { [STAGE_GYM]: { id: STAGE_GYM, slug: 'converted', pipeline_id: GYM_BOARD } },
      pipeline: { id: GYM_BOARD, mode: 'derived', key: 'acquisition' },
    })
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ stage_id: STAGE_GYM }), props)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('pipeline_is_derived')
    // No write, no sequence enrolment, no audit row — nothing happened.
    expect(db.writes).toEqual([])
    expect(triggerSequencesForDealPlacement).not.toHaveBeenCalled()
    expect(logAuditEvent).not.toHaveBeenCalled()
  })

  it('refuses a deal whose pipeline row cannot be resolved at all', async () => {
    const db = makeDb({ pipeline: null })
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ stage_id: STAGE_NEW }), props)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('pipeline_is_derived')
    expect(db.writes).toEqual([])
  })
})

describe('POST /api/deals/[id]/stage — moving a card on a manual board', () => {
  const manualDb = (over = {}) => makeDb({
    pipeline: { id: WAITLIST, mode: 'manual', key: 'waitlist' },
    ...over,
  })

  it('moves the deal and answers moved:true', async () => {
    const db = manualDb()
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ stage_id: STAGE_NEW }), props)
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.success).toBe(true)
    expect(json.data).toMatchObject({ moved: true, stage_id: STAGE_NEW })
    expect(db.writes).toEqual([{ table: 'deals', payload: { stage_id: STAGE_NEW } }])
  })

  it('fires the pipeline_stage_change trigger with the resolved slugs', async () => {
    createServerClient.mockReturnValue(manualDb())
    await POST(req({ stage_id: STAGE_NEW }), props)
    expect(triggerSequencesForDealPlacement).toHaveBeenCalledWith('c-1', {
      action: 'move',
      from_slug: 'waitlist_new_enquiry',
      to_slug: 'waitlist_no_answer',
    })
  })

  it('records WHO moved the card', async () => {
    createServerClient.mockReturnValue(manualDb())
    await POST(req({ stage_id: STAGE_NEW }), props)
    expect(logAuditEvent).toHaveBeenCalledTimes(1)
    expect(logAuditEvent.mock.calls[0][0]).toMatchObject({
      category: 'business',
      action: 'pipeline.manual_move',
      actor: { id: 'u-1', full_name: 'Sarah Coach', email: 'sarah@un1t.ie' },
      target: { label: 'waitlist_no_answer', resource: `deals/${DEAL_ID}` },
      locationId: LOC_ID,
      details: { pipeline: 'waitlist', from_stage_id: STAGE_OLD, to_stage_id: STAGE_NEW },
    })
    // A deal is not a profile — target.id must stay unset (FK → profiles).
    expect(logAuditEvent.mock.calls[0][0].target.id).toBeUndefined()
  })

  // Without the .eq('pipeline_id', …) fence a caller could park a waitlist card
  // in a gym column — the boards share a location, so a location filter alone
  // would let it through.
  it('refuses a stage that belongs to another pipeline', async () => {
    const db = manualDb()
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ stage_id: STAGE_GYM }), props)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('unknown_stage_for_pipeline')
    expect(db.writes).toEqual([])
  })

  it('refuses a stage id that does not exist', async () => {
    const db = manualDb()
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ stage_id: '55555555-5555-4555-8555-555555555555' }), props)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('unknown_stage_for_pipeline')
    expect(db.writes).toEqual([])
  })

  // Dropping a card back where it started is an operator slip, not an error —
  // and it must enrol nobody, or every mis-drop re-fires the sequence.
  it('treats a move to the stage the deal is already in as a no-op success', async () => {
    const db = manualDb()
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ stage_id: STAGE_OLD }), props)
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.success).toBe(true)
    expect(json.data).toMatchObject({ moved: false, stage_id: STAGE_OLD })
    expect(db.writes).toEqual([])
    expect(triggerSequencesForDealPlacement).not.toHaveBeenCalled()
    expect(logAuditEvent).not.toHaveBeenCalled()
  })

  it('reports a failed write instead of answering success', async () => {
    const db = manualDb({ updateError: { message: 'deals_stage_id_fkey' } })
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ stage_id: STAGE_NEW }), props)
    expect(res.status).toBe(500)
    expect((await res.json()).success).toBe(false)
    expect(triggerSequencesForDealPlacement).not.toHaveBeenCalled()
    expect(logAuditEvent).not.toHaveBeenCalled()
  })

  it('still returns 200 when the sequence trigger throws — the move is saved', async () => {
    triggerSequencesForDealPlacement.mockRejectedValueOnce(new Error('sequences down'))
    createServerClient.mockReturnValue(manualDb())
    const res = await POST(req({ stage_id: STAGE_NEW }), props)
    expect(res.status).toBe(200)
    expect((await res.json()).success).toBe(true)
    expect(logAuditEvent).toHaveBeenCalledTimes(1)
  })
})
