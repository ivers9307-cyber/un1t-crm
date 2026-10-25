// Tests for the pure matcher functions behind check:location-scoping
// (scripts/check-location-scoping.mjs, SAAS-9). The script itself is the
// CI gate; these tests pin the core heuristics — table derivation from
// migration SQL, positive/negative evidence detection, chain extraction,
// and EXEMPT handling — so a refactor can't silently loosen the tripwire.

import { describe, it, expect } from 'vitest'
import {
  deriveLocationTables,
  extractQueryChains,
  chainHasTenantEvidence,
  fileHasTenantEvidence,
  tablesQueried,
  classifyRoute,
  classifyPage,
  classifyLayout,
  findStaleExemptions,
  APP_SURFACE_FILES,
  isAppSurfaceFile,
} from '../scripts/check-location-scoping.mjs'

describe('deriveLocationTables', () => {
  it('a -- inside a string does not end the line early (GUARDSTRIP.1)', () => {
    const sql = `SELECT '--'; CREATE TABLE contacts (id uuid, location_id uuid);`
    expect([...deriveLocationTables(sql)]).toEqual(['contacts'])
  })

  it('finds location_id inside a CREATE TABLE body', () => {
    const sql = `
      CREATE TABLE contacts (
        id UUID PRIMARY KEY,
        location_id UUID REFERENCES locations(id)
      );
    `
    expect([...deriveLocationTables(sql)]).toEqual(['contacts'])
  })

  it('handles IF NOT EXISTS + public. prefix + quoted names', () => {
    const sql = `
      CREATE TABLE IF NOT EXISTS public."tv_displays" (
        id uuid,
        location_id uuid NOT NULL
      );
    `
    expect([...deriveLocationTables(sql)]).toEqual(['tv_displays'])
  })

  it('does not bleed a later table\'s location_id into an earlier one', () => {
    const sql = `
      CREATE TABLE global_settings (
        id uuid PRIMARY KEY,
        value jsonb
      );
      CREATE TABLE scoped_things (
        id uuid,
        location_id uuid
      );
    `
    expect([...deriveLocationTables(sql)]).toEqual(['scoped_things'])
  })

  it('finds ALTER TABLE ... ADD COLUMN location_id (with and without IF NOT EXISTS)', () => {
    const sql = `
      ALTER TABLE contacts ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES locations(id);
      ALTER TABLE deals ADD COLUMN location_id UUID;
      ALTER TABLE bookings ADD COLUMN notes TEXT;
    `
    expect([...deriveLocationTables(sql)].sort()).toEqual(['contacts', 'deals'])
  })

  it('ignores commented-out DDL and private-schema tables', () => {
    const sql = `
      -- CREATE TABLE ghosts ( id uuid, location_id uuid );
      CREATE TABLE IF NOT EXISTS private.app_config (
        key text,
        location_id uuid
      );
      -- ALTER TABLE phantoms ADD COLUMN location_id uuid;
    `
    expect([...deriveLocationTables(sql)]).toEqual([])
  })

  it('ignores tables whose body merely references another column name', () => {
    const sql = `
      CREATE TABLE plain (
        id uuid,
        org_ref uuid
      );
    `
    expect([...deriveLocationTables(sql)]).toEqual([])
  })
})

describe('extractQueryChains', () => {
  it('captures a full multiline fluent chain', () => {
    const src = `
      const { data } = await db
        .from('contacts')
        .select('id, name')
        .eq('location_id', locationId)
        .limit(50)
    `
    const chains = extractQueryChains(src, 'contacts')
    expect(chains).toHaveLength(1)
    expect(chains[0]).toContain(".eq('location_id', locationId)")
    expect(chains[0]).toContain('.limit(50)')
  })

  it('stops at the end of the chain (does not swallow the next statement)', () => {
    const src = `
      const a = await db.from('contacts').select('id').eq('id', x).single()
      const b = await db.from('deals').select('id').eq('location_id', loc)
    `
    const [chain] = extractQueryChains(src, 'contacts')
    expect(chain).not.toContain('deals')
    expect(chain).not.toContain('location_id')
  })

  it('survives parens and quotes inside .or() arguments', () => {
    const src = `
      await db.from('contacts').select('id').or(\`location_id.in.(\${ids.join(',')})\`).limit(5)
    `
    const [chain] = extractQueryChains(src, 'contacts')
    expect(chain).toContain('.limit(5)')
  })

  it('returns one chain per occurrence', () => {
    const src = `
      await db.from('contacts').select('id').eq('id', a)
      await db.from('contacts').update(x).eq('id', b)
    `
    expect(extractQueryChains(src, 'contacts')).toHaveLength(2)
  })
})

