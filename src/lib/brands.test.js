// Brand registry contract tests. Locks in the resolver semantics +
// the framework-asset detection used by src/proxy.js. Both are
// pure JS — no React, no Next runtime — runnable under vitest.
//
// Why test this hard: the registry is the only thing standing
// between a buyer-facing payment subdomain (pay.ccfautos.com) and
// the staff CRM. A regression here could expose /dashboard to
// anyone hitting the payment hostname. Pin the obvious-but-subtle
// edge cases so future-me notices breakage before staging does.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { BRANDS, resolveBrand, isFrameworkAsset, getLegacyBrandRows, getCrmHostnames, CANONICAL_CRM_HOSTNAME, LEGACY_CRM_HOSTNAME, CRM_DEFAULT_HOSTNAME } from './brands.js'
import { CANONICAL_CRM_ORIGIN, LEGACY_CRM_HOST } from './legacy-host-redirect.js'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('BRANDS registry shape', () => {
  it('has at least the two known brands', () => {
    const ids = BRANDS.map((b) => b.id)
    expect(ids).toContain('ccfautos-pay')
    expect(ids).toContain('un1t-marketing')
  })

  it('every brand declares the required shape', () => {
    for (const b of BRANDS) {
      expect(typeof b.id).toBe('string')
      expect(b.id.length).toBeGreaterThan(0)
      expect(typeof b.description).toBe('string')
      expect(Array.isArray(b.hostnames)).toBe(true)
      expect(b.hostnames.length).toBeGreaterThan(0)
      for (const h of b.hostnames) {
        expect(typeof h).toBe('string')
        expect(h.length).toBeGreaterThan(0)
      }
      expect(Array.isArray(b.allowedPaths)).toBe(true)
      expect(['reject', 'rewrite']).toContain(b.rootHandler)
      expect(['reject', 'rewrite']).toContain(b.fallbackHandler)
      if (b.rootHandler === 'rewrite') {
        expect(typeof b.rootRewriteTo).toBe('string')
        expect(b.rootRewriteTo.startsWith('/')).toBe(true)
      }
      if (b.fallbackHandler === 'rewrite') {
        expect(typeof b.fallbackRewriteTo).toBe('string')
        expect(b.fallbackRewriteTo.startsWith('/')).toBe(true)
      }
    }
  })
})

describe('resolveBrand', () => {
  it('returns null for the default CRM hostname', () => {
    // Anything not in the registry returns null. Middleware falls
    // through to the CRM auth path.
    expect(resolveBrand('crm.un1tdublin.com')).toBe(null)
    expect(resolveBrand('crm.un1tdublin.com:3000')).toBe(null)
  })

  it('returns null for empty / malformed input', () => {
    expect(resolveBrand('')).toBe(null)
    expect(resolveBrand(null)).toBe(null)
    expect(resolveBrand(undefined)).toBe(null)
    expect(resolveBrand(42)).toBe(null)
  })

  it('resolves the pay subdomain to ccfautos-pay', () => {
    const brand = resolveBrand('pay.ccfautos.com')
    expect(brand?.id).toBe('ccfautos-pay')
    expect(brand?.allowedPaths).toContain('/deposit/')
  })

  it('strips a port suffix when matching', () => {
    // Local dev / preview URLs include a port — must match the
    // same brand as production.
    expect(resolveBrand('pay.ccfautos.com:3000')?.id).toBe('ccfautos-pay')
    expect(resolveBrand('un1tdublin.com:8080')?.id).toBe('un1t-marketing')
  })

  it('resolves both apex + www variants to un1t-marketing', () => {
    expect(resolveBrand('un1tdublin.com')?.id).toBe('un1t-marketing')
    expect(resolveBrand('www.un1tdublin.com')?.id).toBe('un1t-marketing')
  })

  it('is case-sensitive on the host string (Host header arrives lowercase from spec)', () => {
    // We don't normalise case — relying on the HTTP spec that the
    // Host header is normalised by upstream proxies. Document the
    // current contract; if a malformed proxy ever forwards mixed
    // case, this test flags the gap loudly.
    expect(resolveBrand('PAY.CCFAUTOS.COM')).toBe(null)
  })

  it('the pay brand is 404-on-fallback (strictest mode)', () => {
    const brand = resolveBrand('pay.ccfautos.com')
    expect(brand?.rootHandler).toBe('reject')
    expect(brand?.fallbackHandler).toBe('reject')
  })

  it('the marketing brand rewrites instead of rejecting', () => {
    const brand = resolveBrand('un1tdublin.com')
    expect(brand?.rootHandler).toBe('rewrite')
    expect(brand?.rootRewriteTo).toBe('/welcome')
    expect(brand?.fallbackHandler).toBe('rewrite')
    expect(brand?.fallbackRewriteTo).toBe('/welcome')
  })
})

