// C18 ORGROLE.1 — organisation-level routes are for ORGANISATION ADMINS only.
//
// Richard's decision (1 Oct 2026): a master, or a person with an org_admin
// grant on the organisation the route acts on (profile_organizations, mig 417,
// `user.orgAdminOrgIds`). An owner at one studio, or at every studio, is NOT
// an organisation admin, and neither is a manager holding `settings` or
// `accounting_hub`. Before, these routes asked the ACTIVE studio's role or
// permission (and some, getOwnerOrganizationIds: per-studio owner roles).
//
// Each route runs against the same five callers. The allowed ones must get
// past the gate (200 here, with the work below the gate stubbed); the refused
// ones must get the gate's refusal and nothing written.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => {} }),
  headers: async () => ({ get: () => null }),
}))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(), createBrowserClient: vi.fn() }))
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/billing-page', () => ({ getBillingPageData: vi.fn(async () => ({ ok: true })) }))
vi.mock('@/lib/wallet-topup', async (importOriginal) => ({
  ...(await importOriginal()),
  createTopup: vi.fn(async () => ({ checkoutUrl: 'https://checkout.example/x', invoiceId: 'inv-1', number: 'TU-1' })),
}))
vi.mock('@/lib/usage-summary', () => ({ getOrgUsageSummary: vi.fn(async () => ({ ok: true })) }))
vi.mock('@/lib/postmark-account', async (importOriginal) => ({
  ...(await importOriginal()),
  isPostmarkAccountConfigured: vi.fn(() => true),
}))
vi.mock('@/lib/tenant-email', async (importOriginal) => ({
  ...(await importOriginal()),
  orgHasEmailDomainAddon: vi.fn(async () => true),
}))
vi.mock('@/lib/email-domain-service', async (importOriginal) => ({
  ...(await importOriginal()),
  loadEmailDomainRow: vi.fn(async () => null),
  provisionEmailDomain: vi.fn(async () => ({ status: 'pending', sending_domain: 'mail.example.com' })),
  verifyEmailDomain: vi.fn(async () => ({ row: { status: 'live', sending_domain: 'mail.example.com' } })),
}))
vi.mock('@/lib/org-event-fees', () => ({ getOrgEventFees: vi.fn(async () => ({ total_cents: 0 })) }))
vi.mock('@/lib/host-contact-list', () => ({ addEventAttendeesToHostList: vi.fn(async () => 0) }))
vi.mock('@/lib/host-campaign-backfill', () => ({
  backfillHostCampaignEvents: vi.fn(async () => ({ scanned: 0, matched: 0, stamped: 0, updated: 0, skipped: 0, errors: [] })),
}))
vi.mock('@/lib/push', () => ({ sendPush: vi.fn(async () => ({ sent: 0 })) }))

import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { makeFakeDb } from '@/lib/api-auth.test-helpers.js'
import { person, MASTER as MASTER_BASE, ORG, LOC_A, LOC_B } from '../helpers/role-sweep-callers.js'
import * as billing from '@/app/api/settings/billing/route.js'
import * as topup from '@/app/api/settings/billing/topup/route.js'
import * as autoTopup from '@/app/api/settings/billing/auto-topup/route.js'
import * as apiKeys from '@/app/api/settings/api-keys/route.js'
import * as apiKey from '@/app/api/settings/api-keys/[id]/route.js'
import * as emailDomain from '@/app/api/settings/email-domain/route.js'
import * as emailDomainVerify from '@/app/api/settings/email-domain/verify/route.js'
import * as orgBranding from '@/app/api/settings/org-branding/route.js'
import * as orgUsage from '@/app/api/settings/org-usage/route.js'
import * as eventFees from '@/app/api/accounting/event-fees/route.js'
import * as backfillHostContacts from '@/app/api/admin/backfill-host-contacts/route.js'
import * as hostBackfill from '@/app/api/hosts/[id]/backfill-campaign-events/route.js'
import * as staffDevices from '@/app/api/staff-devices/route.js'
import * as nudge from '@/app/api/staff-devices/nudge/route.js'

