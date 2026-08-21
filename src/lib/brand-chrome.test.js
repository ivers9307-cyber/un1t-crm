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
import { DEFAULT_COMPANY_NAME } from './location-branding.js'

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

// The root layout's metadata labels ~160 of this app's 188 pages — nearly
// every staff tab — but a handful of customer-facing pages inherit it too,
// so the answer is operator branding first and the platform name only as a
// floor. Never a hard-coded gym name.
describe('root site name resolves operator branding (CHROME.1)', () => {
  afterEach(() => { _resetDefaultSiteNameCache() })

  const dbReturning = (rows) => ({
    from: () => ({
      select: () => ({
        not: () => ({
          order: () => ({ limit: async () => ({ data: rows, error: null }) }),
        }),
      }),
    }),
  })

  it('uses the operator-configured company_settings.company_name', async () => {
    const name = await resolveDefaultSiteName({ db: dbReturning([{ company_name: 'Acme Fitness' }]) })
    expect(name).toBe('Acme Fitness')
  })

  it('falls back to the PLATFORM name, never a tenant gym, when unconfigured', async () => {
    const name = await resolveDefaultSiteName({ db: dbReturning([]) })
    expect(name).toBe(PLATFORM_SITE_NAME)
    expect(name).not.toMatch(/UN1T/)
  })

  it('ignores a whitespace-only name (an empty tab title is worse)', async () => {
    const name = await resolveDefaultSiteName({ db: dbReturning([{ company_name: '   ' }]) })
    expect(name).toBe(PLATFORM_SITE_NAME)
  })

  it('never throws and never blocks a render when the DB is down', async () => {
    const exploding = { from: () => { throw new Error('db down') } }
    await expect(resolveDefaultSiteName({ db: exploding })).resolves.toBe(PLATFORM_SITE_NAME)
  })

  it('caches within the TTL window and re-reads after it', async () => {
    let reads = 0
    const counting = {
      from: () => { reads++; return dbReturning([{ company_name: 'Acme Fitness' }]).from() },
    }
    await resolveDefaultSiteName({ db: counting, nowMs: 1_000_000 })
    await resolveDefaultSiteName({ db: counting, nowMs: 1_000_000 + 60_000 })
    expect(reads).toBe(1)
    await resolveDefaultSiteName({ db: counting, nowMs: 1_000_000 + 10 * 60_000 })
    expect(reads).toBe(2)
  })

  // The dynamic import pulls the root layout's whole child graph
  // (AppShellServer -> AppShell -> ...) through the transform pipeline, which
  // on a cold Vitest cache can exceed the 5s default and fail this guard for
  // reasons that have nothing to do with branding. Stub the children (only
  // generateMetadata is under test, and it never renders them) and give the
  // case room, so the regression guard cannot itself become the flake.
  it('the root layout renders the resolved name, not a literal', async () => {
    vi.resetModules()
    vi.doMock('@/lib/default-favicon', () => ({ resolveDefaultFaviconUrl: async () => '/f.png' }))
    vi.doMock('@/lib/default-site-name', () => ({ resolveDefaultSiteName: async () => 'Acme Fitness' }))
    vi.doMock('@/components/AppShellServer', () => ({ default: () => null }))
    vi.doMock('@/components/StudioLockOverlay', () => ({ default: () => null }))
    vi.doMock('@/components/CookieConsent', () => ({ default: () => null }))
    const { generateMetadata } = await import('@/app/layout.js')
    const meta = await generateMetadata()
    expect(meta.title).toBe('Acme Fitness')
    expect(meta.openGraph.siteName).toBe('Acme Fitness')
    expect(JSON.stringify(meta)).not.toMatch(/UN1T/)
    vi.doUnmock('@/lib/default-favicon')
    vi.doUnmock('@/lib/default-site-name')
    vi.doUnmock('@/components/AppShellServer')
    vi.doUnmock('@/components/StudioLockOverlay')
    vi.doUnmock('@/components/CookieConsent')
    vi.resetModules()
  }, 30_000)

  // The description used to be a hard-coded UN1T marketing tagline. CHROME.1's
  // first cut set it to the site name, which previews a shared link with a
  // one-word description. Neither is right; the editable home for a tagline is
  // a company_settings column.
  it('does not echo the site name back as the description', async () => {
    vi.resetModules()
    vi.doMock('@/lib/default-favicon', () => ({ resolveDefaultFaviconUrl: async () => '/f.png' }))
    vi.doMock('@/lib/default-site-name', () => ({ resolveDefaultSiteName: async () => 'Acme Fitness' }))
    vi.doMock('@/components/AppShellServer', () => ({ default: () => null }))
    vi.doMock('@/components/StudioLockOverlay', () => ({ default: () => null }))
    vi.doMock('@/components/CookieConsent', () => ({ default: () => null }))
    const { generateMetadata } = await import('@/app/layout.js')
    const meta = await generateMetadata()
    expect(meta.description).toBeUndefined()
    expect(meta.openGraph.description).toBeUndefined()
    vi.doUnmock('@/lib/default-favicon')
    vi.doUnmock('@/lib/default-site-name')
    vi.doUnmock('@/components/AppShellServer')
    vi.doUnmock('@/components/StudioLockOverlay')
    vi.doUnmock('@/components/CookieConsent')
    vi.resetModules()
  }, 30_000)
})

