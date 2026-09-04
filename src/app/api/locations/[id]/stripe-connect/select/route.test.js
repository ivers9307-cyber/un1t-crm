// LOCFIX-ROLEGATE.1 — POST /api/locations/[id]/stripe-connect/select COMMITS
// THE LIVE PAYMENT RAIL for the PATH-PARAM location
// (locations.settings.payments.provider).
//
// THE GATE IS THE POINT. `user.role` resolves at the caller's ACTIVE location
// (with auth.js's highest-role-anywhere fallback), while this route writes to
// params.id — so the old `['master','owner','manager'].includes(user.role)`
// check let a manager at studio A who is plain STAFF at studio B send
//   POST /api/locations/<B>/stripe-connect/select { provider: 'revolut' }
// and switch where B's class-funnel money lands, with a 200. The gate is now
// membership (assertLocationAccessOr404 — this is a detail route, the 404 is
// deliberate) then the role AT THE TARGET, both BEFORE any Stripe call.
//
// TIER B: this route's list is ['master','owner','manager'] and deliberately
// EXCLUDES head_coach, unlike the holidays/channels routes' MANAGER_ROLES.
// Test (g) below is the half of the pair that pins the two tiers apart.
//
// Every refusal asserts BOTH an empty write log AND that no Stripe API call
// was made. @/lib/auth is REAL (importActual) with only getCurrentUser mocked.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/payments/stripe-connect', () => ({ retrieveAccountStatus: vi.fn() }))

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { retrieveAccountStatus } from '@/lib/payments/stripe-connect'

const LOC_A = 'a0000000-0000-0000-0000-000000000001'
const LOC_B = 'b0000000-0000-0000-0000-000000000002'

const MANAGER_A = {
  id: 'u1', role: 'manager', profileRole: 'manager', isMaster: false,
  locations: [{ id: LOC_A }], rolesByLocation: { [LOC_A]: 'manager' },
  activeLocation: { id: LOC_A },
}
// THE AUDIT CAST — manager at the ACTIVE studio, plain staff at the target.
const MANAGER_A_STAFF_B = {
  id: 'u2', role: 'manager', profileRole: 'manager', isMaster: false,
  locations: [{ id: LOC_A }, { id: LOC_B }],
  rolesByLocation: { [LOC_A]: 'manager', [LOC_B]: 'staff' },
  activeLocation: { id: LOC_A },
}
// The mirror image — the target's real manager, active studio elsewhere.
const STAFF_A_MANAGER_B = {
  id: 'u3', role: 'staff', profileRole: 'staff', isMaster: false,
  locations: [{ id: LOC_A }, { id: LOC_B }],
  rolesByLocation: { [LOC_A]: 'staff', [LOC_B]: 'manager' },
  activeLocation: { id: LOC_A },
}
// TIER B EXCLUDES head_coach — refused here, allowed on holidays/channels.
const STAFF_A_HEAD_COACH_B = {
  id: 'u4', role: 'staff', profileRole: 'staff', isMaster: false,
  locations: [{ id: LOC_A }, { id: LOC_B }],
  rolesByLocation: { [LOC_A]: 'staff', [LOC_B]: 'head_coach' },
  activeLocation: { id: LOC_A },
}
const HEAD_COACH_A = {
  id: 'u7', role: 'head_coach', profileRole: 'head_coach', isMaster: false,
  locations: [{ id: LOC_A }], rolesByLocation: { [LOC_A]: 'head_coach' },
  activeLocation: { id: LOC_A },
}
const MASTER = {
  id: 'u5', role: 'master', profileRole: 'master', isMaster: true,
  locations: [{ id: LOC_A }, { id: LOC_B }], rolesByLocation: {},
  activeLocation: { id: LOC_A },
}

// locations.select('settings').eq('id').maybeSingle()
// locations.update({ settings, updated_at }).eq('id')
// Fail LOUD on any other table.
function makeDb({ settings = {} } = {}) {
  const writes = []
  return {
    writes,
    from(table) {
      if (table !== 'locations') throw new Error(`unexpected db.from('${table}') in stripe-select test`)
      return {
        select() {
          return { eq: () => ({ maybeSingle: () => Promise.resolve({ data: { settings }, error: null }) }) }
        },
        update(patch) {
          const filters = {}
          writes.push({ op: 'update', patch, filters })
          const builder = {
            eq(col, val) { filters[col] = val; return builder },
            then: (res, rej) => Promise.resolve({ error: null }).then(res, rej),
          }
          return builder
        },
      }
    },
  }
}

