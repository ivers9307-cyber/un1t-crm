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
  _resetDefaultSiteNameCache,
  PLATFORM_SITE_NAME,
} from './default-site-name.js'

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

  it('the root layout renders the resolved name, not a literal', async () => {
    vi.resetModules()
    vi.doMock('@/lib/default-favicon', () => ({ resolveDefaultFaviconUrl: async () => '/f.png' }))
    vi.doMock('@/lib/default-site-name', () => ({ resolveDefaultSiteName: async () => 'Acme Fitness' }))
    const { generateMetadata } = await import('@/app/layout.js')
    const meta = await generateMetadata()
    expect(meta.title).toBe('Acme Fitness')
    expect(meta.openGraph.siteName).toBe('Acme Fitness')
    expect(JSON.stringify(meta)).not.toMatch(/UN1T/)
    vi.doUnmock('@/lib/default-favicon')
    vi.doUnmock('@/lib/default-site-name')
    vi.resetModules()
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
})