describe('chainHasTenantEvidence', () => {
  it.each([
    [".from('contacts').select('*').eq('location_id', loc)", true],
    [".from('contacts').select('*').in('location_id', ids)", true],
    [".from('x').select('*').eq('block.location_id', loc)", true],
    [".from('x').select('*').eq('organization_id', orgId)", true],
    [".from('x').select('*').or('location_id.eq.abc,location_id.is.null')", true],
    [".from('x').select('*').match({ location_id: loc, active: true })", true],
    [".from('x').insert({ name, location_id: loc })", true],
    [".from('x').update({ label, location_id: loc }).eq('id', id)", true],
    [".from('contact_preferences').select('*').eq('unsubscribe_token', token)", true],
    // negative: pk-only fetch, select-listing the column, unscoped write
    [".from('contacts').select('*').eq('id', id).single()", false],
    [".from('contacts').select('id, location_id').eq('id', id)", false],
    [".from('x').update({ label }).eq('id', id)", false],
    [".from('contacts').select('*').limit(50)", false],
  ])('%s → %s', (chain, expected) => {
    expect(chainHasTenantEvidence(chain)).toBe(expected)
  })
})

describe('fileHasTenantEvidence', () => {
  it('accepts the detached-builder idiom', () => {
    const src = `
      let q = db.from('contacts').select('*')
      if (locationId) q = q.eq('location_id', locationId)
    `
    expect(fileHasTenantEvidence(src)).toBe(true)
  })

  it('accepts verified scoping helpers', () => {
    expect(fileHasTenantEvidence('const guard = assertLocationAccessOr404(user, row.location_id)')).toBe(true)
    expect(fileHasTenantEvidence('const ids = await orgScopeLocationIds(db, auth.orgId)')).toBe(true)
    expect(fileHasTenantEvidence('const bridge = await verifyBridgeToken(request)')).toBe(true)
  })

  it('accepts fetch-by-pk-then-compare shapes', () => {
    expect(fileHasTenantEvidence('if (!contact || contact.location_id !== locationId) return notFound()')).toBe(true)
    expect(fileHasTenantEvidence('if (!userLocIds.includes(contact.location_id)) return forbidden()')).toBe(true)
    expect(fileHasTenantEvidence('if (!userLocIds.has(row.location_id)) continue')).toBe(true)
  })

  it('accepts owner-row boundaries against the authed user', () => {
    expect(fileHasTenantEvidence('if (claim.profile_id !== user.id) return forbidden()')).toBe(true)
    expect(fileHasTenantEvidence("const { data } = await q.eq('profile_id', user.id)")).toBe(true)
  })

  it('accepts master-only gates', () => {
    expect(fileHasTenantEvidence("if (!user || user.profileRole !== 'master') return null")).toBe(true)
    expect(fileHasTenantEvidence('if (!user.isMaster) { return forbidden() }')).toBe(true)
  })

  it('rejects a handler with no tenant evidence at all', () => {
    const src = `
      const user = await getCurrentUser()
      if (!user) return unauthorized()
      const { data } = await db.from('contacts').select('*').eq('id', params.id).single()
      return NextResponse.json({ success: true, data })
    `
    expect(fileHasTenantEvidence(src)).toBe(false)
  })
})

