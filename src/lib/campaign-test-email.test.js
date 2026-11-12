import { describe, it, expect, vi, beforeEach } from 'vitest'

// Wrap the four send-time steps in spies that still run the real code, so a
// test can check both what each was given and the order they ran in.
vi.mock('@/lib/postmark', async (importOriginal) => {
  const real = await importOriginal()
  return {
    ...real,
    applyMergeTags: vi.fn(real.applyMergeTags),
    appendUnsubscribeFooter: vi.fn(real.appendUnsubscribeFooter),
  }
})
vi.mock('@/lib/campaign-web-view', async (importOriginal) => {
  const real = await importOriginal()
  return { ...real, prependViewInBrowserLink: vi.fn(real.prependViewInBrowserLink) }
})
vi.mock('@/lib/email-content', async (importOriginal) => {
  const real = await importOriginal()
  return { ...real, injectPreheader: vi.fn(real.injectPreheader) }
})

import { buildCampaignTestEmail, parseSendAt } from './campaign-test-email.js'
import { applyMergeTags, appendUnsubscribeFooter } from '@/lib/postmark'
import { prependViewInBrowserLink } from '@/lib/campaign-web-view'
import { injectPreheader } from '@/lib/email-content'

const APP = 'https://crm.example.test'
const APPROVE = `${APP}/communications/campaigns/approve/tok_abc123`
const HTML = '<!DOCTYPE html><html><body><table><tr><td>Hello {{first_name}}, news from {{company_name}}.</td></tr></table></body></html>'

const campaign = (over = {}) => ({
  id: 'camp-1', location_id: 'loc-1', name: 'Autumn', subject: 'Hi {{first_name}}', preview_text: 'Big news {{first_name}}',
  from_name: 'Studio', from_email: null, reply_to: null, html_content: HTML, ...over,
})
const STUDIO = { id: 'loc-1', name: 'Dublin Studio', timezone: 'Europe/Dublin' }

const build = (over = {}) => buildCampaignTestEmail({
  campaign: campaign(),
  studio: STUDIO,
  person: { name: 'Pat Murphy', email: 'pat@example.test' },
  branding: { companyName: 'UN1T Dublin' },
  approveUrl: APPROVE,
  audienceEligible: 8,
  sendsAs: 'hello@un1t.test',
  sendAtLabel: 'as soon as approved',
  appUrl: APP,
  ...over,
})

beforeEach(() => vi.clearAllMocks())

describe('buildCampaignTestEmail', () => {
  it('runs the four send-time steps in the sender\'s order with placeholder links', () => {
    const { html } = build()
    expect(applyMergeTags).toHaveBeenCalledWith(HTML, expect.objectContaining({ first_name: 'Pat', email: 'pat@example.test' }),
      expect.objectContaining({
        location_name: 'Dublin Studio',
        company_name: 'UN1T Dublin',
        unsubscribe_url: `${APP}/unsubscribe/test-token`,
        preference_url: `${APP}/preferences/test-token`,
        zone: 'Europe/Dublin',
      }))
    const unsub = appendUnsubscribeFooter.mock.calls[0][1]
    expect(unsub).toBe(`${APP}/unsubscribe/test-token`)
    expect(unsub.endsWith('/unsubscribe/test-token')).toBe(true)
    const viewUrl = prependViewInBrowserLink.mock.calls[0][1]
    expect(viewUrl).toMatch(/test-token$/)
    expect(viewUrl).not.toContain('camp-1')
    expect(injectPreheader.mock.calls[0][1]).toBe('Big news Pat')

    const order = [applyMergeTags, appendUnsubscribeFooter, prependViewInBrowserLink, injectPreheader]
      .map((f) => f.mock.invocationCallOrder[0])
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(html).toContain('Hello Pat, news from UN1T Dublin.')
  })

  it('skips the preheader when the campaign has no preview text', () => {
    build({ campaign: campaign({ preview_text: null }) })
    expect(injectPreheader).not.toHaveBeenCalled()
  })

  it('puts the banner with head count, sends-as, timing and approve link above the body', () => {
    const { html } = build({ audienceEligible: 1234, sendAtLabel: 'Tue 1 Dec 2026, 09:00 (Europe/Dublin)' })
    const banner = html.indexOf('data-campaign-test-banner')
    expect(banner).toBeGreaterThan(-1)
    expect(banner).toBeLessThan(html.indexOf('Hello Pat'))
    expect(banner).toBeLessThan(html.indexOf('View this email in your browser'))
    expect(html).toContain('Dublin Studio')
    expect(html).toContain('This will go to 1,234 people')
    expect(html).toContain('hello@un1t.test')
    expect(html).toContain('Tue 1 Dec 2026, 09:00 (Europe/Dublin)')
    expect(html).toContain(`href="${APPROVE}"`)
    expect(html.split(APPROVE)).toHaveLength(2) // the link appears exactly once
  })

  it('says one person in the singular', () => {
    expect(build({ audienceEligible: 1 }).html).toContain('This will go to 1 person')
  })

  it('escapes every value it puts in the banner', () => {
    const { html } = build({
      studio: { ...STUDIO, name: '<b>Bad & Co</b>' },
      campaign: campaign({ name: '<script>x</script>' }),
      sendsAs: '"><img src=x>@a.test',
      sendAtLabel: '<i>soon</i>',
    })
    expect(html).toContain('&lt;b&gt;Bad &amp; Co&lt;/b&gt;')
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;')
    expect(html).toContain('&quot;&gt;&lt;img src=x&gt;@a.test')
    expect(html).toContain('&lt;i&gt;soon&lt;/i&gt;')
    expect(html).not.toContain('<script>x</script>')
    expect(html).not.toContain('<img src=x>')
  })

  it('prefixes the subject with [TEST] and merges the person\'s first name', () => {
    expect(build().subject).toBe('[TEST] Hi Pat')
    expect(build({ campaign: campaign({ subject: 'News from {{location_name}}' }) }).subject).toBe('[TEST] News from Dublin Studio')
  })
})

describe('parseSendAt', () => {
  const NOW = Date.UTC(2026, 10, 12, 12, 0, 0) // 12 Nov 2026 12:00 UTC
  const Z = 'Europe/Dublin'

  it('converts a studio wall-clock time to its instant', () => {
    expect(parseSendAt('2026-12-01T09:00', Z, NOW)).toEqual({ ok: true, at: new Date(Date.UTC(2026, 11, 1, 9, 0)) })
    // Another zone: 09:00 in New York in February is 14:00 UTC.
    expect(parseSendAt('2027-02-01T09:00', 'America/New_York', NOW)).toEqual({ ok: true, at: new Date(Date.UTC(2027, 1, 1, 14, 0)) })
  })

  it('refuses a malformed value', () => {
    for (const v of ['2026-12-01 09:00', '2026-12-01T9:00', '2026-02-30T09:00', '2026-12-01T24:00', '', 'tomorrow']) {
      expect(parseSendAt(v, Z, NOW).ok, v).toBe(false)
    }
  })

  it('refuses a time that does not exist in the zone', () => {
    const r = parseSendAt('2027-03-28T01:30', Z, NOW)
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/does not exist/)
  })

  it('refuses a past time and one more than 90 days out', () => {
    expect(parseSendAt('2026-11-12T11:00', Z, NOW)).toMatchObject({ ok: false, message: expect.stringMatching(/future/) })
    expect(parseSendAt('2027-02-11T12:30', Z, NOW)).toMatchObject({ ok: false, message: expect.stringMatching(/90 days/) })
    expect(parseSendAt('2027-02-09T12:00', Z, NOW).ok).toBe(true)
  })
})
