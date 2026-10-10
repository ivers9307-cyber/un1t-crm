import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./postmark', () => ({ sendEmail: vi.fn() }))
vi.mock('./location-branding', () => ({ getOrgCustomerBranding: vi.fn() }))

import { renderHostPortalAccessEmail, sendHostPortalAccessEmail } from './host-portal-access-email'
import { sendEmail } from './postmark'
import { getOrgCustomerBranding } from './location-branding'
import { PLATFORM_NAME } from './brand-name'

const URL = 'https://auth.example.test/auth/v1/verify?token=abc&type=recovery&redirect_to=https://x.repset.ie/host/set-password'

beforeEach(() => {
  vi.clearAllMocks()
  sendEmail.mockResolvedValue({ messageId: 'pm-1' })
})

describe('renderHostPortalAccessEmail', () => {
  it('links the action link, HTML-escaped', () => {
    const html = renderHostPortalAccessEmail({ brandName: 'Acme', url: URL })
    expect(html).toContain(`href="${URL.replace(/&/g, '&amp;')}"`)
    expect(html).toContain('Acme host portal')
  })

  it('escapes the brand name', () => {
    const html = renderHostPortalAccessEmail({ brandName: '<b>X</b>', url: URL })
    expect(html).not.toContain('<b>X</b>')
    expect(html).toContain('&lt;b&gt;X&lt;/b&gt;')
  })

  it('falls back to the platform name and carries no em-dash', () => {
    const html = renderHostPortalAccessEmail({ url: URL })
    expect(html).toContain(PLATFORM_NAME)
    expect(html).not.toContain('—')
  })
})

describe('sendHostPortalAccessEmail', () => {
  it('sends on the transactional stream under the org brand', async () => {
    getOrgCustomerBranding.mockResolvedValue({ companyName: 'Acme Fitness', logoUrl: null, faviconUrl: null })
    const db = {}
    const result = await sendHostPortalAccessEmail({ db, orgId: 'org-1', hostId: 'h-1', to: 'h@example.test', url: URL })
    expect(result).toEqual({ messageId: 'pm-1' })
    expect(getOrgCustomerBranding).toHaveBeenCalledWith(db, 'org-1')
    const args = sendEmail.mock.calls[0][0]
    expect(args).toMatchObject({
      to: 'h@example.test',
      subject: 'Set your password for the Acme Fitness host portal',
      fromName: 'Acme Fitness',
      stream: 'outbound',
      tag: 'host-portal-access',
      metadata: { host_id: 'h-1' },
    })
    expect(args.htmlBody).toContain(URL.replace(/&/g, '&amp;'))
    // The link is a credential: body only, never metadata.
    expect(JSON.stringify(args.metadata)).not.toContain('token=abc')
  })

  it('floors the brand on PLATFORM_NAME when the org has none', async () => {
    getOrgCustomerBranding.mockResolvedValue({ companyName: '', logoUrl: null, faviconUrl: null })
    await sendHostPortalAccessEmail({ db: {}, orgId: 'org-1', hostId: 'h-1', to: 'h@example.test', url: URL })
    expect(sendEmail.mock.calls[0][0].fromName).toBe(PLATFORM_NAME)
  })

  it('propagates a send failure to the caller', async () => {
    getOrgCustomerBranding.mockResolvedValue({ companyName: 'Acme', logoUrl: null, faviconUrl: null })
    sendEmail.mockRejectedValue(new Error('Postmark send error'))
    await expect(
      sendHostPortalAccessEmail({ db: {}, orgId: 'org-1', hostId: 'h-1', to: 'h@example.test', url: URL }),
    ).rejects.toThrow('Postmark send error')
  })
})