describe('classifyRoute', () => {
  const TABLES = new Set(['contacts', 'deals'])

  const unscoped = `
    const user = await getCurrentUser()
    const { data } = await db.from('contacts').select('*').eq('id', params.id).single()
  `

  it('flags an authenticated-but-unscoped tenant query', () => {
    const res = classifyRoute('src/app/api/things/route.js', unscoped, TABLES, {})
    expect(res.findings).toEqual([{ table: 'contacts', exempt: false }])
  })

  it('passes when the chain is scoped', () => {
    const src = `
      const { data } = await db.from('contacts').select('*').eq('location_id', loc)
    `
    const res = classifyRoute('src/app/api/things/route.js', src, TABLES, {})
    expect(res.findings).toEqual([])
  })

  it('skips cron and qstash worker paths by design', () => {
    expect(classifyRoute('src/app/api/cron/sweep/route.js', unscoped, TABLES, {})).toEqual({ skipped: 'cron' })
    expect(classifyRoute('src/app/api/webhooks/qstash/jobs/route.js', unscoped, TABLES, {})).toEqual({ skipped: 'qstash' })
  })

  it('honours a per-route-per-table EXEMPT entry (and only that table)', () => {
    const src = `
      const a = await db.from('contacts').select('*').eq('id', x).single()
      const b = await db.from('deals').select('*').limit(5)
    `
    const exempt = {
      'src/app/api/things/route.js': { contacts: 'token IS the scope (test fixture)' },
    }
    const res = classifyRoute('src/app/api/things/route.js', src, new Set(['contacts', 'deals']), exempt)
    expect(res.findings).toEqual([
      { table: 'contacts', exempt: true },
      { table: 'deals', exempt: false },
    ])
  })
})

describe('classifyPage', () => {
  const TABLES = new Set(['email_templates', 'contacts'])

  // The TPL-IDOR.1 shape: server page, service-role client, bare-id fetch,
  // only a login check — the class the /api-only scan could never see.
  const unscopedServerPage = `
    import { createServerClient } from '@/lib/supabase'
    const user = await getCurrentUser()
    if (!user) redirect('/login')
    const db = createServerClient()
    const { data } = await db.from('email_templates').select('*').eq('id', params.id).single()
  `

  it('flags a service-role page querying a tenant table with no scoping (the TPL-IDOR.1 class)', () => {
    const res = classifyPage('src/app/email/templates/[id]/page.js', unscopedServerPage, TABLES, {})
    expect(res.findings).toEqual([{ table: 'email_templates', exempt: false }])
  })

  it('skips pages that never call the service-role client (client/API-fed pages)', () => {
    const src = `'use client'\n// data comes through /api routes with their own guards`
    expect(classifyPage('src/app/contacts/page.js', src, TABLES, {})).toEqual({ skipped: 'no-service-role' })
  })

  it('passes a page that guards the fetched row with assertLocationAccess', () => {
    const src = `
      import { createServerClient } from '@/lib/supabase'
      const db = createServerClient()
      const { data: template } = await db.from('email_templates').select('*').eq('id', params.id).single()
      if (!template || assertLocationAccess(user, template.location_id)) notFound()
    `
    const res = classifyPage('src/app/email/templates/[id]/page.js', src, TABLES, {})
    expect(res.findings).toEqual([])
  })

  it('passes a page whose chain filters on location_id', () => {
    const src = `
      import { createServerClient } from '@/lib/supabase'
      const db = createServerClient()
      const { data } = await db.from('contacts').select('*').eq('location_id', user.activeLocation.id)
    `
    const res = classifyPage('src/app/contacts/page.js', src, TABLES, {})
    expect(res.findings).toEqual([])
  })

  it('honours EXEMPT entries keyed by the page path', () => {
    const exempt = {
      'src/app/offers/page.js': { email_templates: 'public catalogue (test fixture)' },
    }
    const res = classifyPage('src/app/offers/page.js', unscopedServerPage, TABLES, exempt)
    expect(res.findings).toEqual([{ table: 'email_templates', exempt: true }])
  })

  it('does not apply the cron path skip to pages (only /api routes have system paths)', () => {
    const res = classifyPage('src/app/cron/page.js', unscopedServerPage, TABLES, {})
    expect(res.findings).toEqual([{ table: 'email_templates', exempt: false }])
  })
})

