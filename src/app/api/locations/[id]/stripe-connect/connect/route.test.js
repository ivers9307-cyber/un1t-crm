// LOCFIX-ROLEGATE.1 — POST /api/locations/[id]/stripe-connect/connect MINTS A
// STRIPE CONNECTED ACCOUNT for the PATH-PARAM location and writes its id into
// locations.settings.payments.stripe_connected_account_id.
//
// THE GATE IS THE POINT. `user.role` resolves at the caller's ACTIVE location
// (with auth.js's highest-role-anywhere fallback), while this route acts on
// params.id — so the old `['master','owner','manager'].includes(user.role)`
// check let a manager at studio A who is plain STAFF at studio B send
//   POST /api/locations/<B>/stripe-connect/connect
// and mint a Stripe account against B, plus a hosted-onboarding link into it.
// Minting is an IRREVERSIBLE EXTERNAL side effect, so both guards run BEFORE
// any Stripe call: membership (assertLocationAccessOr404 — this is a detail
// route, the 404 is deliberate) then the role AT THE TARGET.
//
// TIER B: this route's list is ['master','owner','manager'] and deliberately
// EXCLUDES head_coach, unlike the holidays/channels routes' MANAGER_ROLES.
// Test (g) below is the half of the pair that pins the two tiers apart.
//
// Every refusal asserts BOTH an empty write log AND that no Stripe API call
// was made. @/lib/auth is REAL (importActual) with only getCurrentUser mocked.

import { describe, it, expect, vi, beforeEach } from 'vitest'

process.env.NEXT_PUBLIC_APP_URL = 'https://crm.test'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/payments/stripe-connect', () => ({
  createConnectedAccount: vi.fn(),
  createOnboardingLink: vi.fn(),
}))

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { createConnectedAccount, createOnboardingLink } from '@/lib/payments/stripe-connect'

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
// TIER B EXCLUDES head_coach — a head coach AT the target must be refused,
// even though the holidays/channels routes let the same person through.
const STAFF_A_HEAD_COACH_B = {
  id: 'u4', role: 'staff', profileRole: 'staff', isMaster: false,
  locations: [{ id: LOC_A }, { id: LOC_B }],
  rolesByLocation: { [LOC_A]: 'staff', [LOC_B]: 'head_coach' },
  activeLocation: { id: LOC_A },
}
// A head coach at their OWN active studio — the same refusal, reached by the
// route's own tier list rather than by the target mismatch.
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

