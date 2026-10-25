// TENANTSCOPE.1 — the Cars Reports page reads the ACTIVE studio's cars for
// everyone, and no active studio means no cars, never every tenant's.

import { describe, it, expect, vi } from 'vitest'

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => {} }),
  headers: async () => ({ get: () => null }),
}))
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(), createBrowserClient: vi.fn() }))
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url) => {
    const err = new Error(`NEXT_REDIRECT:${url}`)
    err.digest = `NEXT_REDIRECT;${url}`
    throw err
  }),
}))
vi.mock('@/lib/fx', () => ({ getCachedGbpToEur: vi.fn(async () => ({ rate: 1.17 })) }))
vi.mock('@/components/cars/CarsReports', () => ({ default: () => null }))
vi.mock('@/lib/cars', async (importOriginal) => ({
  ...(await importOriginal()),
  computeReportMetrics: vi.fn(() => ({})),
}))

import CarsReportsPage from './page.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { computeReportMetrics } from '@/lib/cars'
import {
  makeWorld, makeTenantDb, users, withActiveLocation, LOC_A1, LOC_B1,
} from '../../../../tests/cross-tenant/fixture.js'

function carsWorld() {
  const w = makeWorld()
  w.cars = [
    { id: 'car-a1', location_id: LOC_A1, uk_reg: 'AA11 AAA' },
    { id: 'car-b1', location_id: LOC_B1, uk_reg: 'BB22 BBB' },
  ]
  return w
}

async function renderFor(user) {
  vi.mocked(computeReportMetrics).mockClear()
  vi.mocked(getCurrentUser).mockResolvedValue(user)
  vi.mocked(createServerClient).mockReturnValue(makeTenantDb(carsWorld()))
  return CarsReportsPage()
}

describe('/cars/reports — the active studio only (TENANTSCOPE.1)', () => {
  it('no active studio gets no cars and says so, not every tenant\'s cars', async () => {
    const u = users.ownerA1()
    const el = await renderFor({
      ...u,
      activeLocation: null,
      activeOrganization: null,
      activeAssignment: { ...u.activeAssignment, permissions: { car_processing: true } },
    })
    expect(el.props.error).toBe('No active location')
    expect(vi.mocked(computeReportMetrics).mock.calls[0][0]).toEqual([]) // main: both tenants' cars
  })

  it("a master sees the active studio's cars (unchanged)", async () => {
    await renderFor(withActiveLocation(users.master(), LOC_B1))
    expect(vi.mocked(computeReportMetrics).mock.calls[0][0].map((c) => c.id)).toEqual(['car-b1'])
  })
})
