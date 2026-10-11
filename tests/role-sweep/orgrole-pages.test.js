// C18 ORGROLE.1 — UI gating = route rule. The organisation-level pages, and
// the controls on shared pages that call an organisation-level route, show for
// an ORGANISATION ADMIN of the active organisation (a master or an org_admin
// grant) and for nobody else: not a studio owner, not a manager holding
// `settings` or `accounting_hub`.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => {} }),
  headers: async () => ({ get: () => null }),
}))
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url) => { throw new Error(`NEXT_REDIRECT:${url}`) }),
  notFound: vi.fn(() => { throw new Error('NEXT_NOT_FOUND') }),
}))
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
// A page that gets past its gate reaches the database: that is the signal.
vi.mock('@/lib/supabase', () => ({
  createServerClient: vi.fn(() => { throw new Error('REACHED_DB') }),
  createBrowserClient: vi.fn(),
}))
vi.mock('@/lib/billing-page', () => ({ getBillingPageData: vi.fn(async () => { throw new Error('REACHED_DB') }) }))
vi.mock('@/lib/usage-summary', () => ({ getOrgUsageSummary: vi.fn(async () => { throw new Error('REACHED_DB') }) }))
vi.mock('@/components/accounting/AccountingTabs', () => ({ default: () => 'TABS' }))
vi.mock('@/components/accounting/HuntInboxesCard', () => ({ default: () => 'HUNT-INBOXES' }))
vi.mock('@/components/accounting/EventFeesCard', () => ({ default: () => 'EVENT-FEES' }))
vi.mock('@/components/settings/HostDetail', () => ({
  default: ({ canBackfill }) => `HOST-DETAIL canBackfill=${String(canBackfill)}`,
}))
vi.mock('next/link', () => ({ default: ({ children }) => children }))
// W1.S2 — the host detail page resolves the studio brand for its card; the
// gate under test sits before it, so the brand read is stubbed.
vi.mock('@/lib/location-branding', () => ({ getLocationBranding: vi.fn(async () => ({ companyName: 'Studio' })) }))

import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { person, MASTER as MASTER_BASE, ORG, LOC_A, LOC_B } from '../helpers/role-sweep-callers.js'
import BillingPage from '@/app/settings/billing/page.js'
import UsagePage from '@/app/settings/usage/page.js'
import ApiKeysPage from '@/app/settings/api-keys/page.js'
import AccountingPage from '@/app/(money)/accounting/page.js'
import HostDetailPage from '@/app/settings/hosts/[id]/page.jsx'

const inOrg = { activeOrganization: { id: ORG, name: 'Org' } }
const all = { settings: true, accounting_hub: true }
const CALLERS = {
  master: { ...MASTER_BASE, ...inOrg },
  // An org admin whose own assignment at the active studio is manager.
  orgAdmin: person({ [LOC_A]: { role: 'manager', permissions: all } }, LOC_A, { ...inOrg, orgAdminOrgIds: [ORG] }),
  ownerEverywhere: person({ [LOC_A]: { role: 'owner', permissions: all }, [LOC_B]: { role: 'owner', permissions: all } }, LOC_A, inOrg),
  manager: person({ [LOC_A]: { role: 'manager', permissions: all } }, LOC_A, inOrg),
}

const outcome = async (page, props) => {
  try {
    return { html: renderToStaticMarkup(await page(props)) }
  } catch (e) {
    return { thrown: e.message }
  }
}

beforeEach(() => vi.clearAllMocks())

describe.each([
  ['/settings/billing', BillingPage, { searchParams: Promise.resolve({}) }],
  ['/settings/usage', UsagePage, {}],
  ['/settings/api-keys', ApiKeysPage, {}],
])('%s', (_path, Page, props) => {
  it.each(['master', 'orgAdmin'])('%s gets the page (reaches its data)', async (who) => {
    getCurrentUser.mockResolvedValue(CALLERS[who])
    expect((await outcome(Page, props)).thrown).toBe('REACHED_DB')
  })
  it.each(['ownerEverywhere', 'manager'])('%s is sent back to /settings before any read', async (who) => {
    getCurrentUser.mockResolvedValue(CALLERS[who])
    expect((await outcome(Page, props)).thrown).toBe('NEXT_REDIRECT:/settings')
  })
})

describe('/accounting — the org event-fee card', () => {
  it.each([['master', true], ['orgAdmin', true], ['ownerEverywhere', false], ['manager', false]])(
    '%s → shown: %s (the page itself stays accounting_hub)',
    async (who, shown) => {
      getCurrentUser.mockResolvedValue(CALLERS[who])
      const { html } = await outcome(AccountingPage, {})
      expect(html).toContain('HUNT-INBOXES')
      expect(html.includes('EVENT-FEES')).toBe(shown)
    },
  )
})

describe('/settings/hosts/[id] — the Postmark back-fill control', () => {
  it.each([['master', true], ['orgAdmin', true], ['ownerEverywhere', false], ['manager', false]])(
    '%s → canBackfill %s',
    async (who, can) => {
      getCurrentUser.mockResolvedValue(CALLERS[who])
      // Past its role gate the page reads the brand (stubbed above) with a
      // service-role client; hand it one for this render only.
      createServerClient.mockReturnValueOnce({})
      const { html } = await outcome(HostDetailPage, { params: Promise.resolve({ id: 'host-1' }) })
      expect(html).toContain(`HOST-DETAIL canBackfill=${can}`)
    },
  )
})
