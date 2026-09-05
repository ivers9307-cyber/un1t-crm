// PUBPATH.1 — "these compliance paths are public on EVERY host".
//
// This app makes a path public in FOUR places (CLAUDE.md invariant):
//
//   1. src/proxy.js `publicPaths`            — else an anonymous request 307s to /login
//   2. src/components/AppShell.jsx PUBLIC_PATHS — else the client shell renders null
//                                                and redirects to /login on hydration
//   3. src/lib/brands.js allowedPaths        — else the marketing host (un1tdublin.com)
//                                                fallback-rewrites the path to /welcome
//   4. DB_BRAND_DEFAULTS in src/lib/tenant-domains-edge.js — same rewrite, for any
//                                                SAAS-8 tenant_domains hostname
//
// FOUR, not three. The first draft of this file said three and would have
// taught the next author to miss the same list — docs/CHANGELOG.md's SAAS4-C4
// entry had already named all four, and tier 4 is the easiest to lose because
// it lives in a different file and reads like config rather than routing.
//
// Missing one of the four is a recurring defect, not a one-off: AppShell's own
// comments record it for /unsubscribe, /privacy and (LOCCOMMS.4) /preferences —
// each time the proxy list was right and another list was forgotten, so the
// page server-rendered and then vanished. The 2026-08 platform audit found it
// twice more: /account-deletion (in NONE of them, while its own header
// claims "Must be publicly accessible (no auth) so reviewers can verify") and
// /embed/event/[slug] (in the proxy only, so every third-party iframe — the
// entire audience the route exists for — blanked and bounced).
//
// Both are anonymous-BY-DEFINITION surfaces with real external consequences:
// /account-deletion is the URL in the Google Play Console's "Account Deletion
// URL" field (docs/architecture/MOBILE.md) and the Apple Guideline 5.1.1(v)
// page, and /embed is pasted into third-party sites. Neither audience can ever
// have a session, so a login wall is not a degraded experience, it is a total
// outage — and for the store URL, a live app-review rejection vector.
//
// A page is not "public" until its whole FLOW is: section 5 below follows the
// embed's post-submit hop to the checkout, which is where allowlisting only
// the entry page leaves a paying visitor stranded.
//
// This file is the guard. It exercises the REAL brand registry, the REAL DB
// brand defaults and the REAL proxy (only Supabase and the tenant_domains row
// lookup are faked), and renders the REAL AppShell, so it fails if any ONE of
// the four lists loses an entry.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

// ── proxy scaffolding (mirrors proxy.test.js) ────────────────────────
// @supabase/ssr is faked so the cookie gate resolves a controllable
// user. @/lib/brands is deliberately NOT mocked — the marketing-host
// allowlist is one of the four things under test.
const ssrClient = {
  auth: { getUser: vi.fn(async () => ({ data: { user: null } })) },
  from: () => { throw new Error('no table access expected in these tests') },
}
vi.mock('@supabase/ssr', () => ({ createServerClient: () => ssrClient }))

// The tenant-domain tier is faked only at the ROW LOOKUP — what the DB
// would have returned. Its allowlist (DB_BRAND_DEFAULTS) is imported for
// real below and fed straight in, so tier 4 is genuinely under test: drop
// an entry from the real frozen array and section 6 fails.
let tenantBrandImpl = async () => null
vi.mock('@/lib/tenant-domains-edge', async (importOriginal) => ({
  ...(await importOriginal()),
  resolveTenantDomainBrand: (...args) => tenantBrandImpl(...args),
}))

// ── AppShell scaffolding ─────────────────────────────────────────────
// AppShell is a client component whose public/protected decision reads
// usePathname(). Rendered via react-dom/server (this repo runs vitest
// under the node environment, no jsdom) — useEffect never fires, so the
// render is exactly the branch decision we want to pin.
let pathnameImpl = '/'
vi.mock('next/navigation', () => ({
  usePathname: () => pathnameImpl,
  useRouter: () => ({ replace: () => {}, push: () => {}, refresh: () => {} }),
}))

import { proxy } from './proxy.js'
import { BRANDS } from './lib/brands.js'
import { DB_BRAND_DEFAULTS } from './lib/tenant-domains-edge.js'
import AppShell from './components/AppShell.jsx'

// The paths this file defends, with why they must never regress.
const COMPLIANCE_PATHS = [
  {
    path: '/account-deletion',
    why: 'Google Play "Account Deletion URL" + Apple Guideline 5.1.1(v)',
  },
  {
    path: '/embed/event/summer-race',
    why: 'paste-anywhere signup iframe embedded by third-party sites',
  },
  {
    path: '/cancel/eyJsIjoieCJ9.c2ln',
    why: 'CANCEL-FORM.3: per-contact membership cancellation form link sent by email/WhatsApp; must render without a session on every host, incl. the marketing host when the operator builds links there',
  },
]

