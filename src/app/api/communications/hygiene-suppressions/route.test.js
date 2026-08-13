// HYGREL.1 — the hygiene-suppression list.
//
// THE POINT OF THIS FILE IS THE 1,000-ROW CAP. Every PostgREST .select()
// returns at most 1,000 rows regardless of .limit(), silently, and this
// population was 1,128 on the day the endpoint was written. A list that
// answered "everyone suppressed" by taking the default select would show 1,000
// names, report a plausible total, and drop 128 people with no error anywhere —
// which is precisely the failure mode the whole surface exists to end. So the
// endpoint pages, and the tail past row 1,000 is reachable.
//
// The rest is the usual pair: the tenant guard (service-role client, so the
// application check is the only boundary) and the mechanism flag that tells the
// two sweeps apart.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/permissions', () => ({ hasPermission: vi.fn(() => true) }))
vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  assertLocationAccessOr404: (user, locationId) => {
    if (!user) return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), { status: 401 })
    if (!locationId) return null
    const allowed = (user.locations || []).some((l) => l.id === locationId)
    if (!allowed) return new Response(JSON.stringify({ success: false, error: 'Not found' }), { status: 404 })
    return null
  },
}))

import { GET } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'

const LOC_A = '00000000-0000-4000-8000-00000000000a'
const LOC_B = '00000000-0000-4000-8000-00000000000b'
const USER_AT_A = { id: 'u1', locations: [{ id: LOC_A }], activeLocation: { id: LOC_A } }

// Deliberately larger than the cap: 1,128 was the live number on 2026-08-12.
const TOTAL = 1128
const uuidFor = (i) => `00000000-0000-4000-9000-${String(i).padStart(12, '0')}`
const POPULATION = Array.from({ length: TOTAL }, (_, i) => ({
  id: uuidFor(i),
  name: `Contact ${i}`,
  email: `c${i}@example.com`,
  email_suppressed_at: '2026-08-12T05:15:00.000Z',
  email_status: 'active',
  pipeline_stage_slug: i < 190 ? 'member' : 'dormant',
  email_hygiene_released_at: null,
  audience_location_id: LOC_A,
}))

// Only these carry a live repeat-bounce escalation.
const BOUNCE_OWNED = new Set([uuidFor(0), uuidFor(5)])

function makeDb() {
  const ranges = []
  const db = {
    ranges,
    from(table) {
      const state = { table, filters: {}, ids: null }
      const b = {
        select: () => b,
        eq: (col, val) => { state.filters[col] = val; return b },
        in: (_col, val) => { state.ids = val; return b },
        is: () => b,
        not: () => b,
        order: () => b,
        range: (from, to) => {
          ranges.push([from, to])
          state.range = [from, to]
          return b
        },
        then: (resolve) => {
          if (state.table === 'contact_location_audience') {
            const all = POPULATION.filter((r) => r.audience_location_id === state.filters.audience_location_id)
            const [from, to] = state.range || [0, all.length - 1]
            return resolve({ data: all.slice(from, to + 1), error: null, count: all.length })
          }
          const hit = (state.ids || []).filter((id) => BOUNCE_OWNED.has(id)).map((id) => ({ contact_id: id }))
          return resolve({ data: hit, error: null, count: hit.length })
        },
      }
      return b
    },
  }
  return db
}

const req = (qs = '') => new Request(`http://localhost/api/communications/hygiene-suppressions${qs}`)

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(hasPermission).mockReturnValue(true)
  getCurrentUser.mockResolvedValue(USER_AT_A)
  createServerClient.mockReturnValue(makeDb())
})

describe('GET /api/communications/hygiene-suppressions — paging past the 1,000-row cap', () => {
  it('reports the FULL total, not the page length', async () => {
    const body = await (await GET(req())).json()
    expect(body.data.total).toBe(TOTAL)
    expect(body.data.rows).toHaveLength(100)
  })

  it('reaches the tail past row 1,000, which a bare select would silently drop', async () => {
    const body = await (await GET(req('?offset=1000&limit=200'))).json()
    // 1,128 rows means 128 live beyond the cap. They come back.
    expect(body.data.rows).toHaveLength(TOTAL - 1000)
    expect(body.data.rows[0].contact_id).toBe(uuidFor(1000))
    expect(body.data.rows.at(-1).contact_id).toBe(uuidFor(TOTAL - 1))
  })

  it('walks the whole population in pages with no gaps and no repeats', async () => {
    const seen = []
    for (let offset = 0; offset < TOTAL; offset += 200) {
      const body = await (await GET(req(`?offset=${offset}&limit=200`))).json()
      seen.push(...body.data.rows.map((r) => r.contact_id))
    }
    expect(seen).toHaveLength(TOTAL)
    expect(new Set(seen).size).toBe(TOTAL)
  })

  it('pages with .range(), so the request is a slice rather than a truncated select', async () => {
    const db = makeDb()
    createServerClient.mockReturnValue(db)
    await GET(req('?offset=300&limit=50'))
    expect(db.ranges[0]).toEqual([300, 349])
  })

  it('clamps an oversized limit rather than trusting it', async () => {
    const db = makeDb()
    createServerClient.mockReturnValue(db)
    const body = await (await GET(req('?limit=100000'))).json()
    expect(body.data.limit).toBe(200)
    expect(db.ranges[0]).toEqual([0, 199])
  })

  it('falls back to the default page on a junk limit instead of NaN-ing the range', async () => {
    const db = makeDb()
    createServerClient.mockReturnValue(db)
    const body = await (await GET(req('?limit=abc&offset=xyz'))).json()
    expect(body.data.limit).toBe(100)
    expect(db.ranges[0]).toEqual([0, 99])
  })
})

describe('GET /api/communications/hygiene-suppressions — mechanism + access', () => {
  it('says which sweep owns each stamp, so the operator knows which undo applies', async () => {
    const body = await (await GET(req())).json()
    const byId = Object.fromEntries(body.data.rows.map((r) => [r.contact_id, r]))
    expect(byId[uuidFor(0)].has_bounce_escalation).toBe(true)
    expect(byId[uuidFor(1)].has_bounce_escalation).toBe(false)
  })

  it('carries the stage, which is what the member/dormant split was decided on', async () => {
    const body = await (await GET(req())).json()
    expect(body.data.rows[0].pipeline_stage_slug).toBe('member')
  })

  it('401s with no session and 403s without the email permission', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await GET(req())).status).toBe(401)

    getCurrentUser.mockResolvedValue(USER_AT_A)
    vi.mocked(hasPermission).mockReturnValue(false)
    expect((await GET(req())).status).toBe(403)
  })

  it('404s a location outside the caller\'s access', async () => {
    expect((await GET(req(`?location_id=${LOC_B}`))).status).toBe(404)
  })

  it('404s a malformed location rather than surfacing a cast error as a 500', async () => {
    expect((await GET(req('?location_id=not-a-uuid'))).status).toBe(404)
  })
})
