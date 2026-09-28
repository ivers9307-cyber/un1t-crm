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
vi.mock('@/lib/tenant-email', () => ({
  orgHasEmailDomainAddon: vi.fn(async () => true),
  tenantEmailStatePayload: vi.fn(() => ({ status: 'not_configured' })),
}))
vi.mock('@/lib/email-domain-service', () => ({
  resolveEmailDomainOrgId: () => ({ orgId: 'org-a' }),
  loadEmailDomainRow: vi.fn(),
}))
vi.mock('@/components/settings/EmailDomainWizard', () => ({ default: () => 'WIZARD-RENDERED' }))

import EmailDomainSettingsPage from './page.js'
import { getCurrentUser } from '@/lib/auth'
import { loadEmailDomainRow } from '@/lib/email-domain-service'

const owner = { id: 'u1', role: 'owner', organizationsById: { 'org-a': { name: 'Gym A' } } }
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
