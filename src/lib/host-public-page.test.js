import { describe, it, expect, vi } from 'vitest'
import { pickHostBranding, hostPageCopy, hostPageEvents, hostPageMetadata } from './host-public-page'

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


describe('hostPageMetadata', () => {
  const host = { name: 'PTC', events_headline: 'Train together', list_headline: 'Join PTC', events_blurb: 'Monthly sessions', list_blurb: 'News by email' }
  const path = 'https://hosts.example.com/h/ptc'
  const metadata = (overrides = {}) => hostPageMetadata({ host, events: [], orgName: 'Our Gym', path, ...overrides })

  it('uses the events headline and description in the page and social metadata', () => {
    expect(metadata()).toEqual({
      title: 'Train together', description: 'Monthly sessions',
      openGraph: { title: 'Train together', description: 'Monthly sessions', siteName: 'Our Gym', type: 'website', url: path },
      twitter: { card: 'summary_large_image' },
    })
  })
  it('uses the list headline and description for the join URL', () => {
    expect(metadata({ path: `${path}/join` })).toMatchObject({
      title: 'Join PTC', description: 'News by email',
      openGraph: { title: 'Join PTC', description: 'News by email', url: `${path}/join` },
    })
  })
  it('treats a host named join as the events page', () => {
    expect(metadata({ path: 'https://hosts.example.com/h/join' })).toMatchObject({
      title: 'Train together', description: 'Monthly sessions',
    })
  })
  it('prefers the host hero over event heroes', () => {
    expect(metadata({ host: { ...host, hero_image_url: HERO }, events: [{ hero_image_url: 'https://other/event.png' }] }).openGraph.images)
      .toEqual([{ url: HERO }])
  })
  it('falls back to the first available event hero', () => {
    expect(metadata({ events: [{ hero_image_url: null }, { hero_image_url: HERO }, { hero_image_url: 'https://other/later.png' }] }).openGraph.images)
      .toEqual([{ url: HERO }])
  })
  it('omits images when no usable hero exists', () => {
    expect(metadata().openGraph).not.toHaveProperty('images')
    expect(metadata({ host: { ...host, hero_image_url: 'javascript:bad' }, events: [{ hero_image_url: '/missing.png' }] }).openGraph).not.toHaveProperty('images')
  })
  it('falls back from the events blurb to the list blurb', () => {
    expect(metadata({ host: { ...host, events_blurb: '' } }).description).toBe('News by email')
  })
  it.each([
    [path, 'PTC — upcoming events', "Book PTC's upcoming events."],
    [`${path}/join`, 'PTC — join the list', "Get emails about PTC's events. Unsubscribe anytime."],
  ])('uses default copy for %s when operator copy is absent', (url, title, description) => {
    expect(metadata({ host: { name: 'PTC' }, path: url })).toMatchObject({ title, description, openGraph: { title, description } })
  })
})


// Only the external DB and render-only dependencies are replaced: exercise
// the real metadata entry points so a removed catch would break these tests.
vi.mock('@/lib/supabase', () => ({
  createServerClient: () => ({ from: () => { throw new Error('DB unavailable') } }),
}))
vi.mock('@/fonts/poppins', () => ({ poppinsBody: { variable: '' } }))
vi.mock('@/components/HostListSignup', () => ({ default: () => null }))
vi.mock('@/components/host/HostPublicEvents', () => ({ default: () => null }))

describe('host metadata lookup failure', () => {
  it.each([
    ['events', () => import('../app/h/[slug]/page.js')],
    ['join', () => import('../app/h/[slug]/join/page.js')],
  ])('returns empty metadata for the %s page when the DB throws', async (_page, load) => {
    const { generateMetadata } = await load()
    expect(await generateMetadata({ params: Promise.resolve({ slug: 'ptc' }) })).toEqual({})
  })
})
