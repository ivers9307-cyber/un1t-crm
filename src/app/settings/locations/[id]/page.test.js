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

// C35 SECFIX.3a — one case below runs the REAL getCurrentUser (the stub
// delegates to it), which reads its session through next/headers +
// @supabase/ssr and its rows through a service-role @supabase/supabase-js
// client. Every other case stubs getCurrentUser and never reaches these.
let sessionUser = null
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => {} }),
  headers: async () => ({ get: () => null }),
}))
vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(() => ({ auth: { getUser: async () => ({ data: { user: sessionUser } }) } })),
}))
vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn() }))

import EditLocationPage from './page.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { notFound, redirect } from 'next/navigation'
import { createClient } from '@supabase/supabase-js'
import { LOCATION_SECRET_MASK } from '@/lib/location-secrets'

const LOC_A = 'a0000000-0000-0000-0000-000000000001' // the caller's own studio
const LOC_B = 'b0000000-0000-0000-0000-000000000002' // another org's studio
const ORG_B = 'c0000000-0000-0000-0000-000000000003'

// Records every table touched AND every filter, so "never reached the
// database" and "read only ITS OWN org" are assertions, not assumptions.
function makeDb({ errors = {}, location = null, locationError = null } = {}) {
  const touched = []
  const filters = []
  const from = (table) => {
    touched.push(table)
    const c = {}
    for (const op of ['select', 'in', 'order', 'limit']) c[op] = () => c
    c.eq = (col, val) => { filters.push({ table, col, val }); return c }
    c.single = () => Promise.resolve(table === 'locations' && locationError
      ? { data: null, error: locationError }
      : {
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

// Walks the server-rendered element tree for a component by name.
function findElement(node, name) {
  if (!node || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const n of node) { const f = findElement(n, name); if (f) return f }
    return null
  }
  if (node.type && node.type.name === name) return node
  return findElement(node.props?.children, name)
}

// REVIEWNITS.1 (D5, from CHANNELREAD.1): the location read's error was
// dropped, so a failed read showed the 404 page ("not found") for a location
// that exists. It now says the read failed, with Try again; no row is still
// a 404.
describe('/settings/locations/[id] — a failed location read', () => {
  const owner = () => user({ role: 'owner', rolesByLocation: { [LOC_B]: 'owner' }, locations: [{ id: LOC_B }] })

  it('says the read failed (Try again), not "not found", and renders no form', async () => {
    getCurrentUser.mockResolvedValue(owner())
    createServerClient.mockReturnValue(makeDb({ locationError: { code: 'XX000', message: 'connection reset' } }))
    const el = await call()
    expect(notFound).not.toHaveBeenCalled()
    const note = findElement(el, 'ReadFailedNote')
    expect(note).toBeTruthy()
    expect(note.props.href).toBe(`/settings/locations/${LOC_B}`)
    expect(findElement(el, 'LocationForm')).toBeNull()
  })

  it('no row at all is still a 404', async () => {
    getCurrentUser.mockResolvedValue(owner())
    createServerClient.mockReturnValue(makeDb({ locationError: { code: 'PGRST116', message: 'no rows' } }))
    await expect(call()).rejects.toThrow()
    expect(notFound).toHaveBeenCalled()
  })
})

// INTEGONE.1 — the per-location Integrations tab is retired: every hosted tab
// lives in the Integrations hub's Manage drawer. Every URL of the old tab
// (?section=integrations, ?tab=<provider>, both of which are still produced by
// old bookmarks, emails and any Stripe / Xero redirect minted before the
// change) lands on the hub with that provider's drawer open, carrying the
// rest of the query (the Stripe return and the Xero callback codes are read
// on the hub page). Only AFTER both gates, and before any read.
const HUB = '/settings/integrations-hub'
describe('/settings/locations/[id] — old Integrations-tab URLs redirect into the hub (INTEGONE.1)', () => {
  const owner = () => user({ role: 'owner', rolesByLocation: { [LOC_B]: 'owner' }, locations: [{ id: LOC_B }] })
  const visit = (searchParams) => EditLocationPage({ params: Promise.resolve({ id: LOC_B }), searchParams: Promise.resolve(searchParams) })
  let db
  beforeEach(() => {
    vi.clearAllMocks()
    db = makeDb()
    createServerClient.mockReturnValue(db)
    getCurrentUser.mockResolvedValue(owner())
  })

  const cases = [
    [{ tab: 'xero' }, `${HUB}?manage=xero&location=${LOC_B}`],
    [{ section: 'integrations', tab: 'glofox' }, `${HUB}?manage=glofox&location=${LOC_B}`],
    // the one renamed key
    [{ section: 'integrations', tab: 'ac-devices' }, `${HUB}?manage=climate&location=${LOC_B}`],
    // the bare Integrations section: the hub with nothing open
    [{ section: 'integrations' }, `${HUB}?location=${LOC_B}`],
    // the Stripe Connect return (what returnUrls minted before the change carry)
    [{ section: 'integrations', tab: 'payments', stripe: 'return' }, `${HUB}?manage=payments&location=${LOC_B}&stripe=return`],
    // the Xero callback's outcome codes (XeroCallbackNotice renders on the hub)
    [{ tab: 'xero', xero_connected: '1', xero_orgs: '2' }, `${HUB}?manage=xero&location=${LOC_B}&xero_connected=1&xero_orgs=2`],
    [{ tab: 'xero', xero_error: 'declined' }, `${HUB}?manage=xero&location=${LOC_B}&xero_error=declined`],
    // a manage/location already on the URL is replaced, never doubled
    [{ tab: 'xero', manage: 'bca', location: 'someone-else' }, `${HUB}?manage=xero&location=${LOC_B}`],
  ]
  for (const [query, target] of cases) {
    it(`${new URLSearchParams(query).toString()} → ${target.slice(HUB.length)}`, async () => {
      await expect(visit(query)).rejects.toThrow(`NEXT_REDIRECT:${target}`)
      expect(notFound).not.toHaveBeenCalled()
      // Nothing on this page is needed to answer it.
      expect(db.touched).toEqual([])
    })
  }

  it('a stranger asking for an old tab URL still gets the 404, never a redirect that confirms the id', async () => {
    getCurrentUser.mockResolvedValue(user({ role: 'owner', rolesByLocation: { [LOC_A]: 'owner' }, locations: [{ id: LOC_A }] }))
    await expect(visit({ tab: 'xero' })).rejects.toThrow('NEXT_NOT_FOUND')
    expect(redirect).not.toHaveBeenCalled()
  })

  it('a member who is not owner here is bounced home, not into the hub', async () => {
    getCurrentUser.mockResolvedValue(user({
      role: 'owner', rolesByLocation: { [LOC_A]: 'owner', [LOC_B]: 'staff' }, locations: [{ id: LOC_A }, { id: LOC_B }],
    }))
    await expect(visit({ section: 'integrations', tab: 'xero' })).rejects.toThrow(/^NEXT_REDIRECT:\/$/)
  })

  it('the section strip offers no Integrations tab, and the page reads nothing an integration needed', async () => {
    const tree = await visit({})
    const hrefs = []
    const walk = (n) => {
      if (!n || typeof n !== 'object') return
      if (Array.isArray(n)) { n.forEach(walk); return }
      if (typeof n.props?.href === 'string') hrefs.push(n.props.href)
      walk(n.props?.children)
    }
    walk(tree)
    expect(hrefs).toContain('?section=details')
    expect(hrefs.some((h) => h.includes('section=integrations'))).toBe(false)
    expect(hrefs).toContain(HUB)
    expect(db.touched.sort()).toEqual(['locations', 'organizations'])
  })
})

// ACDEVLOC.1 — every component on this page is a client component, so the
// `location` prop is serialised into the HTML. The Sensibo key and ThinQ PAT
// used to go with it (select('*')), and the AC tab prefilled them into a
// plain-text input.
//
// These cases cover the `location` PROP. The `user` prop (which this page and
// AppShell also hand to client components) is the last case: C35 SECFIX.3a
// redacts it at its source, getCurrentUser().
describe('/settings/locations/[id] — the location prop carries no AC credentials (ACDEVLOC.1)', () => {
  const owner = () => user({ role: 'owner', rolesByLocation: { [LOC_B]: 'owner' }, locations: [{ id: LOC_B }] })
  const ROW = {
    id: LOC_B, organization_id: ORG_B, name: 'Someone else', features: {},
    sensibo_api_key: 'sk-synthetic-not-real', thinq_pat: 'pat-synthetic-not-real', thinq_client_id: 'cid-1',
  }

  it('the Details tab (LocationForm) gets a redacted row: has_* flags, never the key or the PAT', async () => {
    getCurrentUser.mockResolvedValue(owner())
    createServerClient.mockReturnValue(makeDb({ location: ROW }))
    const tree = await EditLocationPage({ params: Promise.resolve({ id: LOC_B }), searchParams: Promise.resolve({}) })
    const el = findElement(tree, 'LocationForm')
    expect(el).toBeTruthy()
    expect(el.props.location.has_sensibo_key).toBe(true)
    expect(el.props.location.has_thinq_pat).toBe(true)
    expect(el.props.location.thinq_client_id).toBe('cid-1')
    expect(JSON.stringify(el.props.location)).not.toContain('synthetic-not-real')
  })

  // C35 SECFIX.3b — the `location` prop's `settings` used to carry the Glofox
  // and UniFi credentials in clear (those tabs prefilled from it and wrote the
  // slice back from the browser). They are write-only clients of the masked
  // PUT now, so the prop keeps each credential's presence and never its value.
  // bca_config (no credential) still crosses whole: the BCA tab prefills from
  // it and its status reads send_from.
  it('the location prop carries no settings credential; presence and bca_config survive (C35 SECFIX.3b)', async () => {
    const SECRET_ROW = {
      ...ROW,
      bca_config: { send_from: 'cars@example.test', send_to: 'bca@example.test' },
      settings: {
        glofox: { branch_id: 'b1', api_key: 'gk-synthetic-not-real', api_token: 'gt-synthetic-not-real', webhook_secret: 'gw-synthetic-not-real', trial_membership_id: 'm1' },
        unifi: { host: 'https://unifi.example', api_token: 'ut-synthetic-not-real' },
        customer_agent: { enabled: true },
      },
    }
    getCurrentUser.mockResolvedValue(owner())
    createServerClient.mockReturnValue(makeDb({ location: SECRET_ROW }))
    // (The hub drawer's copy of this row is pinned by its own route test.)
    for (const [searchParams, component] of [[{}, 'LocationForm']]) {
      const tree = await EditLocationPage({ params: Promise.resolve({ id: LOC_B }), searchParams: Promise.resolve(searchParams) })
      const loc = findElement(tree, component).props.location
      expect(JSON.stringify(loc), component).not.toContain('synthetic-not-real')
      expect(loc.settings.glofox).toEqual({ branch_id: 'b1', api_key: LOCATION_SECRET_MASK, api_token: LOCATION_SECRET_MASK, webhook_secret: LOCATION_SECRET_MASK, trial_membership_id: 'm1' })
      expect(loc.settings.unifi).toEqual({ host: 'https://unifi.example', api_token: LOCATION_SECRET_MASK })
      expect(loc.settings.customer_agent).toEqual({ enabled: true })
      expect(loc.bca_config).toEqual(SECRET_ROW.bca_config)
    }
  })

  // C35 SECFIX.3a — the `user` prop. getCurrentUser() used to load full
  // `locations` rows, so this page (and AppShell, on every page) serialised
  // the Sensibo key, the ThinQ PAT and the `settings` credentials into the
  // HTML through `user`. Here getCurrentUser is the REAL function, run
  // against a service-role double whose location embed carries every stored
  // credential (the double ignores the select list, so this proves the
  // redaction, not just the named columns), and the page's own read hands
  // back the same raw row. Nothing the page passes as `user` may carry a value.
  it('the user prop carries no Sensibo key, ThinQ PAT or settings (C35 SECFIX.3a, PROFILESPREAD.1)', async () => {
    const SECRET_ROW = {
      ...ROW,
      settings: {
        glofox: { branch_id: 'b1', api_key: 'gk-synthetic-not-real', api_token: 'gt-synthetic-not-real', webhook_secret: 'gw-synthetic-not-real' },
        unifi: { host: 'https://unifi.example', api_token: 'ut-synthetic-not-real' },
      },
    }
    const profile = { id: 'u-owner', role: 'owner', full_name: 'Owner', email: 'owner@example.test', active: true }
    const rows = {
      profiles: { data: profile },
      profile_locations: { data: [{ profile_id: profile.id, location_id: LOC_B, role: 'owner', is_default: true, permissions: {}, locations: SECRET_ROW }] },
      organizations: { data: [{ id: ORG_B, name: 'Another Org', active: true }] },
      profile_organizations: { data: [] },
      location_role_permissions: { data: [] },
    }
    // A thenable builder that accepts any chain and answers per table.
    const serviceRole = {
      from: (table) => {
        const b = new Proxy({}, {
          get: (_, k) => (k === 'then'
            ? (res, rej) => Promise.resolve(rows[table] || { data: null }).then(res, rej)
            : () => b),
        })
        return b
      },
    }
    createClient.mockReturnValue(serviceRole)
    sessionUser = { id: profile.id, email: profile.email }
    const { getCurrentUser: realGetCurrentUser } = await vi.importActual('@/lib/auth')
    getCurrentUser.mockImplementation(realGetCurrentUser)
    createServerClient.mockReturnValue(makeDb({ location: SECRET_ROW }))

    try {
      const tree = await EditLocationPage({ params: Promise.resolve({ id: LOC_B }), searchParams: Promise.resolve({ section: 'branding' }) })
      const passedUser = findElement(tree, 'BrandingSettings').props.user
      expect(passedUser.id).toBe(profile.id)
      expect(JSON.stringify(passedUser)).not.toContain('synthetic-not-real')
      // PROFILESPREAD.1 — no location on it carries settings or a credential
      // column at all (the pick drops them even from this raw embed).
      expect(passedUser.activeLocation).not.toHaveProperty('settings')
      expect(passedUser.locations[0]).not.toHaveProperty('settings')
      expect(passedUser.locations[0]).not.toHaveProperty('sensibo_api_key')
    } finally {
      sessionUser = null
      getCurrentUser.mockReset()
    }
  })
})
