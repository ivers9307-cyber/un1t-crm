// UN1TWRITE.12 — the un1t.online tab's write settings: GET adds a `write`
// block for masters (switch, trial product picker list, write permissions
// line); PATCH (master only) sets writes_enabled and trial_product_id through
// mergeLocationSettings and keeps every other settings key.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => ({ ...(await vi.importActual('@/lib/auth')), getCurrentUser: vi.fn() }))
vi.mock('@/lib/log', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/connection-registry', async () => ({
  ...(await vi.importActual('@/lib/connection-registry')),
  readConnection: vi.fn(async () => ({ conn: { source: 'registry', isActive: true, platform: 'un1t_online', config: {}, status: 'connected' }, error: null })),
}))
const permissionReport = vi.fn()
vi.mock('@/lib/un1t-online-write', async () => ({
  ...(await vi.importActual('@/lib/un1t-online-write')),
  createUn1tWriter: vi.fn(async () => ({ permissionReport })),
}))

import { GET, PATCH, _resetPermissionFailuresForTests } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { createUn1tWriter } from '@/lib/un1t-online-write'

const LOC = 'a0000000-0000-4000-8000-000000000002'
const TRIAL = 'p-trial'
const master = { id: 'u-m', email: 'm@example.test', role: 'master', profileRole: 'master', isMaster: true, locations: [{ id: LOC }], rolesByLocation: { [LOC]: 'owner' }, activeLocation: { id: LOC } }
const owner = { ...master, id: 'u-o', role: 'owner', profileRole: 'owner', isMaster: false }

let settings
let settingsReadError
let writes
const products = [
  { un1t_id: 'p-paid', title: 'Ten pack', type: 'one_time', status: 'active', price_cents: 9000, currency: 'EUR' },
  { un1t_id: TRIAL, title: 'Trial', type: 'one_time', status: 'active', price_cents: 0 },
  { un1t_id: 'p-old', title: 'Old trial', type: 'one_time', status: 'archived', price_cents: 0 },
  { un1t_id: 'p-sub', title: 'Free sub', type: 'subscription', status: 'active', price_cents: 0 },
  { un1t_id: 'p-a', title: 'A first', type: 'one_time', status: 'active', price_cents: 0 },
  // Recurring and priced: never on the paid-trial picker (F3).
  { un1t_id: 'p-monthly', title: 'Monthly', type: 'subscription', status: 'active', price_cents: 12000, currency: 'EUR' },
]
let productQueries
let productsThrow
function makeDb() {
  return {
    from(table) {
      const f = []
      let mode = 'select'
      let payload = null
      const run = () => {
        if (table === 'locations') {
          if (mode === 'update') { writes.push(payload); settings = payload.settings; return { data: [{ id: LOC }], error: null } }
          if (settingsReadError) return { data: null, error: settingsReadError }
          return { data: { id: LOC, settings }, error: null }
        }
        if (table === 'un1t_products') {
          productQueries.push([...f])
          if (productsThrow && f.some(([, , op]) => op === 'gt')) throw new Error('mirror down')
          const rows = products.map((p) => ({ location_id: LOC, ...p })).filter((p) => f.every(([c, v, op]) => (op === 'gt' ? p[c] > v : p[c] === v)))
          return { data: rows, error: null }
        }
        if (table === 'un1t_sync_runs') return { data: [], error: null }
        throw new Error(`unexpected table ${table}`)
      }
      const b = {
        select: () => b, order: () => b, limit: () => b,
        eq: (c, v) => { f.push([c, v]); return b },
        gt: (c, v) => { f.push([c, v, 'gt']); return b },
        update: (p) => { mode = 'update'; payload = p; return b },
        single: async () => run(), maybeSingle: async () => run(),
        then: (ok, no) => Promise.resolve(run()).then(ok, no),
      }
      return b
    },
  }
}
const props = { params: Promise.resolve({ id: LOC }) }
const patch = (body) => PATCH(new Request(`http://x/api/locations/${LOC}/un1t-online`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), props)
const get = () => GET(new Request(`http://x/api/locations/${LOC}/un1t-online`), props)

beforeEach(() => {
  vi.clearAllMocks()
  _resetPermissionFailuresForTests()
  settings = { glofox: { branch_id: 'keep' }, un1t_online: { hidden_class_keywords: 'elite' } }
  settingsReadError = null
  writes = []
  productQueries = []
  productsThrow = false
  createServerClient.mockReturnValue(makeDb())
  permissionReport.mockResolvedValue({ missing: [], studioMatches: true })
})

