// HATCHPIPE.2 — GET /api/pipeline/deals ("Load more"): the board read that
// decides the next-class badge. A un1t.online board has no Glofox bookings, so
// no badge; an unreadable board keeps the badge (today's behaviour) rather
// than failing the whole page. Only supabase/auth/log are faked.

import { describe, it, expect, vi, beforeEach } from 'vitest'

let db
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/permissions', () => ({ hasPermission: vi.fn(() => true) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))

import { GET } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { logWarn } from '@/lib/log'

const LOC = 'loc-1'
const STAGE = 'stage-1'
const PIPELINE = 'pipe-1'
const req = () => new Request(`http://localhost/api/pipeline/deals?stage_id=${STAGE}`)

const futureBooking = () => ({ status: 'BOOKED', time_start: Math.floor(Date.now() / 1000) + 86400 })
const dealRow = () => ({
  id: 'd1', title: 'Deal', stage_id: STAGE, created_at: '2026-10-01T00:00:00Z', stage_entered_at: '2026-10-01T00:00:00Z',
  contacts: { id: 'c1', name: 'Pat', lead_source: null, pipeline_stage_slug: 'new_lead', trial_credits_remaining: 0, recent_bookings: [futureBooking()] },
})

// Minimal chainable fake: every builder method returns itself and the chain
// resolves (or maybeSingle()s) to the table's canned result.
function fakeDb(results) {
  return {
    from(table) {
      const r = results[table]
      const chain = {
        select: () => chain, eq: () => chain, order: () => chain, range: () => chain,
        maybeSingle: async () => r,
        then: (res, rej) => Promise.resolve(r).then(res, rej),
      }
      return chain
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue({ activeLocation: { id: LOC } })
})

const setup = (pipelinesResult) => {
  db = fakeDb({
    pipeline_stages: { data: { id: STAGE, pipeline_id: PIPELINE }, error: null },
    pipelines: pipelinesResult,
    deals: { data: [dealRow()], error: null },
  })
}

describe('GET /api/pipeline/deals — next-class badge by board module', () => {
  it('a un1t.online board (acquisition_un1t) carries no next_class_at', async () => {
    setup({ data: { module: 'acquisition_un1t' }, error: null })
    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.deals[0].contacts.next_class_at).toBeNull()
  })

  it('a Glofox board (acquisition) keeps next_class_at', async () => {
    setup({ data: { module: 'acquisition' }, error: null })
    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.deals[0].contacts.next_class_at).not.toBeNull()
  })

  it('an unreadable board read fails open: 200, badge kept, ids-only warning', async () => {
    setup({ data: null, error: { message: 'boom: secret detail' } })
    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.deals[0].contacts.next_class_at).not.toBeNull()
    expect(logWarn).toHaveBeenCalledTimes(1)
    expect(logWarn).toHaveBeenCalledWith('pipeline-deals', 'board read failed; badge kept', { stageId: STAGE, locationId: LOC })
  })
})
