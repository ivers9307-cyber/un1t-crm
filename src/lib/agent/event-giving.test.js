import { describe, it, expect, vi } from 'vitest'
import { createFakeDb } from '../../../tests/helpers/fake-db'

vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))

import { GIVING_WINDOW_DAYS, givingEntry, readStillGiving } from './event-giving'

const ORG = '00000000-0000-4000-8000-0000000000a1'
const OTHER_ORG = '00000000-0000-4000-8000-0000000000a2'
const STILL = '00000000-0000-4000-8000-0000000000b1'
const HATCH = '00000000-0000-4000-8000-0000000000b2'
const ELSEWHERE = '00000000-0000-4000-8000-0000000000b3'
const NOW = Date.parse('2026-11-23T13:00:00Z')
const BASE = 'https://stillorgan.test'

const loc = (id, name, extra = {}) => ({ id, name, organization_id: ORG, timezone: 'Europe/Dublin', active: true, ...extra })
const event = (id, extra = {}) => ({
  id, name: 'MS Ireland X UN1T Dublin Charity Day', slug: 'stillorgan-nov21-0900', race_date: '2026-11-21',
  location_id: STILL, host_id: null, active: true, status: 'published', charity_enabled: true, charity: { name: 'MS Ireland', signup_off: true },
  registration_closes_at: null, ...extra,
})
const raffle = (eventId, extra = {}) => ({
  id: `raffle-${eventId}`, race_event_id: eventId, location_id: STILL, name: 'Raffle', ticket_price_cents: 100, currency: 'EUR',
  sales_open: true, online_enabled: true, online_closes_at: '2026-11-23T15:00:00Z', next_ticket_number: 1486, ticket_options: [], ...extra,
})
const entry = (over = {}) => givingEntry({ event: event('e1'), raffle: raffle('e1'), location: loc(STILL, 'UN1T Stillorgan'), threadLocationId: STILL, baseUrl: BASE, nowMs: NOW, ...over })

describe('givingEntry', () => {
  it('a past charity event with an open raffle: exactly the agreed fields, nothing internal', () => {
    const e = entry()
    expect(e).toEqual({
      name: 'MS Ireland X UN1T Dublin Charity Day', studio: 'UN1T Stillorgan', this_conversation: true, date: 'Sat 21 Nov',
      charity: 'MS Ireland', raffle_open: true, raffle_closes_label: 'Mon 23 Nov, 15:00', donations_open: true,
      url: 'https://stillorgan.test/event/stillorgan-nov21-0900',
    })
    expect(JSON.stringify(e)).not.toMatch(/e1|raffle-|1486/)
  })

  it('the window is 30 days', () => expect(GIVING_WINDOW_DAYS).toBe(30))

  it('raffle open, charity on, 40 days old: listed for the raffle only', () => {
    const e = entry({ event: event('e1', { race_date: '2026-10-14' }) })
    expect(e).toMatchObject({ raffle_open: true, donations_open: false, charity: 'MS Ireland' })
  })

  it('charity off: the public page shows no raffle card, so an open raffle does not list the event', () => {
    expect(entry({ event: event('e1', { charity_enabled: false, charity: null }) })).toBeNull()
  })

  it('donations: listed at exactly 30 days, not at 31', () => {
    expect(entry({ event: event('e1', { race_date: '2026-10-24' }), raffle: null })).toMatchObject({ donations_open: true, raffle_open: false, raffle_closes_label: null })
    expect(entry({ event: event('e1', { race_date: '2026-10-23' }), raffle: null })).toBeNull()
  })

  it('an event dated today is listed (the day most people ask); a future one is not', () => {
    expect(entry({ event: event('e1', { race_date: '2026-11-23' }) })).toMatchObject({ date: 'Mon 23 Nov', donations_open: true })
    expect(entry({ event: event('e1', { race_date: '2026-11-24' }) })).toBeNull()
  })

  it('a past event whose page would still take a paid entry is never linked', () => {
    const open = { charity: { name: 'MS Ireland' }, registration_closes_at: null }
    expect(entry({ event: event('e1', open) })).toBeNull()
    expect(entry({ event: event('e1', { ...open, registration_closes_at: '2026-11-30T00:00:00Z' }) })).toBeNull()
    expect(entry({ event: event('e1', { ...open, registration_closes_at: '2026-11-21T09:49:00Z' }) })).not.toBeNull()
    // On the day itself an open sign-up is the event's own business.
    expect(entry({ event: event('e1', { ...open, race_date: '2026-11-23' }) })).not.toBeNull()
  })

  it("a raffle filed under another studio than its event is not the page's raffle", () => {
    expect(entry({ raffle: raffle('e1', { location_id: HATCH }) })).toMatchObject({ raffle_open: false, donations_open: true })
  })

  it('a raffle that has closed, is off, or is not online does not qualify the event', () => {
    const off = event('e1', { race_date: '2026-10-01' })
    expect(entry({ event: off, raffle: raffle('e1', { online_closes_at: '2026-11-23T12:00:00Z' }) })).toBeNull()
    expect(entry({ event: off, raffle: raffle('e1', { sales_open: false }) })).toBeNull()
    expect(entry({ event: off, raffle: raffle('e1', { online_enabled: false }) })).toBeNull()
    expect(entry({ event: off, raffle: null })).toBeNull()
  })

  it('a raffle with no closing time is open with no label', () => {
    expect(entry({ raffle: raffle('e1', { online_closes_at: null }) })).toMatchObject({ raffle_open: true, raffle_closes_label: null })
  })

  it('a host event, an inactive event and an unpublished event never appear', () => {
    expect(entry({ event: event('e1', { host_id: 'host-1' }) })).toBeNull()
    expect(entry({ event: event('e1', { active: false }) })).toBeNull()
    expect(entry({ event: event('e1', { status: 'draft' }) })).toBeNull()
  })

  it('another studio is named and flagged', () => {
    expect(entry({ threadLocationId: HATCH })).toMatchObject({ studio: 'UN1T Stillorgan', this_conversation: false })
  })
})

