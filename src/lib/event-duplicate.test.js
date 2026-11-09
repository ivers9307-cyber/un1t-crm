// HOSTSERIES.1 — duplicateEvent: a draft copy of an event on a new date, with
// its waves, its registration window shifted by the date delta and its own
// hero file. Never registrations, promo codes, waitlist rows or moves.
import { describe, it, expect, vi } from 'vitest'
import { fakeDb } from './event-waitlist.test-helpers'

vi.mock('./event-slug', async (importOriginal) => ({ ...(await importOriginal()), uniqueEventSlug: vi.fn(async (_db, base) => base) }))
vi.mock('./log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))

const { duplicateEvent, shiftByDays, dayDelta, DUPLICATE_COLUMNS } = await import('./event-duplicate.js')

const E1 = 'e0000000-0000-4000-8000-0000000000e1'
const NEW = 'e0000000-0000-4000-8000-0000000000e9'
const SOURCE = {
  id: E1, kind: 'workshop', name: 'Mobility', description: 'Stretch', location_id: 'L1', host_id: 'h1',
  allowed_team_sizes: [1, 2], capacity_mode: 'people', member_pricing_enabled: false, members_only: false,
  member_fee_cents: null, non_member_fee_cents: 2500, payment_currency: 'EUR',
  registration_opens_at: '2026-11-01T09:00:00+00:00', registration_closes_at: '2026-11-13T18:00:00+00:00',
  hero_image_url: `https://x.supabase.co/storage/v1/object/public/branding/race-hero/${E1}/hero.jpg?t=123`,
  accent_hex: '#112233', venue_name: 'Studio 1', venue_address: '1 Main St',
  confirmation_email_subject: 'See you', entry_policy: { cutoff_hours: 24 }, charity_enabled: false, charity: null,
  race_date: '2026-11-14', series_id: null,
  race_waves: [{ start_time: '10:00:00', label: null, capacity: 20, display_order: 0 }, { start_time: '14:00:00', label: 'PM', capacity: 10, display_order: 1 }],
}

function db({ source = SOURCE, waveError = null, copyError = null } = {}) {
  const storage = { copies: [], from: () => ({
    copy: async (from, to) => { storage.copies.push([from, to]); return copyError ? { data: null, error: copyError } : { data: { path: to }, error: null } },
    getPublicUrl: (path) => ({ data: { publicUrl: `https://x.supabase.co/storage/v1/object/public/branding/${path}` } }),
  }) }
  const d = fakeDb((q) => {
    if (q.table === 'race_events' && q.action === 'select') return { data: source, error: null }
    if (q.table === 'race_events' && q.action === 'insert') return { data: { id: NEW, slug: q.payload.slug }, error: null }
    if (q.table === 'race_waves' && q.action === 'insert') return waveError ? { data: null, error: waveError } : { data: q.payload, error: null }
    return { data: null, error: null }
  })
  d.storage = storage
  return d
}
const inserted = (d, table) => d.queries.find((q) => q.table === table && q.action === 'insert')

describe('shiftByDays / dayDelta', () => {
  it('counts whole days between two dates', () => {
    expect(dayDelta('2026-11-14', '2026-12-12')).toBe(28)
    expect(dayDelta('2026-11-14', '2026-11-07')).toBe(-7)
  })
  it('moves an instant by whole days and leaves null alone', () => {
    expect(shiftByDays('2026-11-13T18:00:00+00:00', 28)).toBe('2026-12-11T18:00:00.000Z')
    expect(shiftByDays(null, 28)).toBeNull()
  })
})

describe('duplicateEvent', () => {
  it('copies the operator columns and every wave as a draft on the new date', async () => {
    const d = db()
    const r = await duplicateEvent(d, { sourceId: E1, raceDate: '2026-12-12' })
    expect(r.ok).toBe(true)
    expect(r.event).toEqual({ id: NEW, slug: expect.stringMatching(/dec12-1000$/) })
    const ev = inserted(d, 'race_events').payload
    expect(ev).toMatchObject({
      kind: 'workshop', name: 'Mobility', description: 'Stretch', location_id: 'L1', host_id: 'h1',
      non_member_fee_cents: 2500, venue_name: 'Studio 1', accent_hex: '#112233', entry_policy: { cutoff_hours: 24 },
      race_date: '2026-12-12', status: 'draft', active: true, series_id: null, submitted_at: null, reviewed_at: null, rejected_reason: null,
    })
    expect(ev).not.toHaveProperty('id')
    const waves = inserted(d, 'race_waves').payload
    expect(waves).toEqual([
      { race_event_id: NEW, start_time: '10:00:00', label: null, capacity: 20, display_order: 0 },
      { race_event_id: NEW, start_time: '14:00:00', label: 'PM', capacity: 10, display_order: 1 },
    ])
  })

  it('shifts the registration window by the date delta', async () => {
    const d = db()
    await duplicateEvent(d, { sourceId: E1, raceDate: '2026-12-12' })
    const ev = inserted(d, 'race_events').payload
    expect(ev.registration_opens_at).toBe('2026-11-29T09:00:00.000Z')
    expect(ev.registration_closes_at).toBe('2026-12-11T18:00:00.000Z')
  })

  it('stamps the series and a given name', async () => {
    const d = db()
    await duplicateEvent(d, { sourceId: E1, raceDate: '2026-12-12', seriesId: 'S1', name: 'Mobility — December' })
    expect(inserted(d, 'race_events').payload).toMatchObject({ series_id: 'S1', name: 'Mobility — December' })
  })

  it('copies the hero file into the new event\'s folder and points the copy at it', async () => {
    const d = db()
    await duplicateEvent(d, { sourceId: E1, raceDate: '2026-12-12' })
    expect(d.storage.copies).toEqual([[`race-hero/${E1}/hero.jpg`, `race-hero/${NEW}/hero.jpg`]])
    const update = d.queries.find((q) => q.table === 'race_events' && q.action === 'update')
    expect(update.payload.hero_image_url).toMatch(new RegExp(`race-hero/${NEW}/hero.jpg`))
    expect(update.ops).toContainEqual(['eq', 'id', NEW])
  })

  it('hero copy failure leaves the copy without a hero, and the duplicate still succeeds', async () => {
    const d = db({ copyError: { message: 'not found' } })
    const r = await duplicateEvent(d, { sourceId: E1, raceDate: '2026-12-12' })
    expect(r.ok).toBe(true)
    expect(inserted(d, 'race_events').payload.hero_image_url).toBeNull()
    expect(d.queries.some((q) => q.table === 'race_events' && q.action === 'update')).toBe(false)
  })

  it('a hero that is not a race-hero object is copied by URL as-is', async () => {
    const d = db({ source: { ...SOURCE, hero_image_url: 'https://cdn.example/pic.jpg' } })
    await duplicateEvent(d, { sourceId: E1, raceDate: '2026-12-12' })
    expect(d.storage.copies).toEqual([])
    expect(inserted(d, 'race_events').payload.hero_image_url).toBe('https://cdn.example/pic.jpg')
  })

  it('a failed wave insert deletes the new event and is write_failed', async () => {
    const d = db({ waveError: { message: 'down' } })
    const r = await duplicateEvent(d, { sourceId: E1, raceDate: '2026-12-12' })
    expect(r).toMatchObject({ ok: false, error: 'write_failed' })
    const del = d.queries.find((q) => q.table === 'race_events' && q.action === 'delete')
    expect(del.ops).toContainEqual(['eq', 'id', NEW])
  })

  it('not_found for an unknown source; load_failed for a failed read', async () => {
    const none = fakeDb(() => ({ data: null, error: null }))
    expect(await duplicateEvent(none, { sourceId: E1, raceDate: '2026-12-12' })).toMatchObject({ ok: false, error: 'not_found' })
    const down = fakeDb(() => ({ data: null, error: { message: 'timeout' } }))
    expect(await duplicateEvent(down, { sourceId: E1, raceDate: '2026-12-12' })).toMatchObject({ ok: false, error: 'load_failed' })
  })

  it('never copies registrations, promo codes, waitlist rows or moves', async () => {
    const d = db()
    await duplicateEvent(d, { sourceId: E1, raceDate: '2026-12-12' })
    const tables = new Set(d.queries.map((q) => q.table))
    expect([...tables].sort()).toEqual(['race_events', 'race_waves'])
  })

  it('DUPLICATE_COLUMNS carries the pricing tiers (TIERS.1) and the registration questions (QUESTIONS.1)', () => {
    expect(DUPLICATE_COLUMNS).toContain('pricing_tiers')
    expect(DUPLICATE_COLUMNS).toContain('registration_questions')
    expect(DUPLICATE_COLUMNS).toContain('duration_minutes')
    expect(DUPLICATE_COLUMNS).toContain('wave_window_minutes') // WAVEWIN.2
  })
  // RATINGCOPY.1 — the copy list carried every other email copy pair but not this one.
  it('DUPLICATE_COLUMNS carries the rating request copy, and a copy keeps it', async () => {
    expect(DUPLICATE_COLUMNS).toContain('rating_email_subject')
    expect(DUPLICATE_COLUMNS).toContain('rating_email_intro')
    const d = db({ source: { ...SOURCE, rating_email_subject: 'How was it?', rating_email_intro: 'Tell us.' } })
    await duplicateEvent(d, { sourceId: E1, raceDate: '2026-12-12' })
    expect(inserted(d, 'race_events').payload).toMatchObject({ rating_email_subject: 'How was it?', rating_email_intro: 'Tell us.' })
  })
  it('DUPLICATE_COLUMNS never names id, slug, status, series_id or the review stamps', () => {
    for (const c of ['id', 'slug', 'status', 'series_id', 'submitted_at', 'reviewed_at', 'rejected_reason', 'active', 'created_at']) {
      expect(DUPLICATE_COLUMNS).not.toContain(c)
    }
  })
})
