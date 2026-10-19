// UN1TRADAR.1 — every radar read API answers data:null while the location's
// provider lacks the memberships capability, before the cache or any row read;
// otherwise `data` is unchanged and `source` / `dataAsOf` sit BESIDE it.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/permissions', () => ({ hasPermission: vi.fn(() => true), hasMobilePermission: vi.fn(() => true) }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({ tag: 'db' })) }))
vi.mock('@/lib/radar-cache', () => ({ radarCache: vi.fn((_k, _l, _s, fn) => fn()), invalidateRadar: vi.fn() }))
vi.mock('@/lib/radar-availability', async (importOriginal) => {
  const real = await importOriginal()
  return { ...real, radarAvailability: vi.fn() }
})
vi.mock('@/lib/churn-radar-data', () => ({
  loadRadar: vi.fn(async () => ({ radar: [{ contactId: 'c1' }], summary: { activeBase: 1 } })),
  loadWinback: vi.fn(async () => ({ winback: [], summary: { total: 0 } })),
  loadOverdue: vi.fn(async () => ({ overdue: [], summary: { total: 0 } })),
  loadUnpaidCharges: vi.fn(async () => ({ charges: [], summary: { total: 0 } })),
  loadAwaitingAuth: vi.fn(async () => ({ charges: [], summary: { total: 0 } })),
  loadQuarantine: vi.fn(async () => []),
}))
vi.mock('@/lib/lead-radar-data', () => ({
  loadFunnel: vi.fn(async () => ({ funnel: [], summary: { funnelTotal: 0 } })),
  loadClassPass: vi.fn(async () => ({ classpass: [], summary: {} })),
  loadCleanup: vi.fn(async () => ({ cleanup: [], summary: {} })),
}))

import { getCurrentUser } from '@/lib/auth'
import { radarCache } from '@/lib/radar-cache'
import { radarAvailability } from '@/lib/radar-availability'
import * as churnData from '@/lib/churn-radar-data'
import * as leadData from '@/lib/lead-radar-data'
import { GET as churnGET } from './route'
import { GET as winbackGET } from './winback/route'
import { GET as overdueGET } from './overdue/route'
import { GET as unpaidGET } from './unpaid-charges/route'
import { GET as awaitingGET } from './awaiting-authorization/route'
import { GET as quarantineGET } from './quarantine/route'
import { GET as leadGET } from '../lead-radar/route'
import { GET as classpassGET } from '../lead-radar/classpass/route'
import { GET as cleanupGET } from '../lead-radar/cleanup/route'

const L = 'loc-1'
const req = (path) => new Request(`http://localhost${path}`)
const ROUTES = [
  ['churn-radar', churnGET, '/api/churn-radar', 'loadRadar', churnData],
  ['winback', winbackGET, '/api/churn-radar/winback', 'loadWinback', churnData],
  ['overdue', overdueGET, '/api/churn-radar/overdue', 'loadOverdue', churnData],
  ['unpaid-charges', unpaidGET, '/api/churn-radar/unpaid-charges', 'loadUnpaidCharges', churnData],
  ['awaiting-authorization', awaitingGET, '/api/churn-radar/awaiting-authorization', 'loadAwaitingAuth', churnData],
  ['quarantine', quarantineGET, '/api/churn-radar/quarantine', 'loadQuarantine', churnData],
  ['lead-radar', leadGET, '/api/lead-radar', 'loadFunnel', leadData],
  ['classpass', classpassGET, '/api/lead-radar/classpass', 'loadClassPass', leadData],
  ['cleanup', cleanupGET, '/api/lead-radar/cleanup', 'loadCleanup', leadData],
]

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue({ id: 'u1', activeLocation: { id: L }, profileRole: 'master', rolesByLocation: { [L]: 'owner' } })
})

describe('radar read APIs and the memberships capability', () => {
  for (const [name, GET, path, loader, mod] of ROUTES) {
    it(`${name}: capability false → { success:true, data:null, unavailable:"memberships" }, no cache, no read`, async () => {
      radarAvailability.mockResolvedValue({ available: false, source: 'un1t_online', dataAsOf: null })
      const res = await GET(req(path))
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ success: true, data: null, unavailable: 'memberships' })
      expect(radarAvailability).toHaveBeenCalledTimes(1)
      expect(radarAvailability.mock.calls[0][1]).toBe(L)
      expect(radarCache).not.toHaveBeenCalled()
      expect(mod[loader]).not.toHaveBeenCalled()
    })

    it(`${name}: Glofox → data unchanged, source "glofox" and dataAsOf null beside it`, async () => {
      radarAvailability.mockResolvedValue({ available: true, source: 'glofox', dataAsOf: null, dataAsOfZone: null, outreachAvailable: true })
      const res = await GET(req(path))
      const body = await res.json()
      expect(res.status).toBe(200)
      expect(body.success).toBe(true)
      expect(body.source).toBe('glofox')
      expect(body.dataAsOf).toBeNull()
      // the radar page's own route also carries the studio zone for its freshness
      // line; the routes behind an outreach button say whether a number is on
      const extra = { 'churn-radar': ['dataAsOfZone', 'outreachAvailable'], winback: ['outreachAvailable'], 'lead-radar': ['outreachAvailable'] }[name] || []
      expect(Object.keys(body).sort()).toEqual(['data', 'dataAsOf', 'source', 'success', ...extra].sort())
      expect(mod[loader]).toHaveBeenCalledTimes(1)
    })

    if (['churn-radar', 'winback', 'lead-radar'].includes(name)) {
      it(`${name}: an unread WhatsApp number is null (unknown), never false`, async () => {
        radarAvailability.mockResolvedValue({ available: true, source: 'glofox', dataAsOf: null, dataAsOfZone: null, outreachAvailable: null })
        expect((await (await GET(req(path))).json()).outreachAvailable).toBeNull()
        radarAvailability.mockResolvedValue({ available: true, source: 'glofox', dataAsOf: null, dataAsOfZone: null, outreachAvailable: false })
        expect((await (await GET(req(path))).json()).outreachAvailable).toBe(false)
      })
    }

    it(`${name}: an unreadable source is a 500`, async () => {
      radarAvailability.mockRejectedValue(Object.assign(new Error('membership source unreadable'), { code: 'MEMBERSHIP_SOURCE_UNREADABLE' }))
      const res = await GET(req(path))
      expect(res.status).toBe(500)
    })
  }

  it('/api/churn-radar data is exactly loadRadar\'s output', async () => {
    radarAvailability.mockResolvedValue({ available: true, source: 'glofox', dataAsOf: null })
    const body = await (await churnGET(req('/api/churn-radar'))).json()
    expect(body.data).toEqual({ radar: [{ contactId: 'c1' }], summary: { activeBase: 1 } })
  })
})
