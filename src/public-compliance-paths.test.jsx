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

// PAGES.1 — the database-driven page slugs. Faked only at the slug LIST (what
// the landing_pages read would return); the matcher, the header helper and the
// proxy wiring are the real ones.
let pageSlugsImpl = async () => []
vi.mock('@/lib/public-pages-edge', async (importOriginal) => ({
  ...(await importOriginal()),
  listPublicPageSlugs: (...args) => pageSlugsImpl(...args),
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
import { BRANDS, UN1T_GROUP_ORG_ID } from './lib/brands.js'
import { DB_BRAND_DEFAULTS } from './lib/tenant-domains-edge.js'
import { PUBLIC_PAGE_SLUGS_FALLBACK } from './lib/public-pages-edge.js'
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
  {
    path: '/legal/un1t/hatch-street/terms',
    why: 'UN1TWRITE.17: the un1t.online terms and waiver the class funnel tick links to; a customer must read them before accepting, on every host',
  },
  {
    path: '/pay-done/dG9rZW4tdG9rZW4tdG9rZW4tdG9rZW4tdG9rZW4tdG9rZW4',
    why: 'MIAHATCH.6: the return page un1t.online checkout sends a member to after paying; the member has no session and lands on the customer (marketing) host, so a login wall or a rewrite to /welcome strands them',
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

function makeReq({ host = CRM_HOST, path = '/', method = 'GET', cookies = {}, headers = {} } = {}) {
  return {
    method,
    headers: new Headers({ host, ...headers }),
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
  pageSlugsImpl = async () => []
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

// ── 7. EVENT-MOVE.6 — the customer's own entry page, as a FLOW ────────
//
// /event/entry/<token> is the "Change your date" link in every event
// confirmation and moved email. Its audience never has a session: the signed
// token in the path is the only credential. The page calls
// /api/public/entry/<token>/*, and a dearer date change hands the browser to
// /event-pay/<id>, whose checkout returns to the entry page. All three legs
// must resolve anonymously on every host that may carry the link (the CRM
// host mints it; the marketing and tenant hosts serve /event/ too).

const ENTRY_FLOW_PATHS = [
  { path: '/event/entry/eyJyIjoieCJ9.c2ln', why: 'the entry page itself' },
  { path: '/api/public/entry/eyJyIjoieCJ9.c2ln/move-options', why: 'the page\'s data' },
  { path: '/event-pay/00000000-0000-4000-8000-000000000002', why: 'a dearer change pays the difference here' },
]

describe('EVENT-MOVE.6 — the entry page flow is public on every host', () => {
  beforeEach(() => {
    tenantBrandImpl = async (hostname) =>
      hostname && hostname.split(':')[0] === TENANT_HOST
        ? { id: `tenant:${TENANT_HOST}`, hostnames: [TENANT_HOST], ...DB_BRAND_DEFAULTS }
        : null
  })

  for (const { path, why } of ENTRY_FLOW_PATHS) {
    it(`CRM host admits ${path} anonymously — ${why}`, async () => {
      const res = await proxy(makeReq({ host: CRM_HOST, path }))
      expect(admitted(res), `${path} 307s to /login: missing from proxy publicPaths`).toBe(true)
      expect(ssrClient.auth.getUser).not.toHaveBeenCalled()
    })

    for (const host of [MARKETING_HOST, TENANT_HOST]) {
      it(`${host} does not rewrite ${path} to /welcome`, async () => {
        const res = await proxy(makeReq({ host, path }))
        expect(rewrittenTo(res), `${path} fell through to the /welcome fallback on ${host}`).toBe(null)
        expect(admitted(res)).toBe(true)
      })
    }
  }

  it('AppShell renders the entry page and its checkout with no session', () => {
    for (const path of ['/event/entry/eyJyIjoieCJ9.c2ln', '/event-pay/00000000-0000-4000-8000-000000000002']) {
      pathnameImpl = path
      const html = renderToStaticMarkup(<AppShell user={null}><p>page-body</p></AppShell>)
      expect(html, `${path} is missing from AppShell PUBLIC_PATHS`).toContain('page-body')
    }
  })

  it('the marketing brand and the tenant defaults name the entry page AND its checkout explicitly', () => {
    for (const [label, allowed] of [['un1t-marketing', marketingBrand().allowedPaths], ['DB_BRAND_DEFAULTS', DB_BRAND_DEFAULTS.allowedPaths]]) {
      expect(allowed, `${label} lost '/event/entry/'`).toContain('/event/entry/')
      expect(allowed, `${label} lost the checkout leg`).toContain('/event-pay/')
    }
  })
})

// ── 7b. BOOKINGSELF.1 — the customer's own booking page, as a FLOW ─────
//
// /book/manage/<token> is the {{manage_url}} link in every booking
// confirmation and reminder email (cancel or reschedule). Its audience never
// has a session: the signed token in the path is the only credential. The
// page calls /api/public/booking-manage/<token>/*. Both legs must resolve
// anonymously on every host that may carry the link (the send path mints it
// on the studio's customer host; the CRM host is the floor).

const BOOKING_MANAGE_FLOW_PATHS = [
  { path: '/book/manage/eyJiIjoieCJ9.c2ln', why: 'the booking page itself' },
  { path: '/api/public/booking-manage/eyJiIjoieCJ9.c2ln/slots', why: 'the page\'s data' },
]

describe('BOOKINGSELF.1 — the booking manage page flow is public on every host', () => {
  beforeEach(() => {
    tenantBrandImpl = async (hostname) =>
      hostname && hostname.split(':')[0] === TENANT_HOST
        ? { id: `tenant:${TENANT_HOST}`, hostnames: [TENANT_HOST], ...DB_BRAND_DEFAULTS }
        : null
  })

  for (const { path, why } of BOOKING_MANAGE_FLOW_PATHS) {
    it(`CRM host admits ${path} anonymously — ${why}`, async () => {
      const res = await proxy(makeReq({ host: CRM_HOST, path }))
      expect(admitted(res), `${path} 307s to /login: missing from proxy publicPaths`).toBe(true)
      expect(ssrClient.auth.getUser).not.toHaveBeenCalled()
    })

    for (const host of [MARKETING_HOST, TENANT_HOST]) {
      it(`${host} does not rewrite ${path} to /welcome`, async () => {
        const res = await proxy(makeReq({ host, path }))
        expect(rewrittenTo(res), `${path} fell through to the /welcome fallback on ${host}`).toBe(null)
        expect(admitted(res)).toBe(true)
      })
    }
  }

  it('AppShell renders the booking page with no session', () => {
    pathnameImpl = '/book/manage/eyJiIjoieCJ9.c2ln'
    const html = renderToStaticMarkup(<AppShell user={null}><p>page-body</p></AppShell>)
    expect(html, '/book/manage is missing from AppShell PUBLIC_PATHS').toContain('page-body')
  })

  it('the marketing brand and the tenant defaults name the booking page explicitly', () => {
    for (const [label, allowed] of [['un1t-marketing', marketingBrand().allowedPaths], ['DB_BRAND_DEFAULTS', DB_BRAND_DEFAULTS.allowedPaths]]) {
      expect(allowed, `${label} lost '/book/manage/'`).toContain('/book/manage/')
    }
  })
})

// ── 7c. MIAHATCH.6 — the pay-done return page is public on every host ──
//
// un1t.online's hosted checkout redirects a member to
// <customer base>/pay-done/<token> (success) or ...?c=1 (cancel). The member
// has no session, and the customer base is the studio's customer host (the
// marketing host or a tenant domain), so all FOUR lists must carry it.

describe('MIAHATCH.6 — /pay-done is public on every host', () => {
  const PAY_DONE = '/pay-done/dG9rZW4tdG9rZW4tdG9rZW4tdG9rZW4tdG9rZW4tdG9rZW4'
  beforeEach(() => {
    tenantBrandImpl = async (hostname) =>
      hostname && hostname.split(':')[0] === TENANT_HOST
        ? { id: `tenant:${TENANT_HOST}`, hostnames: [TENANT_HOST], ...DB_BRAND_DEFAULTS }
        : null
  })

  // (the cancel variant is the same path with ?c=1; the matchers read the pathname only)
  for (const host of [CRM_HOST, MARKETING_HOST, TENANT_HOST]) {
    it(`${host} admits ${PAY_DONE} anonymously without a rewrite`, async () => {
      const res = await proxy(makeReq({ host, path: PAY_DONE }))
      expect(rewrittenTo(res), `${PAY_DONE} fell through to the /welcome fallback on ${host}`).toBe(null)
      expect(admitted(res), `${PAY_DONE} is not admitted on ${host}`).toBe(true)
      expect(ssrClient.auth.getUser).not.toHaveBeenCalled()
    })
  }

  it('AppShell renders the page with no session', () => {
    pathnameImpl = PAY_DONE
    const html = renderToStaticMarkup(<AppShell user={null}><p>page-body</p></AppShell>)
    expect(html, '/pay-done is missing from AppShell PUBLIC_PATHS').toContain('page-body')
  })

  it('the marketing brand and the tenant defaults name /pay-done/ explicitly', () => {
    for (const [label, allowed] of [['un1t-marketing', marketingBrand().allowedPaths], ['DB_BRAND_DEFAULTS', DB_BRAND_DEFAULTS.allowedPaths]]) {
      expect(allowed, `${label} lost '/pay-done/'`).toContain('/pay-done/')
    }
  })

  it('a same-stem sibling (/pay-donefoo) does not inherit the exemption', async () => {
    const res = await proxy(makeReq({ host: MARKETING_HOST, path: '/pay-donefoo' }))
    expect(rewrittenTo(res)).toContain('/welcome')
  })
})

// ── 7d. FEES.3 — the class-fee appeal page is public on every host ──
//
// A member opens <customer base>/fee-appeal/<token> from their fee notice (or
// a link staff sent). No session, and the base is the studio's customer host,
// so all FOUR lists must carry it.

describe('FEES.3 — /fee-appeal is public on every host', () => {
  const APPEAL = '/fee-appeal/dG9rZW4tdG9rZW4tdG9rZW4tdG9rZW4tdG9rZW4'
  beforeEach(() => {
    tenantBrandImpl = async (hostname) =>
      hostname && hostname.split(':')[0] === TENANT_HOST
        ? { id: `tenant:${TENANT_HOST}`, hostnames: [TENANT_HOST], ...DB_BRAND_DEFAULTS }
        : null
  })

  for (const host of [CRM_HOST, MARKETING_HOST, TENANT_HOST]) {
    it(`${host} admits ${APPEAL} anonymously without a rewrite`, async () => {
      const res = await proxy(makeReq({ host, path: APPEAL }))
      expect(rewrittenTo(res), `${APPEAL} fell through to the /welcome fallback on ${host}`).toBe(null)
      expect(admitted(res), `${APPEAL} is not admitted on ${host}`).toBe(true)
      expect(ssrClient.auth.getUser).not.toHaveBeenCalled()
    })
  }

  it('AppShell renders the page with no session', () => {
    pathnameImpl = APPEAL
    const html = renderToStaticMarkup(<AppShell user={null}><p>page-body</p></AppShell>)
    expect(html, '/fee-appeal is missing from AppShell PUBLIC_PATHS').toContain('page-body')
  })

  it('the marketing brand and the tenant defaults name /fee-appeal/ explicitly', () => {
    for (const [label, allowed] of [['un1t-marketing', marketingBrand().allowedPaths], ['DB_BRAND_DEFAULTS', DB_BRAND_DEFAULTS.allowedPaths]]) {
      expect(allowed, `${label} lost '/fee-appeal/'`).toContain('/fee-appeal/')
    }
  })
})

// ── 7e. UN1TDUN.1 — the un1t.online short pay link is public on every host ──
//
// A member opens <customer base>/pay-link/<token> from a WhatsApp payment
// reminder (the template's URL button). No session, and the base is the
// studio's customer host, so all FOUR lists must carry it.

describe('UN1TDUN.1 — /pay-link is public on every host', () => {
  const PAY = '/pay-link/dG9rZW4tdG9rZW4tdG9rZW4tdG9rZW4tdG9r'
  beforeEach(() => {
    tenantBrandImpl = async (hostname) =>
      hostname && hostname.split(':')[0] === TENANT_HOST
        ? { id: `tenant:${TENANT_HOST}`, hostnames: [TENANT_HOST], ...DB_BRAND_DEFAULTS }
        : null
  })

  for (const host of [CRM_HOST, MARKETING_HOST, TENANT_HOST]) {
    it(`${host} admits ${PAY} anonymously without a rewrite`, async () => {
      const res = await proxy(makeReq({ host, path: PAY }))
      expect(rewrittenTo(res), `${PAY} fell through to the /welcome fallback on ${host}`).toBe(null)
      expect(admitted(res), `${PAY} is not admitted on ${host}`).toBe(true)
      expect(ssrClient.auth.getUser).not.toHaveBeenCalled()
    })
  }

  it('AppShell renders the page with no session', () => {
    pathnameImpl = PAY
    const html = renderToStaticMarkup(<AppShell user={null}><p>page-body</p></AppShell>)
    expect(html, '/pay-link is missing from AppShell PUBLIC_PATHS').toContain('page-body')
  })

  it('the marketing brand and the tenant defaults name /pay-link/ explicitly', () => {
    for (const [label, allowed] of [['un1t-marketing', marketingBrand().allowedPaths], ['DB_BRAND_DEFAULTS', DB_BRAND_DEFAULTS.allowedPaths]]) {
      expect(allowed, `${label} lost '/pay-link/'`).toContain('/pay-link/')
    }
  })

  it('only /pay-link/ is public: a look-alike segment is not', async () => {
    for (const path of ['/pay-linkage/x', '/pay/other']) {
      const res = await proxy(makeReq({ host: CRM_HOST, path }))
      expect(admitted(res), `${path} must not inherit the exemption`).toBe(false)
    }
  })
})

// ── 8. W1.L2 — the customer flow is complete on a tenant domain ───────
//
// W1.L1 gave every organisation an automatic <slug>.repset.ie host whose
// tenant_domains row carries brand = {} → DB_BRAND_DEFAULTS. W1.L3 mints
// customer-facing links (unsubscribe, preferences, view-email, class-pay,
// host portal, embeds) on that host. Until this section's paths were in
// the defaults, every one of those links rewrote to /welcome
// (fallbackHandler = 'rewrite'): the customer clicked "unsubscribe" and got
// the studio chooser, with the consent untouched.
//
// Every path here is ALREADY public on the CRM host (proxy publicPaths), so
// the widened default exposes nothing new — it only stops the tenant host
// from swallowing a flow the CRM host already serves anonymously.
//
// Deliberately NOT served by default: /offers, /technical. They are
// Stillorgan literals (W0.4's pinned /offers) or UN1T's own company story (src/app/technical, the
// Meta Tech Provider page) and would show UN1T on another gym's host. UN1T
// Group's own platform row may list them in brand.allowedPaths.

const TENANT_FLOW_PATHS = [
  '/unsubscribe/abc', '/preferences/abc', '/view-email/abc',
  '/api/unsubscribe/abc', '/api/preferences/abc',
  '/class-pay/abc', '/h/pride', '/h/pride/join', '/host', '/host/login', '/host-connect/abc',
  '/api/host/x', '/embed/event/x', '/terms',
]
const TENANT_PINNED_OFF = ['/offers', '/technical']
const PLATFORM_TENANT_HOST = 'gym-a.repset.ie'

// The entries the two rewrite-fallback tiers (un1t-marketing + the tenant
// defaults) must both name, as raw startsWith prefixes.
const W1L2_ALLOWLIST_ENTRIES = [
  '/unsubscribe/', '/preferences/', '/view-email/', '/api/unsubscribe/', '/api/preferences/',
  '/class-pay/', '/h/', '/host', '/host-connect/', '/api/host/', '/embed/', '/terms',
]

describe('W1.L2 — the customer flow is complete on a tenant domain', () => {
  beforeEach(() => {
    // A platform row (mig 716) has brand = {} → the real frozen defaults.
    tenantBrandImpl = async (hostname) =>
      hostname && hostname.split(':')[0] === PLATFORM_TENANT_HOST
        ? { id: `tenant:${PLATFORM_TENANT_HOST}`, hostnames: [PLATFORM_TENANT_HOST], ...DB_BRAND_DEFAULTS }
        : null
  })

  it.each(TENANT_FLOW_PATHS)('%s is served, not rewritten, on a tenant_domains host', async (path) => {
    const res = await proxy(makeReq({ host: PLATFORM_TENANT_HOST, path }))
    expect(rewrittenTo(res), `${path} fell through to /welcome on ${PLATFORM_TENANT_HOST}`).toBe(null)
    expect(admitted(res)).toBe(true)
  })

  it.each(TENANT_FLOW_PATHS)('%s is already public on the CRM host (the default exposes nothing new)', async (path) => {
    const res = await proxy(makeReq({ host: CRM_HOST, path }))
    expect(admitted(res), `${path} is auth-gated on the CRM host: it does not belong in a brand default`).toBe(true)
    expect(ssrClient.auth.getUser).not.toHaveBeenCalled()
  })

  it.each(TENANT_PINNED_OFF)('%s stays OFF the default (Stillorgan-pinned until Wave 2/3)', async (path) => {
    const res = await proxy(makeReq({ host: PLATFORM_TENANT_HOST, path }))
    expect(rewrittenTo(res)).toContain('/welcome')
  })

  it('a CRM page on a tenant host still rewrites to /welcome', async () => {
    const res = await proxy(makeReq({ host: PLATFORM_TENANT_HOST, path: '/dashboard' }))
    expect(rewrittenTo(res)).toContain('/welcome')
  })

  it.each(TENANT_FLOW_PATHS)('%s is also served on the marketing host (same flow, UN1T\'s own domain)', async (path) => {
    const res = await proxy(makeReq({ host: MARKETING_HOST, path }))
    expect(rewrittenTo(res), `${path} fell through to /welcome on ${MARKETING_HOST}`).toBe(null)
    expect(admitted(res)).toBe(true)
  })

  it('the tenant defaults and the marketing brand name every flow entry explicitly', () => {
    for (const [label, allowed] of [['DB_BRAND_DEFAULTS', DB_BRAND_DEFAULTS.allowedPaths], ['un1t-marketing', marketingBrand().allowedPaths]]) {
      for (const entry of W1L2_ALLOWLIST_ENTRIES) {
        expect(allowed, `${label} lost '${entry}'`).toContain(entry)
      }
    }
  })

  it('the tenant defaults never carry the Stillorgan funnel pages', () => {
    for (const entry of TENANT_PINNED_OFF) {
      expect(DB_BRAND_DEFAULTS.allowedPaths, `'${entry}' is a Stillorgan literal; it belongs on UN1T Group's own row, not the default`).not.toContain(entry)
    }
  })
})

// ── PAGES.1 — page slugs are public from the database ──────────────────
//
// A landing_pages row makes `/<slug>` public with no deploy: the proxy asks
// listPublicPageSlugs for the host's organisation and admits the first segment
// (and tells AppShell through x-public-page, so the client shell does not
// blank the page). The four in-code lists stay as the fallback.
describe('page slugs are public from the database', () => {
  const forwarded = (res, name) => res.headers.get(`x-middleware-request-${name}`)

  beforeEach(() => {
    // 'january' is a page of UN1T Group only; the tenant org below has none.
    pageSlugsImpl = async (orgId) => (orgId === UN1T_GROUP_ORG_ID ? ['january'] : [])
  })

  it('the CRM host admits /january and /january/anything anonymously, stamped x-public-page: 1', async () => {
    for (const path of ['/january', '/january/anything']) {
      const res = await proxy(makeReq({ host: CRM_HOST, path }))
      expect(admitted(res), `${path} redirected to login`).toBe(true)
      expect(forwarded(res, 'x-public-page')).toBe('1')
    }
  })

  it('the CRM host still gates a path that is not a page slug', async () => {
    const res = await proxy(makeReq({ host: CRM_HOST, path: '/januaryx' }))
    expect(res.headers.get('location')).toMatch(/\/login/)
    const root = await proxy(makeReq({ host: CRM_HOST, path: '/dashboard' }))
    expect(root.headers.get('location')).toMatch(/\/login/)
  })

  it('the marketing host does not rewrite /january to /welcome, and stamps the header', async () => {
    const res = await proxy(makeReq({ host: 'www.un1tdublin.com', path: '/january' }))
    expect(rewrittenTo(res)).toBe(null)
    expect(admitted(res)).toBe(true)
    expect(forwarded(res, 'x-public-page')).toBe('1')
  })

  it('the host portal (a reject brand with an organisation) still 404s a page slug', async () => {
    const hostBrand = BRANDS.find((b) => b.id === 'un1t-hosts')
    expect(hostBrand.fallbackHandler).toBe('reject')
    expect(hostBrand.organizationId).toBe(UN1T_GROUP_ORG_ID)
    for (const path of ['/january', '/january/anything']) {
      const res = await proxy(makeReq({ host: hostBrand.hostnames[0], path }))
      expect(res.status, `${path} was served on the host portal`).toBe(404)
      expect(forwarded(res, 'x-public-page')).toBe(null)
    }
  })

  it('the marketing host is still admitted for the same slug', async () => {
    const res = await proxy(makeReq({ host: 'www.un1tdublin.com', path: '/january' }))
    expect(admitted(res)).toBe(true)
    expect(rewrittenTo(res)).toBe(null)
  })

  it('the marketing host still rewrites an unknown path to /welcome', async () => {
    const res = await proxy(makeReq({ host: 'www.un1tdublin.com', path: '/nope' }))
    expect(rewrittenTo(res)).toMatch(/\/welcome$/)
  })

  it('the former code routes (trial, 50plus, corp, start, free-class) are public on the UN1T hosts from the page list alone, with no in-code path naming them', async () => {
    // PAGES.1 Task 8: their route directories and in-code allowlist entries are
    // gone; a landing_pages row (or, in an outage, the fallback list) is what
    // makes them public. The list is the real one, fed in as the slug read.
    pageSlugsImpl = async (orgId) => [...(PUBLIC_PAGE_SLUGS_FALLBACK[orgId] || [])]
    for (const slug of ['trial', '50plus', 'corp', 'start', 'free-class']) {
      for (const path of [`/${slug}`, `/${slug}/sub`]) {
        const crm = await proxy(makeReq({ host: CRM_HOST, path }))
        expect(admitted(crm), `${path} is auth-gated on the CRM host`).toBe(true)
        expect(forwarded(crm, 'x-public-page')).toBe('1')
        const marketing = await proxy(makeReq({ host: MARKETING_HOST, path }))
        expect(rewrittenTo(marketing), `${path} fell through to /welcome on the marketing host`).toBe(null)
        expect(admitted(marketing)).toBe(true)
      }
    }
    expect(marketingBrand().allowedPaths).not.toContain('/corp')
    expect(DB_BRAND_DEFAULTS.allowedPaths).not.toContain('/corp')
  })

  it('PR1: the studio paths are not admitted by the page tier, so /stillorgan on the CRM host still goes to /login', async () => {
    // The edge reads campaign pages only and the fallback names no studio
    // page; /stillorgan and /hatch-street stay on the next.config rewrites to
    // /welcome. PR3 lifts this with the studio pages.
    pageSlugsImpl = async (orgId) => [...(PUBLIC_PAGE_SLUGS_FALLBACK[orgId] || [])]
    for (const path of ['/stillorgan', '/hatch-street']) {
      const res = await proxy(makeReq({ host: CRM_HOST, path }))
      expect(res.headers.get('location'), path).toMatch(/\/login/)
      expect(forwarded(res, 'x-public-page')).toBe(null)
    }
  })

  it('a tenant host whose organisation has no pages still rewrites /january', async () => {
    tenantBrandImpl = async () => ({
      id: 'tenant:x', hostnames: [TENANT_HOST],
      allowedPaths: [...DB_BRAND_DEFAULTS.allowedPaths],
      rootHandler: 'rewrite', rootRewriteTo: '/welcome',
      fallbackHandler: 'rewrite', fallbackRewriteTo: '/welcome',
      organizationId: 'org-tenant',
    })
    const res = await proxy(makeReq({ host: TENANT_HOST, path: '/january' }))
    expect(rewrittenTo(res)).toMatch(/\/welcome$/)
  })

  it('a tenant host admits a slug listed for its own organisation', async () => {
    pageSlugsImpl = async (orgId) => (orgId === 'org-tenant' ? ['january'] : [])
    tenantBrandImpl = async () => ({
      id: 'tenant:x', hostnames: [TENANT_HOST],
      allowedPaths: [...DB_BRAND_DEFAULTS.allowedPaths],
      rootHandler: 'rewrite', rootRewriteTo: '/welcome',
      fallbackHandler: 'rewrite', fallbackRewriteTo: '/welcome',
      organizationId: 'org-tenant',
    })
    const res = await proxy(makeReq({ host: TENANT_HOST, path: '/january' }))
    expect(rewrittenTo(res)).toBe(null)
    expect(forwarded(res, 'x-public-page')).toBe('1')
  })

  it('a tenant brand that allowlists a path which is also a page still forwards x-public-page (else AppShell blanks it)', async () => {
    // un1t-group.repset.ie's tenant_domains brand lists /trial, /start and
    // /free-class, which left PUBLIC_PATHS when they became pages.
    pageSlugsImpl = async (orgId) => (orgId === 'org-tenant' ? ['trial'] : [])
    tenantBrandImpl = async () => ({
      id: 'tenant:x', hostnames: [TENANT_HOST],
      allowedPaths: [...DB_BRAND_DEFAULTS.allowedPaths, '/trial', '/privacy'],
      rootHandler: 'rewrite', rootRewriteTo: '/welcome',
      fallbackHandler: 'rewrite', fallbackRewriteTo: '/welcome',
      organizationId: 'org-tenant',
    })
    const page = await proxy(makeReq({ host: TENANT_HOST, path: '/trial' }))
    expect(admitted(page)).toBe(true)
    expect(rewrittenTo(page)).toBe(null)
    expect(forwarded(page, 'x-public-page')).toBe('1')
    // An allowlisted path that is not a page: admitted, unchanged, no header.
    const privacy = await proxy(makeReq({ host: TENANT_HOST, path: '/privacy' }))
    expect(admitted(privacy)).toBe(true)
    expect(rewrittenTo(privacy)).toBe(null)
    expect(forwarded(privacy, 'x-public-page')).toBe(null)
  })

  it('a forged x-public-page on a private path is stripped and still redirected to /login', async () => {
    const res = await proxy(makeReq({ host: CRM_HOST, path: '/dashboard', headers: { 'x-public-page': '1' } }))
    expect(res.headers.get('location')).toMatch(/\/login/)
  })

  it('a forged x-public-page never reaches the app on a path the proxy lets through unchanged', async () => {
    // A bare NextResponse.next() forwards the ORIGINAL request headers, so a
    // forged copy has to be removed by re-stating the headers without it: the
    // response must carry an override list, and the list must not name it.
    const stripped = (res) => {
      const override = res.headers.get('x-middleware-override-headers')
      expect(override, 'forged header was not stripped from the forwarded request').not.toBe(null)
      expect(override).not.toContain('x-public-page')
      expect(forwarded(res, 'x-public-page')).toBe(null)
    }
    // /login is public by the in-code list
    stripped(await proxy(makeReq({ host: CRM_HOST, path: '/login', headers: { 'x-public-page': '1' } })))
    // an allowlisted path on a brand host
    stripped(await proxy(makeReq({ host: 'www.un1tdublin.com', path: '/offers', headers: { 'x-public-page': '1' } })))
    // a signed-in session on a private path
    ssrClient.auth.getUser.mockResolvedValue({ data: { user: { id: 'u1' } } })
    stripped(await proxy(makeReq({ host: CRM_HOST, path: '/dashboard', headers: { 'x-public-page': '1' } })))
  })

  it('AppShell with isPublicPage renders its children with no user', () => {
    pathnameImpl = '/january'
    const html = renderToStaticMarkup(<AppShell user={null} isPublicPage><p>page-body</p></AppShell>)
    expect(html).toContain('page-body')
  })

  it('control — AppShell without isPublicPage blanks the same path', () => {
    pathnameImpl = '/january'
    expect(renderToStaticMarkup(<AppShell user={null}><p>page-body</p></AppShell>)).toBe('')
  })
})
