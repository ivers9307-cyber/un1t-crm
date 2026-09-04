// SETTINGS-PAGE-GATE.1 (#1592) + .2 — the page must judge BOTH membership
// and role against the location in the URL, and must read only that
// location's own organisation.
//
// The defect: the page gated on `user.role`, the caller's role at their
// ACTIVE location, then read `locations` by params.id with the
// SERVICE-ROLE client, which bypasses RLS. That was wrong in both
// directions — an owner anywhere could open any location id (a
// cross-tenant read, .1), and an owner AT the target whose active studio
// was elsewhere was bounced from a page that is entirely theirs (.2).
//
// `@/lib/auth` is only PARTIALLY mocked: getCurrentUser is a stub, but
// assertLocationAccess and guardMasterOrOwner are the REAL functions, so
// these tests exercise the guards that actually ship. next/navigation
// throws the way production does, so a guard that fires stops the handler.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('next/navigation', () => ({
  redirect: vi.fn((url) => {
    const err = new Error(`NEXT_REDIRECT:${url}`)
    err.digest = `NEXT_REDIRECT;${url}`
    throw err
  }),
  notFound: vi.fn(() => {
    const err = new Error('NEXT_NOT_FOUND')
    err.digest = 'NEXT_NOT_FOUND'
    throw err
  }),
}))

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal()),
  getCurrentUser: vi.fn(),
}))

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

import EditLocationPage from './page.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { notFound, redirect } from 'next/navigation'

const LOC_A = 'a0000000-0000-0000-0000-000000000001' // the caller's own studio
const LOC_B = 'b0000000-0000-0000-0000-000000000002' // another org's studio
const ORG_B = 'c0000000-0000-0000-0000-000000000003'

// Records every table touched AND every filter, so "never reached the
// database" and "read only ITS OWN org" are assertions, not assumptions.
function makeDb() {
  const touched = []
  const filters = []
  const from = (table) => {
    touched.push(table)
    const c = {}
    for (const op of ['select', 'in', 'order', 'limit']) c[op] = () => c
    c.eq = (col, val) => { filters.push({ table, col, val }); return c }
    c.single = () => Promise.resolve({
      data: table === 'locations'
        ? { id: LOC_B, organization_id: ORG_B, name: 'Someone else', features: {} }
        : null,
    })
    c.maybeSingle = () => Promise.resolve({
      data: table === 'organizations' ? { id: ORG_B, name: 'Another Org' } : null,
    })
    return c
  }
  return { touched, filters, from }
}

// role = the ACTIVE-location role (the field the page used to trust);
// rolesByLocation = the per-location truth the guards actually read.
function user({ role, profileRole = role, rolesByLocation, locations }) {
  return {
    id: 'u1',
    role,
    profileRole,
    isMaster: profileRole === 'master',
    activeLocation: { id: LOC_A, features: {} },
    rolesByLocation,
    locations,
  }
}

const call = () => EditLocationPage({
  params: Promise.resolve({ id: LOC_B }),
  searchParams: Promise.resolve({}),
})

describe('/settings/locations/[id] — gates judge the location in the URL', () => {
  let db
  beforeEach(() => {
    vi.clearAllMocks()
    db = makeDb()
    createServerClient.mockReturnValue(db)
  })

  it('refuses a location the owner is NOT a member of, without touching the database', async () => {
    // The .1 exploit: owner at A, no membership at B, asks for B.
    getCurrentUser.mockResolvedValue(user({
      role: 'owner',
      rolesByLocation: { [LOC_A]: 'owner' },
      locations: [{ id: LOC_A }],
    }))

    await expect(call()).rejects.toThrow('NEXT_NOT_FOUND')

    expect(notFound).toHaveBeenCalled()
    // 404, not 403/redirect — the id must not be confirmed to exist.
    expect(redirect).not.toHaveBeenCalled()
    // The service-role client is the whole risk: it must never run.
    expect(db.touched).toEqual([])
  })

  it('refuses a MEMBER who is only staff at the target, even though their ACTIVE role is owner', async () => {
    // The tightening half of .2: this caller could open the page before,
    // and every Save on it has 403'd since #1589.
    getCurrentUser.mockResolvedValue(user({
      role: 'owner',
      rolesByLocation: { [LOC_A]: 'owner', [LOC_B]: 'staff' },
      locations: [{ id: LOC_A }, { id: LOC_B }],
    }))

    await expect(call()).rejects.toThrow(/^NEXT_REDIRECT:\/$/)

    // A member already knows the id exists, so this one redirects.
    expect(notFound).not.toHaveBeenCalled()
    expect(db.touched).toEqual([])
  })

  it('lets an owner AT the target in, even when their active studio is elsewhere', async () => {
    // The false-refusal half of .2 — the page is entirely theirs.
    getCurrentUser.mockResolvedValue(user({
      role: 'staff',
      rolesByLocation: { [LOC_A]: 'staff', [LOC_B]: 'owner' },
      locations: [{ id: LOC_A }, { id: LOC_B }],
    }))

    await call()

    expect(notFound).not.toHaveBeenCalled()
    expect(redirect).not.toHaveBeenCalled()
    expect(db.touched).toContain('locations')
  })

  it('lets a master through — they hold every active location', async () => {
    getCurrentUser.mockResolvedValue(user({
      role: 'staff',
      profileRole: 'master',
      rolesByLocation: {},
      locations: [{ id: LOC_A }, { id: LOC_B }],
    }))

    await call()

    expect(notFound).not.toHaveBeenCalled()
    expect(db.touched).toContain('locations')
  })

  it('reads only the location OWN organisation, never the whole estate', async () => {
    getCurrentUser.mockResolvedValue(user({
      role: 'owner',
      rolesByLocation: { [LOC_B]: 'owner' },
      locations: [{ id: LOC_B }],
    }))

    await call()

    const orgFilters = db.filters.filter(f => f.table === 'organizations')
    expect(orgFilters).toEqual([{ table: 'organizations', col: 'id', val: ORG_B }])
    // The old shape listed every active org and picked one client-side.
    expect(orgFilters.some(f => f.col === 'active')).toBe(false)
  })
})
