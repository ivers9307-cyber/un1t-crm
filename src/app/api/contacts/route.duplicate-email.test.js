// W0.6 — POST /api/contacts used to echo Postgres's unique-violation message
// on a duplicate email: it named the index and confirmed the address existed
// somewhere in the estate, an existence oracle across tenants. A duplicate now
// answers a generic 409 (contacts_email_org_unique, mig 712, is per
// organisation, so "already exists in your organisation" is the truth); any
// other insert failure answers a generic 400 with the Postgres text kept for
// the logs.

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
import { makeReq, jsonOf, users, LOC_A1 } from '../../../../tests/cross-tenant/fixture.js'
import * as contactsRoute from './route.js'

// The cross-tenant fixture's insert always succeeds, so the refusal is a db
// whose contacts INSERT answers exactly what PostgREST would.
function dbRefusingInsert(error) {
  return {
    from: (table) => {
      if (table !== 'contacts') throw new Error(`unexpected table ${table}`)
      return { insert: () => ({ select: () => ({ single: async () => ({ data: null, error }) }) }) }
    },
  }
}

const RAW_23505 = 'duplicate key value violates unique constraint "contacts_email_org_unique"'

beforeEach(() => {
  vi.clearAllMocks()
  delete process.env.CRM_API_KEY
  vi.mocked(getCurrentUser).mockResolvedValue(users.managerA1())
})

describe('POST /api/contacts — insert failures never echo Postgres (W0.6)', () => {
  it('a duplicate email answers a generic 409 that never names the index', async () => {
    vi.mocked(createServerClient).mockReturnValue(dbRefusingInsert({ code: '23505', message: RAW_23505 }))
    const { status, json: body } = await jsonOf(await contactsRoute.POST(makeReq('/api/contacts', {
      method: 'POST', body: { name: 'Dup Lead', email: 'dup@example.com', location_id: LOC_A1 },
    })))
    expect(status).toBe(409)
    expect(body).toEqual({ success: false, error: 'A contact with this email already exists in your organisation' })
    expect(JSON.stringify(body)).not.toMatch(/contacts_email|duplicate key/)
  })

  it('any other failure answers a generic 400 without the Postgres text', async () => {
    vi.mocked(createServerClient).mockReturnValue(dbRefusingInsert({ code: '23502', message: 'null value in column "name" violates not-null constraint' }))
    const { status, json: body } = await jsonOf(await contactsRoute.POST(makeReq('/api/contacts', {
      method: 'POST', body: { name: 'Odd Lead', email: 'odd@example.com', location_id: LOC_A1 },
    })))
    expect(status).toBe(400)
    expect(body).toEqual({ success: false, error: 'Could not create contact' })
  })
})
