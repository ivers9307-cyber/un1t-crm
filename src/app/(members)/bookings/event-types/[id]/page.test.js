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

// event_types: .select().eq().single(); bookings: .select().eq().order().order()
function mockDb({ event = null, bookings = [] } = {}) {
  const bookingsFrom = vi.fn(() => {
    const p = Promise.resolve({ data: bookings, error: null })
    const chain = { order: vi.fn(() => chain), then: p.then.bind(p) }
    return { select: vi.fn(() => ({ eq: vi.fn(() => chain) })) }
  })
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
})
