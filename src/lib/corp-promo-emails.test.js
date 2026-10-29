import { describe, it, expect, vi, beforeEach } from 'vitest'

const sent = vi.fn(async () => ({}))
vi.mock('@/lib/postmark', () => ({ sendTransactionalEmail: (...a) => sent(...a) }))

import { sendCorpPromoEmail, expiresOnLabel } from './corp-promo-emails'
import { corpPromoCopyFromBlocks } from './corp-promos'

const COPY = corpPromoCopyFromBlocks([], 'hatch-3-free')
const claim = { id: 'c', location_id: 'loc-h', contact_id: 'c-1', first_name: 'Ann <b>', customer_email: 'ann@work.ie', credits: 3, expires_at: '2026-11-04T10:00:00Z' }
const db = (contact) => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: contact, error: null }) }) }) }) })

beforeEach(() => sent.mockClear())

describe('sendCorpPromoEmail', () => {
  it('sends the credits and the expiry day in the studio zone, tokens escaped', async () => {
    expect(await sendCorpPromoEmail(db({ id: 'c-1' }), { claim, copy: COPY, studioName: 'UN1T Hatch Street', zone: 'Europe/Dublin' })).toEqual({ sent: true })
    const msg = sent.mock.calls[0][0]
    expect(msg.subject).toBe('Your 3 free classes at UN1T Hatch Street')
    expect(msg.htmlBody).toContain('Hi Ann,')
    expect(msg.htmlBody).toContain('Wednesday, 4 November')
    expect(msg.tag).toBe('corp-promo-granted')
  })

  it('appends the app section when the studio has links, nothing when it has none', async () => {
    const appLinks = { iosUrl: 'https://apps.apple.com/x', androidUrl: null, heading: 'Get the app', body: 'Log in.' }
    await sendCorpPromoEmail(db({ id: 'c-1' }), { claim, copy: COPY, studioName: 'S', zone: 'Europe/Dublin', appLinks })
    expect(sent.mock.calls[0][0].htmlBody).toContain('Get the app')
    expect(sent.mock.calls[0][0].htmlBody).toContain('Download on the App Store')
    sent.mockClear()
    await sendCorpPromoEmail(db({ id: 'c-1' }), { claim, copy: COPY, studioName: 'S', zone: 'Europe/Dublin', appLinks: { iosUrl: null, androidUrl: null } })
    expect(sent.mock.calls[0][0].htmlBody).not.toContain('Download on the App Store')
    expect(sent.mock.calls[0][0].htmlBody).not.toContain('Get the app')
    sent.mockClear()
    await sendCorpPromoEmail(db({ id: 'c-1' }), { claim, copy: COPY, studioName: 'S', zone: 'Europe/Dublin' })
    expect(sent.mock.calls[0][0].htmlBody).not.toContain('App Store')
  })

  it('honours the administrative opt-out and a bounced address', async () => {
    expect(await sendCorpPromoEmail(db({ id: 'c-1', contact_preferences: { email_administrative: false } }), { claim, copy: COPY, studioName: 'S', zone: 'Europe/Dublin' })).toEqual({ sent: false, reason: 'opted_out_administrative_email' })
    expect(await sendCorpPromoEmail(db({ id: 'c-1', email_status: 'bounced' }), { claim, copy: COPY, studioName: 'S', zone: 'Europe/Dublin' })).toMatchObject({ sent: false })
    expect(sent).not.toHaveBeenCalled()
  })

  it('an expiry late on a day renders on the studio day, not UTC', () => {
    expect(expiresOnLabel('2026-11-04T23:30:00Z', 'America/New_York')).toBe('Wednesday, 4 November')
    expect(expiresOnLabel('nope', 'Europe/Dublin')).toBeNull()
  })
})