// The other half of the audience split. The root layout floors on the PLATFORM
// name because it labels ~160 staff pages; a customer-facing page must never
// inherit that floor. Verified against prod read-only: the single
// company_settings row has company_name NULL and org_settings is empty, so the
// FLOOR is what renders today — this is not a theoretical branch.
describe('customer-facing surfaces resolve the GYM identity, never the platform (CHROME.1)', () => {
  afterEach(() => { _resetDefaultSiteNameCache() })

  const dbReturning = (rows) => ({
    from: () => ({
      select: () => ({
        not: () => ({
          order: () => ({ limit: async () => ({ data: rows, error: null }) }),
        }),
      }),
    }),
  })

  it('floors on the gym wordmark, not Repset, when nothing is configured', async () => {
    const name = await resolveGymSiteName({ db: dbReturning([]) })
    expect(name).toBe(DEFAULT_COMPANY_NAME)
    expect(name).not.toBe(PLATFORM_SITE_NAME)
  })

  it('the two resolvers differ ONLY in the floor — a configured name wins for both', async () => {
    const gym = await resolveGymSiteName({ db: dbReturning([{ company_name: 'Acme Fitness' }]) })
    _resetDefaultSiteNameCache()
    const platform = await resolveDefaultSiteName({ db: dbReturning([{ company_name: 'Acme Fitness' }]) })
    expect(gym).toBe('Acme Fitness')
    expect(platform).toBe('Acme Fitness')
  })

  it('never throws and never blocks a customer render when the DB is down', async () => {
    const exploding = { from: () => { throw new Error('db down') } }
    await expect(resolveGymSiteName({ db: exploding })).resolves.toBe(DEFAULT_COMPANY_NAME)
  })

  it('customerFacingMetadata carries no description to echo', async () => {
    const meta = await customerFacingMetadata({ db: dbReturning([]) })
    expect(meta.title).toBe(DEFAULT_COMPANY_NAME)
    expect(meta.openGraph.siteName).toBe(DEFAULT_COMPANY_NAME)
    expect(meta.description).toBeUndefined()
    expect(meta.openGraph.description).toBeUndefined()
  })

  // The concrete list of subtrees that used to inherit the root metadata.
  // A new customer-facing route added without its own metadata silently
  // inherits the platform brand again, which is exactly the defect this
  // describe block exists to stop.
  it.each([
    ['src/app/book/[slug]/layout.js', 'public class booking'],
    ['src/app/event/layout.js', 'race confirmation + day board'],
    ['src/app/event-pay/layout.js', 'race payment checkout'],
    ['src/app/host-connect/layout.js', 'host Stripe onboarding'],
    ['src/app/host/layout.js', 'host portal + host login'],
    ['src/app/reset-password/layout.js', 'emailed recovery link'],
    ['src/app/account/layout.js', 'member self-service'],
  ])('%s declares its own customer-facing metadata (%s)', (rel) => {
    const src = repoFile(rel)
    expect(src).toContain('customerFacingMetadata')
    expect(src).toContain('export async function generateMetadata')
    expect(src).not.toMatch(/resolveDefaultSiteName/)
  })
})

// The other half of the locked decision: the gym floor keeps UN1T. These
// pin that the sweep above did NOT spill into it.
describe('gym-floor surfaces keep UN1T (locked decision)', () => {
  it('post-class email still awards "UN1T Points"', () => {
    const src = repoFile('src/lib/hr-post-class-email.js')
    expect(src).toContain('UN1T Points')
  })

  it('the TV cast page keeps its UN1T wordmark', () => {
    const src = repoFile('src/app/tv/cast/[token]/page.js')
    expect(src).toMatch(/UN1T/)
  })

  // /tv/[locationId] and /tv/live/[token] declared NO metadata and there was
  // no /tv layout, so they inherited the root title — which CHROME.1 moved
  // onto the platform name. That rebranded a locked surface by inheritance
  // and left the two boards disagreeing with their own /tv/cast sibling.
  // The subtree layout is now the one place that answers for all of them.
  it('the whole /tv subtree is pinned to UN1T by its own layout', () => {
    const src = repoFile('src/app/tv/layout.js')
    expect(src).toMatch(/export const metadata\s*=\s*\{[\s\S]*title:\s*'UN1T'/)
  })

  it('neither in-studio board is left inheriting the platform chrome', () => {
    for (const rel of ['src/app/tv/[locationId]/page.jsx', 'src/app/tv/live/[token]/page.jsx']) {
      const src = repoFile(rel)
      // Either the page says UN1T itself or it is covered by the /tv layout
      // asserted above; what it must never do is resolve platform chrome.
      expect(src).not.toMatch(/resolveDefaultSiteName|PLATFORM_SITE_NAME|Repset/)
    }
  })
})
