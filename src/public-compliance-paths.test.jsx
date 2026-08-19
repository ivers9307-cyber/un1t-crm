// PUBPATH.1 — "these compliance paths are public on EVERY host".
//
// This app makes a path public in THREE places (CLAUDE.md invariant):
//
//   1. src/proxy.js `publicPaths`            — else an anonymous request 307s to /login
//   2. src/components/AppShell.jsx PUBLIC_PATHS — else the client shell renders null
//                                                and redirects to /login on hydration
//   3. src/lib/brands.js allowedPaths        — else the marketing host (un1tdublin.com)
//                                                fallback-rewrites the path to /welcome
//
// Missing one of the three is a recurring defect, not a one-off: AppShell's own
// comments record it for /unsubscribe, /privacy and (LOCCOMMS.4) /preferences —
// each time the proxy list was right and the third list was forgotten, so the
// page server-rendered and then vanished. The 2026-08 platform audit found it
// twice more: /account-deletion (in NONE of the three, while its own header
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
// This file is the guard. It exercises the REAL brand registry and the REAL
// proxy (only Supabase + the DB brand tier are faked), and renders the REAL
// AppShell, so it fails if any ONE of the three lists loses an entry.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

// ── proxy scaffolding (mirrors proxy.test.js) ────────────────────────
// @supabase/ssr is faked so the cookie gate resolves a controllable
// user. @/lib/brands is deliberately NOT mocked — the marketing-host
// allowlist is one of the three things under test.
const ssrClient = {
  auth: { getUser: vi.fn(async () => ({ data: { user: null } })) },
  from: () => { throw new Error('no table access expected in these tests') },
}
vi.mock('@supabase/ssr', () => ({ createServerClient: () => ssrClient }))
vi.mock('@/lib/tenant-domains-edge', () => ({ resolveTenantDomainBrand: async () => null }))

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
]

const MARKETING_HOST = 'un1tdublin.com'
const CRM_HOST = 'crm.un1tdublin.com'

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
