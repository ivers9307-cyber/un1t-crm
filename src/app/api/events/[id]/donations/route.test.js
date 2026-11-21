// CHARITY.10 — GET /api/events/[id]/donations: gates identical to the teams
// routes, totals from computeCharityTotals, stale abandoned checkouts dropped,
// paid_at rendered in the event location's zone, and the CSV hand-over.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  user: null, race: null, donations: [], payments: [], raffle: null, raffleSales: [], accessGuard: null, zone: null, queries: [],
}))

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(async () => mocks.user),
  assertLocationAccessOr404: vi.fn(() => mocks.accessGuard),
}))
vi.mock('@/lib/permissions', () => ({
  hasPermissionAtAnyLocation: vi.fn(() => true),
  hasPermissionForLocation: vi.fn(() => true),
}))
vi.mock('@/lib/location-time', async () => {
  const actual = await vi.importActual('@/lib/location-time')
  return { ...actual, getLocationZone: vi.fn(async () => { if (mocks.zone instanceof Error) throw mocks.zone; return mocks.zone }) }
})
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('@/lib/supabase', () => ({
  createServerClient: () => ({
    from: (table) => {
      const q = { table, filters: [], range: null }
      mocks.queries.push(q)
      const result = () => {
        if (table === 'race_events') return { data: mocks.race, error: mocks.race ? null : { message: 'none' } }
        if (table === 'donations') return { data: mocks.donations, error: null }
        if (table === 'race_payments') return { data: mocks.payments, error: null }
        if (table === 'raffles') return { data: mocks.raffle, error: null }
        if (table === 'raffle_sales') return { data: mocks.raffleSales, error: null }
        throw new Error(`unexpected table ${table}`)
      }
      const chain = {
        select: () => chain,
        eq: (c, v) => { q.filters.push([c, v]); return chain },
        is: (c, v) => { q.filters.push([c, v]); return chain },
        maybeSingle: () => Promise.resolve(result()),
        order: () => chain,
        range: (a, b) => { q.range = [a, b]; return chain },
        single: () => Promise.resolve(result()),
        then: (res, rej) => Promise.resolve(result()).then(res, rej),
      }
      return chain
    },
  }),
}))

import { GET } from './route'

const ctx = { params: Promise.resolve({ id: 'ev-1' }) }
const req = (qs = '') => new Request(`http://x/api/events/ev-1/donations${qs}`)
const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString()

const PAID = {
  id: 'd1', race_event_id: 'ev-1', location_id: 'loc-1', donor_name: 'Ava, "AJ" Byrne', donor_email: 'ava@example.com',
  message: 'Go\nteam', amount_cents: 2500, currency: 'EUR', match_multiplier: 2, status: 'paid',
  paid_at: '2026-07-01T11:30:00.000Z', created_at: '2026-07-01T11:00:00.000Z', refunded_at: null, receipt_email_status: 'sent', contact_id: 'c1',
}

beforeEach(() => {
  mocks.queries.length = 0
  mocks.user = { id: 'u1', role: 'admin', activeLocation: { id: 'loc-1' } }
  mocks.race = { id: 'ev-1', name: 'Charity Day', slug: 'charity-day', location_id: 'loc-1', charity_enabled: true, charity: { name: 'MS Ireland', match_multiplier: 2 }, payment_currency: 'EUR' }
  mocks.accessGuard = null
  mocks.zone = 'Europe/Dublin'
  mocks.payments = []
  mocks.raffle = null
  mocks.raffleSales = []
  mocks.donations = [
    PAID,
    { ...PAID, id: 'd2', status: 'awaiting_payment', paid_at: null, created_at: hoursAgo(5), match_multiplier: null },
    { ...PAID, id: 'd3', status: 'awaiting_payment', paid_at: null, created_at: hoursAgo(0.5), match_multiplier: null },
    { ...PAID, id: 'd4', status: 'refunded', amount_cents: 1000, refunded_at: '2026-07-02T09:00:00.000Z' },
  ]
})