describe('isFrameworkAsset', () => {
  it('matches Next.js framework prefixes', () => {
    expect(isFrameworkAsset('/_next/static/chunks/main.js')).toBe(true)
    expect(isFrameworkAsset('/_next/image?url=/foo')).toBe(true)
  })

  it('matches the well-known static files', () => {
    expect(isFrameworkAsset('/favicon.ico')).toBe(true)
    expect(isFrameworkAsset('/robots.txt')).toBe(true)
    expect(isFrameworkAsset('/sitemap.xml')).toBe(true)
  })

  it('returns false for app paths', () => {
    expect(isFrameworkAsset('/')).toBe(false)
    expect(isFrameworkAsset('/welcome')).toBe(false)
    expect(isFrameworkAsset('/deposit/abc123')).toBe(false)
    expect(isFrameworkAsset('/api/cron/health-check')).toBe(false)
    expect(isFrameworkAsset('/dashboard')).toBe(false)
  })

  it('returns false for partial matches (e.g. /favicon.ico.bak)', () => {
    // Suffix matching uses Set.has on the file list — exact match
    // only, so a malicious path like /favicon.ico.bak doesn't bypass
    // the brand allowlist by pretending to be the favicon.
    expect(isFrameworkAsset('/favicon.ico.bak')).toBe(false)
    expect(isFrameworkAsset('/_nextish')).toBe(false)
  })

  it('returns false for malformed input', () => {
    expect(isFrameworkAsset(null)).toBe(false)
    expect(isFrameworkAsset(undefined)).toBe(false)
    expect(isFrameworkAsset(42)).toBe(false)
  })
})

describe('getLegacyBrandRows — read-only display descriptors for the admin view', () => {
  it('leads with the CRM default, then one descriptor per BRANDS entry', () => {
    const rows = getLegacyBrandRows()
    expect(rows[0].key).toBe('crm-default')
    expect(rows[0].label).toBe('CRM (default)')
    // Every registry brand id is represented.
    for (const b of BRANDS) {
      expect(rows.map((r) => r.key)).toContain(b.id)
    }
  })

  it('exposes the live legacy hostnames (marketing + pay)', () => {
    const hostnames = getLegacyBrandRows().map((r) => r.hostname)
    expect(hostnames).toContain('un1tdublin.com')
    expect(hostnames).toContain('pay.ccfautos.com')
  })

  it('CRM default falls back to the constant when NEXT_PUBLIC_APP_URL is unset', () => {
    const crmRow = getLegacyBrandRows().find((r) => r.key === 'crm-default')
    // In the test env NEXT_PUBLIC_APP_URL is typically unset → constant.
    expect(typeof crmRow.hostname).toBe('string')
    expect(crmRow.hostname.length).toBeGreaterThan(0)
    expect(CRM_DEFAULT_HOSTNAME).toBe(LEGACY_CRM_HOSTNAME)
  })

  it('carries a brand\'s extra hostnames (e.g. www.) separately from the primary', () => {
    const marketing = getLegacyBrandRows().find((r) => r.key === 'un1t-marketing')
    expect(marketing.hostname).toBe('un1tdublin.com')
    expect(marketing.extraHostnames).toContain('www.un1tdublin.com')
  })

  // REPSET-P6 — dual-domain: BOTH CRM hosts must show as managed-in-code
  // rows, or an admin looking at /admin/tenant-domains would think the
  // other one is unclaimed and try to add it as a tenant row.
  it('the CRM row shows BOTH CRM hostnames, canonical as the primary', () => {
    const crmRow = getLegacyBrandRows().find((r) => r.key === 'crm-default')
    // AUDIT-13.F — this used to assert the LEGACY host as primary while
    // its own title said "canonical primary". The row is the admin's
    // picture of which host the platform considers its front door.
    expect(crmRow.hostname).toBe(CANONICAL_CRM_HOSTNAME)
    expect(crmRow.extraHostnames).toContain(LEGACY_CRM_HOSTNAME)
  })

  it('a preview NEXT_PUBLIC_APP_URL host joins the CRM row as an extra hostname', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://preview-abc.vercel.app')
    const crmRow = getLegacyBrandRows().find((r) => r.key === 'crm-default')
    expect(crmRow.hostname).toBe(CANONICAL_CRM_HOSTNAME)
    expect(crmRow.extraHostnames).toContain('preview-abc.vercel.app')
    expect(crmRow.extraHostnames).toContain(LEGACY_CRM_HOSTNAME)
  })
})

