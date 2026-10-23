import { describe, it, expect, vi } from 'vitest'
import { newLeadEventId, pixelUserData, fireBrowserLead, fireBrowserInitiateCheckout, checkoutEventIdFor } from './meta-pixel-lead.js'

describe('BROWSERLEAD.1 — browser Lead helpers', () => {
  it('mints a usable id', () => {
    const id = newLeadEventId()
    expect(typeof id).toBe('string')
    expect(id.length).toBeGreaterThanOrEqual(8)
    expect(/^[A-Za-z0-9_-]+$/.test(id)).toBe(true)
  })
  it('builds the Pixel user data normalised, blanks left out, country only from an Irish phone', () => {
    expect(pixelUserData({ email: ' Sam@Example.COM ', phone: '087 123 4567', firstName: "Seán", lastName: "O'Brien" }))
      .toEqual({ em: 'sam@example.com', ph: '353871234567', fn: 'seán', ln: 'obrien', country: 'ie' })
    expect(pixelUserData({ email: 'x', phone: '+44 7700 900123' })).toEqual({ ph: '447700900123' })
    expect(pixelUserData({})).toEqual({})
  })
  it('inits every pixel with the user data, then tracks one Lead with the shared event id', () => {
    const fbq = vi.fn()
    const ok = fireBrowserLead({ fbq, pixelIds: ['111', '222'], eventId: 'abc-123', userData: { em: 'sam@example.com' }, contentName: 'DUO' })
    expect(ok).toBe(true)
    expect(fbq.mock.calls).toEqual([
      ['init', '111', { em: 'sam@example.com' }],
      ['init', '222', { em: 'sam@example.com' }],
      ['track', 'Lead', { content_name: 'DUO' }, { eventID: 'abc-123' }],
    ])
  })
  it('skips the init when there is nothing to match on, and still tracks', () => {
    const fbq = vi.fn()
    fireBrowserLead({ fbq, pixelIds: ['111'], eventId: 'abc-123', userData: {} })
    expect(fbq.mock.calls).toEqual([['track', 'Lead', {}, { eventID: 'abc-123' }]])
  })
  // TRIALCHECKOUT.1 — the InitiateCheckout the Sales ad set optimises on.
  it('derives the checkout event id from the lead id, so browser and server dedupe', () => {
    expect(checkoutEventIdFor('abc-123')).toBe('trialcheckout-abc-123')
    expect(checkoutEventIdFor('')).toBeNull()
    expect(checkoutEventIdFor(undefined)).toBeNull()
  })
  it('tracks one InitiateCheckout with the price, upper-cased currency and the shared event id; no init (the Lead did it)', () => {
    const fbq = vi.fn()
    const ok = fireBrowserInitiateCheckout({ fbq, eventId: 'trialcheckout-abc-123', value: 39, currency: 'eur', contentName: 'The 14 Day Reset' })
    expect(ok).toBe(true)
    expect(fbq.mock.calls).toEqual([['track', 'InitiateCheckout', { value: 39, currency: 'EUR', content_name: 'The 14 Day Reset' }, { eventID: 'trialcheckout-abc-123' }]])
  })
  it('InitiateCheckout leaves out what it does not know, and is a quiet no-op without a Pixel or an id', () => {
    const fbq = vi.fn()
    fireBrowserInitiateCheckout({ fbq, eventId: 'x', value: NaN })
    expect(fbq.mock.calls).toEqual([['track', 'InitiateCheckout', {}, { eventID: 'x' }]])
    expect(fireBrowserInitiateCheckout({ fbq: undefined, eventId: 'x' })).toBe(false)
    expect(fireBrowserInitiateCheckout({ fbq: vi.fn(), eventId: null })).toBe(false)
    expect(fireBrowserInitiateCheckout({ fbq: vi.fn(() => { throw new Error('blocked') }), eventId: 'x' })).toBe(false)
  })
  it('is a quiet no-op without a Pixel or without an id, and never throws', () => {
    expect(fireBrowserLead({ fbq: undefined, pixelIds: ['1'], eventId: 'x' })).toBe(false)
    expect(fireBrowserLead({ fbq: vi.fn(), pixelIds: ['1'], eventId: '' })).toBe(false)
    const boom = vi.fn(() => { throw new Error('blocked') })
    expect(fireBrowserLead({ fbq: boom, pixelIds: ['1'], eventId: 'x' })).toBe(false)
  })
})
