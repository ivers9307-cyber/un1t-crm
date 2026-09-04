// LOCFIX-ROLEGATE.1 — GET /api/locations/[id]/stripe-connect/refresh MINTS a
// fresh Stripe onboarding link for the PATH-PARAM location's connected account
// and 302s the operator's browser into it.
//
// This is connect's risk in a URL you can simply visit. The old gate read
// `user.role` — the caller's ACTIVE-location role — so a manager at studio A
// who is plain STAFF at studio B could open
//   GET /api/locations/<B>/stripe-connect/refresh
// in a browser and land inside B's Stripe onboarding. Both guards therefore
// run BEFORE createOnboardingLink.
//
// Refusals here are 302s back to the settings page (this route is reached by
// Stripe redirecting a browser, not by fetch), so "refused" is asserted as
// "redirected to settings AND no Stripe call", never as a status code alone.
//
// TIER B: head_coach deliberately excluded. @/lib/auth is REAL (importActual).

import { describe, it, expect, vi, beforeEach } from 'vitest'

process.env.NEXT_PUBLIC_APP_URL = 'https://crm.test'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/payments/stripe-connect', () => ({ createOnboardingLink: vi.fn() }))

import { GET } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { createOnboardingLink } from '@/lib/payments/stripe-connect'

const LOC_A = 'a0000000-0000-0000-0000-000000000001'
const LOC_B = 'b0000000-0000-0000-0000-000000000002'
const SETTINGS_B = `https://crm.test/settings/locations/${LOC_B}?section=integrations&tab=payments`

const at = (over) => ({ id: 'u', isMaster: false, activeLocation: { id: LOC_A }, ...over })
const MANAGER_A_STAFF_B = at({
  role: 'manager', profileRole: 'manager',
  locations: [{ id: LOC_A }, { id: LOC_B }],
  rolesByLocation: { [LOC_A]: 'manager', [LOC_B]: 'staff' },
})
const STAFF_A_MANAGER_B = at({
  role: 'staff', profileRole: 'staff',
  locations: [{ id: LOC_A }, { id: LOC_B }],
  rolesByLocation: { [LOC_A]: 'staff', [LOC_B]: 'manager' },
})
const STAFF_A_HEAD_COACH_B = at({
  role: 'staff', profileRole: 'staff',
  locations: [{ id: LOC_A }, { id: LOC_B }],
  rolesByLocation: { [LOC_A]: 'staff', [LOC_B]: 'head_coach' },
})
const MASTER = at({ role: 'master', profileRole: 'master', isMaster: true, locations: [{ id: LOC_A }, { id: LOC_B }], rolesByLocation: {} })
const OUTSIDER = at({ role: 'manager', profileRole: 'manager', locations: [{ id: LOC_A }], rolesByLocation: { [LOC_A]: 'manager' } })

function db() {
  return {
    from: (table) => {
      if (table !== 'locations') throw new Error(`unexpected table ${table}`)
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({
              data: { settings: { payments: { stripe_connected_account_id: 'acct_B' } } },
            }),
          }),
        }),
      }
    },
  }
}
const call = () => GET({}, { params: Promise.resolve({ id: LOC_B }) })

describe('GET stripe-connect/refresh — role judged at the target', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    createServerClient.mockReturnValue(db())
    createOnboardingLink.mockResolvedValue('https://connect.stripe.com/setup/acct_B')
  })

  it('refuses a manager at A who is plain staff at the target — no onboarding link is minted', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A_STAFF_B)
    const res = await call()
    expect(res.headers.get('location')).toBe(SETTINGS_B)
    expect(createOnboardingLink).not.toHaveBeenCalled()
  })

  it('sends the target own manager into Stripe, even when their active studio is elsewhere', async () => {
    getCurrentUser.mockResolvedValue(STAFF_A_MANAGER_B)
    const res = await call()
    expect(res.headers.get('location')).toBe('https://connect.stripe.com/setup/acct_B')
    expect(createOnboardingLink).toHaveBeenCalledTimes(1)
  })

  it('sends a master into Stripe', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const res = await call()
    expect(res.headers.get('location')).toBe('https://connect.stripe.com/setup/acct_B')
  })

  it('refuses a head_coach at the target — tier B excludes them', async () => {
    getCurrentUser.mockResolvedValue(STAFF_A_HEAD_COACH_B)
    const res = await call()
    expect(res.headers.get('location')).toBe(SETTINGS_B)
    expect(createOnboardingLink).not.toHaveBeenCalled()
  })

  it('refuses a non-member', async () => {
    getCurrentUser.mockResolvedValue(OUTSIDER)
    const res = await call()
    expect(res.headers.get('location')).toBe(SETTINGS_B)
    expect(createOnboardingLink).not.toHaveBeenCalled()
  })

  it('bounces an anonymous caller without touching Stripe', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await call()
    expect(res.headers.get('location')).toBe(SETTINGS_B)
    expect(createOnboardingLink).not.toHaveBeenCalled()
  })
})
