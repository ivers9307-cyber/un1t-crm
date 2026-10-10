// CHROME.1 — regression guard for the STAFF/PLATFORM chrome strings.
//
// The brand split is a LOCKED product decision and it is a boundary
// judgement, not a find-and-replace:
//
//   staff / platform chrome     → Repset   (this file guards it)
//   gym floor: TV boards,
//   in-class displays,
//   "UN1T Points"               → UN1T     (deliberately untouched)
//   anything naming the gym to
//   a customer                  → operator branding via company_settings
//
// Every assertion below reads the REAL producer, so it fails if the string
// is reintroduced anywhere on the path — not just in the file it lives in.
// The one exception is the login footer, which is JSX inside a client
// component with no exported renderer; that is asserted against the source.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { getOpenApiSpec } from './openapi.js'
import { SYSTEM_PROMPT } from './assistant-prompt.js'
import { buildReportEmailHtml } from './report-generator.js'
import { buildDigestEmail } from './churn-radar-digest.js'
import {
  resolveDefaultSiteName,
  resolveGymSiteName,
  customerFacingMetadata,
  _resetDefaultSiteNameCache,
  PLATFORM_SITE_NAME,
} from './default-site-name.js'
import { makeFakeDb } from './api-auth.test-helpers.js'
import { _resetTenantDomainsCache } from './tenant-domains-edge.js'
import { UN1T_GROUP_ORG_ID } from './brands.js'

const repoFile = (rel) => readFileSync(path.join(process.cwd(), rel), 'utf8')

describe('platform chrome reads Repset, not UN1T (CHROME.1)', () => {
  it('OpenAPI spec info — the integrator-facing product name', async () => {
    const spec = await getOpenApiSpec()
    expect(spec.info.title).toBe('Repset CRM API')
    expect(spec.info.title).not.toMatch(/UN1T/)
    expect(spec.info.description).not.toMatch(/UN1T/)
  })

  it('/api-docs portal — page title and spec picker', () => {
    const src = repoFile('src/app/api-docs/route.js')
    expect(src).toContain('<title>Repset — API Portal</title>')
    expect(src).toContain("name: 'Repset CRM'")
    expect(src).toContain("'urls.primaryName': 'Repset CRM'")
  })

  // Swagger UI silently renders NOTHING when primaryName matches no entry in
  // `urls`, so the two must be changed together. This is the guard for that.
  it('/api-docs primaryName matches a spec name exactly', () => {
    const src = repoFile('src/app/api-docs/route.js')
    const primary = src.match(/'urls\.primaryName':\s*'([^']+)'/)?.[1]
    const names = [...src.matchAll(/name:\s*'([^']+)'\s*\}/g)].map((m) => m[1])
    expect(primary).toBeTruthy()
    expect(names).toContain(primary)
  })

  it('in-app assistant introduces the platform as Repset', () => {
    expect(SYSTEM_PROMPT).toContain('Repset CRM Assistant')
    expect(SYSTEM_PROMPT).toContain('Repset gym management platform')
    expect(SYSTEM_PROMPT).not.toContain('UN1T CRM Assistant')
    expect(SYSTEM_PROMPT).not.toContain('UN1T gym management platform')
  })

  it('scheduled-report email footer — staff recipients, platform name', () => {
    const html = buildReportEmailHtml(
      { report_name: 'Weekly', rows: [], period_start: '2026-08-01', period_end: '2026-08-07' },
      { appUrl: 'https://crm.repset.ie' },
    )
    expect(html).toContain('Repset · automated report delivery')
    expect(html).not.toMatch(/UN1T/)
  })

  it('churn radar digest footer — staff digest, platform name', () => {
    const { html } = buildDigestEmail({}, [], { locationName: 'UN1T Stillorgan' })
    expect(html).toContain('Repset radar')
    // The STUDIO's name still renders — that is the operator's identity and
    // must survive; only the platform footer changed.
    expect(html).toContain('UN1T Stillorgan')
  })

  it('churn radar digest never substitutes one tenant\'s gym for a missing name', () => {
    const { subject, html } = buildDigestEmail({}, [], {})
    expect(subject).not.toMatch(/UN1T/)
    expect(html).not.toMatch(/UN1T/)
  })

  it('staff push-fallback email names the app staff can actually install', () => {
    const src = repoFile('src/lib/notify.js')
    expect(src).toContain('Repset mobile app')
    expect(src).not.toContain('UN1T CRM mobile app')
    expect(src).not.toContain("|| 'UN1T notification'")
  })

  it('login page footer names the platform', () => {
    const src = repoFile('src/app/login/page.js')
    expect(src).toContain('>Repset</p>')
    expect(src).not.toContain('>UN1T CRM</p>')
  })

  // Byte-identical copy to notify.js's, on the same staff surface, for the
  // same reason: the staff app ships to the stores as "Repset"
  // (mobile/app.config.js `name`), so "UN1T CRM mobile app" names a title
  // staff cannot search for. The first sweep changed one of the two and the
  // guard only watched that one, which is how the pair drifted.
  it('the staff notification-health nudge names an app staff can find', () => {
    const src = repoFile('src/app/settings/notifications/health/page.js')
    expect(src).toContain('Install the Repset mobile app')
    expect(src).toContain('Please install the Repset mobile app from TestFlight')
    expect(src).not.toContain('UN1T CRM mobile app')
  })

  // The assistant's SYSTEM PROMPT was renamed to "Repset CRM Assistant" but
  // its visible panel header and greeting were not, so staff read one brand
  // on screen and the model claimed another. Both are staff chrome inside the
  // authenticated AppShell.
  it('the assistant panel staff actually see says Repset too', () => {
    const src = repoFile('src/components/AssistantBubble.jsx')
    expect(src).toContain('>Repset Assistant<')
    expect(src).toContain("I'm your Repset assistant.")
    expect(src).not.toContain('UN1T Assistant')
    expect(src).not.toContain('your UN1T assistant')
  })
})

