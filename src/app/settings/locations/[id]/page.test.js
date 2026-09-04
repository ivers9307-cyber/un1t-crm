// SETTINGS-PAGE-GATE.1 — the page must refuse a location the caller is
// not a member of, BEFORE it reads anything.
//
// The defect this pins: the page gated on `user.role` (the caller's role
// at their ACTIVE location) and then read `locations` by params.id with
// the SERVICE-ROLE client, which bypasses RLS. Nothing else filtered it,
// so any owner-role caller could open ANY location id — another
// organisation's included — and have its full row server-rendered.
//
// `@/lib/auth` is only PARTIALLY mocked: getCurrentUser is a stub, but
// assertLocationAccess is the REAL function, so these tests exercise the
// guard that actually ships. next/navigation throws the way production
// does, so a guard that fires stops the handler.

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

const LOC_A = 'a0000000-0000-0000-0000-000000000001' // the caller's studio
const LOC_B = 'b0000000-0000-0000-0000-000000000002' // another org's studio

// Records every table touched, so "never reached the database" is an
// assertion and not an assumption.
function makeDb(tables = []) {
  const touched = []
  const row = {
    id: LOC_B,
    organization_id: 'org-2',
    name: 'Someone else',
    features: {},
  }
  const chain = (table) => {
    const c = {}
    for (const op of ['select', 'eq', 'in', 'order', 'limit']) c[op] = () => c
    c.single = () => Promise.resolve({ data: tables.includes(table) ? row : null })
    c.maybeSingle = () => Promise.resolve({ data: null })
    c.then = (res) => Promise.resolve({ data: table === 'organizations' ? [] : null }).then(res)
    return c
  }
  return {
    touched,
    from: (table) => {
      touched.push(table)
      return chain(table)
    },
  }
}

function user({ role, rolesByLocation, locations }) {
  return {
    id: 'u1',
    role,
    profileRole: role,
    isMaster: role === 'master',
    activeLocation: { id: LOC_A, features: {} },
    rolesByLocation,
    locations,
  }
}

describe('/settings/locations/[id] — membership gate', () => {
  let db
  beforeEach(() => {
    vi.clearAllMocks()
    db = makeDb(['locations'])
    createServerClient.mockReturnValue(db)
  })

  it('refuses a location the owner is NOT a member of, without touching the database', async () => {
    // The exploit: owner at A (so the role gate passes), no membership at
    // B, asks for B. Before the fix this rendered B's full row.
    getCurrentUser.mockResolvedValue(user({
      role: 'owner',
      rolesByLocation: { [LOC_A]: 'owner' },
      locations: [{ id: LOC_A }],
    }))

    await expect(
      EditLocationPage({ params: Promise.resolve({ id: LOC_B }), searchParams: Promise.resolve({}) })
    ).rejects.toThrow('NEXT_NOT_FOUND')

    expect(notFound).toHaveBeenCalled()
    // 404, not 403/redirect — the id must not be confirmed to exist.
    expect(redirect).not.toHaveBeenCalled()
    // The service-role client is the whole risk: it must never run.
    expect(db.touched).toEqual([])
  })

  it('lets a member owner through to the read', async () => {
    getCurrentUser.mockResolvedValue(user({
      role: 'owner',
      rolesByLocation: { [LOC_B]: 'owner' },
      locations: [{ id: LOC_B }],
    }))

    await EditLocationPage({
      params: Promise.resolve({ id: LOC_B }),
      searchParams: Promise.resolve({}),
    })

    expect(notFound).not.toHaveBeenCalled()
    expect(db.touched).toContain('locations')
  })

  it('lets a master through — they hold every active location', async () => {
    getCurrentUser.mockResolvedValue(user({
      role: 'master',
      rolesByLocation: {},
      locations: [{ id: LOC_A }, { id: LOC_B }],
    }))

    await EditLocationPage({
      params: Promise.resolve({ id: LOC_B }),
      searchParams: Promise.resolve({}),
    })

    expect(notFound).not.toHaveBeenCalled()
    expect(db.touched).toContain('locations')
  })

  it('still refuses a non-owner outright, before the membership check', async () => {
    getCurrentUser.mockResolvedValue(user({
      role: 'staff',
      rolesByLocation: { [LOC_A]: 'staff' },
      locations: [{ id: LOC_A }, { id: LOC_B }],
    }))

    await expect(
      EditLocationPage({ params: Promise.resolve({ id: LOC_B }), searchParams: Promise.resolve({}) })
    ).rejects.toThrow(/^NEXT_REDIRECT:\/$/)

    expect(db.touched).toEqual([])
  })
})
