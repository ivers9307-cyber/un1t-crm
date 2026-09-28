// CHANNELREAD.1 — /api/settings/ads.
//
// GET discarded both read errors and answered success:true with data:[], so
// the Ads tab could never tell a failed read from "no account" (its banner
// never fired in production). The recipients PUT read locations.settings,
// discarded the error, and wrote { ...{}, ads } over the WHOLE column: a blip
// wiped the location's Glofox credentials, UniFi, payments and the rest.
// All ids and emails are synthetic.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { GET, PUT } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { SECRET_MASK } from '@/lib/secret-keys'

const LOC = 'a0000000-0000-4000-8000-000000000001'
const OWNER = {
  id: 'u1', role: 'owner', profileRole: 'owner', isMaster: false, email: 'owner@example.test',
  locations: [{ id: LOC }], rolesByLocation: { [LOC]: 'owner' }, activeLocation: { id: LOC },
}
const BOOM = { message: 'canceling statement due to statement timeout' }

// results: { ad_accounts: { data, error }, locations: { data, error } }
function makeDb(results) {
  const writes = []
  return {
    writes,
    from(table) {
      const res = results[table] || { data: null, error: null }
      const b = {
        select: () => b,
        eq: () => b,
        maybeSingle: () => Promise.resolve(res),
        then: (ok, bad) => Promise.resolve(res).then(ok, bad),
        update(patch) {
          writes.push({ table, op: 'update', patch })
          const u = { eq: () => Promise.resolve({ error: null }) }
          return u
        },
        upsert(row) {
          writes.push({ table, op: 'upsert', row })
          return { select: () => ({ maybeSingle: () => Promise.resolve({ data: row, error: null }) }) }
        },
      }
      return b
    },
  }
}

const get = () => new Request(`http://localhost/api/settings/ads?locationId=${LOC}`)
const put = (body) => new Request('http://localhost/api/settings/ads', {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(OWNER)
})

describe('GET /api/settings/ads — a failed read is a 500, never "no account"', () => {
  it('ad_accounts read fails → 500, no data', async () => {
    createServerClient.mockReturnValue(makeDb({
      ad_accounts: { data: null, error: BOOM },
      locations: { data: { settings: {} }, error: null },
    }))
    const res = await GET(get())
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.success).toBe(false)
    expect(body.data).toBeUndefined()
  })

  it('locations read fails → 500, never the caller\'s own email as the recipients', async () => {
    createServerClient.mockReturnValue(makeDb({
      ad_accounts: { data: [], error: null },
      locations: { data: null, error: BOOM },
    }))
    const res = await GET(get())
    expect(res.status).toBe(500)
    expect((await res.json()).report_recipients).toBeUndefined()
  })

  it('pin: both reads succeed → masked rows + stored recipients', async () => {
    createServerClient.mockReturnValue(makeDb({
      ad_accounts: { data: [{ id: 'ad-1', provider: 'meta', external_account_id: 'act_1', access_token: 'SECRETTOKEN1234', is_active: true }], error: null },
      locations: { data: { settings: { ads: { report_recipients: ['ops@example.test'] } } }, error: null },
    }))
    const res = await GET(get())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data[0].has_access_token).toBe(true)
    expect(body.data[0].access_token).not.toContain('SECRET')
    expect(body.report_recipients).toEqual(['ops@example.test'])
  })
})

describe('N8NECHO.1: the ads token is presence only, and its mask never overwrites it', () => {
  const STORED_TOKEN = 'SYNTH-ADS-TOKEN-1234'
  const STORED = { id: 'ad-1', location_id: LOC, provider: 'meta', external_account_id: 'act_1', access_token: STORED_TOKEN, is_active: true }

  it('the GET token is the shared mask, with no character of the stored value', async () => {
    createServerClient.mockReturnValue(makeDb({
      ad_accounts: { data: [STORED], error: null },
      locations: { data: { settings: {} }, error: null },
    }))
    const body = await (await GET(get())).json()
    expect(body.data[0].access_token).toBe(SECRET_MASK)
    expect(body.data[0].access_token).not.toMatch(/1234/)
    expect(body.data[0].has_access_token).toBe(true)
    expect(JSON.stringify(body)).not.toMatch(/SYNTH-/)
  })

  it('round-trip: the GET mask, sent back on a PUT, leaves the stored token unchanged', async () => {
    createServerClient.mockReturnValue(makeDb({
      ad_accounts: { data: [STORED], error: null },
      locations: { data: { settings: {} }, error: null },
    }))
    const echoed = (await (await GET(get())).json()).data[0].access_token

    const db = makeDb({})
    createServerClient.mockReturnValue(db)
    const res = await PUT(put({ locationId: LOC, provider: 'meta', external_account_id: 'act_1', access_token: echoed, is_active: true }))
    expect(res.status).toBe(200)
    expect(db.writes).toHaveLength(1)
    const upserted = db.writes[0].row
    expect(upserted).not.toHaveProperty('access_token')
    // ON CONFLICT DO UPDATE touches only the columns sent: the stored token survives.
    expect({ ...STORED, ...upserted }.access_token).toBe(STORED_TOKEN)
  })

  it('a real new token is still written', async () => {
    const db = makeDb({})
    createServerClient.mockReturnValue(db)
    await PUT(put({ locationId: LOC, provider: 'meta', external_account_id: 'act_1', access_token: 'SYNTH-ADS-NEW-5678' }))
    expect(db.writes[0].row.access_token).toBe('SYNTH-ADS-NEW-5678')
  })
})

describe('PUT /api/settings/ads (recipients) — a failed settings read writes NOTHING', () => {
  it('500s and never updates locations.settings', async () => {
    const db = makeDb({ locations: { data: null, error: BOOM } })
    createServerClient.mockReturnValue(db)
    const res = await PUT(put({ locationId: LOC, report_recipients: ['ops@example.test'] }))
    expect(res.status).toBe(500)
    expect((await res.json()).success).toBe(false)
    expect(db.writes).toEqual([])
  })

  it('pin: a good read merges the ads slice and keeps every other key', async () => {
    const db = makeDb({ locations: { data: { settings: { glofox: { branch_id: 'b1' }, ads: {} } }, error: null } })
    createServerClient.mockReturnValue(db)
    const res = await PUT(put({ locationId: LOC, report_recipients: ['ops@example.test'] }))
    expect(res.status).toBe(200)
    expect(db.writes).toHaveLength(1)
    expect(db.writes[0].patch.settings).toEqual({ glofox: { branch_id: 'b1' }, ads: { report_recipients: ['ops@example.test'] } })
  })
})
