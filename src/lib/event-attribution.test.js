// @vitest-environment jsdom
// HOSTSTATS.1 — where an event-page visitor came from: first-touch capture in
// the tab (no cookie), the server-side sanitiser, and the operator labels.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  EVENT_ATTRIBUTION_KEY, rememberEventAttribution, readEventAttribution,
  sanitiseEventAttribution, sourceOf, referrerSourceLabel, attributionSourceLabel,
} from './event-attribution'

const HC = '80000000-0000-4000-8000-000000000001'
const SESSION_RE = /^[A-Za-z0-9_-]{8,64}$/

beforeEach(() => { window.sessionStorage.clear(); vi.restoreAllMocks() })

describe('rememberEventAttribution (browser)', () => {
  it('stores the first touch with a session id and keeps it on a later call with other params', () => {
    rememberEventAttribution({ search: `?utm_source=Instagram&utm_medium=social&hc=${HC}`, referrer: 'https://l.instagram.com/' })
    const first = readEventAttribution()
    expect(first.session_id).toMatch(SESSION_RE)
    expect(first).toMatchObject({ utm_source: 'Instagram', utm_medium: 'social', hc: HC, referrer: 'https://l.instagram.com/' })
    rememberEventAttribution({ search: '?utm_source=facebook', referrer: '' })
    expect(readEventAttribution()).toEqual(first)
  })
  it('caps every stored string at 300 characters', () => {
    rememberEventAttribution({ search: `?utm_campaign=${'c'.repeat(500)}`, referrer: '' })
    expect(readEventAttribution().utm_campaign.length).toBe(300)
  })
  it('swallows a storage that throws, and read answers null', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
    expect(() => rememberEventAttribution({ search: '?x=1', referrer: '' })).not.toThrow()
    expect(readEventAttribution()).toBeNull()
  })
  it('read answers null for nothing stored or malformed JSON', () => {
    expect(readEventAttribution()).toBeNull()
    window.sessionStorage.setItem(EVENT_ATTRIBUTION_KEY, '{nope')
    expect(readEventAttribution()).toBeNull()
  })
})

describe('sanitiseEventAttribution (server)', () => {
  it('caps and nulls hostile input, never throws', () => {
    const s = sanitiseEventAttribution({ session_id: 'abc', utm_source: 'x'.repeat(500), hc: 'nope', referrer: 'javascript:alert(1)' })
    expect(s.session_id).toBeNull()
    expect(s.utm_source.length).toBe(120)
    expect(s.host_campaign_id).toBeNull()
    expect(s.referrer_host).toBeNull()
    expect(s.source).toBe('direct') // 500 chars is not a token: falls through
  })
  it('a host campaign id wins over every other signal', () => {
    const s = sanitiseEventAttribution({ session_id: 'sess-00001', hc: HC, utm_source: 'instagram' })
    expect(s).toMatchObject({ session_id: 'sess-00001', host_campaign_id: HC, source: 'host_email', utm_source: 'instagram' })
  })
  it('reads the referrer host (lower-cased, no www) and labels the known ones', () => {
    expect(sanitiseEventAttribution({ referrer: 'https://l.instagram.com/?u=x' })).toMatchObject({ referrer_host: 'l.instagram.com', source: 'instagram' })
    expect(sanitiseEventAttribution({ referrer: 'https://WWW.Example.org/p?q=1' })).toMatchObject({ referrer_host: 'example.org', source: 'example.org' })
    expect(sanitiseEventAttribution({}).source).toBe('direct')
    expect(sanitiseEventAttribution({}).utm_medium).toBeNull()
    expect(sanitiseEventAttribution('str')).toBeNull()
    expect(sanitiseEventAttribution(null)).toBeNull()
  })
})

describe('sourceOf / referrerSourceLabel / attributionSourceLabel', () => {
  it('derives the source in order: campaign, utm_source, referrer, direct', () => {
    expect(sourceOf({ host_campaign_id: HC, utm_source: 'ig', referrer_host: 'x.com' })).toBe('host_email')
    expect(sourceOf({ host_campaign_id: null, utm_source: 'IG', referrer_host: 'x.com' })).toBe('ig')
    expect(sourceOf({ host_campaign_id: null, utm_source: null, referrer_host: 't.co' })).toBe('x')
    expect(sourceOf({ host_campaign_id: null, utm_source: null, referrer_host: null })).toBe('direct')
  })
  it('a utm_source that is not a plain token (letters, digits, _ . -; ≤40) falls through, so the card never shows attacker text', () => {
    expect(sourceOf({ host_campaign_id: null, utm_source: '<script>alert(1)</script>', referrer_host: 'l.instagram.com' })).toBe('instagram')
    expect(sourceOf({ host_campaign_id: null, utm_source: 'Meta Ads', referrer_host: null })).toBe('direct')
    expect(sourceOf({ host_campaign_id: null, utm_source: 'x'.repeat(41), referrer_host: null })).toBe('direct')
    expect(sourceOf({ host_campaign_id: null, utm_source: '-lead', referrer_host: null })).toBe('direct')
    expect(sourceOf({ host_campaign_id: null, utm_source: 'meta_ads.v2-b', referrer_host: null })).toBe('meta_ads.v2-b')
  })
  it('a utm_source spelling a reserved word cannot pose as a server-derived source', () => {
    expect(sourceOf({ host_campaign_id: null, utm_source: 'host_email', referrer_host: 'l.instagram.com' })).toBe('instagram')
    expect(sourceOf({ host_campaign_id: null, utm_source: 'Direct', referrer_host: null })).toBe('direct')
    expect(sourceOf({ host_campaign_id: null, utm_source: 'unknown', referrer_host: null })).toBe('direct')
  })
  it('knows the social and search hosts', () => {
    for (const [host, label] of [['lm.facebook.com', 'facebook'], ['m.facebook.com', 'facebook'], ['wa.me', 'whatsapp'], ['google.ie', 'google'], ['strava.com', 'strava'], ['linkedin.com', 'linkedin'], ['tiktok.com', 'tiktok'], ['youtube.com', 'youtube'], ['example.org', 'example.org']]) {
      expect(referrerSourceLabel(host)).toBe(label)
    }
  })
  it('labels for operators', () => {
    expect(attributionSourceLabel('host_email')).toBe('Host email')
    expect(attributionSourceLabel('direct')).toBe('Direct')
    expect(attributionSourceLabel('whatsapp')).toBe('WhatsApp')
    expect(attributionSourceLabel('qr')).toBe('QR code')
    expect(attributionSourceLabel('example.org')).toBe('example.org')
  })
})
