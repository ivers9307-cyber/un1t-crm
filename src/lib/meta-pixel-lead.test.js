import { describe, it, expect, vi } from 'vitest'
import { newLeadEventId, pixelUserData, fireBrowserLead } from './meta-pixel-lead.js'

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
  it('is a quiet no-op without a Pixel or without an id, and never throws', () => {
    expect(fireBrowserLead({ fbq: undefined, pixelIds: ['1'], eventId: 'x' })).toBe(false)
    expect(fireBrowserLead({ fbq: vi.fn(), pixelIds: ['1'], eventId: '' })).toBe(false)
    const boom = vi.fn(() => { throw new Error('blocked') })
    expect(fireBrowserLead({ fbq: boom, pixelIds: ['1'], eventId: 'x' })).toBe(false)
  })
})