// REPSET-P6 — the CRM hostname concept is SET-valued: the platform
// gains crm.repset.ie while crm.un1tdublin.com keeps serving forever.
// Everything that used to compare against ONE host derived from
// NEXT_PUBLIC_APP_URL consults this set instead.
describe('getCrmHostnames — dual-domain CRM host set', () => {
  it('defaults to both CRM hosts, canonical first', () => {
    expect(getCrmHostnames()).toEqual(['crm.repset.ie', 'crm.un1tdublin.com'])
  })

  // AUDIT-13.F — the assertion that gives "canonical-first" a MEANING
  // instead of a spelling. The docblock on getCrmHostnames() promises
  // index 0 is the canonical CRM host; the only other place in the repo
  // that names a canonical CRM host is legacy-host-redirect.js, which
  // redirects the legacy host TO CANONICAL_CRM_ORIGIN. Those two must
  // agree, or "canonical" means whatever the reader assumes. Before this
  // commit they disagreed: index 0 was the host being redirected AWAY.
  it('index 0 is the host legacy-host-redirect.js redirects TO', () => {
    const hosts = getCrmHostnames()
    expect(hosts[0]).toBe(new URL(CANONICAL_CRM_ORIGIN).hostname)
    expect(hosts[0]).not.toBe(LEGACY_CRM_HOST)
    // …and the legacy host is still in the set, serving forever.
    expect(hosts).toContain(LEGACY_CRM_HOST)
  })

  it('CRM_HOSTNAMES env comma-list overrides, order preserved (canonical first)', () => {
    vi.stubEnv('CRM_HOSTNAMES', 'crm.staging.example.com, crm.other.example.com')
    expect(getCrmHostnames()).toEqual(['crm.staging.example.com', 'crm.other.example.com'])
  })

  it('lowercases and drops empty entries', () => {
    vi.stubEnv('CRM_HOSTNAMES', ' CRM.Repset.ie ,, crm.un1tdublin.com ')
    expect(getCrmHostnames()).toEqual(['crm.repset.ie', 'crm.un1tdublin.com'])
  })

  it('appends the NEXT_PUBLIC_APP_URL hostname when not already listed (previews)', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://preview-abc.vercel.app')
    expect(getCrmHostnames()).toEqual(['crm.repset.ie', 'crm.un1tdublin.com', 'preview-abc.vercel.app'])
  })

  it('does not duplicate the NEXT_PUBLIC_APP_URL host when already in the set', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://crm.un1tdublin.com')
    expect(getCrmHostnames()).toEqual(['crm.repset.ie', 'crm.un1tdublin.com'])
  })

  it('tolerates an unset/malformed NEXT_PUBLIC_APP_URL (dev/tests)', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'not a url')
    expect(getCrmHostnames()).toEqual(['crm.repset.ie', 'crm.un1tdublin.com'])
  })

  // Order must never become load-bearing for the guards: both consumers
  // use .includes(), and a reorder must not change what they admit.
  it('both CRM hosts are in the set regardless of order', () => {
    vi.stubEnv('CRM_HOSTNAMES', 'crm.un1tdublin.com,crm.repset.ie')
    const reversed = getCrmHostnames()
    expect(new Set(reversed)).toEqual(new Set([CANONICAL_CRM_HOSTNAME, LEGACY_CRM_HOSTNAME]))
  })
})

describe('ccfautos-web brand', () => {
  const brand = BRANDS.find((b) => b.id === 'ccfautos-web')

  it('exists and covers apex + www', () => {
    expect(brand).toBeTruthy()
    expect(brand.hostnames).toContain('ccfautos.com')
    expect(brand.hostnames).toContain('www.ccfautos.com')
  })

  it('resolves from the hostname, with and without a port', () => {
    expect(resolveBrand('ccfautos.com')).toBe(brand)
    expect(resolveBrand('www.ccfautos.com:443')).toBe(brand)
  })

  it('rewrites root and strays to the landing page', () => {
    expect(brand.rootHandler).toBe('rewrite')
    expect(brand.rootRewriteTo).toBe('/ccf')
    expect(brand.fallbackHandler).toBe('rewrite')
    expect(brand.fallbackRewriteTo).toBe('/ccf')
  })

  it('allows ONLY the landing page + its enquiry API', () => {
    expect(brand.allowedPaths).toEqual(['/ccf', '/api/public/ccf-enquiry'])
  })
})