// The embed's post-submit hop. RaceSignupWidget sends a PAID signup to a
// host-relative /event-pay/<id> via window.open(url, '_top'), which resolves
// against the iframe document's origin — the marketing host, per the embed
// page's own documented snippet. Allowlisting only the entry page takes the
// registration and then rewrites the payer to the studio chooser.
const EMBED_CHECKOUT_PATH = '/event-pay/00000000-0000-4000-8000-000000000001'

const MARKETING_HOST = 'un1tdublin.com'
const CRM_HOST = 'crm.un1tdublin.com'
const TENANT_HOST = 'fitness.example.com'

function makeReq({ host = CRM_HOST, path = '/', method = 'GET', cookies = {} } = {}) {
  return {
    method,
    headers: new Headers({ host }),
    url: `https://${host}${path}`,
    nextUrl: {
      pathname: path,
      search: '',
      clone: () => new URL(`https://${host}${path}`),
    },
    cookies: {
      getAll: () => [],
      get: (name) => (name in cookies ? { value: cookies[name] } : undefined),
      set: () => {},
    },
  }
}

const admitted = (res) => res.headers.get('x-middleware-next') === '1'
const rewrittenTo = (res) => res.headers.get('x-middleware-rewrite')

const marketingBrand = () => BRANDS.find((b) => b.id === 'un1t-marketing')

beforeEach(() => {
  vi.clearAllMocks()
  ssrClient.auth.getUser.mockResolvedValue({ data: { user: null } })
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://localhost:54321')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-key')
  pathnameImpl = '/'
  tenantBrandImpl = async () => null
})

afterEach(() => {
  vi.unstubAllEnvs()
})

// ── 1. the proxy allowlist ───────────────────────────────────────────

describe('proxy admits the compliance paths anonymously (CRM host)', () => {
  for (const { path, why } of COMPLIANCE_PATHS) {
    it(`${path} — ${why}`, async () => {
      const res = await proxy(makeReq({ host: CRM_HOST, path }))
      expect(admitted(res), `${path} must not be auth-gated on ${CRM_HOST}`).toBe(true)
      // Belt and braces: no session was ever consulted, because the
      // publicPaths gate returns before the cookie check.
      expect(ssrClient.auth.getUser).not.toHaveBeenCalled()
    })
  }

  it('control — a genuinely private path still redirects to /login', async () => {
    const res = await proxy(makeReq({ host: CRM_HOST, path: '/dashboard' }))
    expect(admitted(res)).toBe(false)
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toContain('/login')
  })
})

// ── 2. STAFF-WEB-LOCK (#1457) must not swallow them ──────────────────
//
// The lock walls an authenticated page request off to /use-the-app. It
// runs AFTER the publicPaths gate, so a public path returns before the
// decision is ever taken — but that ordering is exactly the kind of
// thing a refactor moves, and moving it would silently re-wall the
// store-review URL. Pin it with the flag ON and a real session.

describe('STAFF_WEB_LOCK=1 does not intercept the compliance paths', () => {
  beforeEach(() => {
    vi.stubEnv('STAFF_WEB_LOCK', '1')
    ssrClient.auth.getUser.mockResolvedValue({ data: { user: { id: 'staff-1' } } })
  })

  for (const { path } of COMPLIANCE_PATHS) {
    it(`${path} is served, not bounced to /use-the-app`, async () => {
      const res = await proxy(makeReq({ host: CRM_HOST, path }))
      expect(admitted(res)).toBe(true)
      expect(res.headers.get('location')).toBe(null)
    })
  }

  it('control — the lock still walls an ordinary staff page', async () => {
    const res = await proxy(makeReq({ host: CRM_HOST, path: '/dashboard' }))
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toContain('/use-the-app')
  })
})

// ── 3. the brand (marketing host) allowlist ──────────────────────────

describe('marketing host serves the compliance paths', () => {
  for (const { path, why } of COMPLIANCE_PATHS) {
    it(`${path} is not rewritten to /welcome — ${why}`, async () => {
      const res = await proxy(makeReq({ host: MARKETING_HOST, path }))
      expect(rewrittenTo(res), `${path} fell through to the /welcome fallback`).toBe(null)
      expect(admitted(res)).toBe(true)
    })
  }

  it('control — an unknown path on the marketing host still rewrites to /welcome', async () => {
    const res = await proxy(makeReq({ host: MARKETING_HOST, path: '/dashboard' }))
    expect(rewrittenTo(res)).toContain('/welcome')
  })

  it('the un1t-marketing allowlist names both paths explicitly', () => {
    const allowed = marketingBrand().allowedPaths
    expect(allowed).toContain('/account-deletion')
    // Directory prefix — the brand matcher is a raw startsWith.
    expect(allowed).toContain('/embed/')
  })
})

