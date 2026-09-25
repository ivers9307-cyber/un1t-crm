// src/app/api/schedule/offers/[id]/claim/route.test.js
// REPLACE.1b — a coach claims an offered shift: member of the studio (404
// otherwise), open, not started, not on leave or on another shift (CANDIDATES.1's
// facts); the database lock decides between two claimers; the log row is
// stamped (a self change tells nobody); the managers' "taken" notice goes
// through processOffer.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, after: vi.fn((fn) => fn()) }
})
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({})) }))
vi.mock('@/lib/auth', async (importOriginal) => {
  const real = await importOriginal()
  return { getCurrentUser: vi.fn(), assertLocationAccessOr404: real.assertLocationAccessOr404 }
})
vi.mock('@/lib/shift-offer-server', () => ({ readOffer: vi.fn(), claimOffer: vi.fn(), processOffer: vi.fn(async () => 'sent') }))
vi.mock('@/lib/candidates-data', () => ({ loadBlockCandidates: vi.fn() }))
vi.mock('@/lib/roster-change-log', () => ({ logRosterChange: vi.fn(async () => ({ logged: true, id: 'log-1' })), markChangesNotified: vi.fn(async () => {}) }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { readOffer, claimOffer, processOffer } = await import('@/lib/shift-offer-server')
const { loadBlockCandidates } = await import('@/lib/candidates-data')
const { logRosterChange, markChangesNotified } = await import('@/lib/roster-change-log')
const { POST } = await import('./route.js')

const OFFER_ID = '0ffe0000-0000-4000-8000-000000000001'
const COACH = { id: 'c1', full_name: 'Coach B', profileRole: 'staff', rolesByLocation: { 'loc-1': 'staff' }, locations: [{ id: 'loc-1' }] }
const BLOCK = { id: 'b1', location_id: 'loc-1', block_date: '2026-09-29', start_time: '06:00:00', end_time: '07:00:00', min_coaches: 1, max_coaches: 3, rosters: { status: 'published' }, shift_templates: { name: 'Morning', kind: 'class' }, shift_assignments: [] }
const OFFER = { id: OFFER_ID, location_id: 'loc-1', block_id: 'b1', status: 'open', offered_by: 'mgr', notice_attempts: 0, notice_lease_until: null, shift_blocks: BLOCK, locations: { name: 'Studio North', timezone: 'Europe/Dublin' } }
const CHECKED = { shifts: true, cross_studio: true, leave: true, availability: true }
const answer = (me) => ({ error: null, checked: CHECKED, candidates: [{ profile_id: 'c1', tier: 'ready', free: true, ...me }] })
const call = (id = OFFER_ID) => POST({ json: () => Promise.resolve({}), headers: { get: () => '' } }, { params: Promise.resolve({ id }) })

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-09-28T10:00:00Z') })
  getCurrentUser.mockResolvedValue(COACH)
  readOffer.mockResolvedValue({ offer: OFFER, error: null })
  loadBlockCandidates.mockResolvedValue(answer())
  claimOffer.mockResolvedValue({ result: { outcome: 'claimed', assignment_id: 'as-9', block_date: '2026-09-29' }, error: null })
})
afterEach(() => vi.useRealTimers())