describe('GET /api/events/[id]/donations', () => {
  it('401s an anonymous caller', async () => {
    mocks.user = null
    const res = await GET(req(), ctx)
    expect(res.status).toBe(401)
  })

  it('404s an event at a studio the caller cannot see', async () => {
    const { NextResponse } = await import('next/server')
    mocks.accessGuard = NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
    const res = await GET(req(), ctx)
    expect(res.status).toBe(404)
  })

  it('404s an unknown event', async () => {
    mocks.race = null
    const res = await GET(req(), ctx)
    expect(res.status).toBe(404)
  })

  it('returns rows, totals and settings; keeps every awaiting_payment row, however old (staff reconcile them)', async () => {
    const res = await GET(req(), ctx)
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data.donations.map((d) => d.id)).toEqual(['d1', 'd2', 'd3', 'd4'])
    expect(data.donations[1].status).toBe('awaiting_payment')
    // The page offers a Re-check on a paid row with no linked contact.
    expect(data.donations[0].contact_id).toBe('c1')
    expect(data.totals).toEqual({
      donations_cents: 2500, donations_matched_cents: 5000, entries_cents: 0, entries_matched_cents: 0,
      raffle_cents: 0, raffle_ticket_count: 0, raffle_sale_count: 0, raised_cents: 5000, donation_count: 1,
    })
    expect(data.settings.has_raffle).toBe(false)
    expect(data.currency).toBe('EUR')
    expect(data.settings.name).toBe('MS Ireland')
    expect(data.settings.match_multiplier).toBe(2)
    const paid = data.donations[0]
    expect(paid.matched_cents).toBe(5000)
    expect(data.donations[1].matched_cents).toBe(0)
    expect(data.donations[2].matched_cents).toBe(0)
    expect(data.donations[3].matched_cents).toBe(0)
  })

  it('renders paid_at in the event location zone, beside the raw instant', async () => {
    mocks.zone = 'Pacific/Auckland'
    const res = await GET(req(), ctx)
    const { data } = await res.json()
    expect(data.donations[0].paid_at).toBe('2026-07-01T11:30:00.000Z')
    // 11:30Z is 23:30 the same day in Auckland (NZST, UTC+12).
    expect(data.donations[0].paid_at_label).toMatch(/23:30/)
    expect(data.donations[1].paid_at_label).toBeNull()
  })

  it('falls back to the default zone when the zone read fails', async () => {
    mocks.zone = new Error('db down')
    const res = await GET(req(), ctx)
    expect(res.status).toBe(200)
    const { data } = await res.json()
    // 11:30Z in July is 12:30 in Dublin (IST).
    expect(data.donations[0].paid_at_label).toMatch(/12:30/)
  })

  it('reads only this event at this location, and entries only when included', async () => {
    mocks.race = { ...mocks.race, charity: { match_multiplier: 2, include_entries: false } }
    await GET(req(), ctx)
    const q = mocks.queries.find((x) => x.table === 'donations')
    expect(q.filters).toEqual([['race_event_id', 'ev-1'], ['location_id', 'loc-1']])
    expect(q.range).toEqual([0, 999])
    expect(mocks.queries.some((x) => x.table === 'race_payments')).toBe(false)

    mocks.queries.length = 0
    mocks.race = { ...mocks.race, charity: { match_multiplier: 2, include_entries: true } }
    mocks.payments = [{ amount_cents: 4000, status: 'completed' }]
    const res = await GET(req(), ctx)
    const { data } = await res.json()
    expect(data.totals.entries_cents).toBe(4000)
    expect(data.totals.entries_matched_cents).toBe(8000)
    expect(data.totals.raised_cents).toBe(13000)
    expect(mocks.queries.find((x) => x.table === 'race_payments').filters).toEqual([['race_event_id', 'ev-1'], ['status', 'completed']])
  })

  // RAFFLEDONATIONS.1 — raffle money counts toward Raised at face value.
  it('adds the event raffle sales to Raised, unmatched, read at this location without voided sales', async () => {
    mocks.raffle = { id: 'raf-1' }
    mocks.raffleSales = [{ id: 's1', quantity: 20, total_cents: 1000, voided_at: null }, { id: 's2', quantity: 1, total_cents: 100, voided_at: null }]
    const res = await GET(req(), ctx)
    const { data } = await res.json()
    expect(data.totals.raffle_cents).toBe(1100)
    expect(data.totals.raffle_ticket_count).toBe(21)
    expect(data.totals.raised_cents).toBe(5000 + 1100)
    expect(data.settings.has_raffle).toBe(true)
    expect(mocks.queries.find((x) => x.table === 'raffles').filters).toEqual([['race_event_id', 'ev-1'], ['location_id', 'loc-1']])
    const s = mocks.queries.find((x) => x.table === 'raffle_sales')
    expect(s.filters).toEqual([['raffle_id', 'raf-1'], ['location_id', 'loc-1'], ['voided_at', null]])
    expect(s.range).toEqual([0, 999])
  })

  it('?format=csv returns a text/csv attachment with euro amounts and escaped cells', async () => {
    const res = await GET(req('?format=csv'), ctx)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toMatch(/^text\/csv/)
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="charity-day-donations.csv"')
    const text = (await res.text()).replace(/^﻿/, '')
    const lines = text.split('\r\n')
    expect(lines[0]).toBe('paid_at,name,email,amount,matched,status,message,type')
    expect(lines[1]).toBe('"1 Jul 2026, 12:30","Ava, ""AJ"" Byrne",ava@example.com,25.00,50.00,paid,"Go\nteam",donation')
    expect(text).not.toContain('2500')
  })

  // RAFFLEDONATIONS.2 — the same unvoided raffle sales are listed (and exported), labelled raffle.
  const SALE = {
    id: 's1', quantity: 20, total_cents: 1000, voided_at: null, created_at: '2026-07-01T07:24:00.000Z',
    buyer_name: 'Sam Till', buyer_email: 'sam@example.com', first_ticket: 3, last_ticket: 22,
    payment_method: 'card', channel: 'till', option_label: '20 for €10', email_status: 'sent',
  }

  it('lists the raffle sales newest first, in the event zone, beside the donations', async () => {
    mocks.raffle = { id: 'raf-1' }
    mocks.raffleSales = [
      SALE,
      { ...SALE, id: 's2', quantity: 1, total_cents: 100, created_at: '2026-07-01T07:48:00.000Z', first_ticket: 23, last_ticket: 23, channel: 'online', option_label: null, email_status: null },
    ]
    const res = await GET(req(), ctx)
    const { data } = await res.json()
    expect(data.donations.map((d) => d.id)).toEqual(['d1', 'd2', 'd3', 'd4'])
    expect(data.raffle_sales.map((r) => r.id)).toEqual(['s2', 's1'])
    expect(data.raffle_sales[1]).toEqual({
      id: 's1', sold_at: '2026-07-01T07:24:00.000Z', sold_at_label: expect.stringMatching(/08:24/),
      buyer_name: 'Sam Till', buyer_email: 'sam@example.com', quantity: 20, total_cents: 1000,
      tickets_label: '#003–#022', payment_method: 'card', channel: 'till', option_label: '20 for €10', email_status: 'sent',
    })
    expect(data.raffle_sales[0].tickets_label).toBe('#023')
    // Listed and counted from the same rows: no voided sale, nothing counted twice.
    expect(data.totals.raffle_cents).toBe(1100)
    expect(data.totals.raised_cents).toBe(5000 + 1100)
  })

  it('returns an empty raffle list when the event has no raffle', async () => {
    const res = await GET(req(), ctx)
    const { data } = await res.json()
    expect(data.raffle_sales).toEqual([])
    expect(mocks.queries.some((x) => x.table === 'raffle_sales')).toBe(false)
  })

  it('?format=csv adds one raffle line per sale after the donations, never matched', async () => {
    mocks.raffle = { id: 'raf-1' }
    mocks.raffleSales = [SALE]
    const res = await GET(req('?format=csv'), ctx)
    const lines = (await res.text()).replace(/^﻿/, '').split('\r\n').filter(Boolean)
    expect(lines).toHaveLength(1 + 4 + 1)
    expect(lines[5]).toBe('"1 Jul 2026, 08:24",Sam Till,sam@example.com,10.00,,paid,20 tickets #003–#022 · card,raffle')
  })
})
