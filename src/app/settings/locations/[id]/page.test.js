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
function makeDb({ errors = {}, location = null } = {}) {
  const touched = []
  const filters = []
  const from = (table) => {
    touched.push(table)
    const c = {}
    for (const op of ['select', 'in', 'order', 'limit']) c[op] = () => c
    c.eq = (col, val) => { filters.push({ table, col, val }); return c }
    c.single = () => Promise.resolve({
      data: table === 'locations'
        ? (location || { id: LOC_B, organization_id: ORG_B, name: 'Someone else', features: {} })
        : null,
    })
    c.maybeSingle = () => Promise.resolve(errors[table]
      ? { data: null, error: errors[table] }
      : { data: table === 'organizations' ? { id: ORG_B, name: 'Another Org' } : null })
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

// CHANNELREAD.1 — the xero_connections read discarded its error, so a blip
// rendered "Not connected." + Connect Xero over a live connection (and
// Connect starts an OAuth rebind). The page now tells the tab.
function findElement(node, name) {
  if (!node || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const n of node) { const f = findElement(n, name); if (f) return f }
    return null
  }
  if (node.type && node.type.name === name) return node
  return findElement(node.props?.children, name)
}

describe('/settings/locations/[id] — a failed Xero read (CHANNELREAD.1)', () => {
  const owner = () => user({ role: 'owner', rolesByLocation: { [LOC_B]: 'owner' }, locations: [{ id: LOC_B }] })
  const xeroTab = () => EditLocationPage({ params: Promise.resolve({ id: LOC_B }), searchParams: Promise.resolve({ tab: 'xero' }) })

  it('passes xeroReadFailed to the integrations tabs', async () => {
    getCurrentUser.mockResolvedValue(owner())
    createServerClient.mockReturnValue(makeDb({ errors: { xero_connections: { message: 'boom' } } }))
    const el = findElement(await xeroTab(), 'LocationIntegrations')
    expect(el).toBeTruthy()
    expect(el.props.xeroReadFailed).toBe(true)
    expect(el.props.xeroConnection).toBeNull()
  })

  it('pin: a good read (no row) is not a failure', async () => {
    getCurrentUser.mockResolvedValue(owner())
    createServerClient.mockReturnValue(makeDb())
    const el = findElement(await xeroTab(), 'LocationIntegrations')
    expect(el.props.xeroReadFailed).toBe(false)
  })
})

// ACDEVLOC.1 — every component on this page is a client component, so the
// `location` prop is serialised into the HTML. The Sensibo key and ThinQ PAT
// used to go with it (select('*')), and the AC tab prefilled them into a
// plain-text input.
describe('/settings/locations/[id] — AC credentials never reach the browser (ACDEVLOC.1)', () => {
  const owner = () => user({ role: 'owner', rolesByLocation: { [LOC_B]: 'owner' }, locations: [{ id: LOC_B }] })
  const xeroTab = () => EditLocationPage({ params: Promise.resolve({ id: LOC_B }), searchParams: Promise.resolve({ tab: 'xero' }) })
  const ROW = {
    id: LOC_B, organization_id: ORG_B, name: 'Someone else', features: {},
    sensibo_api_key: 'sk-synthetic-not-real', thinq_pat: 'pat-synthetic-not-real', thinq_client_id: 'cid-1',
  }

  it('hands the integrations tabs has_* flags, not the key or the PAT', async () => {
    getCurrentUser.mockResolvedValue(owner())
    createServerClient.mockReturnValue(makeDb({ location: ROW }))
    const el = findElement(await xeroTab(), 'LocationIntegrations')
    expect(el.props.location.has_sensibo_key).toBe(true)
    expect(el.props.location.has_thinq_pat).toBe(true)
    expect(el.props.location.thinq_client_id).toBe('cid-1')
    expect(JSON.stringify(el.props.location)).not.toContain('synthetic-not-real')
  })

  it('the Details tab (LocationForm) gets the same redacted row', async () => {
    getCurrentUser.mockResolvedValue(owner())
    createServerClient.mockReturnValue(makeDb({ location: ROW }))
    const tree = await EditLocationPage({ params: Promise.resolve({ id: LOC_B }), searchParams: Promise.resolve({}) })
    const el = findElement(tree, 'LocationForm')
    expect(el).toBeTruthy()
    expect(JSON.stringify(el.props.location)).not.toContain('synthetic-not-real')
  })
})