export const OTHER_ORG = 'e0000000-0000-4000-8000-0000000000e0'
const inOrg = { activeOrganization: { id: ORG, name: 'Org' } }

// ── the five callers (all working in ORG, studio A active) ──────────────────
export const CALLERS = {
  // A master: the platform.
  master: { ...MASTER_BASE, ...inOrg },
  // An org admin of ORG whose own assignment at the active studio is staff.
  orgAdmin: person({ [LOC_A]: { role: 'staff' } }, LOC_A, { ...inOrg, orgAdminOrgIds: [ORG] }),
  // An owner at EVERY studio of ORG with no org_admin grant (the P4 shape).
  ownerEverywhere: person({ [LOC_A]: { role: 'owner' }, [LOC_B]: { role: 'owner' } }, LOC_A, inOrg),
  // A manager holding every permission these routes used to ask for.
  manager: person({ [LOC_A]: { role: 'manager', permissions: { settings: true, accounting_hub: true, contracts: true } } }, LOC_A, inOrg),
  // An org admin of ANOTHER organisation, owner at a studio of this one.
  adminElsewhere: person({ [LOC_A]: { role: 'owner' } }, LOC_A, { ...inOrg, orgAdminOrgIds: [OTHER_ORG] }),
}
export const ALLOWED = ['master', 'orgAdmin']
export const REFUSED = ['ownerEverywhere', 'manager', 'adminElsewhere']

/** makeFakeDb plus upsert (insert semantics), and a log of every write. */
export function fakeDb(tables) {
  const base = makeFakeDb(tables)
  const writes = []
  return {
    writes,
    from(table) {
      const b = base.from(table)
      for (const op of ['insert', 'update', 'delete']) {
        const orig = b[op]
        b[op] = (...args) => { writes.push({ table, op }); return orig(...args) }
      }
      b.upsert = (row) => { writes.push({ table, op: 'upsert' }); return b.insert(row) }
      // `.not(col, 'is', null)` only (the back-fill's hosted-event filter).
      b.not = (col, op, val) => (op === 'is' ? b.neq(col, val) : b)
      return b
    },
  }
}

const json = (method, body) => new Request('http://localhost/api/x', {
  method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})
const bare = (method, qs = '') => new Request(`http://localhost/api/x${qs}`, { method })
const params = (p) => ({ params: Promise.resolve(p) })

const settingsTables = () => ({
  locations: [{ id: LOC_A, organization_id: ORG }, { id: LOC_B, organization_id: ORG }],
  org_settings: [],
  wallets: [],
  api_keys: [{ id: 'key-1', organization_id: ORG, name: 'Zapier', key_prefix: 'unitk_ab', revoked_at: null }],
  tenant_email_domains: [],
})

/**
 * Run one route against every caller.
 * @param {string} label
 * @param {{ call: () => Promise<Response>, tables?: () => object, refused?: Record<string, number> }} spec
 *   `refused` overrides the expected status per caller (default 403).
 */
export function describeOrgAdminRoute(label, { call, tables = settingsTables, refused = {} }) {
  describe(label, () => {
    it.each(ALLOWED)('%s gets past the gate', async (who) => {
      getCurrentUser.mockResolvedValue(CALLERS[who])
      createServerClient.mockReturnValue(fakeDb(tables()))
      const res = await call()
      expect(res.status, JSON.stringify(await res.clone().json())).toBe(200)
    })
    it.each(REFUSED)('%s is refused, and nothing is written', async (who) => {
      getCurrentUser.mockResolvedValue(CALLERS[who])
      const db = fakeDb(tables())
      createServerClient.mockReturnValue(db)
      const res = await call()
      expect(res.status).toBe(refused[who] || 403)
      expect((await res.json()).success).toBe(false)
      expect(db.writes).toEqual([])
    })
  })
}

beforeEach(() => vi.clearAllMocks())

