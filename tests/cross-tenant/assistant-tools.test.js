// SAAS-10 — cross-tenant boundary harness: the assistant executeTool
// surface, run against the SAME canonical two-tenant world as the route
// files (fixture.js).
//
// Deep per-tool coverage (roster, allowances, reports, permission
// gates) already lives in src/app/api/assistant/chat/route.test.js
// (SAAS-1) with its own two-location fixture. This file pins the
// tenant-data tools to the SHARED world so the whole harness asserts
// one consistent boundary: a manager operating at org-A location A1
// never receives (or writes) another tenant's rows.
//
// @/lib/auth is mocked wholesale (matching the SAAS-1 file) because
// executeTool never calls it — the mock only keeps next/headers out of
// the import graph. @/lib/supabase returns the shared double.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))

import { executeTool } from '@/app/api/assistant/chat/route.js'
import { createServerClient } from '@/lib/supabase'
import {
  makeWorld, makeTenantDb,
  ORG_A,
  LOC_A1, LOC_B1,
  C_A1, C_B1,
  SHT_A1, SHT_B1,
  P_STAFF_A1, P_MGR_A1, P_OWNER_A1, P_STAFF_B1,
} from './fixture.js'

// Manager operating at org-A location A1 — clears the gate for every tool
// under test.
//
// ASSISTREG.2 — the nine tenant-data tools now run the registry bodies in
// src/lib/agent-tools/ through src/lib/assistant/tool-bridge.js, so the
// context carries the session `user`: the registry gates read
// rolesByLocation/assignmentsByLocation, and the studio a tool acts at is
// ALWAYS user.activeLocation (the model is never offered a studio_id). These
// cross-tenant assertions are unchanged in substance — they are what proves
// the swap kept the boundary.
const LOC_A1_ROW = { id: LOC_A1, organization_id: ORG_A, name: 'A One', timezone: 'Europe/Dublin', active: true }
const MANAGER_A1 = {
  locationId: LOC_A1,
  role: 'manager',
  userId: P_MGR_A1,
  user: {
    id: P_MGR_A1,
    isMaster: false,
    rolesByLocation: { [LOC_A1]: 'manager' },
    assignmentsByLocation: { [LOC_A1]: { role: 'manager', permissions: {} } },
    activeLocation: LOC_A1_ROW,
    permissions: {},
  },
}

let world
let db

beforeEach(() => {
  vi.mocked(createServerClient).mockReset()
  world = makeWorld()
  db = makeTenantDb(world)
  vi.mocked(createServerClient).mockReturnValue(db)
})

describe('executeTool search_contacts — canonical two-tenant world', () => {
  it('a shared search token matches every tenant in the DB but only org-A/loc-A1 rows come back', async () => {
    // Every fixture contact matches 'lead' — an unscoped query would
    // return all four tenants' contacts.
    const res = await executeTool('search_contacts', { query: 'lead' }, MANAGER_A1)
    expect(res.contacts.map((c) => c.id)).toEqual([C_A1])
    expect(res.contacts.some((c) => c.location_id !== LOC_A1)).toBe(false)
  })
})

describe('executeTool list_staff — canonical two-tenant world', () => {
  it('lists only staff linked to A1, never another tenant’s roster', async () => {
    const res = await executeTool('list_staff', {}, MANAGER_A1)
    expect(res.staff.map((s) => s.id).sort()).toEqual([P_MGR_A1, P_OWNER_A1, P_STAFF_A1].sort())
    expect(res.staff.some((s) => s.id === P_STAFF_B1)).toBe(false)
  })
})

describe('executeTool create_activity — canonical two-tenant world', () => {
  it('refuses to attach an activity to another tenant’s contact and writes nothing', async () => {
    const res = await executeTool('create_activity', { subject: 'Call Bob', type: 'call', contact_id: C_B1 }, MANAGER_A1)
    expect(res.error).toMatch(/not found/i)
    expect(db._writesTo('activities').filter((w) => w.op === 'insert')).toEqual([])
  })

  it('stamps the active location on an own-tenant activity (positive control)', async () => {
    const res = await executeTool('create_activity', { subject: 'Call Alice', type: 'call', contact_id: C_A1 }, MANAGER_A1)
    expect(res.success).toBe(true)
    const insert = db._writesTo('activities').find((w) => w.op === 'insert')
    expect(insert.payload.location_id).toBe(LOC_A1)
  })
})

describe('executeTool list_shift_templates — canonical two-tenant world', () => {
  it('returns only A1 templates, never another tenant’s', async () => {
    const res = await executeTool('list_shift_templates', {}, MANAGER_A1)
    expect(res.templates.map((t) => t.id)).toEqual([SHT_A1])
    expect(res.templates.some((t) => t.id === SHT_B1)).toBe(false)
  })
})

describe('executeTool create_contact — canonical two-tenant world', () => {
  it('ignores a smuggled cross-tenant location_id and stamps the active location', async () => {
    const res = await executeTool('create_contact', { name: 'New Lead', email: 'x@x.com', location_id: LOC_B1 }, MANAGER_A1)
    // The registry body answers { existing, contact } (an email already in the
    // org is reported, not failed). location_id is not in its schema, so zod
    // strips the smuggled one before any write; the row is stamped with the
    // session's active studio.
    expect(res.error).toBeUndefined()
    expect(res.existing).toBe(false)
    const insert = db._writesTo('contacts').find((w) => w.op === 'insert')
    expect(insert.payload.location_id).toBe(LOC_A1)
  })
})