const props = (id) => ({ params: { id } })
const post = (id, body) => new Request(`http://localhost/api/locations/${id}/stripe-connect/select`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

let db
beforeEach(() => {
  vi.clearAllMocks()
  db = makeDb()
  createServerClient.mockReturnValue(db)
  getCurrentUser.mockResolvedValue(MANAGER_A)
  retrieveAccountStatus.mockResolvedValue({ chargesEnabled: true, detailsSubmitted: true })
})

describe('POST .../stripe-connect/select — the legitimate flow is byte-identical', () => {
  it('a manager switching their own studio to Revolut gets exactly the body they always did', async () => {
    const res = await POST(post(LOC_A, { provider: 'revolut' }), props(LOC_A))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { provider: 'revolut' } })
    expect(retrieveAccountStatus).not.toHaveBeenCalled()
  })

  it('writes provider into settings.payments for the TARGET without clobbering other settings', async () => {
    createServerClient.mockReturnValue(db = makeDb({ settings: { other: 'keep', payments: { stripe_connected_account_id: 'acct_1', provider: 'revolut' } } }))
    const res = await POST(post(LOC_A, { provider: 'stripe_connect' }), props(LOC_A))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { provider: 'stripe_connect' } })
    expect(retrieveAccountStatus).toHaveBeenCalledWith('acct_1')
    expect(db.writes).toHaveLength(1)
    expect(db.writes[0].patch.settings).toEqual({
      other: 'keep',
      payments: { stripe_connected_account_id: 'acct_1', provider: 'stripe_connect' },
    })
    expect(db.writes[0].filters).toEqual({ id: LOC_A })
  })

  it('400s an unknown provider without writing or calling Stripe (unchanged)', async () => {
    const res = await POST(post(LOC_A, { provider: 'paypal' }), props(LOC_A))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Invalid provider')
    expect(db.writes).toEqual([])
    expect(retrieveAccountStatus).not.toHaveBeenCalled()
  })

  it('refuses stripe_connect until charges are enabled (unchanged), without writing', async () => {
    createServerClient.mockReturnValue(db = makeDb({ settings: { payments: { stripe_connected_account_id: 'acct_1' } } }))
    retrieveAccountStatus.mockResolvedValue({ chargesEnabled: false })
    const res = await POST(post(LOC_A, { provider: 'stripe_connect' }), props(LOC_A))
    expect(res.status).toBe(400)
    expect(db.writes).toEqual([])
  })
})

describe('POST .../stripe-connect/select — the gate is the role AT THE TARGET studio', () => {
  it('(a) refuses a manager-at-A who is plain STAFF at the target B, writing nothing', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A_STAFF_B)
    const res = await POST(post(LOC_B, { provider: 'revolut' }), props(LOC_B))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('Manager+ required')
    expect(db.writes).toEqual([])
    expect(retrieveAccountStatus).not.toHaveBeenCalled()
  })

  it('(b) lets the MANAGER AT THE TARGET through, byte-identical, with their active studio elsewhere', async () => {
    getCurrentUser.mockResolvedValue(STAFF_A_MANAGER_B)
    const res = await POST(post(LOC_B, { provider: 'revolut' }), props(LOC_B))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { provider: 'revolut' } })
    expect(db.writes[0].filters).toEqual({ id: LOC_B })
  })

  it('(c) a master passes with no per-location rows at all', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const res = await POST(post(LOC_B, { provider: 'revolut' }), props(LOC_B))
    expect(res.status).toBe(200)
    expect(db.writes).toHaveLength(1)
  })

  it('(d) 404s a non-member — the detail-route 404 is deliberate — writing nothing', async () => {
    const res = await POST(post(LOC_B, { provider: 'revolut' }), props(LOC_B))
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe('Not found')
    expect(db.writes).toEqual([])
    expect(retrieveAccountStatus).not.toHaveBeenCalled()
  })

  it('(e) 401s an anonymous caller, writing nothing', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await POST(post(LOC_A, { provider: 'revolut' }), props(LOC_A))
    expect(res.status).toBe(401)
    expect(db.writes).toEqual([])
    expect(retrieveAccountStatus).not.toHaveBeenCalled()
  })

  // TIER B — the same fixture succeeds on holidays/channels and must be
  // refused here: this route moves where real money lands.
  it('(g) TIER B: a HEAD COACH at the target is REFUSED — head_coach is NOT in this route\'s list', async () => {
    getCurrentUser.mockResolvedValue(STAFF_A_HEAD_COACH_B)
    const res = await POST(post(LOC_B, { provider: 'revolut' }), props(LOC_B))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('Manager+ required')
    expect(db.writes).toEqual([])
    expect(retrieveAccountStatus).not.toHaveBeenCalled()
  })

  it('(g\') TIER B: a HEAD COACH at their OWN studio is refused too', async () => {
    getCurrentUser.mockResolvedValue(HEAD_COACH_A)
    const res = await POST(post(LOC_A, { provider: 'revolut' }), props(LOC_A))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('Manager+ required')
    expect(db.writes).toEqual([])
  })

  it('the gate answers before the provider is even parsed', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A_STAFF_B)
    const res = await POST(post(LOC_B, { provider: 'stripe_connect' }), props(LOC_B))
    expect(res.status).toBe(403)
    expect(retrieveAccountStatus).not.toHaveBeenCalled()
  })
})