// ── 4. the AppShell client gate ──────────────────────────────────────

describe('AppShell renders the compliance paths bare instead of blanking', () => {
  for (const { path, why } of COMPLIANCE_PATHS) {
    it(`${path} renders its children with no session — ${why}`, () => {
      pathnameImpl = path
      const html = renderToStaticMarkup(
        <AppShell user={null}><p>page-body</p></AppShell>
      )
      expect(html, `${path} is missing from AppShell PUBLIC_PATHS`).toContain('page-body')
    })
  }

  it('control — a protected path with no user renders nothing', () => {
    pathnameImpl = '/dashboard'
    const html = renderToStaticMarkup(
      <AppShell user={null}><p>page-body</p></AppShell>
    )
    expect(html).toBe('')
  })

  it('the segment-aware matcher does not leak a lookalike path', () => {
    // Entries carry no trailing slash and match `=== p || startsWith(p + '/')`,
    // so a future '/account-deletionista' page is NOT silently public.
    pathnameImpl = '/account-deletionista'
    const html = renderToStaticMarkup(
      <AppShell user={null}><p>page-body</p></AppShell>
    )
    expect(html).toBe('')
  })
})

// ── 5. the embed's post-submit hop (the FLOW, not just the page) ──────
//
// Section 3 proves /embed/event/<slug> RENDERS on un1tdublin.com. That is
// only the first half. RaceSignupWidget posts the registration and then,
// for any non-free event, navigates to a HOST-RELATIVE /event-pay/<id>
// (src/components/RaceSignupWidget.jsx) — in the embed via
// window.open(url, '_top'), so the URL resolves against the iframe
// document's origin, which the embed page's own header documents as
// https://un1tdublin.com. The marketing brand listed '/event/' but not
// '/event-pay/', so that hop hit the fallback: the registration was
// created and the payer landed on the studio chooser, unpaid.
//
// un1t-hosts has carried the pair since HOST-PORTAL.1 ('/event/' with the
// comment "+ the checkout"), which is the shape every host allowlisting a
// signup page needs.

describe('the embed checkout leg resolves on every host that serves the embed', () => {
  it('marketing host does not rewrite the checkout to /welcome', async () => {
    const res = await proxy(makeReq({ host: MARKETING_HOST, path: EMBED_CHECKOUT_PATH }))
    expect(
      rewrittenTo(res),
      'paid embed signup dead-ends: /event-pay/ is missing from the un1t-marketing allowlist',
    ).toBe(null)
    expect(admitted(res)).toBe(true)
  })

  it('CRM host admits the checkout anonymously', async () => {
    const res = await proxy(makeReq({ host: CRM_HOST, path: EMBED_CHECKOUT_PATH }))
    expect(admitted(res)).toBe(true)
  })

  it('AppShell renders the checkout with no session', () => {
    pathnameImpl = EMBED_CHECKOUT_PATH
    const html = renderToStaticMarkup(
      <AppShell user={null}><p>page-body</p></AppShell>
    )
    expect(html).toContain('page-body')
  })

  it('every host that serves /event/ also serves its checkout', () => {
    // The structural rule behind the three assertions above: a brand that
    // admits the signup page but not the checkout takes registrations it
    // cannot collect payment for. Catches the same gap on a brand added later.
    //
    // AUDIT-13.B widened this to the FOURTH tier. It used to walk BRANDS
    // only, and DB_BRAND_DEFAULTS — a different file, same handler block —
    // carried '/event/' without '/event-pay/' for exactly that reason.
    const tiers = [
      ...BRANDS.map((b) => [`brand '${b.id}'`, b.allowedPaths]),
      ['DB_BRAND_DEFAULTS (tenant-domain tier)', DB_BRAND_DEFAULTS.allowedPaths],
    ]
    for (const [label, allowed] of tiers) {
      if (!allowed.includes('/event/')) continue
      expect(
        allowed,
        `${label} allows /event/ but not its checkout /event-pay/`,
      ).toContain('/event-pay/')
    }
  })
})

// ── 5b. the LEGACY alias pair (AUDIT-13.B) ───────────────────────────
//
// next.config.js forever-rewrites /race/:slug → /event/:slug and
// /race-pay/:paymentId → /event-pay/:paymentId, with a comment calling
// them "the critical ones — shared externally". They were in NEITHER the
// proxy list nor AppShell's, so every anonymous hit 307'd to /login on the
// CRM host — the rewrite never got a chance, because middleware runs
// BEFORE afterFiles rewrites.
//
// These are NOT dead config, which is the reason to allowlist rather than
// delete them:
//   - src/lib/agent/event-tools.js mints `${appUrl}/race/<slug>` as the
//     signup_url Mia hands customers in WhatsApp — two call sites, live.
//   - src/app/api/public/races/[slug]/register/route.js and
//     src/lib/race-register-solo.js both set the Revolut post-payment
//     returnUrl to `${baseUrl}/race/<slug>/confirmed`.
// Both audiences are anonymous by definition: a WhatsApp recipient and a
// payer returning from a card form.

