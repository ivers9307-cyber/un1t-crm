// DEALSCOPE.2 — POST /api/deals had the same location-blind stage lookup that
// #1357 (DEALSCOPE.1) fixed on PUT /api/deals/[id]:
//
//   .eq('slug', body.stage_slug).single()   // error discarded
//
// Every core slug already exists on FIVE locations (measured live in #1357), so
// the query matched five rows, PostgREST errored, the error was thrown away, and
// `stageId` stayed undefined. The deal was then created with NO STAGE at all and
// the caller got a success — worse on POST than on PUT, because a stageless deal
// never appears on the board the caller expects to see it on.
//
// `stage_id` had the mirror problem: taken verbatim, with nothing checking the
// stage belonged to this deal's location. Same fix as the sibling — both resolve
// through one location-scoped lookup, and an unresolvable stage is a 400.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/api-auth', () => ({
  authenticateApiKey: vi.fn(),
  orgLocationIds: vi.fn(async () => []),
}))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

import { POST } from './route.js'
import { authenticateApiKey } from '@/lib/api-auth'
import { createServerClient } from '@/lib/supabase'

// Real UUIDs — contact_id / stage_id go through the uuidLike Zod block.
const CONTACT = '33333333-3333-3333-3333-333333333333'
const STAGE_CONV = '22222222-2222-2222-2222-222222222222'
const LOC_2 = '44444444-4444-4444-4444-444444444444'

/**
 * Minimal chainable double. `contact` is the row the contact-location read
 * returns; `stage` is what the location-scoped pipeline_stages lookup resolves
 * to (null = "no such stage for this location").
 */
function mockDb({
  contact = { location_id: 'loc-1' },
  stage = { id: STAGE_CONV, pipeline_id: 'p-acq' },
  // PIPELINES.5 — the deal's location's boards. Only read on the STAGELESS
  // path, where there is no stage to take the board off; a resolved stage
  // carries its own pipeline_id and this is never queried.
  pipelines = [{ id: 'p-acq', mode: 'derived' }],
} = {}) {
  const insert = vi.fn(() => ({
    select: vi.fn(() => ({ single: vi.fn(async () => ({ data: { id: 'd1' }, error: null })) })),
  }))
  const stageBuilders = []
  const from = vi.fn((table) => {
    if (table === 'contacts') {
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({ maybeSingle: vi.fn(async () => ({ data: contact, error: null })) })),
        })),
      }
    }
    if (table === 'pipeline_stages') {
      const builder = {
        select: vi.fn(() => builder),
        eq: vi.fn(() => builder),
        maybeSingle: vi.fn(async () => ({ data: stage, error: null })),
      }
      stageBuilders.push(builder)
      return builder
    }
    if (table === 'deals') return { insert }
    if (table === 'pipelines') {
      const builder = {
        select: vi.fn(() => builder),
        eq: vi.fn(() => builder),
        limit: vi.fn(async () => ({ data: pipelines, error: null })),
      }
      return builder
    }
    throw new Error(`unexpected table: ${table}`)
  })
  return { from, insert, stageBuilders }
}

const req = (body) => new Request('http://localhost/api/deals', {
  method: 'POST',
  body: JSON.stringify(body),
  headers: { 'Content-Type': 'application/json' },
})

beforeEach(() => {
  vi.clearAllMocks()
  authenticateApiKey.mockResolvedValue({ ok: true, orgId: null })
})

describe('POST /api/deals — stage lookups are location-scoped (DEALSCOPE.2)', () => {
  it('scopes a stage_slug lookup to the contact own location', async () => {
    const db = mockDb()
    createServerClient.mockReturnValue(db)

    const res = await POST(req({ title: 'T', contact_id: CONTACT, stage_slug: 'converted' }))

    expect(res.status).toBe(200)
    const eqCalls = db.stageBuilders[0].eq.mock.calls
    expect(eqCalls).toContainEqual(['slug', 'converted'])
    expect(eqCalls).toContainEqual(['location_id', 'loc-1'])
    // and the resolved stage actually reaches the insert
    expect(db.insert.mock.calls[0][0].stage_id).toBe(STAGE_CONV)
    // PIPELINES.5 — with it, the board the stage belongs to. A null
    // pipeline_id is invisible to the nightly orchestrator's
    // `.in('pipeline_id', …)` read, which then opens a duplicate deal for
    // this contact every night.
    expect(db.insert.mock.calls[0][0].pipeline_id).toBe('p-acq')
  })

  it('anchors on an explicit location_id when one is supplied', async () => {
    const db = mockDb({ contact: { location_id: 'loc-1' } })
    createServerClient.mockReturnValue(db)

    await POST(req({
      title: 'T', contact_id: CONTACT, stage_slug: 'converted', location_id: LOC_2,
    }))

    expect(db.stageBuilders[0].eq.mock.calls).toContainEqual(['location_id', LOC_2])
  })

  it('refuses an unresolvable slug with a 400 and creates NO deal', async () => {
    const db = mockDb({ stage: null })
    createServerClient.mockReturnValue(db)

    const res = await POST(req({ title: 'T', contact_id: CONTACT, stage_slug: 'nope' }))

    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('unknown_stage_for_location')
    // the old code created a STAGELESS deal here and returned success
    expect(db.insert).not.toHaveBeenCalled()
  })

  it('refuses a stage_id belonging to another location', async () => {
    const db = mockDb({ stage: null })
    createServerClient.mockReturnValue(db)

    const res = await POST(req({ title: 'T', contact_id: CONTACT, stage_id: STAGE_CONV }))

    expect(res.status).toBe(400)
    expect(db.insert).not.toHaveBeenCalled()
  })

  it('leaves a stageless create alone — no stage requested, no lookup', async () => {
    const db = mockDb()
    createServerClient.mockReturnValue(db)

    const res = await POST(req({ title: 'T', contact_id: CONTACT }))

    expect(res.status).toBe(200)
    expect(db.stageBuilders).toHaveLength(0)
    // PIPELINES.5 — stageless, but NOT boardless: with no stage to read the
    // board off, the deal takes its location's primary one. A null here is the
    // nightly-duplication bug.
    expect(db.insert.mock.calls[0][0].pipeline_id).toBe('p-acq')
  })
})