describe('PATCH /api/locations/[id]/un1t-online (write settings)', () => {
  it('refuses a non-master 403 and writes nothing', async () => {
    getCurrentUser.mockResolvedValue(owner)
    expect((await patch({ writes_enabled: true })).status).toBe(403)
    expect(writes).toHaveLength(0)
  })

  it('sets writes_enabled through mergeLocationSettings and keeps every other settings key', async () => {
    getCurrentUser.mockResolvedValue(master)
    const res = await patch({ writes_enabled: true })
    expect(res.status).toBe(200)
    expect(settings).toEqual({ glofox: { branch_id: 'keep' }, un1t_online: { hidden_class_keywords: 'elite', writes_enabled: true } })
  })

  it('accepts an active €0 one-time product at this studio, and null clears it', async () => {
    getCurrentUser.mockResolvedValue(master)
    expect((await patch({ trial_product_id: TRIAL })).status).toBe(200)
    expect(settings.un1t_online.trial_product_id).toBe(TRIAL)
    expect((await patch({ trial_product_id: null })).status).toBe(200)
    expect(settings.un1t_online.trial_product_id).toBeNull()
  })

  it('refuses a trial product that is not an active €0 one-time product at this studio', async () => {
    getCurrentUser.mockResolvedValue(master)
    for (const id of ['p-paid', 'p-old', 'p-sub', 'nope']) {
      const res = await patch({ trial_product_id: id })
      expect(res.status, id).toBe(400)
    }
    expect(writes).toHaveLength(0)
  })

  it('a settings read failure is 503 and nothing is written', async () => {
    getCurrentUser.mockResolvedValue(master)
    settingsReadError = { code: 'XX000', message: 'boom' }
    expect((await patch({ writes_enabled: true })).status).toBe(503)
    expect(writes).toHaveLength(0)
  })

  it('an empty body is a 400', async () => {
    getCurrentUser.mockResolvedValue(master)
    expect((await patch({})).status).toBe(400)
  })
})

describe('GET adds the write block for masters', () => {
  it('reports the switch, the €0 one-time products by title and the missing write permissions', async () => {
    getCurrentUser.mockResolvedValue(master)
    settings = { un1t_online: { writes_enabled: true, trial_product_id: TRIAL } }
    permissionReport.mockResolvedValue({ missing: ['purchases:create', 'credits:read'], studioMatches: true })
    const j = await (await get()).json()
    expect(j.data.write).toMatchObject({
      writes_enabled: true,
      trial_product_id: TRIAL,
      trial_products: [{ un1t_id: 'p-a', title: 'A first' }, { un1t_id: TRIAL, title: 'Trial' }],
      permissions: { all_present: false, missing: ['purchases:create', 'credits:read'] },
    })
  })

  it('lists the active priced products with price and currency for the paid-trial picker', async () => {
    getCurrentUser.mockResolvedValue(master)
    const j = await (await get()).json()
    expect(j.data.paid_products).toEqual([
      { un1t_id: 'p-paid', title: 'Ten pack', price_cents: 9000, currency: 'EUR', type: 'one_time' },
    ])
  })

  it('the paid-trial picker reads one-off products only, in the query, never a recurring one', async () => {
    getCurrentUser.mockResolvedValue(owner)
    const j = await (await get()).json()
    expect(j.data.paid_products.map((p) => p.un1t_id)).not.toContain('p-monthly')
    const paidQuery = productQueries.find((q) => q.some(([, , op]) => op === 'gt'))
    expect(paidQuery).toEqual(expect.arrayContaining([['location_id', LOC], ['status', 'active'], ['type', 'one_time'], ['price_cents', 0, 'gt']]))
  })

  it('a thrown paid-products read is an empty list, not a failed GET', async () => {
    getCurrentUser.mockResolvedValue(owner)
    productsThrow = true
    const res = await get()
    expect(res.status).toBe(200)
    expect((await res.json()).data.paid_products).toEqual([])
  })

  it('an owner gets paid_products but no write block', async () => {
    getCurrentUser.mockResolvedValue(owner)
    const j = await (await get()).json()
    expect(j.data.paid_products).toEqual([
      { un1t_id: 'p-paid', title: 'Ten pack', price_cents: 9000, currency: 'EUR', type: 'one_time' },
    ])
    expect(j.data).not.toHaveProperty('write')
  })

  it('an unreadable permission check says so, is not retried for a minute, and never waits', async () => {
    getCurrentUser.mockResolvedValue(master)
    permissionReport.mockRejectedValue(new Error('down'))
    expect((await (await get()).json()).data.write.permissions).toEqual({ unreadable: true })
    expect((await (await get()).json()).data.write.permissions).toEqual({ unreadable: true })
    expect(permissionReport).toHaveBeenCalledTimes(1)
    const opts = createUn1tWriter.mock.calls[0][2]
    await expect(opts.sleep(1000)).rejects.toThrow(/does not wait/)
  })

  it('a token for another studio is never "all present"', async () => {
    getCurrentUser.mockResolvedValue(master)
    permissionReport.mockResolvedValue({ missing: [], studioMatches: false })
    expect((await (await get()).json()).data.write.permissions).toEqual({ all_present: false, missing: [], wrong_studio: true })
  })

  it('an owner gets no write block, only whether writes are on', async () => {
    getCurrentUser.mockResolvedValue(owner)
    settings = { un1t_online: { writes_enabled: true, trial_product_id: TRIAL } }
    const j = await (await get()).json()
    expect(j.data).not.toHaveProperty('write')
    expect(j.data.writes_enabled).toBe(true)
    expect(createUn1tWriter).not.toHaveBeenCalled()
  })
})

