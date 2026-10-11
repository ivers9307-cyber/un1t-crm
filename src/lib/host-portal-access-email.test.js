import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./postmark', () => ({ sendEmail: vi.fn() }))
vi.mock('./host-org-brand', () => ({ resolveHostOrgBrand: vi.fn() }))

import { renderHostPortalAccessEmail, hostPortalAccessSubject, sendHostPortalAccessEmail } from './host-portal-access-email'
import { sendEmail } from './postmark'
import { resolveHostOrgBrand } from './host-org-brand'
import { PLATFORM_NAME } from './brand-name'

const URL = 'https://auth.example.test/auth/v1/verify?token=abc&type=recovery&redirect_to=https://x.repset.ie/host/set-password'
const BRAND = { name: 'Acme Fitness', shortName: 'ACME' }
const HOST = { id: 'h-1', organization_id: 'org-1' }

beforeEach(() => {
  vi.clearAllMocks()
  sendEmail.mockResolvedValue({ messageId: 'pm-1' })
  resolveHostOrgBrand.mockResolvedValue(BRAND)
})

describe('renderHostPortalAccessEmail', () => {
  it('links the action link, HTML-escaped', () => {
    const html = renderHostPortalAccessEmail({ url: URL, brand: BRAND })
    expect(html).toContain(`href="${URL.replace(/&/g, '&amp;')}"`)
  })

  it('uses the short name as the wordmark and the brand name in sentences', () => {
    const html = renderHostPortalAccessEmail({ url: URL, brand: BRAND })
    expect(html).toContain('font-size:18px;">ACME</span>')
    expect(html).toContain('your Acme Fitness host portal')
  })

  it('escapes the brand name', () => {
    const html = renderHostPortalAccessEmail({ url: URL, brand: { name: '<b>X</b>' } })
    expect(html).not.toContain('<b>X</b>')
    expect(html).toContain('&lt;b&gt;X&lt;/b&gt;')
  })

  it('falls back to the platform name and carries no em-dash', () => {
    const html = renderHostPortalAccessEmail({ url: URL })
    expect(html).toContain(PLATFORM_NAME)
    expect(html).not.toContain('—')
    expect(hostPortalAccessSubject(null)).toBe(`Set your password for the ${PLATFORM_NAME} host portal`)
  })
})

describe('sendHostPortalAccessEmail', () => {
  it("sends on the transactional stream under the host's organisation brand", async () => {
    const db = {}
    const result = await sendHostPortalAccessEmail({ db, host: HOST, to: 'h@example.test', url: URL })
    expect(result).toEqual({ messageId: 'pm-1' })
    expect(resolveHostOrgBrand).toHaveBeenCalledWith(db, HOST)
    const args = sendEmail.mock.calls[0][0]
    expect(args).toMatchObject({
      to: 'h@example.test',
      subject: 'Set your password for the Acme Fitness host portal',
      stream: 'outbound',
      tag: 'host-portal-access',
      metadata: { host_id: 'h-1' },
    })
    expect(args.htmlBody).toContain(URL.replace(/&/g, '&amp;'))
    // The link is a credential: body only, never metadata.
    expect(JSON.stringify(args.metadata)).not.toContain('token=abc')
  })

  it('propagates a send failure to the caller', async () => {
    sendEmail.mockRejectedValue(new Error('Postmark send error'))
    await expect(
      sendHostPortalAccessEmail({ db: {}, host: HOST, to: 'h@example.test', url: URL }),
    ).rejects.toThrow('Postmark send error')
  })
})