describe('classifyLayout (PAGE-SCOPE.2)', () => {
  const TABLES = new Set(['sale_offers', 'email_mailboxes'])

  // The W0.4 shape: src/app/offers/layout.js before #1958 — a service-role
  // client in BOTH generateMetadata and the layout body, selecting
  // sale_offers across every location with only an active=true filter.
  // layout.js was never walked, so the gate could not see it.
  const unscopedLayout = `
    import { createServerClient } from '@/lib/supabase'
    export async function generateMetadata() {
      const db = createServerClient()
      const { data } = await db.from('sale_offers').select('category').eq('active', true)
      return { title: data?.length ? 'Sale' : 'Gift Cards' }
    }
    export default async function OffersLayout({ children }) {
      const db = createServerClient()
      const { data } = await db.from('sale_offers').select('ends_at').eq('active', true).limit(1).maybeSingle()
      return <div>{children}</div>
    }
  `

  it('flags a service-role layout querying a tenant table with no scoping (the W0.4 /offers class)', () => {
    const res = classifyLayout('src/app/offers/layout.js', unscopedLayout, TABLES, {})
    expect(res.findings).toEqual([{ table: 'sale_offers', exempt: false }])
  })

  it('flags a layout whose ONLY tenant query lives inside generateMetadata', () => {
    const src = `
      import { createServerClient } from '@/lib/supabase'
      export async function generateMetadata() {
        const db = createServerClient()
        const { data } = await db.from('sale_offers').select('category').eq('active', true)
        return { title: data?.length ? 'Sale' : 'Gift Cards' }
      }
      export default function OffersLayout({ children }) { return <div>{children}</div> }
    `
    const res = classifyLayout('src/app/offers/layout.js', src, TABLES, {})
    expect(res.findings).toEqual([{ table: 'sale_offers', exempt: false }])
  })

  it('flags a PAGE whose only tenant query lives inside generateMetadata (whole-file scope, pinned)', () => {
    const src = `
      import { createServerClient } from '@/lib/supabase'
      export async function generateMetadata({ params }) {
        const db = createServerClient()
        const { data } = await db.from('sale_offers').select('name').eq('slug', params.slug).maybeSingle()
        return { title: data?.name || 'Offer' }
      }
      export default function OfferPage() { return <div /> }
    `
    const res = classifyPage('src/app/offers/[slug]/page.js', src, TABLES, {})
    expect(res.findings).toEqual([{ table: 'sale_offers', exempt: false }])
  })

  it('passes a layout whose chain filters on location_id (the post-#1958 /offers shape)', () => {
    const src = `
      import { createServerClient } from '@/lib/supabase'
      export async function generateMetadata() {
        const db = createServerClient()
        const homeId = await resolveOffersHomeLocationId(db)
        const { data } = await db.from('sale_offers').select('category').eq('active', true).eq('location_id', homeId || NO_HOME_LOCATION_ID)
        return { title: data?.length ? 'Sale' : 'Gift Cards' }
      }
    `
    const res = classifyLayout('src/app/offers/layout.js', src, TABLES, {})
    expect(res.findings).toEqual([])
  })

  it('passes a layout scoped to the org via orgLocationIdsFor + .in(location_id)', () => {
    const src = `
      import { createServerClient } from '@/lib/supabase'
      import { orgLocationIdsFor } from '@/lib/inbound-contact-match'
      export default async function HubLayout({ children }) {
        const db = createServerClient()
        const ids = await orgLocationIdsFor(db, user.activeLocation.id)
        const { data } = await db.from('email_mailboxes').select('id').in('location_id', ids).eq('active', true).limit(1)
        return <div>{children}</div>
      }
    `
    const res = classifyLayout('src/app/communications/(hub)/layout.js', src, TABLES, {})
    expect(res.findings).toEqual([])
  })

  it('skips layouts that never call the service-role client (pure chrome / RLS-bound)', () => {
    const src = `
      import { getCurrentUser } from '@/lib/auth'
      export default async function Layout({ children }) {
        const user = await getCurrentUser()
        if (!user) redirect('/login')
        return <Shell user={user}>{children}</Shell>
      }
    `
    expect(classifyLayout('src/app/settings/layout.js', src, TABLES, {})).toEqual({ skipped: 'no-service-role' })
  })

  it('honours EXEMPT entries keyed by the layout path, and only for that table', () => {
    const exempt = {
      'src/app/offers/layout.js': { sale_offers: 'public catalogue (test fixture)' },
    }
    const res = classifyLayout('src/app/offers/layout.js', unscopedLayout, TABLES, exempt)
    expect(res.findings).toEqual([{ table: 'sale_offers', exempt: true }])
    // Same file under a different path is NOT exempt — the key is the path.
    const other = classifyLayout('src/app/cars/layout.js', unscopedLayout, TABLES, exempt)
    expect(other.findings).toEqual([{ table: 'sale_offers', exempt: false }])
  })

  it('does not apply the cron path skip to layouts (only /api routes have system paths)', () => {
    const res = classifyLayout('src/app/cron/layout.js', unscopedLayout, TABLES, {})
    expect(res.findings).toEqual([{ table: 'sale_offers', exempt: false }])
  })

  it('uses the same classifier as pages — identical verdict for identical source', () => {
    for (const src of [unscopedLayout, `'use client'\n// chrome only`]) {
      expect(classifyLayout('src/app/x/layout.js', src, TABLES, {}))
        .toEqual(classifyPage('src/app/x/page.js', src, TABLES, {}))
    }
  })
})

