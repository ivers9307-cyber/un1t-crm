// BOOKINGOUTCOME.1 — /bookings gains a "Needs outcome" tab: bookings at the
// ACTIVE studio still 'confirmed' whose end (booking_date + end_time, a wall
// clock in that studio's zone) has passed, with the count on the tab, one-tap
// Showed / No-show per row and a "Mark all as showed" action.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url) => { throw new Error(`NEXT_REDIRECT:${url}`) }),
}))
vi.mock('next/link', () => ({
  default: ({ href, children, className }) => <a href={href} className={className}>{children}</a>,
}))
vi.mock('@/components/CalendlyTabs', () => ({ default: () => null }))
vi.mock('@/components/BookingStatusToggle', () => ({
  default: ({ bookingId }) => <span data-testid="status-toggle" data-id={bookingId} />,
}))
vi.mock('@/components/BookingSkipReminderToggle', () => ({
  default: ({ bookingId }) => <span data-testid="skip-toggle" data-id={bookingId} />,
}))
vi.mock('@/components/BookingOutcomeButtons', () => ({
  default: ({ bookingId }) => <span data-testid="outcome-buttons" data-id={bookingId} />,
}))
vi.mock('@/components/BookingOutcomeBulk', () => ({
  default: ({ bookingIds }) => <span data-testid="outcome-bulk" data-ids={bookingIds.join(',')} />,
}))

import BookingsPage from './page.js'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { makeFakeDb } from '@/lib/api-auth.test-helpers.js'
import { person, LOC_A, LOC_B } from '../../../../tests/helpers/role-sweep-callers.js'

const NOW = '2026-11-01T12:00:00Z' // 12:00 GMT in Dublin; 07:00 EST in New York
let tables
const bk = (id, fields) => ({
  id, status: 'confirmed', location_id: LOC_A, booking_date: '2026-10-30', start_time: '09:00:00', end_time: '10:00:00',
  customer_name: `Customer ${id}`, customer_email: `${id}@example.com`, event_types: { name: 'Consult', color: '#000' }, contacts: null,
  ...fields,
})
const staffAt = (zone) => {
  const u = person({ [LOC_A]: { role: 'staff', permissions: { bookings: true } } }, LOC_A)
  u.activeLocation = { ...u.activeLocation, timezone: zone }
  return u
}
const render = async (filter) => renderToStaticMarkup(await BookingsPage({ searchParams: Promise.resolve(filter ? { filter } : {}) }))
const ids = (html, testid) => [...html.matchAll(new RegExp(`data-testid="${testid}" data-id="([^"]+)"`, 'g'))].map((m) => m[1])

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(NOW))
  getCurrentUser.mockResolvedValue(staffAt('Europe/Dublin'))
  tables = {
    bookings: [
      bk('ended-1', { booking_date: '2026-10-31' }),
      bk('ended-2'),
      bk('ended-today', { booking_date: '2026-11-01', start_time: '09:00', end_time: '10:00' }), // 10:00 GMT
      bk('later-today', { booking_date: '2026-11-01', start_time: '15:00', end_time: '16:00' }),
      bk('tomorrow', { booking_date: '2026-11-02' }),
      bk('decided', { status: 'completed' }),
      bk('elsewhere', { location_id: LOC_B }),
    ],
  }
  createServerClient.mockReturnValue(makeFakeDb(tables))
})
afterEach(() => vi.useRealTimers())

describe('/bookings: the Needs outcome tab', () => {
  it('is offered on every filter, with its count', async () => {
    const html = await render()
    expect(html).toContain('href="/bookings?filter=needs_outcome"')
    expect(html).toMatch(/Needs outcome<span[^>]*>3<\/span>/)
  })

  it('lists only confirmed bookings at the active studio whose end has passed, each with Showed / No-show', async () => {
    const html = await render('needs_outcome')
    expect(ids(html, 'outcome-buttons').sort()).toEqual(['ended-1', 'ended-2', 'ended-today'])
    expect(html).not.toContain('later-today@example.com')
    expect(html).not.toContain('elsewhere@example.com')
    // The outcome buttons replace the pill and the reminder bell on this tab.
    expect(ids(html, 'status-toggle')).toEqual([])
    expect(ids(html, 'skip-toggle')).toEqual([])
  })

  it('hands the bulk action exactly the listed ids', async () => {
    const html = await render('needs_outcome')
    const listed = ids(html, 'outcome-buttons')
    expect(html).toContain(`data-testid="outcome-bulk" data-ids="${listed.join(',')}"`)
  })

  it("reads the end in the studio's zone: in New York at 07:00 EST, today's 09:00 to 10:00 has not ended", async () => {
    getCurrentUser.mockResolvedValue(staffAt('America/New_York'))
    const html = await render('needs_outcome')
    expect(ids(html, 'outcome-buttons').sort()).toEqual(['ended-1', 'ended-2'])
    expect(await render()).toMatch(/Needs outcome<span[^>]*>2<\/span>/)
  })

  it('nothing to record: a plain empty state and no bulk action', async () => {
    tables.bookings = [bk('decided', { status: 'no_show' })]
    const html = await render('needs_outcome')
    expect(html).toContain('Every past booking has an outcome.')
    expect(html).not.toContain('outcome-bulk')
    expect(html).not.toMatch(/Needs outcome<span/)
  })

  it('a failed read says so, never "nothing to record"', async () => {
    const real = makeFakeDb(tables)
    createServerClient.mockReturnValue({ from: (t) => {
      const b = real.from(t)
      b.range = () => { b.then = (res, rej) => Promise.resolve({ data: null, error: { message: 'timeout' } }).then(res, rej); return b }
      return b
    } })
    const html = await render('needs_outcome')
    expect(html).toContain('Could not load the bookings that need an outcome')
    expect(html).not.toContain('Every past booking has an outcome.')
  })

  it('the other filters keep their pill and bell', async () => {
    const html = await render('upcoming')
    expect(ids(html, 'status-toggle').length).toBeGreaterThan(0)
    expect(ids(html, 'outcome-buttons')).toEqual([])
  })
})
