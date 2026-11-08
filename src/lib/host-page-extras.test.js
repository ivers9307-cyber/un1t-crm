// HOSTPAGE.2 — the host page's extra sections as data: about, photos,
// testimonials, the two toggles, and the past-events list.
import { describe, it, expect } from 'vitest'
import { hostPageExtras, pastEventCards, HostPhotosSchema, HostTestimonialsSchema, HOST_PHOTOS_MAX, HOST_TESTIMONIALS_MAX, hostPhotoPathOf, isOwnHostPhotoUrl } from './host-page-extras'

describe('hostPageExtras', () => {
  it('trims about, keeps only valid photos and testimonials, caps both, defaults the toggles on', () => {
    const photos = Array.from({ length: 14 }, (_, i) => ({ url: `https://x.test/p${i}.jpg`, caption: i === 0 ? ' First ' : null }))
    photos.splice(1, 0, { url: 'not-a-url' })
    const testimonials = Array.from({ length: 8 }, (_, i) => ({ quote: `Great ${i}`, author: 'A' }))
    testimonials.splice(2, 0, { quote: 'x'.repeat(401), author: 'Too long' })
    const x = hostPageExtras({ about_text: '  Who we are.  ', photos, testimonials })
    expect(x.about).toBe('Who we are.')
    expect(x.photos.length).toBe(HOST_PHOTOS_MAX)
    expect(x.photos[0]).toEqual({ url: 'https://x.test/p0.jpg', caption: 'First' })
    expect(x.photos.some((p) => p.url === 'not-a-url')).toBe(false)
    expect(x.testimonials.length).toBe(HOST_TESTIMONIALS_MAX)
    expect(x.testimonials.some((t) => t.quote.length > 400)).toBe(false)
    expect(x.showPastEvents).toBe(true)
    expect(x.showRatings).toBe(true)
  })
  it('empty and null inputs → empty sections; explicit false toggles honoured', () => {
    expect(hostPageExtras(null)).toEqual({ about: '', photos: [], testimonials: [], showPastEvents: true, showRatings: true })
    expect(hostPageExtras({ about_text: null, photos: 'junk', testimonials: null, show_past_events: false, show_ratings: false }))
      .toEqual({ about: '', photos: [], testimonials: [], showPastEvents: false, showRatings: false })
  })
  it('the schemas refuse too many entries and over-long fields', () => {
    expect(HostPhotosSchema.safeParse(Array.from({ length: 13 }, () => ({ url: 'https://x.test/a.jpg' }))).success).toBe(false)
    expect(HostPhotosSchema.safeParse([{ url: 'https://x.test/a.jpg', caption: 'c'.repeat(121) }]).success).toBe(false)
    expect(HostTestimonialsSchema.safeParse([{ quote: '' }]).success).toBe(false)
    expect(HostTestimonialsSchema.safeParse([{ quote: 'ok', author: 'a'.repeat(81) }]).success).toBe(false)
    expect(HostTestimonialsSchema.safeParse([{ quote: 'ok' }]).success).toBe(true)
  })
})

describe('pastEventCards', () => {
  const rows = [
    { id: 'a', name: 'Older', race_date: '2026-05-01' },
    { id: 'b', name: 'Today', race_date: '2026-07-18' },
    { id: 'c', name: 'Yesterday', race_date: '2026-07-17' },
    { id: 'd', name: 'Future', race_date: '2026-08-01' },
  ]
  it('keeps only dates before today, newest first, with a long date label', () => {
    expect(pastEventCards(rows, '2026-07-18')).toEqual([
      { id: 'c', name: 'Yesterday', dateLabel: 'Friday 17 July 2026' },
      { id: 'a', name: 'Older', dateLabel: 'Friday 1 May 2026' },
    ])
  })
  it('caps at 24 by default', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ id: `e${i}`, name: `E${i}`, race_date: `2026-01-${String(i + 1).padStart(2, '0')}` }))
    expect(pastEventCards(many, '2026-07-18').length).toBe(24)
    expect(pastEventCards(many, '2026-07-18', { max: 5 }).length).toBe(5)
  })
})

describe('hostPhotoPathOf / isOwnHostPhotoUrl (security review: pinned host)', () => {
  const H = 'a0000000-0000-4000-8000-0000000000a1'
  const own = `https://cdn.test/storage/v1/object/public/branding/host-photos/${H}/a.jpg`
  it('accepts only the project Supabase host with the full public-branding prefix, under the host folder', () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://cdn.test'
    expect(hostPhotoPathOf(own)).toBe(`host-photos/${H}/a.jpg`)
    expect(isOwnHostPhotoUrl(own, H)).toBe(true)
    expect(isOwnHostPhotoUrl(`https://evil.example/storage/v1/object/public/branding/host-photos/${H}/x.jpg`, H)).toBe(false)
    expect(isOwnHostPhotoUrl(`https://cdn.test/other/object/public/branding/host-photos/${H}/x.jpg`, H)).toBe(false)
    expect(isOwnHostPhotoUrl(`http://cdn.test/storage/v1/object/public/branding/host-photos/${H}/x.jpg`, H)).toBe(false)
    expect(isOwnHostPhotoUrl(`https://cdn.test/storage/v1/object/public/branding/host-photos/${H}/../other/x.jpg`, H)).toBe(false)
    expect(isOwnHostPhotoUrl(`https://cdn.test/storage/v1/object/public/branding/host-photos/${H}/%2e%2e/x.jpg`, H)).toBe(false)
    expect(isOwnHostPhotoUrl(`https://cdn.test/storage/v1/object/public/branding/host-photos/other/x.jpg`, H)).toBe(false)
    expect(isOwnHostPhotoUrl('not a url', H)).toBe(false)
  })
  it('fails closed without a project URL', () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL
    expect(hostPhotoPathOf(own)).toBeNull()
    expect(isOwnHostPhotoUrl(own, H)).toBe(false)
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://cdn.test'
  })
})
