// EVT-IDOR.1 — /bookings/event-types/[id] page guard (found by the
// PAGE-SCOPE.1 first scan, sibling of TPL-IDOR.1 / PR #1307).
//
// The page fetched event_types by bare id on the service-role client with
// NO user check inside the page at all (auth was only the proxy login
// gate) and then listed every booking for the event — contact names and
// emails included — so any logged-in staffer at any location could read
// another location's booking type and its attendee PII.
//
// Required behaviour: getCurrentUser → login redirect; a missing OR
// foreign-location event renders the same "not found" panel (collapsed,
// so foreign ids aren't enumerable) and the bookings query never runs;
// an assigned-location event renders the full detail.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  assertLocationAccess: (user, locationId) => {
    if (!user) {
      return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), { status: 401 })
    }
    if (!locationId) return null
    const allowed = (user.locations || []).some((l) => l.id === locationId)
    if (!allowed) {
      return new Response(JSON.stringify({ success: false, error: 'Forbidden' }), { status: 403 })
    }
    return null
  },
}))

vi.mock('@/lib/supabase', () => ({
  createServerClient: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  redirect: vi.fn((url) => {
    const err = new Error(`NEXT_REDIRECT:${url}`)
    err.digest = `NEXT_REDIRECT;${url}`
    throw err
  }),
  notFound: vi.fn(() => {
    const err = new Error('NEXT_NOT_FOUND')
    err.digest = 'NEXT_NOT_FOUND'
    throw err
  }),
}))

// Client components — stubs; the test asserts on the server-rendered shell.
// ROLEUI.1 — the stub prints the canDelete it was handed, so the page's
// decision is visible in the markup.
vi.mock('@/components/EventActions', () => ({
  default: ({ canDelete }) => <span data-testid="event-actions" data-can-delete={String(canDelete)} />,
}))
// C134 — the stub prints the canEdit it was handed.
vi.mock('@/components/BookingStatusToggle', () => ({
  default: ({ canEdit }) => <span data-testid="status-toggle" data-can-edit={String(canEdit)} />,
}))
vi.mock('next/link', () => ({
  default: ({ href, children }) => <a href={typeof href === 'string' ? href : ''}>{children}</a>,
}))

import BookingTypeDetailPage from './page.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

// event_types: .select().eq().single(); bookings: a paged read
// (.select().eq().order()….range(from, to)), recorded so a test can read the
// columns and the pages asked for. `bookingsError` fails every page.
function mockDb({ event = null, bookings = [], bookingsError = null } = {}) {
  const bookingsFrom = vi.fn(() => {
    const q = { orders: [] }
    bookingsFrom.queries.push(q)
    const chain = {
      select: vi.fn((cols) => { q.select = cols; return chain }),
      eq: vi.fn((c, v) => { q.eq = [c, v]; return chain }),
      order: vi.fn((c) => { q.orders.push(c); return chain }),
      range: vi.fn((lo, hi) => { q.range = [lo, hi]; return chain }),
      then: (res, rej) => Promise.resolve(bookingsError
        ? { data: null, error: bookingsError }
        : { data: q.range ? bookings.slice(q.range[0], q.range[1] + 1) : bookings, error: null }).then(res, rej),
    }
    return chain
  })
  bookingsFrom.queries = []
  const db = {
    from: vi.fn((table) => {
      if (table === 'event_types') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              single: vi.fn(async () => ({
                data: event,
                error: event ? null : { message: 'not found' },
              })),
            })),
          })),
        }
      }
      return bookingsFrom(table)
    }),
    bookingsQueries: bookingsFrom.queries,
  }
  return db
}

const user = {
  id: 'user-1',
  locations: [{ id: 'loc-mine' }],
  activeLocation: { id: 'loc-mine' },
}

const myEvent = {
  id: 'evt-1', location_id: 'loc-mine', name: 'PT Consult', color: '#fff',
  slug: 'pt-consult', active: true, duration_minutes: 45, buffer_minutes: 15,
}

function props(id = 'evt-1') {
  return { params: Promise.resolve({ id }) }
}

beforeEach(() => vi.clearAllMocks())

