// ROLESWEEP.1c — the contractor-invoice list picks its owner scope by the
// owner role AT the target location, never by the caller's ACTIVE studio's
// role (`user.role`). (The Xero connection routes this plan also covered —
// bills-email, connect, disconnect, status, select-tenant and the OAuth
// callback — were fixed by SECFIX.1, #1797, and are pinned by their own
// route tests.)
// Harness: tests/helpers/role-gate-probe.js.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => {} }),
  headers: async () => ({ get: () => null }),
}))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(), createBrowserClient: vi.fn() }))
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))

import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { gateProbe, runProbed } from '../helpers/role-gate-probe.js'
import { person, LOC_A, LOC_B } from '../helpers/role-sweep-callers.js'
import * as invoices from '@/app/api/invoices/route.js'

const two = (roleA, roleB, active) => person({ [LOC_A]: { role: roleA }, [LOC_B]: { role: roleB } }, active)

beforeEach(() => vi.clearAllMocks())

// ── contractor invoices list: the owner scope is judged at the target ──────
describe('GET /api/invoices — owner scope judged at the target location', () => {
  const run = async (caller, qs = '') => {
    getCurrentUser.mockResolvedValue(caller)
    const probe = gateProbe([])
    createServerClient.mockReturnValue(probe.db)
    const out = await runProbed(probe, () => invoices.GET(new Request(`http://localhost/api/invoices${qs}`)))
    return { probe, ...out }
  }
  const scoped = (probe, loc) => {
    expect(probe.tripped.table).toBe('contractor_invoices')
    expect(probe.tripped.chain).toContainEqual(['eq', 'location_id', loc])
    expect(probe.tripped.chain.some(([m, col]) => m === 'eq' && col === 'contractor_id')).toBe(false)
  }
  const ownRows = (probe) => {
    expect(probe.tripped.chain).toContainEqual(['eq', 'contractor_id', 'user-1'])
    expect(probe.tripped.chain.some(([m, col]) => m === 'eq' && col === 'location_id')).toBe(false)
  }
  it('staff at A, owner at B, A active, ?location_id=B: B\'s invoices (main: own rows only)', async () => {
    const { probe } = await run(two('staff', 'owner', LOC_A), `?location_id=${LOC_B}`)
    scoped(probe, LOC_B)
  })
  it('owner at A with B active, ?location_id=A: A\'s invoices (main: own rows only)', async () => {
    const { probe } = await run(two('owner', 'staff', LOC_B), `?location_id=${LOC_A}`)
    scoped(probe, LOC_A)
  })
  it('owner at A, A active, no location_id: A\'s invoices', async () => {
    const { probe } = await run(two('owner', 'staff', LOC_A))
    scoped(probe, LOC_A)
  })
  it('owner at A, staff at B, A active, ?location_id=B: refused', async () => {
    const { probe, status: code, body } = await run(two('owner', 'staff', LOC_A), `?location_id=${LOC_B}`)
    expect(probe.passed).toBe(false)
    expect({ code, body }).toEqual({ code: 403, body: { success: false, error: 'Forbidden — not your location' } })
  })
  it('staff at A, owner at B, A active, no location_id: own rows', async () => {
    const { probe } = await run(two('staff', 'owner', LOC_A))
    ownRows(probe)
  })
  it('staff at A and at B, ?location_id=B: own rows', async () => {
    const { probe } = await run(two('staff', 'staff', LOC_A), `?location_id=${LOC_B}`)
    ownRows(probe)
  })
})