describe('UN1TWRITE.24 — funnel settings', () => {
  it('funnel on is refused while writes are off; with writes on (or in the same change) it is stored', async () => {
    getCurrentUser.mockResolvedValue(master)
    settings = { un1t_online: { writes_enabled: false } }
    const res = await patch({ funnel_enabled: true })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Turn writes on first.')
    expect(writes).toHaveLength(0)
    expect((await patch({ writes_enabled: true, funnel_enabled: true })).status).toBe(200)
    expect(settings.un1t_online).toMatchObject({ writes_enabled: true, funnel_enabled: true })
    settings = { un1t_online: { writes_enabled: true } }
    expect((await patch({ funnel_enabled: true })).status).toBe(200)
  })

  it('keywords are stored as typed and parsed by parseHiddenKeywords', async () => {
    getCurrentUser.mockResolvedValue(master)
    const { parseHiddenKeywords } = await import('@/lib/class-keywords')
    expect((await patch({ hidden_class_keywords: 'Elite, Members only' })).status).toBe(200)
    expect(settings.un1t_online.hidden_class_keywords).toBe('Elite, Members only')
    expect(parseHiddenKeywords(settings.un1t_online.hidden_class_keywords)).toEqual(['elite', 'members only'])
  })

  it('the three email flags round-trip through PATCH and GET', async () => {
    getCurrentUser.mockResolvedValue(master)
    expect((await patch({ un1t_sends_welcome: true, un1t_welcome_sets_login: true, un1t_sends_booking_confirmation: true })).status).toBe(200)
    expect(settings.un1t_online).toMatchObject({ un1t_sends_welcome: true, un1t_welcome_sets_login: true, un1t_sends_booking_confirmation: true })
    const j = await (await get()).json()
    expect(j.data.write).toMatchObject({ un1t_sends_welcome: true, un1t_welcome_sets_login: true, un1t_sends_booking_confirmation: true, hidden_class_keywords: 'elite', funnel_enabled: false })
  })
})

describe('UN1TWELCOME.1 — app links', () => {
  it('a master PATCH merges app_links key by key and keeps every other key', async () => {
    getCurrentUser.mockResolvedValue(master)
    settings = { un1t_online: { hidden_class_keywords: 'elite', app_links: { android_url: 'https://play.google.com/x', heading: 'Old' } } }
    const res = await patch({ app_links: { ios_url: 'https://apps.apple.com/x', heading: null } })
    expect(res.status).toBe(200)
    expect(settings.un1t_online.app_links.ios_url).toBe('https://apps.apple.com/x')
    expect(settings.un1t_online.app_links.android_url).toBe('https://play.google.com/x')
    expect(settings.un1t_online.app_links).not.toHaveProperty('heading')
    expect(settings.un1t_online.hidden_class_keywords).toBe('elite')
    const j = await (await get()).json()
    expect(j.data.write.app_links).toMatchObject({ ios_url: 'https://apps.apple.com/x', android_url: 'https://play.google.com/x' })
  })

  it('refuses a link that is not https', async () => {
    getCurrentUser.mockResolvedValue(master)
    expect((await patch({ app_links: { ios_url: 'http://x.test' } })).status).toBe(400)
    expect(writes).toHaveLength(0)
  })

  it('a non-master gets 403', async () => {
    getCurrentUser.mockResolvedValue(owner)
    expect((await patch({ app_links: { ios_url: 'https://apps.apple.com/x' } })).status).toBe(403)
    expect(writes).toHaveLength(0)
  })
})

describe('UN1TWRITE.24 — writes off switches the funnel off', () => {
  it('a PATCH turning writes off clears funnel_enabled, so writes on again never re-arms it', async () => {
    getCurrentUser.mockResolvedValue(master)
    settings = { un1t_online: { writes_enabled: true, funnel_enabled: true } }
    expect((await patch({ writes_enabled: false })).status).toBe(200)
    expect(settings.un1t_online).toMatchObject({ writes_enabled: false, funnel_enabled: false })
    expect((await patch({ writes_enabled: true })).status).toBe(200)
    expect(settings.un1t_online.funnel_enabled).toBe(false)
  })
})