// W1.L4 — the site name resolves by the REQUEST'S HOST. A tenant host (a
// tenant_domains row, or an in-code brand carrying an organizationId) reads
// its organisation's brand (org_settings → the earliest active location's
// company_settings in that org → the location name); the CRM hosts and any
// unmapped host read the PLATFORM name. Before W1.L4 both resolvers took the
// FIRST configured company_settings row estate-wide, so one tenant's name
// labelled every tenant's tabs — and the CRM's.
const ORG_A = 'org-a'
const ORG_B = 'org-b'
function hostTables() {
  return {
    tenant_domains: [
      { id: 'td-a', hostname: 'gym-a.repset.ie', organization_id: ORG_A, brand: {}, active: true, source: 'platform', location_id: null },
      { id: 'td-b', hostname: 'gym-b.repset.ie', organization_id: ORG_B, brand: {}, active: true, source: 'platform', location_id: null },
    ],
    organizations: [{ id: ORG_A, slug: 'gym-a', master_location_id: null }, { id: ORG_B, slug: 'gym-b', master_location_id: null }],
    locations: [
      { id: 'loc-a1', name: 'Gym A North', organization_id: ORG_A, active: true, created_at: '2026-01-01' },
      { id: 'loc-b1', name: 'Gym B', organization_id: ORG_B, active: true, created_at: '2026-01-02' },
    ],
    org_settings: [],
    company_settings: [],
  }
}
function seedTenantDomain(t, row) { t.tenant_domains.push({ id: `td-${row.hostname}`, brand: {}, active: true, source: 'custom', location_id: null, ...row }) }
function seedOrgSettings(t, row) { t.org_settings.push({ logo_url: null, favicon_url: null, ...row }) }
function seedCompanySettings(t, row) { t.company_settings.push({ logo_url: null, favicon_url: null, ...row }) }
const resetBrandCaches = () => { _resetDefaultSiteNameCache(); _resetTenantDomainsCache() }

