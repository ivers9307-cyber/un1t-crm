// Host onboarding email HTML (EVENTS-HOST.9) — link + escaping; W1.S1c — the
// host's organisation brand, never a literal gym.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./postmark', () => ({ sendEmail: vi.fn(async () => ({ messageId: 'pm-1' })) }))
vi.mock('./supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('./host-org-brand', () => ({ resolveHostOrgBrand: vi.fn() }))

import { renderHostOnboardingEmail, hostOnboardingSubject, sendHostOnboardingEmail } from './host-onboarding-email.js'
import { sendEmail } from './postmark'
import { resolveHostOrgBrand } from './host-org-brand'
import { PLATFORM_NAME } from './brand-name'

const UN1T = { name: 'UN1T Dublin', shortName: 'UN1T' }

beforeEach(() => vi.clearAllMocks())

describe('renderHostOnboardingEmail', () => {
  it('embeds the onboarding URL in the CTA', () => {
    const html = renderHostOnboardingEmail({ hostName: 'Pride Training Club', url: 'https://crm.un1tdublin.com/host-connect/tok.sig', brand: UN1T })
    expect(html).toContain('href="https://crm.un1tdublin.com/host-connect/tok.sig"')
    expect(html).toContain('Pride Training Club')
    expect(html).toContain('Connect your Stripe account')
  })

  it('falls back to a neutral greeting when the host has no name', () => {
    const html = renderHostOnboardingEmail({ url: 'https://x/host-connect/t' })
    expect(html).toContain('Hi there,')
  })

  it('escapes the host name (no HTML injection)', () => {
    const html = renderHostOnboardingEmail({ hostName: '<script>bad</script>', url: 'https://x/t' })
    expect(html).not.toContain('<script>bad')
    expect(html).toContain('&lt;script&gt;')
  })

  it("speaks for the host's organisation: short name as the wordmark, brand in the copy", () => {
    const html = renderHostOnboardingEmail({ hostName: 'Pride Training Club', url: 'https://x/t', brand: UN1T })
    expect(html).toContain('font-size:18px;">UN1T</span>')
    expect(html).toContain('host events with UN1T Dublin.')
    expect(html).toContain('ask UN1T Dublin for a fresh one')
  })

  it("another gym's host reads that gym, and an unknown brand reads the platform name", () => {
    const pulse = renderHostOnboardingEmail({ url: 'https://x/t', brand: { name: 'Pulse Gym', shortName: 'Pulse Gym' } })
    expect(pulse).toContain('host events with Pulse Gym.')
    expect(pulse).not.toMatch(/UN1T/)
    const bare = renderHostOnboardingEmail({ url: 'https://x/t' })
    expect(bare).toContain(`host events with ${PLATFORM_NAME}.`)
    expect(bare).not.toMatch(/UN1T/)
  })

  it('escapes the brand too', () => {
    const html = renderHostOnboardingEmail({ url: 'https://x/t', brand: { name: '<b>x</b>', shortName: '<i>' } })
    expect(html).not.toContain('<b>x</b>')
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;')
  })
})

describe('sendHostOnboardingEmail', () => {
  it("resolves the host's organisation brand and sends the branded subject", async () => {
    resolveHostOrgBrand.mockResolvedValue(UN1T)
    const db = { from: vi.fn() }
    const host = { id: 'h1', name: 'Pride Training Club', email: 'colm@example.com', organization_id: 'org-1' }
    await sendHostOnboardingEmail({ host, url: 'https://x/t', db })
    expect(resolveHostOrgBrand).toHaveBeenCalledWith(db, host)
    const sent = sendEmail.mock.calls[0][0]
    expect(sent.subject).toBe('Connect your Stripe account to get paid for your UN1T Dublin events')
    expect(sent.htmlBody).toContain('host events with UN1T Dublin.')
    expect(sent.to).toBe('colm@example.com')
  })

  it('the subject floors on the platform name', () => {
    expect(hostOnboardingSubject(null)).toBe(`Connect your Stripe account to get paid for your ${PLATFORM_NAME} events`)
  })
})
