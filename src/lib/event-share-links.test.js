// HOSTPORTAL.4 — tagged share links: every token is a source Insights accepts
// and labels, and the URL helper keeps everything but utm_source.
import { describe, it, expect } from 'vitest'
import { sourceOf, attributionSourceLabel } from './event-attribution'
import { SHARE_SOURCES, QR_SOURCE, taggedEventUrl } from './event-share-links'

describe('event share links', () => {
  it('every share token and the QR token is a source Insights accepts and labels', () => {
    for (const { token, label } of SHARE_SOURCES) {
      expect(sourceOf({ utm_source: token })).toBe(token)
      expect(attributionSourceLabel(token)).toBe(label)
    }
    expect(sourceOf({ utm_source: QR_SOURCE })).toBe('qr')
    expect(attributionSourceLabel('qr')).toBe('QR code')
  })
  it('lists the six sources in order', () => {
    expect(SHARE_SOURCES.map((s) => s.token)).toEqual(['instagram', 'whatsapp', 'facebook', 'tiktok', 'x', 'linkedin'])
  })
  it('adds utm_source to a bare URL', () => {
    expect(taggedEventUrl('https://example.test/event/abc', 'instagram')).toBe('https://example.test/event/abc?utm_source=instagram')
  })
  it('keeps an existing query and hash, and replaces an existing utm_source', () => {
    expect(taggedEventUrl('https://example.test/event/abc?x=1&utm_source=old#top', 'x')).toBe('https://example.test/event/abc?x=1&utm_source=x#top')
  })
  it('returns the input unchanged when it is not a URL', () => {
    expect(taggedEventUrl('not a url', 'x')).toBe('not a url')
  })
})
