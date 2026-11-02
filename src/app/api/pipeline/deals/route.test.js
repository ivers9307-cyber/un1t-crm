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
vi.mock('@/lib/pipeline-card-signals', async (importOriginal) => ({ ...(await importOriginal()), loadUn1tCardSignals: vi.fn() }))

import { GET } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { logWarn } from '@/lib/log'
import { loadUn1tCardSignals } from '@/lib/pipeline-card-signals'

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

describe('GET /api/pipeline/deals — Glofox credit count by board module (HATCHPIPE.3)', () => {
  it('a un1t.online board (acquisition_un1t) card carries no trial_credits_remaining', async () => {
    setup({ data: { module: 'acquisition_un1t' }, error: null })
    const body = await (await GET(req())).json()
    expect(body.deals[0].contacts).not.toHaveProperty('trial_credits_remaining')
  })

  it('a Glofox board (acquisition) card keeps trial_credits_remaining', async () => {
    setup({ data: { module: 'acquisition' }, error: null })
    const body = await (await GET(req())).json()
    expect(body.deals[0].contacts.trial_credits_remaining).toBe(0)
  })
})

// HATCHCARD.1 — a Load-more page carries the same signals as the board's first
// page: un1t board, active view, a live funnel column.
describe('GET /api/pipeline/deals — un1t card signals (HATCHCARD.1)', () => {
  const SIG = { classes_attended: 1, credits_left: 2, credits_unlimited: false, next_class_at: null, last_class_days: 1, last_class_warm: false, wa_state: 'never', wa_days: null }
  const withStage = (slug, module) => {
    db = fakeDb({
      pipeline_stages: { data: { id: STAGE, pipeline_id: PIPELINE, slug }, error: null },
      pipelines: { data: { module }, error: null },
      deals: { data: [dealRow()], error: null },
    })
  }
  beforeEach(() => { loadUn1tCardSignals.mockReset(); loadUn1tCardSignals.mockResolvedValue({ signals: new Map([['c1', SIG]]) }) })

  it('a un1t board\'s live column: the page\'s contacts are read once and each card carries its signals', async () => {
    withStage('new_lead', 'acquisition_un1t')
    const body = await (await GET(req())).json()
    expect(loadUn1tCardSignals).toHaveBeenCalledTimes(1)
    expect(loadUn1tCardSignals.mock.calls[0][1]).toMatchObject({ locationId: LOC, contactIds: ['c1'] })
    expect(body.deals[0].signals).toEqual(SIG)
  })
  it('a Glofox board, a pile column, or the dormant view: no read and no signals key', async () => {
    withStage('new_lead', 'acquisition')
    expect('signals' in (await (await GET(req())).json()).deals[0]).toBe(false)
    withStage('dormant', 'acquisition_un1t')
    expect('signals' in (await (await GET(req())).json()).deals[0]).toBe(false)
    withStage('new_lead', 'acquisition_un1t')
    const dormantReq = new Request(`http://localhost/api/pipeline/deals?stage_id=${STAGE}&view=dormant`)
    expect('signals' in (await (await GET(dormantReq)).json()).deals[0]).toBe(false)
    expect(loadUn1tCardSignals).not.toHaveBeenCalled()
  })
  it('a failed signals read still answers 200 with the cards, ids-only warning', async () => {
    withStage('new_lead', 'acquisition_un1t')
    loadUn1tCardSignals.mockResolvedValue({ error: { message: 'boom' } })
    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.deals).toHaveLength(1)
    expect('signals' in body.deals[0]).toBe(false)
    expect(logWarn).toHaveBeenCalledWith('pipeline-deals', expect.stringMatching(/signals/), expect.objectContaining({ stageId: STAGE, locationId: LOC }))
  })
})