describe('readStillGiving', () => {
  const seed = ({ events = [], raffles = [], errors = {} } = {}) => createFakeDb({
    tables: {
      locations: [loc(STILL, 'UN1T Stillorgan'), loc(HATCH, 'UN1T Hatch Street'), loc(ELSEWHERE, 'Someone Else', { organization_id: OTHER_ORG })],
      race_events: events,
      raffles,
    },
    errors,
  })
  const baseUrlFor = async (_db, id) => `https://${id.slice(-2)}.test`
  const read = (db, threadLocationId = HATCH) => readStillGiving(db, { threadLocationId, nowMs: NOW, baseUrlFor })

  it('reads across the organisation, never another organisation, and links to the event studio host', async () => {
    const db = seed({
      events: [event('e1'), event('e2', { location_id: ELSEWHERE, slug: 'other', name: 'Not ours' })],
      raffles: [raffle('e1')],
    })
    const res = await read(db)
    expect(res.unreadable).toBe(false)
    expect(res.entries.map((e) => e.name)).toEqual(['MS Ireland X UN1T Dublin Charity Day'])
    expect(res.entries[0]).toMatchObject({ this_conversation: false, studio: 'UN1T Stillorgan', url: 'https://b1.test/event/stillorgan-nov21-0900' })
  })

  it("the conversation's studio comes first, then the most recent", async () => {
    const db = seed({
      events: [
        event('e1', { name: 'Stillorgan recent', race_date: '2026-11-21' }),
        event('e2', { name: 'Hatch older', race_date: '2026-11-01', location_id: HATCH, slug: 'h-old' }),
        event('e3', { name: 'Stillorgan older', race_date: '2026-11-10', slug: 's-old' }),
      ],
    })
    expect((await read(db)).entries.map((e) => e.name)).toEqual(['Hatch older', 'Stillorgan recent', 'Stillorgan older'])
  })

  it('an event the caller already lists as upcoming is left out', async () => {
    const db = seed({ events: [event('e1', { race_date: '2026-11-23' })] })
    expect((await readStillGiving(db, { threadLocationId: STILL, nowMs: NOW, baseUrlFor })).entries).toHaveLength(1)
    expect((await readStillGiving(db, { threadLocationId: STILL, nowMs: NOW, baseUrlFor, excludeEventIds: ['e1'] })).entries).toEqual([])
  })

  it('a host anchor studio is never named to a customer', async () => {
    const db = createFakeDb({
      tables: { locations: [loc(HATCH, 'UN1T Hatch Street'), loc(STILL, 'Host (host events)', { is_host_anchor: true })], race_events: [event('e1')], raffles: [] },
    })
    expect((await read(db)).entries).toEqual([])
  })

  it('nothing giving is an empty, readable answer', async () => {
    expect(await read(seed({ events: [event('e1', { charity_enabled: false })] }))).toEqual({ entries: [], unreadable: false })
  })

  it('a failed events read is unknown, never empty', async () => {
    const db = seed({ events: [event('e1')], errors: { race_events: { select: { message: 'boom' } } } })
    expect(await read(db)).toEqual({ entries: [], unreadable: true })
  })

  it('a failed studio read is unknown', async () => {
    const db = seed({ events: [event('e1')], errors: { locations: { select: { message: 'boom' } } } })
    expect(await read(db)).toEqual({ entries: [], unreadable: true })
  })

  it('a failed raffle read keeps what donations qualify and says the rest is unknown', async () => {
    const db = seed({
      events: [event('e1'), event('e2', { name: 'Raffle only', race_date: '2026-10-01', slug: 'r-only' })],
      raffles: [raffle('e1'), raffle('e2')],
      errors: { raffles: { select: { message: 'boom' } } },
    })
    const res = await read(db)
    expect(res.unreadable).toBe(true)
    expect(res.entries).toHaveLength(1)
    expect(res.entries[0]).toMatchObject({ donations_open: true, raffle_open: false })
  })

  it('never throws, and without a studio answers unknown', async () => {
    expect(await readStillGiving(null, { threadLocationId: STILL })).toEqual({ entries: [], unreadable: true })
    expect(await readStillGiving(seed(), {})).toEqual({ entries: [], unreadable: true })
  })
})