describe('/bookings/event-types/[id] page', () => {
  it('redirects to /login without a session', async () => {
    getCurrentUser.mockResolvedValue(null)
    createServerClient.mockReturnValue(mockDb({}))
    await expect(BookingTypeDetailPage(props())).rejects.toThrow(/^NEXT_REDIRECT:\/login$/)
  })

  it('renders the not-found panel for a foreign-location event and never fetches its bookings (IDOR)', async () => {
    getCurrentUser.mockResolvedValue(user)
    const db = mockDb({
      event: { ...myEvent, location_id: 'loc-foreign', name: 'Foreign Secret Session' },
      bookings: [{ id: 'b1', customer_email: 'someone@example.com' }],
    })
    createServerClient.mockReturnValue(db)
    const html = renderToStaticMarkup(await BookingTypeDetailPage(props()))
    expect(html).toContain('Booking type not found')
    expect(html).not.toContain('Foreign Secret Session')
    expect(html).not.toContain('someone@example.com')
    expect(db.from).not.toHaveBeenCalledWith('bookings')
  })

  it('renders the same not-found panel for a missing event', async () => {
    getCurrentUser.mockResolvedValue(user)
    createServerClient.mockReturnValue(mockDb({ event: null }))
    const html = renderToStaticMarkup(await BookingTypeDetailPage(props()))
    expect(html).toContain('Booking type not found')
  })

  it('renders the detail for an event at an assigned location', async () => {
    getCurrentUser.mockResolvedValue(user)
    createServerClient.mockReturnValue(mockDb({ event: myEvent, bookings: [] }))
    const html = renderToStaticMarkup(await BookingTypeDetailPage(props()))
    expect(html).toContain('PT Consult')
    expect(html).not.toContain('Booking type not found')
  })

  // ROLEUI.1 — Edit and Delete show exactly when /api/bookings/event-types/[id]
  // would act (a master, or MANAGER_ROLES at the booking type's location).
  // The page used to render both for anyone who could open it.
  describe('ROLEUI.1 — Edit and Delete follow the route', () => {
    const at = (role) => ({ ...user, rolesByLocation: { 'loc-mine': role } })

    it('a manager at the booking type\'s studio gets Edit and Delete', async () => {
      getCurrentUser.mockResolvedValue(at('manager'))
      createServerClient.mockReturnValue(mockDb({ event: myEvent, bookings: [] }))
      const html = renderToStaticMarkup(await BookingTypeDetailPage(props()))
      expect(html).toContain('data-can-delete="true"')
      expect(html).toContain('href="/bookings/event-types/evt-1/edit"')
    })

    it('staff there get neither (main: both, and Delete answered "Not found")', async () => {
      getCurrentUser.mockResolvedValue(at('staff'))
      createServerClient.mockReturnValue(mockDb({ event: myEvent, bookings: [] }))
      const html = renderToStaticMarkup(await BookingTypeDetailPage(props()))
      expect(html).toContain('data-can-delete="false"')
      expect(html).not.toContain('href="/bookings/event-types/evt-1/edit"')
    })

    it('a master gets both', async () => {
      getCurrentUser.mockResolvedValue({ ...user, isMaster: true, profileRole: 'master', role: 'master' })
      createServerClient.mockReturnValue(mockDb({ event: myEvent, bookings: [] }))
      const html = renderToStaticMarkup(await BookingTypeDetailPage(props()))
      expect(html).toContain('data-can-delete="true"')
      expect(html).toContain('href="/bookings/event-types/evt-1/edit"')
    })
  })

  // C134 WEBBOOKINGWRITES.1 — the status pill writes through
  // POST /api/bookings/[id]/status, which asks the WEB `bookings` key at the
  // booking's studio; this page opens on membership, so it passes canEdit.
  describe('C134 — the status pill is editable only with web bookings at the studio', () => {
    const booking = { id: 'b1', status: 'confirmed', booking_date: '2999-01-01', start_time: '09:00', end_time: '10:00', customer_name: 'A Customer' }
    const at = (permissions) => ({
      ...user,
      locations: [{ id: 'loc-mine', role: 'staff' }],
      rolesByLocation: { 'loc-mine': 'staff' },
      assignmentsByLocation: { 'loc-mine': { role: 'staff', permissions } },
    })
    it('with it: editable', async () => {
      getCurrentUser.mockResolvedValue(at({ bookings: true }))
      createServerClient.mockReturnValue(mockDb({ event: myEvent, bookings: [booking] }))
      const html = renderToStaticMarkup(await BookingTypeDetailPage(props()))
      expect(html).toContain('data-can-edit="true"')
    })
    it('switched off for them there: read-only', async () => {
      getCurrentUser.mockResolvedValue(at({ bookings: false }))
      createServerClient.mockReturnValue(mockDb({ event: myEvent, bookings: [booking] }))
      const html = renderToStaticMarkup(await BookingTypeDetailPage(props()))
      expect(html).toContain('data-can-edit="false"')
    })
  })

  // BOOKINGOUTCOME.1 — the outcomes summary for this booking type.
  describe('BOOKINGOUTCOME.1 — outcomes summary', () => {
    const b = (id, status, booking_date, contacts = null) => ({
      id, status, booking_date, start_time: '09:00:00', end_time: '10:00:00', customer_name: `C ${id}`, customer_email: `${id}@example.com`, contacts,
    })
    const rows = [
      b('1', 'completed', '2026-01-05', { id: 'c1', name: 'One', pipeline_stage_slug: 'member' }),
      b('2', 'completed', '2026-01-06', { id: 'c2', name: 'Two', pipeline_stage_slug: 'trial' }),
      b('3', 'no_show', '2026-01-07', { id: 'c3', name: 'Three', pipeline_stage_slug: 'pack_member' }),
      b('4', 'cancelled', '2026-01-08'),
      b('5', 'confirmed', '2026-01-09', { id: 'c1', name: 'One', pipeline_stage_slug: 'member' }),
      b('6', 'confirmed', '2999-01-01'),
    ]
    const cell = (html, label) => {
      const m = html.match(new RegExp(`data-outcome="${label}"[^>]*>[\\s\\S]*?<p class="text-xl[^"]*">([^<]+)</p>`))
      return m && m[1]
    }

    it('counts total, showed, no-show, cancelled, awaiting and now members (once per contact)', async () => {
      getCurrentUser.mockResolvedValue(user)
      createServerClient.mockReturnValue(mockDb({ event: myEvent, bookings: rows }))
      const html = renderToStaticMarkup(await BookingTypeDetailPage(props()))
      expect(cell(html, 'total')).toBe('6')
      expect(cell(html, 'showed')).toBe('2')
      expect(cell(html, 'no_show')).toBe('1')
      expect(cell(html, 'cancelled')).toBe('1')
      expect(cell(html, 'awaiting')).toBe('1')
      expect(cell(html, 'members')).toBe('2')
      expect(html).toContain('67% showed')
      expect(html).toContain('href="/bookings?filter=needs_outcome"')
    })

    it('names its columns (the member stage included) and pages past 1,000 bookings', async () => {
      getCurrentUser.mockResolvedValue(user)
      const many = Array.from({ length: 1200 }, (_, i) => b(`m${i}`, 'completed', '2026-01-05'))
      const db = mockDb({ event: myEvent, bookings: many })
      createServerClient.mockReturnValue(db)
      const html = renderToStaticMarkup(await BookingTypeDetailPage(props()))
      // (the studio zone read shares this mock; keep only the bookings pages)
      const pages = db.bookingsQueries.filter((x) => x.range)
      const q = pages[0]
      expect(q.select).not.toContain('*')
      expect(q.select).toContain('pipeline_stage_slug')
      expect(q.eq).toEqual(['event_type_id', 'evt-1'])
      expect(q.orders).toContain('id')
      expect(pages.map((x) => x.range)).toEqual([[0, 999], [1000, 1999]])
      expect(cell(html, 'total')).toBe('1200')
    })

    it('a failed read says so instead of showing zeros', async () => {
      getCurrentUser.mockResolvedValue(user)
      createServerClient.mockReturnValue(mockDb({ event: myEvent, bookingsError: { message: 'timeout' } }))
      const html = renderToStaticMarkup(await BookingTypeDetailPage(props()))
      expect(html).toContain('Could not load the bookings for this booking type')
      expect(cell(html, 'total')).toBeNull()
    })
  })
})