// ── billing, the usage wallet, API keys, the email domain, org settings ────
describeOrgAdminRoute('GET /api/settings/billing', { call: () => billing.GET(bare('GET')) })
describeOrgAdminRoute('POST /api/settings/billing/topup', {
  call: () => topup.POST(json('POST', { location_id: LOC_A, amount_cents: 2500 })),
  // An admin of another organisation passes the coarse check and is then
  // refused at the location's organisation with the not-found answer.
  refused: { adminElsewhere: 404 },
})
describeOrgAdminRoute('PATCH /api/settings/billing/auto-topup', {
  call: () => autoTopup.PATCH(json('PATCH', { location_id: LOC_A, enabled: true })),
  refused: { adminElsewhere: 404 },
})
describeOrgAdminRoute('GET /api/settings/api-keys', { call: () => apiKeys.GET() })
describeOrgAdminRoute('POST /api/settings/api-keys', { call: () => apiKeys.POST(json('POST', { name: 'Zapier' })) })
describeOrgAdminRoute('DELETE /api/settings/api-keys/[id]', { call: () => apiKey.DELETE(bare('DELETE'), params({ id: 'key-1' })) })
describeOrgAdminRoute('GET /api/settings/email-domain', { call: () => emailDomain.GET(bare('GET')) })
describeOrgAdminRoute('POST /api/settings/email-domain', {
  call: () => emailDomain.POST(json('POST', { domain: 'mail.example.com' })),
})
describeOrgAdminRoute('POST /api/settings/email-domain/verify', {
  call: () => emailDomainVerify.POST(json('POST', {})),
})
describeOrgAdminRoute('GET /api/settings/org-branding', { call: () => orgBranding.GET(bare('GET')) })
describeOrgAdminRoute('PUT /api/settings/org-branding', {
  call: () => orgBranding.PUT(json('PUT', { company_name: 'Org' })),
})
describeOrgAdminRoute('GET /api/settings/org-usage', { call: () => orgUsage.GET(bare('GET')) })
describeOrgAdminRoute('PUT /api/settings/org-usage', {
  call: () => orgUsage.PUT(json('PUT', { ai_hard_cap_cents: 5000 })),
})

describe('an explicit foreign organisation id is not found (no existence probe)', () => {
  const asks = [
    ['GET /api/settings/billing', () => billing.GET(bare('GET', `?organization_id=${OTHER_ORG}`))],
    ['GET /api/settings/email-domain', () => emailDomain.GET(bare('GET', `?organization_id=${OTHER_ORG}`))],
    ['POST /api/settings/email-domain/verify', () => emailDomainVerify.POST(json('POST', { organization_id: OTHER_ORG }))],
  ]
  it.each(asks)('%s', async (_label, call) => {
    getCurrentUser.mockResolvedValue(CALLERS.orgAdmin)
    createServerClient.mockReturnValue(fakeDb(settingsTables()))
    const res = await call()
    expect(res.status).toBe(404)
  })
})

// ── the org event-fee report, the host back-fill jobs, the staff device fleet ─
const orgTables = () => ({
  ...settingsTables(),
  event_hosts: [{ id: 'host-1', organization_id: ORG, name: 'Host One' }],
  race_events: [{ id: 'ev-1', name: 'Hosted run', host_id: 'host-1' }],
  profile_locations: [{ profile_id: 'user-1', location_id: LOC_A }],
  profile_organizations: [],
  profiles: [{ id: 'user-1', full_name: 'Coach One', email: 'coach.one@example.com', role: 'staff', active: true }],
  device_tokens: [],
})
describeOrgAdminRoute('GET /api/accounting/event-fees', { call: () => eventFees.GET(), tables: orgTables })
describeOrgAdminRoute('POST /api/admin/backfill-host-contacts', { call: () => backfillHostContacts.POST(), tables: orgTables })
describeOrgAdminRoute('POST /api/hosts/[id]/backfill-campaign-events', {
  call: () => hostBackfill.POST(bare('POST', '?dry=1'), params({ id: 'host-1' })), tables: orgTables,
})
describeOrgAdminRoute('GET /api/staff-devices', { call: () => staffDevices.GET(), tables: orgTables })
describeOrgAdminRoute('POST /api/staff-devices/nudge', {
  call: () => nudge.POST(json('POST', { profile_ids: ['c0000000-0000-4000-8000-0000000000c0'] })), tables: orgTables,
})
