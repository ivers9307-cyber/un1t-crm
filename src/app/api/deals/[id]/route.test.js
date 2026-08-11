// STAGETRIG.1 — PUT /api/deals/[id] is the manual stage-move path, and it
// never told the sequence engine anything. It writes deals.stage_id; the
// mig-155 trigger re-derives contacts.pipeline_stage_slug inside Postgres;
// triggerSequencesForPipelineStageChange was wired only to POST
// /api/contacts, where the old stage is always null. Result: a
// pipeline_stage_change sequence with any to_status other than the creation
// stage was dead on arrival — including the shipped
// `lead_status_member_welcome` template ({ to_status: 'converted' }).
//
// Wiring it makes previously-dead sequences start firing, so these tests
// pin the gates as hard as the happy path: no fire on a no-op, none on a
// non-stage edit, none without a contact, and never at the cost of the
// response.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/api-auth', () => ({
  authenticateApiKey: vi.fn(),
  orgLocationIds: vi.fn(async () => []),
}))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/sequences/triggers', () => ({
  triggerSequencesForDealPlacement: vi.fn(async () => {}),
}))

import { PUT } from './route.js'
import { authenticateApiKey } from '@/lib/api-auth'
import { createServerClient } from '@/lib/supabase'
import { triggerSequencesForDealPlacement } from '@/lib/sequences/triggers'

// Real UUIDs — stage_id goes through the uuidLike Zod block.
const STAGE_TRIAL = '11111111-1111-1111-1111-111111111111'
const STAGE_CONV  = '22222222-2222-2222-2222-222222222222'
const STAGE_ROWS = [
  { id: STAGE_TRIAL, slug: 'active_trial' },
  { id: STAGE_CONV, slug: 'converted' },
]

/**
 * Minimal chainable double. `deal` is the pre-update row returned by the
 * .maybeSingle() read; `pipeline_stages` answers both the slug→id lookup
 * (.single()) and the id→slug batch (.in() then await).
 */
function mockDb({ deal, stageRows = STAGE_ROWS, updateError = null } = {}) {
  const update = vi.fn(() => ({
    eq: vi.fn(() => ({
      select: vi.fn(() => ({
        single: vi.fn(async () => (
          updateError ? { data: null, error: updateError } : { data: { id: 'd1' }, error: null }
        )),
      })),
    })),
  }))
  return {
    update,
    from: vi.fn((table) => {
      if (table === 'deals') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({ maybeSingle: vi.fn(async () => ({ data: deal ?? null, error: null })) })),
          })),
          update,
        }
      }
      if (table === 'pipeline_stages') {
        const builder = {
          select: vi.fn(() => builder),
          eq: vi.fn(() => builder),
          in: vi.fn(() => builder),
          single: vi.fn(async () => ({ data: stageRows[1] ?? null, error: null })),
          // DEALSCOPE.1 — scoping by location makes 0-or-1 rows the correct
          // expectation, so the route uses maybeSingle rather than single.
          maybeSingle: vi.fn(async () => ({ data: stageRows[1] ?? null, error: null })),
          then: (onF) => Promise.resolve({ data: stageRows, error: null }).then(onF),
        }
        return builder
      }
      throw new Error(`unexpected table: ${table}`)
    }),
  }
}

const req = (body) => new Request('http://localhost/api/deals/d1', {
  method: 'PUT',
  body: JSON.stringify(body),
  headers: { 'Content-Type': 'application/json' },
})
const props = { params: { id: 'd1' } }

beforeEach(() => {
  vi.clearAllMocks()
  authenticateApiKey.mockResolvedValue({ ok: true, orgId: null })
})

