// GET /api/churn-radar/winback through the real withAuth wrapper: churn_radar
// at the active studio, which must be set; the data is the active studio's.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { person, LOC_A, LOC_B } from '../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({ tag: 'db' })) }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))
vi.mock('@/lib/radar-cache', () => ({ radarCache: vi.fn((_k, _l, _s, fn) => fn()) }))
vi.mock('@/lib/radar-availability', async (importOriginal) => ({ ...(await importOriginal()), radarAvailability: vi.fn() }))
vi.mock('@/lib/churn-radar-data', () => ({ loadWinback: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { radarAvailability } = await import('@/lib/radar-availability')
const { loadWinback } = await import('@/lib/churn-radar-data')
const { GET } = await import('./route.js')

const get = () => GET(new Request('http://localhost/api/churn-radar/winback'))
const withKey = (on, active = LOC_A) => person({ [LOC_A]: { role: 'owner', permissions: { churn_radar: on } }, [LOC_B]: { role: 'owner', permissions: { churn_radar: !on } } }, active)

beforeEach(() => {
  vi.clearAllMocks()
  radarAvailability.mockResolvedValue({ available: true, source: 'glofox', dataAsOf: '2026-11-20T08:00:00Z' })
  loadWinback.mockResolvedValue([{ contactId: 'c1' }])
})

describe('GET /api/churn-radar/winback', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await get()).status).toBe(401)
  })

  it('403 without churn_radar at the active studio (held elsewhere does not count), nothing read', async () => {
    getCurrentUser.mockResolvedValue(withKey(false))
    const res = await get()
    expect(res.status).toBe(403)
    expect(loadWinback).not.toHaveBeenCalled()
  })

  it('400 with no active studio', async () => {
    getCurrentUser.mockResolvedValue({ ...withKey(true), activeLocation: null })
    expect((await get()).status).toBe(400)
  })

  it('an allowed caller gets the active studio\'s rows in the same shape', async () => {
    getCurrentUser.mockResolvedValue(withKey(true))
    const res = await get()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: [{ contactId: 'c1' }], source: 'glofox', dataAsOf: '2026-11-20T08:00:00Z', outreachAvailable: null })
    expect(radarAvailability).toHaveBeenCalledWith({ tag: 'db' }, LOC_A, { module: 'churn-radar', withOutreach: true })
    expect(loadWinback).toHaveBeenCalledWith({ tag: 'db' }, LOC_A)
  })

  it('a failed read is a 500 without the error text', async () => {
    getCurrentUser.mockResolvedValue(withKey(true))
    loadWinback.mockRejectedValue(new Error('secret detail'))
    const res = await get()
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'fetch_failed' })
  })
})
