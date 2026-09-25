// src/app/api/schedule/offers/route.test.js
// REPLACE.1b — the coach's list (default 6, when/what/where only) and the
// manager's (view=manage, the notice state).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({})) }))
vi.mock('@/lib/auth', async (importOriginal) => {
  const real = await importOriginal()
  return { getCurrentUser: vi.fn(), assertLocationAccess: real.assertLocationAccess, hasRoleAtLocation: real.hasRoleAtLocation }
})
vi.mock('@/lib/shift-offer-server', () => ({ listOpenOffers: vi.fn() }))
vi.mock('@/lib/candidates-data', () => ({ loadBlockCandidates: vi.fn() }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { listOpenOffers } = await import('@/lib/shift-offer-server')
const { loadBlockCandidates } = await import('@/lib/candidates-data')
const { GET } = await import('./route.js')

const COACH = { id: 'c1', profileRole: 'staff', rolesByLocation: { 'loc-1': 'staff' }, locations: [{ id: 'loc-1' }] }
const MANAGER = { ...COACH, id: 'mgr', profileRole: 'manager', rolesByLocation: { 'loc-1': 'manager' } }
const B = (over = {}) => ({ id: 'b1', block_date: '2026-09-29', start_time: '06:00:00', end_time: '07:00:00', min_coaches: 1, max_coaches: 3, rosters: { status: 'published' }, shift_templates: { name: 'Morning', kind: 'class' }, shift_assignments: [], ...over })
const O = (id, block, over = {}) => ({ id, location_id: 'loc-1', block_id: block.id, status: 'open', created_at: 'c', broadcast_at: null, broadcast_count: null, shift_blocks: block, locations: { name: 'Studio North', timezone: 'Europe/Dublin' }, ...over })
const CHECKED = { shifts: true, cross_studio: true, leave: true, availability: true }
const FOR_ME = { error: null, checked: CHECKED, candidates: [{ profile_id: 'c1', tier: 'ready' }] }
const call = (qs) => GET({ url: `https://x/api/schedule/offers?${qs}`, headers: { get: () => '' } })

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-09-28T10:00:00Z') })
  getCurrentUser.mockResolvedValue(COACH)
  loadBlockCandidates.mockResolvedValue(FOR_ME)
  listOpenOffers.mockResolvedValue({ offers: [], error: null })
})
afterEach(() => vi.useRealTimers())

describe('GET /api/schedule/offers — coach view', () => {
  it('401 signed out; 400 without a studio; 403 for a studio that is not yours (nothing read)', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await call('location_id=loc-1')).status).toBe(401)
    getCurrentUser.mockResolvedValue(COACH)
    expect((await call('')).status).toBe(400)
    expect((await call('location_id=loc-9')).status).toBe(403)
    expect(listOpenOffers).not.toHaveBeenCalled()
  })
  it('reads only the caller\'s studio', async () => {
    await call('location_id=loc-1')
    expect(listOpenOffers).toHaveBeenCalledWith(expect.anything(), { locationId: 'loc-1' })
  })
  it('only offers that still need someone, have not started and are for the caller (default 6): when, what, where', async () => {
    listOpenOffers.mockResolvedValue({ offers: [
      O('o1', B()),
      O('o2', B({ id: 'b2', shift_assignments: [{ profile_id: 'x', status: 'scheduled' }] })), // filled
      O('o3', B({ id: 'b3', block_date: '2026-09-27' })),                                   // started
      O('o4', B({ id: 'b4', rosters: { status: 'draft' } })),                                // unpublished
    ], error: null })
    const body = await (await call('location_id=loc-1')).json()
    expect(body.data).toEqual([{ id: 'o1', block_id: 'b1', block_date: '2026-09-29', start_time: '06:00:00', end_time: '07:00:00', shift_name: 'Morning', studio_name: 'Studio North' }])
    expect(JSON.stringify(body.data)).not.toMatch(/min_coaches|max_coaches|broadcast/)
    expect(loadBlockCandidates).toHaveBeenCalledTimes(1)
    expect(loadBlockCandidates).toHaveBeenCalledWith(expect.anything(), { block: expect.objectContaining({ id: 'b1', location_id: 'loc-1' }), audience: 'manager' })
  })
  it('not for someone busy, on leave or unavailable then; an unreadable check still SHOWS it (the claim re-checks)', async () => {
    listOpenOffers.mockResolvedValue({ offers: [O('o1', B())], error: null })
    for (const tier of ['blocked', 'unavailable']) {
      loadBlockCandidates.mockResolvedValue({ ...FOR_ME, candidates: [{ profile_id: 'c1', tier }] })
      expect((await (await call('location_id=loc-1')).json()).data).toEqual([])
    }
    loadBlockCandidates.mockResolvedValue({ error: { message: 'down' } })
    expect((await (await call('location_id=loc-1')).json()).data).toHaveLength(1)
  })
  it('an unreadable offer list is a 500, never an empty list', async () => {
    listOpenOffers.mockResolvedValue({ offers: [], error: { message: 'down' } })
    expect((await call('location_id=loc-1')).status).toBe(500)
  })
})

describe('GET /api/schedule/offers — manager view', () => {
  it('403 for a coach; a manager gets the period\'s open offers with their notice state', async () => {
    listOpenOffers.mockResolvedValue({ offers: [O('o1', B()), O('o9', B({ id: 'b9', block_date: '2026-10-20' }))], error: null })
    expect((await call('location_id=loc-1&view=manage&start_date=2026-09-28&end_date=2026-10-04')).status).toBe(403)
    getCurrentUser.mockResolvedValue(MANAGER)
    const body = await (await call('location_id=loc-1&view=manage&start_date=2026-09-28&end_date=2026-10-04')).json()
    expect(body.data).toEqual([{ id: 'o1', block_id: 'b1', block_date: '2026-09-29', created_at: 'c', notice_state: 'sending', broadcast_count: 0 }])
    expect(loadBlockCandidates).not.toHaveBeenCalled()
  })
  it('refuses a date the calendar does not have (DATECHECK.1)', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    expect((await call('location_id=loc-1&view=manage&start_date=2026-02-30&end_date=2026-03-04')).status).toBe(400)
  })
})
