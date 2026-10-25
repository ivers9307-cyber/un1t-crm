// src/app/api/schedule/blocks/[id]/offer/route.test.js
// REPLACE.1b — a manager offers a shift to the team: the manager-at-the-
// studio gate, the shared rule, the unique index's 409, the broadcast through
// processOffer and the now / morning answer.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('next/server', async (importOriginal) => ({ ...(await importOriginal()), after: vi.fn((fn) => fn()) }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({})) }))
vi.mock('@/lib/auth', async (importOriginal) => {
  const real = await importOriginal()
  return { getCurrentUser: vi.fn(), assertLocationAccessOr404: real.assertLocationAccessOr404, hasRoleAtLocation: real.hasRoleAtLocation, hasRoleAtAnyLocation: real.hasRoleAtAnyLocation }
})
vi.mock('@/lib/shift-offer-server', () => ({ readOfferBlock: vi.fn(), createOffer: vi.fn(), processOffer: vi.fn(async () => 'sent') }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { readOfferBlock, createOffer, processOffer } = await import('@/lib/shift-offer-server')
const { POST } = await import('./route.js')

const BLOCK_ID = 'b10c0000-0000-4000-8000-000000000001'
const MANAGER = { id: 'mgr', profileRole: 'manager', rolesByLocation: { 'loc-1': 'manager' }, locations: [{ id: 'loc-1' }] }
const BLOCK = { id: BLOCK_ID, location_id: 'loc-1', block_date: '2026-09-29', start_time: '06:00:00', end_time: '07:00:00', min_coaches: 1, max_coaches: 3, rosters: { status: 'published' }, shift_templates: { name: 'Morning', kind: 'class' }, shift_assignments: [], locations: { name: 'Studio North', timezone: 'Europe/Dublin' } }
const call = (id = BLOCK_ID) => POST({ json: () => Promise.resolve({}), headers: { get: () => '' } }, { params: Promise.resolve({ id }) })

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-09-28T10:00:00Z') })
  getCurrentUser.mockResolvedValue(MANAGER)
  readOfferBlock.mockResolvedValue({ block: BLOCK, error: null })
  createOffer.mockResolvedValue({ offer: { id: 'o1', status: 'open', location_id: 'loc-1', block_id: BLOCK_ID, notice_attempts: 0, shift_blocks: BLOCK, locations: BLOCK.locations } })
})
afterEach(() => vi.useRealTimers())

describe('POST /api/schedule/blocks/[id]/offer', () => {
  it('gates: 401, 403 manages nowhere, 404 malformed / unknown / foreign, 403 staff there', async () => {
    getCurrentUser.mockResolvedValue(null); expect((await call()).status).toBe(401)
    getCurrentUser.mockResolvedValue({ ...MANAGER, rolesByLocation: { 'loc-1': 'staff' }, profileRole: 'staff' }); expect((await call()).status).toBe(403)
    getCurrentUser.mockResolvedValue(MANAGER); expect((await call('nope')).status).toBe(404)
    readOfferBlock.mockResolvedValue({ block: null, error: null }); expect((await call()).status).toBe(404)
    readOfferBlock.mockResolvedValue({ block: BLOCK, error: null })
    getCurrentUser.mockResolvedValue({ ...MANAGER, rolesByLocation: { 'loc-9': 'manager' }, locations: [{ id: 'loc-9' }] }); expect((await call()).status).toBe(404)
    getCurrentUser.mockResolvedValue({ ...MANAGER, rolesByLocation: { 'loc-1': 'staff', 'loc-2': 'manager' }, profileRole: 'staff', locations: [{ id: 'loc-1' }, { id: 'loc-2' }] }); expect((await call()).status).toBe(403)
    expect(createOffer).not.toHaveBeenCalled()
  })
  it('an unreadable shift is a 500', async () => {
    readOfferBlock.mockResolvedValue({ block: null, error: { message: 'down' } })
    expect((await call()).status).toBe(500)
  })
  it('the shared rule refuses: a draft, a staffed shift, a past one, a started one (409 with the words)', async () => {
    readOfferBlock.mockResolvedValue({ block: { ...BLOCK, rosters: { status: 'draft' } }, error: null })
    let res = await call(); expect(res.status).toBe(409); expect((await res.json()).code).toBe('not_published')
    readOfferBlock.mockResolvedValue({ block: { ...BLOCK, shift_assignments: [{ profile_id: 'x', status: 'scheduled' }] }, error: null })
    expect((await (await call()).json()).code).toBe('staffed')
    readOfferBlock.mockResolvedValue({ block: { ...BLOCK, block_date: '2026-09-27' }, error: null })
    expect((await (await call()).json()).code).toBe('past')
    readOfferBlock.mockResolvedValue({ block: BLOCK, error: null })
    vi.setSystemTime(Date.parse('2026-09-29T05:00:00Z'))
    res = await call()
    expect(await res.json()).toMatchObject({ code: 'started', error: 'This shift has already started.' })
    expect(createOffer).not.toHaveBeenCalled()
  })
  it('already offered (the unique index) is 409', async () => {
    createOffer.mockResolvedValue({ code: 'already_offered' })
    const res = await call(); expect(res.status).toBe(409); expect((await res.json()).code).toBe('already_offered')
    expect(processOffer).not.toHaveBeenCalled()
  })
  it('a failed insert is a 500, nothing broadcast', async () => {
    createOffer.mockResolvedValue({ error: { message: 'x' } })
    expect((await call()).status).toBe(500)
    expect(processOffer).not.toHaveBeenCalled()
  })
  it('201: the offer exists at once; the broadcast goes through processOffer; notice now / morning', async () => {
    const res = await call()
    expect(res.status).toBe(201)
    expect((await res.json()).data).toEqual({ offer_id: 'o1', notice: 'now' })
    expect(createOffer).toHaveBeenCalledWith(expect.anything(), { block: BLOCK, actorId: 'mgr' })
    expect(processOffer).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 'o1' }), { nowMs: Date.parse('2026-09-28T10:00:00Z') })
    vi.setSystemTime(Date.parse('2026-09-28T22:30:00Z'))
    expect((await (await call()).json()).data.notice).toBe('morning')
  })
  it('a failed broadcast never fails the offer', async () => {
    processOffer.mockRejectedValueOnce(new Error('push down'))
    expect((await call()).status).toBe(201)
  })
})
