// INTEG-D1 — PATCH /api/settings/billing/auto-topup: access + the
// validation bounds, and the invariant that the write payload only
// ever carries the three auto_topup config columns (never balance).

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

import { PATCH } from './route'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

beforeEach(() => vi.clearAllMocks())

const LOC_A = 'a0000000-0000-0000-0000-00000000aaa1'
const LOC_B = 'b0000000-0000-0000-0000-00000000bbb1'

const ownerA = {
  id: 'owner-a',
  role: 'owner',
  activeOrganization: { id: 'org-a' },
  rolesByLocation: { [LOC_A]: 'owner' },
  locations: [{ id: LOC_A, organization_id: 'org-a' }],
}
const master = { id: 'root', role: 'master', rolesByLocation: {}, locations: [] }

function patchReq(body) {
  return new Request('http://x/api/settings/billing/auto-topup', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// locations lookup by id (org resolution) + wallets upsert capture.
function mockDb({ locationsById = { [LOC_A]: 'org-a', [LOC_B]: 'org-b' } } = {}) {
  let upserted = null
  createServerClient.mockReturnValue({
    from: (table) => {
      if (table === 'locations') {
        return {
          select: () => ({
            eq: (_col, id) => ({
              maybeSingle: () =>
                Promise.resolve({
                  data: locationsById[id] ? { id, organization_id: locationsById[id] } : null,
                  error: null,
                }),
            }),
          }),
        }
      }
      if (table === 'wallets') {
        return {
          upsert: (patch) => {
            upserted = patch
            return {
              select: () => ({
                single: () =>
                  Promise.resolve({
                    data: {
                      auto_topup_enabled: patch.auto_topup_enabled,
                      auto_topup_amount_cents: patch.auto_topup_amount_cents ?? null,
                      auto_topup_threshold_cents: patch.auto_topup_threshold_cents ?? null,
                    },
                    error: null,
                  }),
              }),
            }
          },
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  })
  return () => upserted
}

const validBody = { location_id: LOC_A, enabled: true, amount_cents: 2000, threshold_cents: 500 }

describe('PATCH auto-topup — auth + org boundary', () => {
  it('401 when unauthenticated', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await PATCH(patchReq(validBody))).status).toBe(401)
  })

  it('403 for staff and manager', async () => {
    getCurrentUser.mockResolvedValue({ ...ownerA, role: 'staff' })
    expect((await PATCH(patchReq(validBody))).status).toBe(403)
    getCurrentUser.mockResolvedValue({ ...ownerA, role: 'manager' })
    expect((await PATCH(patchReq(validBody))).status).toBe(403)
  })

  it('200 for the owner of the location org', async () => {
    getCurrentUser.mockResolvedValue(ownerA)
    mockDb()
    expect((await PATCH(patchReq(validBody))).status).toBe(200)
  })

  it("404 (not 403) when an owner targets ANOTHER org's location", async () => {
    getCurrentUser.mockResolvedValue(ownerA)
    mockDb()
    const res = await PATCH(patchReq({ ...validBody, location_id: LOC_B }))
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe('Not found')
  })

  it('404 for a nonexistent location (identical to foreign)', async () => {
    getCurrentUser.mockResolvedValue(ownerA)
    mockDb({ locationsById: {} })
    expect((await PATCH(patchReq(validBody))).status).toBe(404)
  })

  it("master can configure any org's wallet", async () => {
    getCurrentUser.mockResolvedValue(master)
    mockDb()
    expect((await PATCH(patchReq({ ...validBody, location_id: LOC_B }))).status).toBe(200)
  })
})

describe('PATCH auto-topup — validation bounds', () => {
  beforeEach(() => {
    getCurrentUser.mockResolvedValue(ownerA)
    mockDb()
  })

  it('400 when enabled is missing or non-boolean', async () => {
    expect((await PATCH(patchReq({ location_id: LOC_A, amount_cents: 2000 }))).status).toBe(400)
    expect((await PATCH(patchReq({ ...validBody, enabled: 'yes' }))).status).toBe(400)
  })

  it('amount_cents: 500–50000, integer, nullable', async () => {
    expect((await PATCH(patchReq({ ...validBody, amount_cents: 499 }))).status).toBe(400)
    expect((await PATCH(patchReq({ ...validBody, amount_cents: 500 }))).status).toBe(200)
    expect((await PATCH(patchReq({ ...validBody, amount_cents: 50000 }))).status).toBe(200)
    expect((await PATCH(patchReq({ ...validBody, amount_cents: 50001 }))).status).toBe(400)
    expect((await PATCH(patchReq({ ...validBody, amount_cents: 1000.5 }))).status).toBe(400)
    expect((await PATCH(patchReq({ ...validBody, amount_cents: null }))).status).toBe(200)
  })

  it('threshold_cents: 0–20000, integer, nullable', async () => {
    expect((await PATCH(patchReq({ ...validBody, threshold_cents: -1 }))).status).toBe(400)
    expect((await PATCH(patchReq({ ...validBody, threshold_cents: 0 }))).status).toBe(200)
    expect((await PATCH(patchReq({ ...validBody, threshold_cents: 20000 }))).status).toBe(200)
    expect((await PATCH(patchReq({ ...validBody, threshold_cents: 20001 }))).status).toBe(400)
    expect((await PATCH(patchReq({ ...validBody, threshold_cents: null }))).status).toBe(200)
  })

  it('400 on a non-uuid location_id', async () => {
    expect((await PATCH(patchReq({ ...validBody, location_id: 'not-a-uuid' }))).status).toBe(400)
  })
})

describe('PATCH auto-topup — write shape', () => {
  it('upsert payload carries ONLY config columns — never balance_cents', async () => {
    getCurrentUser.mockResolvedValue(ownerA)
    const getUpserted = mockDb()
    await PATCH(patchReq(validBody))
    const patch = getUpserted()
    expect(Object.keys(patch).sort()).toEqual([
      'auto_topup_amount_cents',
      'auto_topup_enabled',
      'auto_topup_threshold_cents',
      'location_id',
      'updated_at',
    ])
    expect(patch).not.toHaveProperty('balance_cents')
    expect(patch.auto_topup_enabled).toBe(true)
    expect(patch.auto_topup_amount_cents).toBe(2000)
    expect(patch.auto_topup_threshold_cents).toBe(500)
  })

  it('omitted optional fields are NOT written (partial config update)', async () => {
    getCurrentUser.mockResolvedValue(ownerA)
    const getUpserted = mockDb()
    await PATCH(patchReq({ location_id: LOC_A, enabled: false }))
    const patch = getUpserted()
    expect(patch).not.toHaveProperty('auto_topup_amount_cents')
    expect(patch).not.toHaveProperty('auto_topup_threshold_cents')
    expect(patch.auto_topup_enabled).toBe(false)
  })
})
