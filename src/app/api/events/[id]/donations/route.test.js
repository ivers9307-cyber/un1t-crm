// CHARITY.10 — GET /api/events/[id]/donations: gates identical to the teams
// routes, totals from computeCharityTotals, stale abandoned checkouts dropped,
// paid_at rendered in the event location's zone, and the CSV hand-over.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  user: null, race: null, donations: [], payments: [], accessGuard: null, zone: null, queries: [],
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
        throw new Error(`unexpected table ${table}`)
      }
      const chain = {
        select: () => chain,
        eq: (c, v) => { q.filters.push([c, v]); return chain },
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
      donations_cents: 2500, donations_matched_cents: 5000, entries_cents: 0, entries_matched_cents: 0, raised_cents: 5000, donation_count: 1,
    })
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

  it('?format=csv returns a text/csv attachment with euro amounts and escaped cells', async () => {
    const res = await GET(req('?format=csv'), ctx)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toMatch(/^text\/csv/)
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="charity-day-donations.csv"')
    const text = (await res.text()).replace(/^﻿/, '')
    const lines = text.split('\r\n')
    expect(lines[0]).toBe('paid_at,name,email,amount,matched,status,message')
    expect(lines[1]).toBe('"1 Jul 2026, 12:30","Ava, ""AJ"" Byrne",ava@example.com,25.00,50.00,paid,"Go\nteam"')
    expect(text).not.toContain('2500')
  })
})