// The root layout's metadata labels ~160 of this app's 188 pages — nearly
// every staff tab — so on the CRM hosts it is the PLATFORM name, and a
// tenant's own host reads the tenant's brand. Never a hard-coded gym name,
// and never ANOTHER tenant's.
describe('root site name resolves by host (CHROME.1 / W1.L4)', () => {
  afterEach(resetBrandCaches)

  it('a tenant host → that org\'s operator-configured brand', async () => {
    const t = hostTables()
    seedOrgSettings(t, { organization_id: ORG_A, company_name: 'Acme Fitness' })
    expect(await resolveDefaultSiteName({ host: 'gym-a.repset.ie', db: makeFakeDb(t) })).toBe('Acme Fitness')
  })

  it('the CRM host → the PLATFORM name, never a tenant gym, whatever company_settings holds', async () => {
    const t = hostTables()
    seedCompanySettings(t, { location_id: 'loc-a1', company_name: 'Acme Fitness' })
    expect(await resolveDefaultSiteName({ host: 'crm.repset.ie', db: makeFakeDb(t) })).toBe(PLATFORM_SITE_NAME)
    resetBrandCaches()
    expect(await resolveDefaultSiteName({ host: 'crm.un1tdublin.com', db: makeFakeDb(t) })).toBe(PLATFORM_SITE_NAME)
    resetBrandCaches()
    expect(await resolveDefaultSiteName({ db: makeFakeDb(t) })).toBe(PLATFORM_SITE_NAME)
    expect(PLATFORM_SITE_NAME).not.toMatch(/UN1T/)
  })

  it('ignores a whitespace-only org name and floors on the location name, then the platform', async () => {
    const t = hostTables()
    seedOrgSettings(t, { organization_id: ORG_A, company_name: '   ' })
    expect(await resolveDefaultSiteName({ host: 'gym-a.repset.ie', db: makeFakeDb(t) })).toBe('Gym A North')
    resetBrandCaches()
    t.locations = []
    expect(await resolveDefaultSiteName({ host: 'gym-a.repset.ie', db: makeFakeDb(t) })).toBe(PLATFORM_SITE_NAME)
  })

  it('never throws and never blocks a render when the DB is down', async () => {
    const exploding = { from: () => { throw new Error('db down') } }
    await expect(resolveDefaultSiteName({ host: 'gym-a.repset.ie', db: exploding })).resolves.toBe(PLATFORM_SITE_NAME)
  })

  it('caches PER HOST within the TTL window and re-reads after it', async () => {
    const t = hostTables()
    seedOrgSettings(t, { organization_id: ORG_A, company_name: 'Acme Fitness' })
    seedOrgSettings(t, { organization_id: ORG_B, company_name: 'Gym B' })
    const inner = makeFakeDb(t)
    let reads = 0
    const counting = { from: (table) => { reads++; return inner.from(table) } }
    expect(await resolveDefaultSiteName({ host: 'gym-a.repset.ie', db: counting, nowMs: 1_000_000 })).toBe('Acme Fitness')
    const after = reads
    expect(await resolveDefaultSiteName({ host: 'gym-a.repset.ie', db: counting, nowMs: 1_000_000 + 60_000 })).toBe('Acme Fitness')
    expect(reads).toBe(after)
    // A different host is a different cache entry — Gym A's answer is never served to Gym B.
    expect(await resolveDefaultSiteName({ host: 'gym-b.repset.ie', db: counting, nowMs: 1_000_000 + 60_000 })).toBe('Gym B')
    expect(reads).toBeGreaterThan(after)
    const afterB = reads
    await resolveDefaultSiteName({ host: 'gym-a.repset.ie', db: counting, nowMs: 1_000_000 + 10 * 60_000 })
    expect(reads).toBeGreaterThan(afterB)
  })

  // The dynamic import pulls the root layout's whole child graph
  // (AppShellServer -> AppShell -> ...) through the transform pipeline, which
  // on a cold Vitest cache can exceed the 5s default and fail this guard for
  // reasons that have nothing to do with branding. Stub the children (only
  // generateMetadata is under test, and it never renders them) and give the
  // case room, so the regression guard cannot itself become the flake.
  const mockRootLayoutDeps = () => {
    vi.resetModules()
    vi.doMock('next/headers', () => ({ headers: async () => new Headers({ host: 'gym-a.repset.ie' }) }))
    vi.doMock('@/lib/default-favicon', () => ({ resolveDefaultFaviconUrl: async ({ host }) => `/f-${host}.png` }))
    vi.doMock('@/lib/default-site-name', () => ({ resolveDefaultSiteName: async ({ host }) => (host === 'gym-a.repset.ie' ? 'Acme Fitness' : 'WRONG HOST') }))
    vi.doMock('@/components/AppShellServer', () => ({ default: () => null }))
    vi.doMock('@/components/StudioLockOverlay', () => ({ default: () => null }))
    vi.doMock('@/components/CookieConsent', () => ({ default: () => null }))
  }
  const unmockRootLayoutDeps = () => {
    vi.doUnmock('next/headers')
    vi.doUnmock('@/lib/default-favicon')
    vi.doUnmock('@/lib/default-site-name')
    vi.doUnmock('@/components/AppShellServer')
    vi.doUnmock('@/components/StudioLockOverlay')
    vi.doUnmock('@/components/CookieConsent')
    vi.resetModules()
  }

  it('the root layout renders the name resolved for the REQUEST HOST, not a literal', async () => {
    mockRootLayoutDeps()
    const { generateMetadata } = await import('@/app/layout.js')
    const meta = await generateMetadata()
    expect(meta.title).toBe('Acme Fitness')
    expect(meta.openGraph.siteName).toBe('Acme Fitness')
    expect(meta.icons.icon).toBe('/f-gym-a.repset.ie.png')
    expect(JSON.stringify(meta)).not.toMatch(/UN1T/)
    unmockRootLayoutDeps()
  }, 30_000)

  // The description used to be a hard-coded UN1T marketing tagline. CHROME.1's
  // first cut set it to the site name, which previews a shared link with a
  // one-word description. Neither is right; the editable home for a tagline is
  // a company_settings column.
  it('does not echo the site name back as the description', async () => {
    mockRootLayoutDeps()
    const { generateMetadata } = await import('@/app/layout.js')
    const meta = await generateMetadata()
    expect(meta.description).toBeUndefined()
    expect(meta.openGraph.description).toBeUndefined()
    unmockRootLayoutDeps()
  }, 30_000)
})

