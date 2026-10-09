import { describe, it, expect } from 'vitest'
import { pickHostBranding, hostPageCopy, hostPageEvents } from './host-public-page'

const HERO = 'https://x.supabase.co/storage/v1/object/public/branding/race-hero/a/hero.png'

describe('pickHostBranding', () => {
  it('uses the host hero and accent when set', () => {
    expect(pickHostBranding({ hero_image_url: HERO, accent_hex: '#FF5A1F' }, [{ hero_image_url: 'https://other/x.png', accent_hex: '#000000' }]))
      .toEqual({ heroUrl: HERO, accentHex: '#FF5A1F' })
  })
  it('falls back to the first event that has a hero (events arrive nearest-first)', () => {
    expect(pickHostBranding({}, [{ hero_image_url: null }, { hero_image_url: HERO }, { hero_image_url: 'https://later/x.png' }]))
      .toEqual({ heroUrl: HERO, accentHex: null })
  })
  it('takes the accent from an event when the host has none', () => {
    expect(pickHostBranding({ hero_image_url: HERO }, [{ accent_hex: '#123abc' }])).toEqual({ heroUrl: HERO, accentHex: '#123abc' })
  })
  it('rejects a non-http hero and a malformed accent', () => {
    expect(pickHostBranding({ hero_image_url: 'javascript:alert(1)', accent_hex: 'red' }, [])).toEqual({ heroUrl: null, accentHex: null })
  })
  it('handles no host and no events', () => {
    expect(pickHostBranding(null)).toEqual({ heroUrl: null, accentHex: null })
  })
})

describe('hostPageCopy', () => {
  it('defaults the headline and leaves the blurb null', () => {
    expect(hostPageCopy({})).toEqual({ headline: 'Upcoming events', blurb: null })
  })
  it('uses trimmed operator copy', () => {
    expect(hostPageCopy({ events_headline: '  Train with PTC ', events_blurb: ' Sessions every month. ' }))
      .toEqual({ headline: 'Train with PTC', blurb: 'Sessions every month.' })
  })
})

describe('hostPageEvents (HOST-EVENTS-PAGE.2)', () => {
  const ev = (slug, race_date, registration_closes_at = null) => ({ slug, race_date, registration_closes_at })
  it('keeps an upcoming event whose registration has closed, and drops past ones', () => {
    const rows = [
      ev('past', '2026-10-08'),
      ev('closed-upcoming', '2026-10-18', '2026-10-08T18:00:00Z'),
      ev('open', '2026-10-25', '2026-10-24T18:00:00Z'),
    ]
    expect(hostPageEvents(rows, '2026-10-09').map((e) => e.slug)).toEqual(['closed-upcoming', 'open'])
  })
  it('an event today is still listed, nearest first', () => {
    expect(hostPageEvents([ev('later', '2026-10-20'), ev('today', '2026-10-09')], '2026-10-09').map((e) => e.slug)).toEqual(['today', 'later'])
  })
  it('tolerates no rows', () => {
    expect(hostPageEvents(null, '2026-10-09')).toEqual([])
  })
})
