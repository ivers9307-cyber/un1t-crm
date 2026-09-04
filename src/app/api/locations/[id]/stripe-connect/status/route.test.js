// LOCFIX-ROLEGATE.1 — GET /api/locations/[id]/stripe-connect/status reads the
// PATH-PARAM location's Stripe connected-account state.
//
// Same defect as its connect/select siblings: `user.role` resolves at the
// caller's ACTIVE location, so the old ['master','owner','manager'] check let
// a manager at studio A who is plain STAFF at studio B read B's Stripe
// posture. Read-only, so lower severity than minting — but the same class.
//
// TIER B: head_coach is deliberately excluded here, unlike holidays/channels.
// @/lib/auth is REAL (importActual) with only getCurrentUser mocked.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/payments/stripe-connect', () => ({ retrieveAccountStatus: vi.fn() }))

import { GET } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { retrieveAccountStatus } from '@/lib/payments/stripe-connect'

const LOC_A = 'a0000000-0000-0000-0000-000000000001'
const LOC_B = 'b0000000-0000-0000-0000-000000000002'

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

describe('GET stripe-connect/status — role judged at the target', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    createServerClient.mockReturnValue(db())
    retrieveAccountStatus.mockResolvedValue({ chargesEnabled: true, detailsSubmitted: true })
  })

  it('refuses a manager at A who is plain staff at the target, without calling Stripe', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A_STAFF_B)
    const res = await call()
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('Manager+ required')
    expect(retrieveAccountStatus).not.toHaveBeenCalled()
  })

  it('allows the target own manager even when their active studio is elsewhere', async () => {
    getCurrentUser.mockResolvedValue(STAFF_A_MANAGER_B)
    const res = await call()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      success: true,
      data: { connected: true, charges_enabled: true, details_submitted: true },
    })
  })

  it('allows a master', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    expect((await call()).status).toBe(200)
  })

  it('refuses a head_coach at the target — tier B excludes them, unlike holidays/channels', async () => {
    getCurrentUser.mockResolvedValue(STAFF_A_HEAD_COACH_B)
    const res = await call()
    expect(res.status).toBe(403)
    expect(retrieveAccountStatus).not.toHaveBeenCalled()
  })

  it('404s a non-member — a detail route must not confirm the id exists', async () => {
    getCurrentUser.mockResolvedValue(OUTSIDER)
    expect((await call()).status).toBe(404)
    expect(retrieveAccountStatus).not.toHaveBeenCalled()
  })

  it('401s an anonymous caller', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await call()).status).toBe(401)
    expect(retrieveAccountStatus).not.toHaveBeenCalled()
  })
})
