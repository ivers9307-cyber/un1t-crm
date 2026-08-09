// COMMSFIX.F.3 — SECURITY + shape tests for GET /api/campaigns/[id]/links.
//
// This route runs createServerClient() — the service-role client, which
// BYPASSES RLS. Application-layer location scoping is therefore the ONLY thing
// between a manager at tenant A and tenant B's campaign click report. Two IDORs
// shipped in this codebase within a fortnight (TPL-IDOR.1 template editor
// #1307, event-types #1311) and both were missing exactly this guard, so it is
// pinned here first and hardest — including that the refusal is a 404 with a
// body byte-identical to "no such campaign", so campaign ids stay
// unenumerable.
//
// The aggregate itself must happen in Postgres. campaign_link_clicks holds
// 19,140 rows before this feature even ships, and every .select() is capped at
// 1,000 rows regardless of .limit() — a route that pulled rows to group them in
// JS would silently under-report on any real campaign. So there is a test that
// the route calls the RPC and never touches the table.
//
// @/lib/auth is mocked with a real-equivalent assertLocationAccessOr404
// (inlined to keep its next/headers import out of the node test env, the same
// pattern as src/app/api/schedule/templates/[id]/route.test.js).

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  assertLocationAccessOr404: (user, locationId) => {
    if (!user) {
      return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), { status: 401 })
    }
    if (!locationId) return null
    const allowed = (user.locations || []).some((l) => l.id === locationId)
    if (!allowed) {
      return new Response(JSON.stringify({ success: false, error: 'Campaign not found' }), { status: 404 })
    }
    return null
  },
}))

import { GET } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

const LOC_A = 'loc-aaaa'
const LOC_B = 'loc-bbbb'

const USER_AT_A = { id: 'u1', locations: [{ id: LOC_A }] }

const CAMPAIGNS = {
  'camp-a': { id: 'camp-a', location_id: LOC_A },
  'camp-b': { id: 'camp-b', location_id: LOC_B },
}

const STATS = [
  { url: 'https://un1t.ie/offers', clicks: 41, unique_clickers: 30 },
  { url: 'https://un1t.ie/timetable', clicks: 12, unique_clickers: 11 },
]

/**
 * Supabase-shaped fake that records which tables were queried and every rpc
 * call, so the "aggregate in Postgres" property is asserted on behaviour
 * rather than on a spy of the thing under test.
 */
function makeDb({ stats = STATS, rpcError = null } = {}) {
  const tablesQueried = []
  const rpcCalls = []

  return {
    tablesQueried,
    rpcCalls,
    from(table) {
      tablesQueried.push(table)
      const state = { filters: {} }
      const b = {
        select: () => b,
        eq: (col, val) => { state.filters[col] = val; return b },
        single: () => {
          const row = table === 'campaigns' ? CAMPAIGNS[state.filters.id] : null
          return Promise.resolve(
            row ? { data: row, error: null } : { data: null, error: { message: 'No rows' } },
          )
        },
        maybeSingle: () => b.single(),
      }
      return b
    },
    rpc(fn, args) {
      rpcCalls.push([fn, args])
      return Promise.resolve(rpcError ? { data: null, error: rpcError } : { data: stats, error: null })
    },
  }
}

const req = () => new Request('http://localhost/api/campaigns/camp-a/links')
const props = (id) => ({ params: Promise.resolve({ id }) })

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/campaigns/[id]/links — access control', () => {
  it('401s when there is no session', async () => {
    getCurrentUser.mockResolvedValue(null)
    createServerClient.mockReturnValue(makeDb())

    const res = await GET(req(), props('camp-a'))

    expect(res.status).toBe(401)
  })

  it('404s a campaign belonging to another location — never 403, so ids stay unenumerable', async () => {
    getCurrentUser.mockResolvedValue(USER_AT_A)
    const db = makeDb()
    createServerClient.mockReturnValue(db)

    const res = await GET(req(), props('camp-b'))
    const body = await res.json()

    expect(res.status).toBe(404)
    expect(body.success).toBe(false)
    // No stats were computed for the foreign campaign.
    expect(db.rpcCalls).toEqual([])
  })

  it('a foreign campaign is indistinguishable from a missing one', async () => {
    getCurrentUser.mockResolvedValue(USER_AT_A)
    createServerClient.mockReturnValue(makeDb())

    const foreign = await GET(req(), props('camp-b'))
    const missing = await GET(req(), props('camp-nope'))

    expect(foreign.status).toBe(missing.status)
    expect(await foreign.json()).toEqual(await missing.json())
  })
})

describe('GET /api/campaigns/[id]/links — report', () => {
  beforeEach(() => {
    getCurrentUser.mockResolvedValue(USER_AT_A)
  })

  it('returns url / clicks / unique_clickers for a campaign in the caller’s location', async () => {
    createServerClient.mockReturnValue(makeDb())

    const res = await GET(req(), props('camp-a'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.data).toEqual([
      { url: 'https://un1t.ie/offers', clicks: 41, unique_clickers: 30 },
      { url: 'https://un1t.ie/timetable', clicks: 12, unique_clickers: 11 },
    ])
  })

  it('aggregates in Postgres — calls campaign_link_click_stats and never selects the table (1,000-row cap)', async () => {
    const db = makeDb()
    createServerClient.mockReturnValue(db)

    await GET(req(), props('camp-a'))

    expect(db.rpcCalls).toEqual([['campaign_link_click_stats', { p_campaign_id: 'camp-a' }]])
    expect(db.tablesQueried).not.toContain('campaign_link_clicks')
  })

  it('orders by unique_clickers desc even if the RPC hands back another order', async () => {
    createServerClient.mockReturnValue(makeDb({
      stats: [
        { url: 'https://un1t.ie/quiet', clicks: 9, unique_clickers: 2 },
        { url: 'https://un1t.ie/loud', clicks: 15, unique_clickers: 14 },
      ],
    }))

    const body = await (await GET(req(), props('camp-a'))).json()

    expect(body.data.map((r) => r.url)).toEqual([
      'https://un1t.ie/loud',
      'https://un1t.ie/quiet',
    ])
  })

  it('coerces the bigint counts to numbers so the UI’s share maths cannot become NaN', async () => {
    createServerClient.mockReturnValue(makeDb({
      stats: [{ url: 'https://un1t.ie/offers', clicks: '41', unique_clickers: '30' }],
    }))

    const body = await (await GET(req(), props('camp-a'))).json()

    expect(body.data[0]).toEqual({ url: 'https://un1t.ie/offers', clicks: 41, unique_clickers: 30 })
  })

  it('returns an empty list, not an error, for a campaign nobody clicked', async () => {
    createServerClient.mockReturnValue(makeDb({ stats: [] }))

    const res = await GET(req(), props('camp-a'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual({ success: true, data: [] })
  })

  it('surfaces an RPC failure as a 500 in the standard error shape', async () => {
    createServerClient.mockReturnValue(makeDb({
      rpcError: { message: 'function campaign_link_click_stats does not exist' },
    }))

    const res = await GET(req(), props('camp-a'))
    const body = await res.json()

    expect(res.status).toBe(500)
    expect(body.success).toBe(false)
    expect(body.error).toBeTruthy()
  })
})
