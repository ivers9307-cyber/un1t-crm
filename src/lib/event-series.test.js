// HOSTSERIES.1 — event-series: slug, ownership, making a series from an
// event (one duplicate per date), adding an event, the public page read and
// the host's list.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fakeDb } from './event-waitlist.test-helpers'

vi.mock('./log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('./event-duplicate', async (importOriginal) => ({ ...(await importOriginal()), duplicateEvent: vi.fn() }))
vi.mock('./location-time', async (importOriginal) => ({ ...(await importOriginal()), getLocationZone: vi.fn(async () => 'Europe/Dublin') }))

const { duplicateEvent } = await import('./event-duplicate')
const { RESERVED_EVENT_SLUGS } = await import('./event-slug')
const {
  hostOwnsSeries, seriesSlugBase, uniqueSeriesSlug, createSeriesFromEvent, addEventToSeries, loadSeriesPage, listHostSeries,
} = await import('./event-series.js')

const E1 = 'e0000000-0000-4000-8000-0000000000e1'
const S1 = 'd0000000-0000-4000-8000-0000000000d1'
const SOURCE = { id: E1, host_id: 'h1', location_id: 'L1', race_date: '2026-12-05', series_id: null }

beforeEach(() => {
  vi.clearAllMocks()
  let n = 0
  duplicateEvent.mockImplementation(async (_db, { raceDate }) => { n += 1; return { ok: true, event: { id: `E-copy-${n}`, slug: `copy-${raceDate}` } } })
})

describe('slugs', () => {
  it('"series" is a reserved event slug (the page lives at /event/series/<slug>)', () => {
    expect(RESERVED_EVENT_SLUGS.has('series')).toBe(true)
  })
  it('seriesSlugBase slugs the name', () => {
    expect(seriesSlugBase('Monthly Mobility  Workshop!')).toBe('monthly-mobility-workshop')
    expect(seriesSlugBase('')).toBe('series')
  })
  it('uniqueSeriesSlug suffixes a taken slug and treats a failed probe as taken', async () => {
    const taken = new Set(['monthly', 'monthly-2'])
    const d = fakeDb((q) => ({ data: taken.has(q.ops.find((o) => o[0] === 'eq' && o[1] === 'slug')?.[2]) ? { id: 'x' } : null, error: null }))
    expect(await uniqueSeriesSlug(d, 'monthly')).toBe('monthly-3')
    const down = fakeDb(() => ({ data: null, error: { message: 'timeout' } }))
    expect(await uniqueSeriesSlug(down, 'monthly')).toMatch(/^monthly-\d{10,}$/)
  })
})

describe('hostOwnsSeries', () => {
  it('yes for the host\'s own, no for another\'s or an unknown one, load_failed on a failed read', async () => {
    expect(await hostOwnsSeries(fakeDb(() => ({ data: { id: S1, host_id: 'h1' }, error: null })), { seriesId: S1, hostId: 'h1' })).toEqual({ ok: true })
    expect(await hostOwnsSeries(fakeDb(() => ({ data: { id: S1, host_id: 'h2' }, error: null })), { seriesId: S1, hostId: 'h1' })).toEqual({ ok: false, error: 'invalid_series' })
    expect(await hostOwnsSeries(fakeDb(() => ({ data: null, error: null })), { seriesId: S1, hostId: 'h1' })).toEqual({ ok: false, error: 'invalid_series' })
    expect(await hostOwnsSeries(fakeDb(() => ({ data: null, error: { message: 'x' } })), { seriesId: S1, hostId: 'h1' })).toEqual({ ok: false, error: 'load_failed' })
    expect(await hostOwnsSeries(fakeDb(() => ({ data: null, error: null })), { seriesId: null, hostId: 'h1' })).toEqual({ ok: true })
  })
})

function seriesDb({ source = SOURCE, slugTaken = () => false } = {}) {
  return fakeDb((q) => {
    if (q.table === 'race_events' && q.action === 'select') return { data: source, error: null }
    if (q.table === 'event_series' && q.action === 'select') {
      const slug = q.ops.find((o) => o[0] === 'eq' && o[1] === 'slug')?.[2]
      return { data: slug && slugTaken(slug) ? { id: 'other' } : null, error: null }
    }
    if (q.table === 'event_series' && q.action === 'insert') return { data: { id: S1, slug: q.payload.slug }, error: null }
    return { data: null, error: null }
  })
}

describe('createSeriesFromEvent', () => {
  it('creates the series, stamps the source, then duplicates each date with the series id', async () => {
    const d = seriesDb()
    const r = await createSeriesFromEvent(d, { sourceId: E1, dates: ['2027-01-02', '2027-02-06'], name: 'Monthly Mobility' })
    expect(r.ok).toBe(true)
    expect(r.series).toEqual({ id: S1, slug: 'monthly-mobility' })
    expect(r.created.map((c) => c.race_date)).toEqual(['2027-01-02', '2027-02-06'])
    const ins = d.queries.find((q) => q.table === 'event_series' && q.action === 'insert')
    expect(ins.payload).toMatchObject({ host_id: 'h1', location_id: 'L1', name: 'Monthly Mobility', slug: 'monthly-mobility' })
    const stamp = d.queries.find((q) => q.table === 'race_events' && q.action === 'update')
    expect(stamp.payload).toEqual({ series_id: S1 })
    expect(stamp.ops).toContainEqual(['eq', 'id', E1])
    expect(duplicateEvent).toHaveBeenCalledTimes(2)
    expect(duplicateEvent.mock.calls[0][1]).toEqual({ sourceId: E1, raceDate: '2027-01-02', seriesId: S1 })
    // order: series insert → source stamp → duplicates
    const order = d.queries.filter((q) => q.action !== 'select').map((q) => `${q.table}:${q.action}`)
    expect(order).toEqual(['event_series:insert', 'race_events:update'])
  })
  it('refuses a source already in a series', async () => {
    const r = await createSeriesFromEvent(seriesDb({ source: { ...SOURCE, series_id: 'S0' } }), { sourceId: E1, dates: ['2027-01-02'], name: 'X' })
    expect(r).toMatchObject({ ok: false, error: 'already_in_series' })
    expect(duplicateEvent).not.toHaveBeenCalled()
  })
  it('refuses a date equal to the source\'s, a duplicate date, none, or more than 24', async () => {
    const d = seriesDb()
    expect(await createSeriesFromEvent(d, { sourceId: E1, dates: ['2026-12-05'], name: 'X' })).toMatchObject({ ok: false, error: 'invalid_dates' })
    expect(await createSeriesFromEvent(d, { sourceId: E1, dates: ['2027-01-02', '2027-01-02'], name: 'X' })).toMatchObject({ ok: false, error: 'invalid_dates' })
    expect(await createSeriesFromEvent(d, { sourceId: E1, dates: [], name: 'X' })).toMatchObject({ ok: false, error: 'invalid_dates' })
    const many = Array.from({ length: 25 }, (_, i) => `2027-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + Math.floor(i / 12)).padStart(2, '0')}`)
    expect(await createSeriesFromEvent(d, { sourceId: E1, dates: many, name: 'X' })).toMatchObject({ ok: false, error: 'invalid_dates' })
    expect(d.queries.some((q) => q.action === 'insert')).toBe(false)
  })
  it('a failed duplicate midway is write_failed, naming the copies already made', async () => {
    duplicateEvent
      .mockResolvedValueOnce({ ok: true, event: { id: 'E-a', slug: 'a' } })
      .mockResolvedValueOnce({ ok: false, error: 'write_failed', message: 'down' })
    const r = await createSeriesFromEvent(seriesDb(), { sourceId: E1, dates: ['2027-01-02', '2027-02-06', '2027-03-06'], name: 'X' })
    expect(r).toMatchObject({ ok: false, error: 'write_failed' })
    expect(r.created).toEqual([{ id: 'E-a', slug: 'a', race_date: '2027-01-02' }])
    expect(r.message).toMatch(/1 of 3/)
    expect(duplicateEvent).toHaveBeenCalledTimes(2)
  })
  it('not_found for an unknown source', async () => {
    expect(await createSeriesFromEvent(fakeDb(() => ({ data: null, error: null })), { sourceId: E1, dates: ['2027-01-02'], name: 'X' })).toMatchObject({ ok: false, error: 'not_found' })
  })
})

describe('addEventToSeries', () => {
  it('stamps the series when both belong to the host; not_found otherwise', async () => {
    const d = fakeDb((q) => {
      if (q.table === 'race_events' && q.action === 'select') return { data: { id: E1, host_id: 'h1' }, error: null }
      if (q.table === 'event_series') return { data: { id: S1, host_id: 'h1' }, error: null }
      return { data: null, error: null }
    })
    expect(await addEventToSeries(d, { eventId: E1, seriesId: S1, hostId: 'h1' })).toEqual({ ok: true })
    const upd = d.queries.find((q) => q.action === 'update')
    expect(upd.payload).toEqual({ series_id: S1 })
    const other = fakeDb((q) => (q.table === 'event_series' ? { data: { id: S1, host_id: 'h2' }, error: null } : { data: { id: E1, host_id: 'h1' }, error: null }))
    expect(await addEventToSeries(other, { eventId: E1, seriesId: S1, hostId: 'h1' })).toMatchObject({ ok: false, error: 'not_found' })
  })
})

describe('loadSeriesPage', () => {
  const series = { id: S1, host_id: 'h1', location_id: 'L1', name: 'Monthly', slug: 'monthly', headline: null, blurb: null }
  it('returns the series, its published upcoming dates in date order, and the studio zone', async () => {
    const d = fakeDb((q) => {
      if (q.table === 'event_series') return { data: series, error: null }
      if (q.table === 'race_events') return { data: [{ id: 'b', slug: 'b', race_date: '2027-02-06', waves: [], registrations: [] }, { id: 'a', slug: 'a', race_date: '2027-01-02', waves: [], registrations: [] }], error: null }
      return { data: null, error: null }
    })
    const r = await loadSeriesPage(d, { slug: 'monthly', today: '2026-12-01' })
    expect(r.series).toEqual(series)
    expect(r.zone).toBe('Europe/Dublin')
    expect(r.dates.map((e) => e.id)).toEqual(['a', 'b'])
    const q = d.queries.find((x) => x.table === 'race_events')
    expect(q.ops).toEqual(expect.arrayContaining([['eq', 'series_id', S1], ['eq', 'active', true], ['eq', 'status', 'published'], ['gte', 'race_date', '2026-12-01']]))
  })
  it('null for an unknown slug', async () => {
    expect(await loadSeriesPage(fakeDb(() => ({ data: null, error: null })), { slug: 'nope', today: '2026-12-01' })).toBeNull()
  })
})

describe('listHostSeries', () => {
  it('lists the host\'s series with how many published dates are still to come', async () => {
    const d = fakeDb((q) => {
      if (q.table === 'event_series') return { data: [{ id: S1, name: 'Monthly', slug: 'monthly', headline: null, blurb: null }, { id: 'S2', name: 'Camp', slug: 'camp', headline: 'Summer camp', blurb: null }], error: null }
      if (q.table === 'race_events') return { data: [
        { series_id: S1, race_date: '2027-01-02', status: 'published', active: true },
        { series_id: S1, race_date: '2026-01-02', status: 'published', active: true },
        { series_id: S1, race_date: '2027-02-06', status: 'draft', active: true },
        { series_id: 'S2', race_date: '2027-07-01', status: 'published', active: true },
      ], error: null }
      return { data: null, error: null }
    })
    const r = await listHostSeries(d, { hostId: 'h1', today: '2026-12-01' })
    expect(r).toEqual([
      { id: S1, name: 'Monthly', slug: 'monthly', headline: null, blurb: null, upcoming_count: 1 },
      { id: 'S2', name: 'Camp', slug: 'camp', headline: 'Summer camp', blurb: null, upcoming_count: 1 },
    ])
    expect(d.queries.find((q) => q.table === 'event_series').ops).toContainEqual(['eq', 'host_id', 'h1'])
  })
})