describe('PUT /api/deals/[id] — pipeline_stage_change trigger (STAGETRIG.1)', () => {
  it('fires with the resolved from/to slugs on a real stage move', async () => {
    createServerClient.mockReturnValue(mockDb({
      deal: { location_id: 'loc-1', contact_id: 'c1', stage_id: STAGE_TRIAL },
    }))
    const res = await PUT(req({ stage_id: STAGE_CONV }), props)
    expect(res.status).toBe(200)
    expect(triggerSequencesForDealPlacement).toHaveBeenCalledWith('c1', {
      action: 'move',
      from_slug: 'active_trial',
      to_slug: 'converted',
    })
  })

  it('resolves a stage_slug body the same way', async () => {
    createServerClient.mockReturnValue(mockDb({
      deal: { location_id: 'loc-1', contact_id: 'c1', stage_id: STAGE_TRIAL },
    }))
    await PUT(req({ stage_slug: 'converted' }), props)
    expect(triggerSequencesForDealPlacement).toHaveBeenCalledWith('c1', expect.objectContaining({
      from_slug: 'active_trial', to_slug: 'converted',
    }))
  })

  // The idempotency gate. A PUT that re-sends the stage the deal is
  // already in must enrol nobody — otherwise any client that PUTs the
  // whole object on every save re-triggers the sequence.
  it('does NOT fire when the deal is already in that stage', async () => {
    createServerClient.mockReturnValue(mockDb({
      deal: { location_id: 'loc-1', contact_id: 'c1', stage_id: STAGE_CONV },
    }))
    const res = await PUT(req({ stage_id: STAGE_CONV }), props)
    expect(res.status).toBe(200)
    expect(triggerSequencesForDealPlacement).not.toHaveBeenCalled()
  })

  it('does NOT fire for a non-stage edit', async () => {
    createServerClient.mockReturnValue(mockDb({
      deal: { location_id: 'loc-1', contact_id: 'c1', stage_id: STAGE_TRIAL },
    }))
    await PUT(req({ title: 'Renamed' }), props)
    expect(triggerSequencesForDealPlacement).not.toHaveBeenCalled()
  })

  it('does NOT fire for a deal with no contact', async () => {
    createServerClient.mockReturnValue(mockDb({
      deal: { location_id: 'loc-1', contact_id: null, stage_id: STAGE_TRIAL },
    }))
    await PUT(req({ stage_id: STAGE_CONV }), props)
    expect(triggerSequencesForDealPlacement).not.toHaveBeenCalled()
  })

  it('does NOT fire when the update itself failed', async () => {
    createServerClient.mockReturnValue(mockDb({
      deal: { location_id: 'loc-1', contact_id: 'c1', stage_id: STAGE_TRIAL },
      updateError: { message: 'constraint violation' },
    }))
    const res = await PUT(req({ stage_id: STAGE_CONV }), props)
    expect(res.status).toBe(400)
    expect(triggerSequencesForDealPlacement).not.toHaveBeenCalled()
  })

  it('still returns 200 when the trigger throws', async () => {
    triggerSequencesForDealPlacement.mockRejectedValueOnce(new Error('sequences down'))
    createServerClient.mockReturnValue(mockDb({
      deal: { location_id: 'loc-1', contact_id: 'c1', stage_id: STAGE_TRIAL },
    }))
    const res = await PUT(req({ stage_id: STAGE_CONV }), props)
    expect(res.status).toBe(200)
    expect((await res.json()).success).toBe(true)
  })
})

// DEALSCOPE.1 — the stage lookup was location-blind.
//
// `.eq('slug', …).single()` with no location filter is not a future risk: every
// core slug ALREADY exists on 5 locations (measured live), so `.single()` matches
// 5 rows, PostgREST errors, the error was discarded, `stage` came back null and
// `updates.stage_id` was never set. The caller got a 200 and the deal did not
// move. A silent no-op on a live endpoint, not a cross-tenant read.
//
// `stage_id` had the mirror problem in the other direction: accepted verbatim,
// with nothing checking the stage belonged to the deal's location at all.
describe('PUT /api/deals/[id] — stage lookups are location-scoped (DEALSCOPE.1)', () => {
  it('scopes a stage_slug lookup to the deal own location', async () => {
    const db = mockDb({
      deal: { location_id: 'loc-1', contact_id: 'c1', stage_id: STAGE_TRIAL },
      stageRows: [{ id: STAGE_TRIAL, slug: 'trial_done' }, { id: STAGE_CONV, slug: 'converted' }],
    })
    createServerClient.mockReturnValue(db)

    await PUT(req({ stage_slug: 'converted' }), props)

    const stageBuilder = db.from.mock.results
      .filter((r, i) => db.from.mock.calls[i][0] === 'pipeline_stages')
      .map((r) => r.value)[0]
    const eqCalls = stageBuilder.eq.mock.calls
    expect(eqCalls).toContainEqual(['slug', 'converted'])
    expect(eqCalls).toContainEqual(['location_id', 'loc-1'])
  })

  it('refuses a stage_slug that does not resolve, instead of silently not moving the deal', async () => {
    const db = mockDb({
      deal: { location_id: 'loc-1', contact_id: 'c1', stage_id: STAGE_TRIAL },
      stageRows: [null, null],
    })
    createServerClient.mockReturnValue(db)

    const res = await PUT(req({ stage_slug: 'no_such_stage' }), props)

    expect(res.status).toBe(400)
    // The deal must not be updated at all when the requested stage is unknown.
    expect(db.update).not.toHaveBeenCalled()
  })

  it('refuses a stage_id belonging to another location', async () => {
    const db = mockDb({
      deal: { location_id: 'loc-1', contact_id: 'c1', stage_id: STAGE_TRIAL },
      stageRows: [null, null],   // the id resolves to nothing under loc-1
    })
    createServerClient.mockReturnValue(db)

    const res = await PUT(req({ stage_id: STAGE_CONV }), props)

    expect(res.status).toBe(400)
    expect(db.update).not.toHaveBeenCalled()
  })
})