describe('app-dir scan surface (PAGE-SCOPE.2)', () => {
  it('walks page AND layout files in both extensions — the set the gate promises to read', () => {
    expect([...APP_SURFACE_FILES].sort()).toEqual(['layout.js', 'layout.jsx', 'page.js', 'page.jsx'])
  })

  it.each([
    ['page.js', true],
    ['page.jsx', true],
    ['layout.js', true],
    ['layout.jsx', true],
    ['route.js', false], // the /api walk, not the app-dir walk
    ['loading.js', false],
    ['template.js', false],
    ['error.js', false],
    ['not-found.js', false],
    ['default.js', false],
    ['page.test.js', false],
    ['layout.css', false],
    ['_layout.js', false],
  ])('isAppSurfaceFile(%s) → %s', (name, expected) => {
    expect(isAppSurfaceFile(name)).toBe(expected)
  })
})

describe('findStaleExemptions', () => {
  const exempt = {
    'src/app/api/gone/route.js': { contacts: 'file was deleted' },
    'src/app/api/still-here/route.js': { contacts: 'route stopped querying contacts' },
  }

  it('flags exemptions whose file is gone or no longer queries the table', () => {
    const readFile = (p) =>
      p === 'src/app/api/still-here/route.js'
        ? "await db.from('deals').select('*')" // no contacts query any more
        : null
    const stale = findStaleExemptions(exempt, readFile)
    expect(stale).toEqual([
      { file: 'src/app/api/gone/route.js', table: 'contacts', why: 'file no longer exists' },
      { file: 'src/app/api/still-here/route.js', table: 'contacts', why: 'route no longer queries this table' },
    ])
  })

  it('accepts a live exemption', () => {
    const readFile = () => "await db.from('contacts').select('*')"
    expect(findStaleExemptions({ 'src/app/api/x/route.js': { contacts: 'ok' } }, readFile)).toEqual([])
  })
})

describe('tablesQueried', () => {
  it('matches all three quote styles and ignores non-derived tables', () => {
    const src = `
      db.from('contacts').select()
      db.from("deals").select()
      db.from(\`bookings\`).select()
      db.from('not_tenant').select()
    `
    expect(tablesQueried(src, ['contacts', 'deals', 'bookings', 'other']).sort())
      .toEqual(['bookings', 'contacts', 'deals'])
  })
})
