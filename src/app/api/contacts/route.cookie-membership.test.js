// SECFIX.2 — POST /api/contacts on the cookie path creates a contact only at
// a location the caller belongs to. Before this, `requireApiKeyOrManager`
// said "Manager+ at the active studio" and nothing checked the body's
// location_id, so a cookie manager could create a contact (and fire its
// new-lead push, contact-created sequences and Glofox lead provisioning) at
// ANY location id, another organisation's included.
//
// Real handler + real guard helpers against the two-tenant world from the
// cross-tenant harness; only getCurrentUser is swapped for the persona.

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
import { sendPushToRolesAtLocationOnce } from '@/lib/push-dedup'
import { triggerSequencesForContactCreated } from '@/lib/sequences/triggers'
import { maybeProvisionLeadInGlofox } from '@/lib/automations/glofox-lead-provisioning'
import { makeWorld, makeTenantDb, makeReq, jsonOf, users, LOC_A1, LOC_A2, LOC_B1 } from '../../../../tests/cross-tenant/fixture.js'
import * as contactsRoute from './route.js'

let world

beforeEach(() => {
  vi.clearAllMocks()
  world = makeWorld()
  vi.mocked(createServerClient).mockReturnValue(makeTenantDb(world))
})

const NEW_EMAIL = 'secfix2.new@example.com'
const create = (persona, body) => {
  vi.mocked(getCurrentUser).mockResolvedValue(users[persona]())
  return contactsRoute.POST(makeReq('/api/contacts', {
    method: 'POST',
    body: { name: 'New Lead', email: NEW_EMAIL, ...body },
  }))
}
const created = () => world.contacts.filter((c) => c.email === NEW_EMAIL)

describe('POST /api/contacts — cookie caller creates only where they belong', () => {
  it('a manager at A1 creating at org B is refused (403) and nothing is created or fired', async () => {
    const { status } = await jsonOf(await create('managerA1', { location_id: LOC_B1 }))
    expect(status).toBe(403)
    expect(created()).toEqual([])
    expect(sendPushToRolesAtLocationOnce).not.toHaveBeenCalled()
    expect(triggerSequencesForContactCreated).not.toHaveBeenCalled()
    expect(maybeProvisionLeadInGlofox).not.toHaveBeenCalled()
  })

  it('a manager at A1 creating at A2 (same org, not theirs) is refused (403)', async () => {
    const { status } = await jsonOf(await create('managerA1', { location_id: LOC_A2 }))
    expect(status).toBe(403)
    expect(created()).toEqual([])
  })

  it('an owner at B1 creating at A1 is refused (403)', async () => {
    const { status } = await jsonOf(await create('ownerB1', { location_id: LOC_A1 }))
    expect(status).toBe(403)
    expect(created()).toEqual([])
  })

  it('a manager at A1 creating at A1 succeeds', async () => {
    const { status, json } = await jsonOf(await create('managerA1', { location_id: LOC_A1 }))
    expect(status).toBe(200)
    expect(json.data.location_id).toBe(LOC_A1)
    expect(created()).toHaveLength(1)
  })

  it('no location_id defaults to the active studio (A1), which the caller belongs to', async () => {
    const { status, json } = await jsonOf(await create('managerA1', {}))
    expect(status).toBe(200)
    expect(json.data.location_id).toBe(LOC_A1)
  })

  it('the org admin of A reaches A2 but not org B', async () => {
    expect((await jsonOf(await create('orgAdminA', { location_id: LOC_A2 }))).status).toBe(200)
    expect((await jsonOf(await create('orgAdminA', { location_id: LOC_B1 }))).status).toBe(403)
  })

  it('a cookie caller with no body location and no active studio gets 400 and nothing is created', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue({ ...users.managerA1(), locations: [], activeLocation: null })
    const { status, json } = await jsonOf(await contactsRoute.POST(makeReq('/api/contacts', {
      method: 'POST',
      body: { name: 'New Lead', email: NEW_EMAIL },
    })))
    expect(status).toBe(400)
    expect(json.error).toBe('location_id required')
    expect(created()).toEqual([])
  })

  it('a master may create at any location', async () => {
    const { status, json } = await jsonOf(await create('master', { location_id: LOC_B1 }))
    expect(status).toBe(200)
    expect(json.data.location_id).toBe(LOC_B1)
  })
})
