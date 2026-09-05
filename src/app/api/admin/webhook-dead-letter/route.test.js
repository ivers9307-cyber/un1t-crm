// MAIL-DEADLETTER.1 review fix — the morgue LIST is org-scoped.
//
// The route used to gate on the caller's ACTIVE role (`user.role === 'owner'`)
// and then select every row with no filter — so an owner in any org read every
// other org's dead-letter payloads (for postmark_inbound that is the full email
// body, headers and attachment metadata). Now: master sees everything; anyone
// else sees only rows at locations where they are OWNER (hasRoleAtLocation),
// and a NULL-location row is invisible to them — `.in('location_id', ids)` is
// never true for NULL, exactly as SQL's IN is, and the fake below models that.
//
// @/lib/auth is the REAL module with only getCurrentUser mocked, so the
// owner-location derivation runs against hasRoleAtLocation's actual contract.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})

import { GET } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

const LOC_A = 'a0000000-0000-0000-0000-000000000001'
const LOC_B = 'b0000000-0000-0000-0000-000000000002'

// `role` is the ACTIVE-location value the OLD gate trusted — kept on every
// fixture so a regression back to `user.role` is visible.
const MASTER = { id: 'u-master', role: 'owner', profileRole: 'master', isMaster: true, rolesByLocation: {} }
const OWNER_A = { id: 'u-owner-a', role: 'owner', profileRole: 'owner', isMaster: false, rolesByLocation: { [LOC_A]: 'owner' } }
const OWNER_B = { id: 'u-owner-b', role: 'owner', profileRole: 'owner', isMaster: false, rolesByLocation: { [LOC_B]: 'owner', [LOC_A]: 'manager' } }
const MANAGER_A = { id: 'u-mgr-a', role: 'manager', profileRole: 'manager', isMaster: false, rolesByLocation: { [LOC_A]: 'manager' } }
// Active role says owner, but no location grants it — a regression back to
// `user.role` would let this fixture through.
const PHANTOM_OWNER = { id: 'u-phantom', role: 'owner', profileRole: 'owner', isMaster: false, rolesByLocation: {} }

const ROWS = [
  { id: 1, provider: 'postmark_inbound', status: 'pending', location_id: LOC_A, payload: { Subject: 'A mail' }, received_at: '2026-09-05T10:00:00Z' },
  { id: 2, provider: 'postmark_inbound', status: 'pending', location_id: LOC_B, payload: { Subject: 'B mail' }, received_at: '2026-09-05T09:00:00Z' },
  { id: 3, provider: 'postmark_inbound', status: 'pending', location_id: null, payload: { Subject: 'unrouted' }, received_at: '2026-09-05T08:00:00Z' },
  { id: 4, provider: 'zoom_contact_sync', status: 'failed', location_id: LOC_A, payload: {}, received_at: '2026-09-05T07:00:00Z' },
]

// ── fake db ─────────────────────────────────────────────────────────────────
// Applies .eq / .in like SQL would (IN never matches NULL) and records the
// filters so a test can assert what was — and was not — bound.
let filters
let queryError

function makeDb() {
  return {
    from: (table) => {
      let rows = table === 'webhook_dead_letter' ? [...ROWS] : []
      const b = {}
      b.select = () => b
      b.order = () => b
      b.limit = () => b
      b.eq = (col, val) => { filters.push(['eq', col, val]); rows = rows.filter(r => r[col] === val); return b }
      b.in = (col, vals) => {
        filters.push(['in', col, vals])
        rows = rows.filter(r => r[col] !== null && r[col] !== undefined && vals.includes(r[col]))
        return b
      }
      b.then = (res, rej) => Promise.resolve(queryError ? { data: null, error: queryError } : { data: rows, error: null }).then(res, rej)
      return b
    },
  }
}

function call(qs = '') {
  return GET({ url: `http://x/api/admin/webhook-dead-letter${qs}` })
}

const locationFilters = () => filters.filter(([, col]) => col === 'location_id')

beforeEach(() => {
  vi.clearAllMocks()
  filters = []
  queryError = null
  createServerClient.mockImplementation(() => makeDb())
  getCurrentUser.mockResolvedValue(MASTER)
})

describe('GET /api/admin/webhook-dead-letter — who sees which rows', () => {
  it('master sees every row, including NULL-location ones, with no location filter bound', async () => {
    const res = await call()
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.data.map(r => r.id)).toEqual([1, 2, 3, 4])
    expect(locationFilters()).toHaveLength(0)
  })

  it('an owner sees ONLY rows at the locations they own — another org\'s rows never leave the database', async () => {
    getCurrentUser.mockResolvedValue(OWNER_A)
    const res = await call()
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.data.map(r => r.id)).toEqual([1, 4])
    // The bound is applied IN THE QUERY (.in on location_id), not by trimming
    // rows after a cross-org read.
    expect(locationFilters()).toEqual([['in', 'location_id', [LOC_A]]])
  })

  it('a NULL-location row is invisible to a non-master (it belongs to no org the caller can be judged against)', async () => {
    getCurrentUser.mockResolvedValue(OWNER_A)
    const json = await (await call()).json()
    expect(json.data.some(r => r.location_id === null)).toBe(false)
  })

  it('owner at B who is only a MANAGER at A sees B\'s rows and none of A\'s', async () => {
    getCurrentUser.mockResolvedValue(OWNER_B)
    const json = await (await call()).json()
    expect(json.data.map(r => r.id)).toEqual([2])
    expect(locationFilters()).toEqual([['in', 'location_id', [LOC_B]]])
  })

  it('an active-role "owner" who owns no location is refused like a manager — the active role is never consulted', async () => {
    getCurrentUser.mockResolvedValue(PHANTOM_OWNER)
    const res = await call()
    expect(res.status).toBe(403)
    expect(filters).toHaveLength(0)
  })

  it('a manager is refused (403 — a collection route, nothing to enumerate)', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    expect((await call()).status).toBe(403)
  })

  it('anonymous is 401', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await call()).status).toBe(401)
  })
})

describe('GET /api/admin/webhook-dead-letter — filters and annotations still apply under the bound', () => {
  it('provider + status filters stack with the location bound', async () => {
    getCurrentUser.mockResolvedValue(OWNER_A)
    const json = await (await call('?provider=zoom_contact_sync&status=failed')).json()
    expect(json.data.map(r => r.id)).toEqual([4])
    expect(filters).toEqual(expect.arrayContaining([
      ['eq', 'provider', 'zoom_contact_sync'],
      ['eq', 'status', 'failed'],
      ['in', 'location_id', [LOC_A]],
    ]))
  })

  it('rows are annotated `replayable` from the provider registry', async () => {
    const json = await (await call()).json()
    const byId = Object.fromEntries(json.data.map(r => [r.id, r.replayable]))
    expect(byId[1]).toBe(true)   // postmark_inbound — operator-only replay
    expect(byId[4]).toBe(false)  // zoom_contact_sync — no re-driver
  })

  it('rejects an unknown status with 400', async () => {
    expect((await call('?status=bogus')).status).toBe(400)
  })

  it('surfaces a query error as 500', async () => {
    queryError = { message: 'boom' }
    expect((await call()).status).toBe(500)
  })
})
