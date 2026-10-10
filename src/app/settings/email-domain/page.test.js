// CHANNELREAD.1 — a failed read rendered the wizard in its "not configured"
// (set-up) state. It now renders Could not load + a Try again link, and no
// wizard. All ids are synthetic.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('next/navigation', () => ({ redirect: vi.fn((u) => { throw new Error(`NEXT_REDIRECT:${u}`) }) }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({})) }))
vi.mock('@/lib/log', () => ({ logError: vi.fn() }))
vi.mock('@/lib/postmark-account', () => ({ isPostmarkAccountConfigured: () => true }))
vi.mock('@/lib/plans', () => ({ plansGrantingFeature: vi.fn(async () => []) }))
vi.mock('@/lib/tenant-email', () => ({
  orgHasEmailDomainAddon: vi.fn(async () => true),
  tenantEmailStatePayload: vi.fn(() => ({ status: 'not_configured' })),
}))
vi.mock('@/lib/email-domain-service', () => ({
  resolveEmailDomainOrgId: () => ({ orgId: 'org-a' }),
  loadEmailDomainRow: vi.fn(),
}))
vi.mock('@/components/settings/EmailDomainWizard', () => ({ default: vi.fn(() => 'WIZARD-RENDERED') }))

import EmailDomainSettingsPage from './page.js'
import { getCurrentUser } from '@/lib/auth'
import { loadEmailDomainRow } from '@/lib/email-domain-service'
import { plansGrantingFeature } from '@/lib/plans'
import EmailDomainWizard from '@/components/settings/EmailDomainWizard'

// C18 ORGROLE.1 — the page is for organisation admins (an org_admin grant).
const owner = { id: 'u1', role: 'owner', orgAdminOrgIds: ['org-a'], activeOrganization: { id: 'org-a' }, organizationsById: { 'org-a': { name: 'Gym A' } } }
const render = async () => renderToStaticMarkup(await EmailDomainSettingsPage({ searchParams: Promise.resolve({}) }))

beforeEach(() => { vi.clearAllMocks(); getCurrentUser.mockResolvedValue(owner) })

describe('/settings/email-domain — a failed read (CHANNELREAD.1)', () => {
  it('renders Could not load + Try again, never the set-up wizard', async () => {
    loadEmailDomainRow.mockRejectedValue(new Error('Could not read the email domain: boom'))
    const html = await render()
    expect(html).not.toContain('WIZARD-RENDERED')
    expect(html).toContain('Could not load this organisation&#x27;s sending domain just now')
    expect(html).toContain('href="/settings/email-domain"')
    expect(html).toContain('>Try again<')
  })

  it('pin: a good read renders the wizard', async () => {
    loadEmailDomainRow.mockResolvedValue(null)
    const html = await render()
    expect(html).toContain('WIZARD-RENDERED')
  })
})

describe('/settings/email-domain — organisation admins only (C18 ORGROLE.1)', () => {
  it('a studio owner with no org_admin grant is sent back to /settings', async () => {
    getCurrentUser.mockResolvedValue({ ...owner, orgAdminOrgIds: [] })
    await expect(render()).rejects.toThrow(/^NEXT_REDIRECT:\/settings$/)
  })
})

// W1.E1 — the page reads the plans that carry custom_email_domain so the
// upsell can NAME them; a failed catalogue read never blocks the page.
describe('/settings/email-domain — the upsell names the plans (W1.E1)', () => {
  it('passes the plans that grant custom_email_domain to the wizard', async () => {
    loadEmailDomainRow.mockResolvedValue(null)
    plansGrantingFeature.mockResolvedValue([{ id: 'p1', slug: 'scale', name: 'Scale', kind: 'tier' }])
    const html = await render()
    expect(html).toContain('WIZARD-RENDERED')
    expect(plansGrantingFeature).toHaveBeenCalledWith(expect.anything(), 'custom_email_domain')
    expect(EmailDomainWizard).toHaveBeenCalledWith(
      expect.objectContaining({ featurePlans: [{ id: 'p1', slug: 'scale', name: 'Scale', kind: 'tier' }] }),
      undefined
    )
  })
})