describe('POST /api/schedule/offers/[id]/claim', () => {
  it('401 signed out; 404 malformed or unknown offer; 404 for someone who is not at the studio (never confirms the id)', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await call()).status).toBe(401)
    getCurrentUser.mockResolvedValue(COACH)
    expect((await call('nope')).status).toBe(404)
    expect(readOffer).not.toHaveBeenCalled()
    readOffer.mockResolvedValue({ offer: null, error: null })
    expect((await call()).status).toBe(404)
    readOffer.mockResolvedValue({ offer: OFFER, error: null })
    getCurrentUser.mockResolvedValue({ ...COACH, locations: [{ id: 'loc-9' }] })
    expect((await call()).status).toBe(404)
    expect(claimOffer).not.toHaveBeenCalled()
  })

  it('an unreadable offer is a 500, not a 404', async () => {
    readOffer.mockResolvedValue({ offer: null, error: { message: 'down' } })
    expect((await call()).status).toBe(500)
  })

  it('a closed offer is 409 in words a coach understands', async () => {
    readOffer.mockResolvedValue({ offer: { ...OFFER, status: 'claimed' }, error: null })
    const res = await call()
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('Someone else has just taken this shift.')
  })

  it('a started shift is 409, nothing claimed', async () => {
    vi.setSystemTime(Date.parse('2026-09-29T05:00:00Z'))
    expect((await call()).status).toBe(409)
    expect(claimOffer).not.toHaveBeenCalled()
  })

  it('on leave or on another shift at that time (CANDIDATES.1\'s facts): refused before the database is asked', async () => {
    loadBlockCandidates.mockResolvedValue(answer({ tier: 'blocked', on_leave: { type: 'holiday' } }))
    let res = await call()
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/approved leave/)
    loadBlockCandidates.mockResolvedValue(answer({ tier: 'blocked', free: false }))
    res = await call()
    expect((await res.json()).error).toMatch(/another shift/)
    expect(claimOffer).not.toHaveBeenCalled()
    expect(loadBlockCandidates).toHaveBeenCalledWith(expect.anything(), { block: { ...BLOCK, location_id: 'loc-1' }, audience: 'manager' })
  })

  it('already on the shift is 409; a member the candidates do not list is 403', async () => {
    readOffer.mockResolvedValue({ offer: { ...OFFER, shift_blocks: { ...BLOCK, shift_assignments: [{ profile_id: 'c1', status: 'scheduled' }] } }, error: null })
    loadBlockCandidates.mockResolvedValue({ error: null, checked: CHECKED, candidates: [] })
    expect((await call()).status).toBe(409)
    readOffer.mockResolvedValue({ offer: OFFER, error: null })
    expect((await call()).status).toBe(403)
  })

  it('unavailability does NOT block a claim (claiming says you are free)', async () => {
    loadBlockCandidates.mockResolvedValue(answer({ tier: 'unavailable', unavailable: { summary: 'all day' } }))
    expect((await call()).status).toBe(200)
  })

  it('an unreadable check is 503 (try again), never a claim on a guess', async () => {
    loadBlockCandidates.mockResolvedValue({ error: { message: 'down' } })
    expect((await call()).status).toBe(503)
    loadBlockCandidates.mockResolvedValue({ ...answer(), checked: { ...CHECKED, leave: false } })
    expect((await call()).status).toBe(503)
    expect(claimOffer).not.toHaveBeenCalled()
  })

  it('the second of two claimers gets the lock\'s answer', async () => {
    claimOffer.mockResolvedValue({ result: null, error: { code: 'P0001', message: 'offer_not_open: offer is already claimed' } })
    const res = await call()
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('Someone else has just taken this shift.')
    expect(logRosterChange).not.toHaveBeenCalled()
    expect(processOffer).not.toHaveBeenCalled()
  })

  it('an unexpected RPC failure is a logged 500', async () => {
    claimOffer.mockResolvedValue({ result: null, error: { code: 'XX000', message: 'boom' } })
    expect((await call()).status).toBe(500)
  })

  it('filled meanwhile: 409 "no longer needs cover"', async () => {
    claimOffer.mockResolvedValue({ result: { outcome: 'filled', offer_id: OFFER_ID }, error: null })
    const res = await call()
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('This shift no longer needs cover.')
  })

  it('claimed: one log row (via offer), stamped at once (nobody to tell), then the managers\' notice', async () => {
    const res = await call()
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ assignment_id: 'as-9', block_date: '2026-09-29' })
    expect(claimOffer).toHaveBeenCalledWith(expect.anything(), { offerId: OFFER_ID, profileId: 'c1' })
    expect(logRosterChange).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      isPublished: true, locationId: 'loc-1', blockId: 'b1', blockDate: '2026-09-29', actorId: 'c1', coachId: 'c1', action: 'assigned', details: { via: 'offer' },
    }))
    expect(markChangesNotified).toHaveBeenCalledWith(expect.anything(), ['log-1'])
    expect(processOffer).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      id: OFFER_ID, status: 'claimed', claimed_by: 'c1', taken_notified_at: null, notice_attempts: 0, claimer: { full_name: 'Coach B' },
    }), { nowMs: Date.parse('2026-09-28T10:00:00Z') })
  })

  it('a log row that was not written is not stamped, and the claim still stands', async () => {
    logRosterChange.mockResolvedValueOnce({ logged: false, reason: 'error' })
    expect((await call()).status).toBe(200)
    expect(markChangesNotified).not.toHaveBeenCalled()
  })

  it('a failed "taken" notice never fails the claim', async () => {
    processOffer.mockRejectedValueOnce(new Error('push down'))
    expect((await call()).status).toBe(200)
  })
})