// locations.select('id, name, settings').eq('id').maybeSingle()
// locations.update({ settings, updated_at }).eq('id')
// Fail LOUD on any other table.
function makeDb({ settings = {}, name = 'UN1T Studio' } = {}) {
  const writes = []
  return {
    writes,
    from(table) {
      if (table !== 'locations') throw new Error(`unexpected db.from('${table}') in stripe-connect test`)
      return {
        select() {
          let id = null
          return {
            eq: (col, val) => { id = val; return { maybeSingle: () => Promise.resolve({ data: { id, name, settings }, error: null }) } },
          }
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
const post = (id) => new Request(`http://localhost/api/locations/${id}/stripe-connect/connect`, { method: 'POST' })

const noStripeCalls = () => {
  expect(createConnectedAccount).not.toHaveBeenCalled()
  expect(createOnboardingLink).not.toHaveBeenCalled()
}

let db
beforeEach(() => {
  vi.clearAllMocks()
  db = makeDb()
  createServerClient.mockReturnValue(db)
  getCurrentUser.mockResolvedValue(MANAGER_A)
  createConnectedAccount.mockResolvedValue('acct_new123')
  createOnboardingLink.mockResolvedValue('https://connect.stripe.test/setup/abc')
})

describe('POST .../stripe-connect/connect — the legitimate flow is byte-identical', () => {
  it('a manager connecting their own studio gets exactly the body they always did', async () => {
    const res = await POST(post(LOC_A), props(LOC_A))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { url: 'https://connect.stripe.test/setup/abc' } })
  })

  it('mints the account for the TARGET location and stores its id without clobbering other settings', async () => {
    createServerClient.mockReturnValue(db = makeDb({ settings: { payments: { provider: 'revolut' }, other: 'keep' } }))
    await POST(post(LOC_A), props(LOC_A))
    expect(createConnectedAccount).toHaveBeenCalledWith({ name: 'UN1T Studio', locationId: LOC_A })
    expect(db.writes).toHaveLength(1)
    expect(db.writes[0].patch.settings).toEqual({
      other: 'keep',
      payments: { provider: 'revolut', stripe_connected_account_id: 'acct_new123' },
    })
    expect(db.writes[0].filters).toEqual({ id: LOC_A })
    expect(createOnboardingLink).toHaveBeenCalledWith({
      accountId: 'acct_new123',
      refreshUrl: `https://crm.test/api/locations/${LOC_A}/stripe-connect/refresh`,
      returnUrl: `https://crm.test/settings/locations/${LOC_A}?section=integrations&tab=payments&stripe=return`,
    })
  })

  it('reuses an existing connected account — no second mint, no settings write', async () => {
    createServerClient.mockReturnValue(db = makeDb({ settings: { payments: { stripe_connected_account_id: 'acct_old' } } }))
    const res = await POST(post(LOC_A), props(LOC_A))
    expect(res.status).toBe(200)
    expect(createConnectedAccount).not.toHaveBeenCalled()
    expect(db.writes).toEqual([])
  })
})

describe('POST .../stripe-connect/connect — the gate is the role AT THE TARGET studio', () => {
  it('(a) refuses a manager-at-A who is plain STAFF at the target B, minting nothing', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A_STAFF_B)
    const res = await POST(post(LOC_B), props(LOC_B))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('Manager+ required')
    expect(db.writes).toEqual([])
    noStripeCalls()
  })

  it('(b) lets the MANAGER AT THE TARGET through, byte-identical, with their active studio elsewhere', async () => {
    getCurrentUser.mockResolvedValue(STAFF_A_MANAGER_B)
    const res = await POST(post(LOC_B), props(LOC_B))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { url: 'https://connect.stripe.test/setup/abc' } })
    expect(createConnectedAccount).toHaveBeenCalledWith({ name: 'UN1T Studio', locationId: LOC_B })
    expect(db.writes[0].filters).toEqual({ id: LOC_B })
  })

  it('(c) a master passes with no per-location rows at all', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const res = await POST(post(LOC_B), props(LOC_B))
    expect(res.status).toBe(200)
    expect(createConnectedAccount).toHaveBeenCalledOnce()
  })

  it('(d) 404s a non-member — the detail-route 404 is deliberate — minting nothing', async () => {
    const res = await POST(post(LOC_B), props(LOC_B))
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe('Not found')
    expect(db.writes).toEqual([])
    noStripeCalls()
  })

  it('(e) 401s an anonymous caller, minting nothing', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await POST(post(LOC_A), props(LOC_A))
    expect(res.status).toBe(401)
    expect(db.writes).toEqual([])
    noStripeCalls()
  })

  // TIER B — the half of the pair that keeps the two tiers apart. The SAME
  // fixture succeeds on holidays/channels (MANAGER_ROLES includes head_coach)
  // and must be refused here: this route mints a Stripe account.
  it('(g) TIER B: a HEAD COACH at the target is REFUSED — head_coach is NOT in this route\'s list', async () => {
    getCurrentUser.mockResolvedValue(STAFF_A_HEAD_COACH_B)
    const res = await POST(post(LOC_B), props(LOC_B))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('Manager+ required')
    expect(db.writes).toEqual([])
    noStripeCalls()
  })

  it('(g\') TIER B: a HEAD COACH at their OWN studio is refused too', async () => {
    getCurrentUser.mockResolvedValue(HEAD_COACH_A)
    const res = await POST(post(LOC_A), props(LOC_A))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('Manager+ required')
    expect(db.writes).toEqual([])
    noStripeCalls()
  })
})
