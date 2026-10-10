// C145 TRIALDEFAULT.1 (Richard, 2 Oct) — POST /api/contacts gave every new
// contact 3 trial credits (`?? 3`), shown as "3 credits" on the contact until
// Glofox linked it. A new contact now starts with NO credit count (null) until
// Glofox says otherwise. An explicit value in the body is still stored.
// (The column DEFAULT 3 from mig 001 goes in mig 702.)

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => {} }),
  headers: async () => ({ get: () => null }),
}))
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, getCurrentUser: vi.fn(async () => null) }
})
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(), createBrowserClient: vi.fn() }))
vi.mock('@/lib/sequences', () => ({
  triggerSequencesForTagsAdded: vi.fn(async () => {}),
  triggerSequencesForPipelineStageChange: vi.fn(async () => {}),
}))
vi.mock('@/lib/sequences/triggers', () => ({ triggerSequencesForContactCreated: vi.fn(async () => {}) }))
vi.mock('@/lib/automations/glofox-lead-provisioning', () => ({ maybeProvisionLeadInGlofox: vi.fn(async () => {}) }))
vi.mock('@/lib/push-dedup', () => ({ sendPushToRolesAtLocationOnce: vi.fn(async () => {}) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logInfo: vi.fn(), logError: vi.fn() }))

import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { makeWorld, makeTenantDb, makeReq, jsonOf, users, ORG_A_KEY, LOC_A1 } from '../../../../tests/cross-tenant/fixture.js'
import * as contactsRoute from './route.js'

let world
const EMAIL = 'c145.new@example.com'
const created = () => world.contacts.filter((c) => c.email === EMAIL)

beforeEach(() => {
  vi.clearAllMocks()
  world = makeWorld()
  vi.mocked(createServerClient).mockReturnValue(makeTenantDb(world))
})

describe('POST /api/contacts — no default trial credits (C145)', () => {
  it('web form (cookie): a new contact has no credit count', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(users.managerA1())
    const { status } = await jsonOf(await contactsRoute.POST(makeReq('/api/contacts', {
      method: 'POST', body: { name: 'New Lead', email: EMAIL, location_id: LOC_A1 },
    })))
    expect(status).toBe(200)
    expect(created()).toHaveLength(1)
    expect(created()[0].trial_credits_remaining ?? null).toBeNull()
  })

  it('API key: a new contact has no credit count either', async () => {
    const { status } = await jsonOf(await contactsRoute.POST(makeReq('/api/contacts', {
      method: 'POST', bearer: ORG_A_KEY, body: { name: 'New Lead', email: EMAIL, location_id: LOC_A1 },
    })))
    expect(status).toBe(200)
    expect(created()[0].trial_credits_remaining ?? null).toBeNull()
  })

  it('an explicit value in the body is still stored', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(users.managerA1())
    await contactsRoute.POST(makeReq('/api/contacts', {
      method: 'POST', body: { name: 'New Lead', email: EMAIL, location_id: LOC_A1, trial_credits_remaining: 2 },
    }))
    expect(created()[0].trial_credits_remaining).toBe(2)
  })
})