const LEGACY_ALIAS_PATHS = [
  { path: '/race/summer-hyrox', why: "Mia's signup_url — agent/event-tools.js" },
  { path: '/race/summer-hyrox/confirmed', why: 'Revolut post-payment returnUrl' },
  { path: '/race/summer-hyrox/display', why: 'studio TV board' },
  { path: '/race-pay/00000000-0000-4000-8000-000000000001', why: 'legacy checkout leg' },
]

describe('the legacy /race aliases resolve for an anonymous visitor', () => {
  for (const { path, why } of LEGACY_ALIAS_PATHS) {
    it(`CRM host admits ${path} — ${why}`, async () => {
      const res = await proxy(makeReq({ host: CRM_HOST, path }))
      expect(admitted(res), `${path} 307s to /login: missing from proxy publicPaths`).toBe(true)
      expect(ssrClient.auth.getUser).not.toHaveBeenCalled()
    })

    it(`AppShell renders ${path} with no session`, () => {
      pathnameImpl = path
      const html = renderToStaticMarkup(
        <AppShell user={null}><p>page-body</p></AppShell>
      )
      expect(html, `${path} is missing from AppShell PUBLIC_PATHS`).toContain('page-body')
    })

    it(`marketing host does not rewrite ${path} to /welcome`, async () => {
      const res = await proxy(makeReq({ host: MARKETING_HOST, path }))
      expect(rewrittenTo(res), `${path} fell through to the /welcome fallback`).toBe(null)
      expect(admitted(res)).toBe(true)
    })
  }

  it('the marketing allowlist carries the alias PAIR, not just the entry page', () => {
    const allowed = marketingBrand().allowedPaths
    expect(allowed).toContain('/race/')
    expect(allowed, "'/race/' without '/race-pay/' strands the payer").toContain('/race-pay/')
  })

  it('control — /races (the OPERATOR alias) stays auth-gated', async () => {
    // /races/* rewrites to the staff /events/* pages. Those are staff
    // surfaces and must keep their login wall; only the public /race/
    // singular pair is anonymous.
    const res = await proxy(makeReq({ host: CRM_HOST, path: '/races/abc/teams' }))
    expect(admitted(res)).toBe(false)
    expect(res.headers.get('location') || '').toContain('/login')
  })
})

// ── 6. the FOURTH allowlist — SAAS-8 tenant domains ──────────────────
//
// Any hostname the in-code registry misses is resolved against
// tenant_domains (mig 415); a row with no explicit brand override gets
// DB_BRAND_DEFAULTS, which rides the identical proxy handler block. Its
// allowlist includes '/privacy' — startsWith-matched, so also
// /privacy/members — and BOTH of those pages link to /account-deletion
// with a host-relative href. Without the entry a tenant's own privacy
// notice promises a deletion page and delivers /welcome.
//
// Zero tenant_domains rows exist today, so this tier is LATENT — which is
// exactly why it needs a test rather than an operator noticing.

describe('tenant-domain brand defaults serve /account-deletion', () => {
  beforeEach(() => {
    // What resolveTenantDomainBrand builds for a row with brand = {}:
    // the real frozen defaults, unmodified.
    tenantBrandImpl = async (hostname) =>
      hostname && hostname.split(':')[0] === TENANT_HOST
        ? { id: `tenant:${TENANT_HOST}`, hostnames: [TENANT_HOST], ...DB_BRAND_DEFAULTS }
        : null
  })

  it('/account-deletion is not rewritten to /welcome', async () => {
    const res = await proxy(makeReq({ host: TENANT_HOST, path: '/account-deletion' }))
    expect(
      rewrittenTo(res),
      '/account-deletion is missing from DB_BRAND_DEFAULTS.allowedPaths',
    ).toBe(null)
    expect(admitted(res)).toBe(true)
  })

  it('control — /privacy (the page that links to it) is already served', async () => {
    const res = await proxy(makeReq({ host: TENANT_HOST, path: '/privacy/members' }))
    expect(rewrittenTo(res)).toBe(null)
    expect(admitted(res)).toBe(true)
  })

  it('control — a CRM path on a tenant host still rewrites to /welcome', async () => {
    const res = await proxy(makeReq({ host: TENANT_HOST, path: '/dashboard' }))
    expect(rewrittenTo(res)).toContain('/welcome')
  })

  it('the defaults name it explicitly', () => {
    expect(DB_BRAND_DEFAULTS.allowedPaths).toContain('/account-deletion')
  })
})