// The customer-facing half. Since W1.L4 the customer-facing layouts thread
// the request host in, so a tenant's customers read the tenant's brand and
// a CRM-host link reads the platform's — never the first company_settings
// row in the estate, which is what every customer used to read.
describe('customer-facing surfaces resolve the brand of the host\'s organisation (CHROME.1 / W1.L4)', () => {
  afterEach(resetBrandCaches)

  it('W1.L4 — customerFacingMetadata resolves the brand of the host\'s organisation', async () => {
    const t = hostTables()
    seedTenantDomain(t, { hostname: 'members.gym-a.com', organization_id: ORG_A })
    seedOrgSettings(t, { organization_id: ORG_A, company_name: 'Gym A' })
    const meta = await customerFacingMetadata({ host: 'members.gym-a.com', db: makeFakeDb(t) })
    expect(meta.title).toBe('Gym A')
    expect(meta.openGraph.siteName).toBe('Gym A')
    resetBrandCaches()
    const platform = await customerFacingMetadata({ host: 'gym-a.repset.ie', db: makeFakeDb(t) })
    expect(platform.title).toBe('Gym A')
  })

  it('W1.L4 — on the CRM host with no org the name is the platform name, never the first company_settings row', async () => {
    const t = hostTables()
    seedCompanySettings(t, { location_id: 'loc-a1', company_name: 'Gym A' })
    const meta = await customerFacingMetadata({ host: 'crm.repset.ie', db: makeFakeDb(t) })
    expect(meta.title).toBe('Repset')
    expect(meta.openGraph.siteName).toBe('Repset')
  })

  // THE regression this task exists to close: before W1.L4 every tenant's
  // customers read whichever company_settings row sorted first.
  it('W1.L4 — a second tenant\'s company_settings row cannot change another tenant\'s rendered brand', async () => {
    const t = hostTables()
    seedCompanySettings(t, { location_id: 'loc-a1', company_name: 'Gym A' })
    seedCompanySettings(t, { location_id: 'loc-b1', company_name: 'AAA Gym B' }) // sorts first by any column
    seedOrgSettings(t, { organization_id: ORG_B, company_name: 'AAA Gym B' })
    expect((await customerFacingMetadata({ host: 'gym-a.repset.ie', db: makeFakeDb(t) })).title).toBe('Gym A')
    expect((await customerFacingMetadata({ host: 'gym-b.repset.ie', db: makeFakeDb(t) })).title).toBe('AAA Gym B')
    expect((await customerFacingMetadata({ host: 'crm.repset.ie', db: makeFakeDb(t) })).title).toBe('Repset')
    expect((await resolveGymSiteName({ host: 'gym-a.repset.ie', db: makeFakeDb(t) }))).toBe('Gym A')
  })

  it('W1.L4 — an in-code brand host (un1tdublin.com) resolves its organisation through the in-code tier', async () => {
    const t = hostTables()
    seedOrgSettings(t, { organization_id: UN1T_GROUP_ORG_ID, company_name: 'UN1T Dublin' })
    expect((await customerFacingMetadata({ host: 'un1tdublin.com', db: makeFakeDb(t) })).title).toBe('UN1T Dublin')
  })

  it('the two resolvers agree — same chain, same floor', async () => {
    const t = hostTables()
    seedOrgSettings(t, { organization_id: ORG_A, company_name: 'Acme Fitness' })
    const gym = await resolveGymSiteName({ host: 'gym-a.repset.ie', db: makeFakeDb(t) })
    resetBrandCaches()
    const platform = await resolveDefaultSiteName({ host: 'gym-a.repset.ie', db: makeFakeDb(t) })
    expect(gym).toBe('Acme Fitness')
    expect(platform).toBe('Acme Fitness')
    resetBrandCaches()
    expect(await resolveGymSiteName({ host: 'gym-a.repset.ie', db: makeFakeDb(hostTables()) })).toBe('Gym A North')
  })

  it('never throws and never blocks a customer render when the DB is down', async () => {
    const exploding = { from: () => { throw new Error('db down') } }
    await expect(resolveGymSiteName({ host: 'gym-a.repset.ie', db: exploding })).resolves.toBe(PLATFORM_SITE_NAME)
  })

  it('customerFacingMetadata carries no description to echo', async () => {
    const meta = await customerFacingMetadata({ host: 'crm.repset.ie', db: makeFakeDb(hostTables()) })
    expect(meta.title).toBe(PLATFORM_SITE_NAME)
    expect(meta.openGraph.siteName).toBe(PLATFORM_SITE_NAME)
    expect(meta.description).toBeUndefined()
    expect(meta.openGraph.description).toBeUndefined()
  })

  // The concrete list of subtrees that used to inherit the root metadata.
  // A new customer-facing route added without its own metadata silently
  // inherits the platform brand again, which is exactly the defect this
  // describe block exists to stop. Since W1.L4 each one must also thread the
  // request host in, or it reads the platform name on every tenant host.
  it.each([
    ['src/app/book/[slug]/layout.js', 'public class booking'],
    ['src/app/event/layout.js', 'race confirmation + day board'],
    ['src/app/event-pay/layout.js', 'race payment checkout'],
    ['src/app/host-connect/layout.js', 'host Stripe onboarding'],
    ['src/app/host/layout.js', 'host portal + host login'],
    ['src/app/reset-password/layout.js', 'emailed recovery link'],
    ['src/app/account/layout.js', 'member self-service'],
  ])('%s declares its own HOST-keyed customer-facing metadata (%s)', (rel) => {
    const src = repoFile(rel)
    expect(src).toContain('customerFacingMetadata')
    expect(src).toContain('export async function generateMetadata')
    expect(src).toMatch(/customerFacingMetadata\(\{\s*host:\s*\(await headers\(\)\)\.get\('host'\)/)
    expect(src).not.toMatch(/resolveDefaultSiteName/)
  })

  it('the root layout threads the request host into both resolvers', () => {
    const src = repoFile('src/app/layout.js')
    expect(src).toMatch(/resolveDefaultFaviconUrl\(\{\s*host/)
    expect(src).toMatch(/resolveDefaultSiteName\(\{\s*host/)
  })

  // Static `export const metadata` on a customer page is a literal by
  // construction. These used to say "— UN1T"; now each resolves by host.
  it.each([
    'src/app/unsubscribe/[token]/page.js',
    'src/app/unsubscribe/host/[token]/page.js',
    'src/app/preferences/layout.js',
    'src/app/preferences/[token]/page.js',
    'src/app/welcome/page.js',
  ])('%s resolves its title by host instead of a UN1T literal', (rel) => {
    const src = repoFile(rel)
    expect(src).toContain('export async function generateMetadata')
    expect(src).not.toMatch(/export const metadata/)
    expect(src).not.toMatch(/title:\s*'[^']*UN1T/)
    expect(src).not.toMatch(/siteName:\s*'UN1T/)
  })

  it.each([
    'src/app/event/[slug]/page.js',
    'src/app/embed/event/[slug]/page.js',
    'src/app/welcome/[location]/page.js',
    'src/app/welcome/[location]/events/page.js',
  ])('%s OG metadata names the resolved brand, not a UN1T literal', (rel) => {
    const src = repoFile(rel)
    const meta = src.slice(src.indexOf('export async function generateMetadata'), src.indexOf('export default'))
    expect(meta).not.toMatch(/UN1T/)
  })
})

// The other half of the locked decision: the gym floor keeps UN1T. These
// pin that the sweep above did NOT spill into it.
describe('gym-floor surfaces keep UN1T (locked decision)', () => {
  it('post-class email still awards "UN1T Points"', () => {
    const src = repoFile('src/lib/hr-post-class-email.js')
    expect(src).toContain('UN1T Points')
  })

  // W1.S1b — the gym floor keeps the GYM's brand, which is no longer a
  // literal: every board names its studio's configured brand (UN1T's own
  // studios resolve to "UN1T Stillorgan" / "UN1T Hatch Street").
  it('the TV cast page titles itself from its display\'s studio brand, not a literal', () => {
    const src = repoFile('src/app/tv/cast/[token]/page.js')
    expect(src).toContain('export async function generateMetadata')
    expect(src).toMatch(/display\?\.company_name/)
    expect(src).not.toMatch(/export const metadata/)
    expect(src).not.toMatch(/title:\s*'[^']*UN1T/)
  })

  // /tv/live/[token] and /challenges declare no metadata of their own; the
  // /tv layout is their floor. It names the request host's organisation
  // (never the platform chrome, never a literal) and each board sets the tab
  // from its payload's brand.
  it('the /tv subtree floor resolves the host\'s organisation brand, not a literal', () => {
    const src = repoFile('src/app/tv/layout.js')
    expect(src).toContain('export async function generateMetadata')
    expect(src).toMatch(/resolveHostBrand\(/)
    expect(src).not.toMatch(/export const metadata/)
    expect(src).not.toMatch(/resolveDefaultSiteName|PLATFORM_SITE_NAME|PLATFORM_NAME/)
    for (const rel of ['src/app/tv/live/[token]/LiveTvClient.jsx', 'src/app/tv/live/[token]/challenges/ChallengeTvClient.jsx']) {
      expect(repoFile(rel)).toMatch(/document\.title = brandName/)
    }
  })

  it('neither in-studio board is left inheriting the platform chrome', () => {
    for (const rel of ['src/app/tv/live/[token]/page.jsx', 'src/app/tv/live/[token]/challenges/page.jsx']) {
      const src = repoFile(rel)
      // Either the page says UN1T itself or it is covered by the /tv layout
      // asserted above; what it must never do is resolve platform chrome.
      expect(src).not.toMatch(/resolveDefaultSiteName|PLATFORM_SITE_NAME|Repset/)
    }
  })
})
