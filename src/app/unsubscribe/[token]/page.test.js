// W1.L4 — the unsubscribe tab names the gym whose email it was, and the
// caller-controlled `?l=` hint can never make one host render another
// tenant's name (review of #1997, BLOCKER).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeFakeDb } from '@/lib/api-auth.test-helpers.js'
import { _resetTenantDomainsCache } from '@/lib/tenant-domains-edge.js'
import { _resetHostBrandCache } from '@/lib/host-brand.js'

let currentHost = 'crm.repset.ie'
vi.mock('next/headers', () => ({ headers: async () => new Headers({ host: currentHost }) }))

let db
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/components/UnsubscribePage', () => ({ default: () => null }))

import { generateMetadata } from './page.js'

const ORG_A = 'org-a'
const ORG_B = 'org-b'
const LOC_A1 = 'aaaaaaaa-0000-4000-8000-000000000001'
const LOC_B1 = 'bbbbbbbb-0000-4000-8000-000000000001'

function tables() {
  return {
    tenant_domains: [
      { id: 'td-a', hostname: 'gym-a.repset.ie', organization_id: ORG_A, brand: {}, active: true, source: 'platform', location_id: null },
    ],
    organizations: [{ id: ORG_A, slug: 'gym-a', master_location_id: null }, { id: ORG_B, slug: 'gym-b', master_location_id: null }],
    locations: [
      { id: LOC_A1, name: 'Gym A North', organization_id: ORG_A, active: true, created_at: '2026-01-01' },
      { id: LOC_B1, name: 'Gym B', organization_id: ORG_B, active: true, created_at: '2026-01-02' },
    ],
    org_settings: [{ organization_id: ORG_A, company_name: 'Gym A', logo_url: null, favicon_url: null }],
    company_settings: [
      { location_id: LOC_A1, company_name: 'Gym A North', logo_url: null, favicon_url: null },
      { location_id: LOC_B1, company_name: 'Gym B', logo_url: null, favicon_url: null },
    ],
  }
}

const props = (l) => ({ params: Promise.resolve({ token: 'tok' }), searchParams: Promise.resolve(l == null ? {} : { l }) })

beforeEach(() => {
  _resetTenantDomainsCache()
  _resetHostBrandCache()
  db = makeFakeDb(tables())
})

describe('/unsubscribe/[token] generateMetadata (W1.L4)', () => {
  it('?l= of the host\'s own studio → that studio\'s brand', async () => {
    currentHost = 'gym-a.repset.ie'
    expect((await generateMetadata(props(LOC_A1))).title).toBe('Unsubscribe — Gym A North')
  })

  it('BLOCKER: host gym-a + ?l=<gym B\'s location> → Gym A\'s title, never Gym B\'s', async () => {
    currentHost = 'gym-a.repset.ie'
    expect((await generateMetadata(props(LOC_B1))).title).toBe('Unsubscribe — Gym A')
  })

  it('a CRM-host link honours the hint (that is where today\'s links were minted)', async () => {
    currentHost = 'crm.un1tdublin.com'
    expect((await generateMetadata(props(LOC_B1))).title).toBe('Unsubscribe — Gym B')
  })

  it('a non-UUID ?l= makes no DB call and reads the host brand (the platform on the CRM host)', async () => {
    currentHost = 'crm.repset.ie'
    let calls = 0
    const inner = db
    db = { from(t) { calls += 1; return inner.from(t) } }
    expect((await generateMetadata(props('not-a-uuid'))).title).toBe('Unsubscribe — Repset')
    expect(calls).toBe(0)
  })

  it('no hint → the host brand', async () => {
    currentHost = 'gym-a.repset.ie'
    expect((await generateMetadata(props())).title).toBe('Unsubscribe — Gym A')
  })
})
