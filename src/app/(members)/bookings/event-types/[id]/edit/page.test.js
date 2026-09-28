// EVT-IDOR.1 — /bookings/event-types/[id]/edit page guard (found by the
// PAGE-SCOPE.1 first scan, sibling of TPL-IDOR.1 / PR #1307).
//
// The edit page had only a logged-in check before fetching event_types by
// bare id on the service-role client — any staffer at any location could
// open another location's booking type in the edit form. A missing OR
// foreign-location event must render the same "not found" panel
// (collapsed, non-enumerable); an assigned one renders the form.

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

vi.mock('@/components/EventForm', () => ({ default: () => <form data-testid="event-form" /> }))
vi.mock('next/link', () => ({
  default: ({ href, children }) => <a href={typeof href === 'string' ? href : ''}>{children}</a>,
}))

import EditBookingTypePage from './page.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

function mockDb({ event = null } = {}) {
  return {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          single: vi.fn(async () => ({
            data: event,
            error: event ? null : { message: 'not found' },
          })),
        })),
      })),
    })),
  }
}

// ROLEUI.1 — a manager at loc-mine: the form's PUT decides MANAGER_ROLES at
// the booking type's location, and so does the page now.
const user = {
  id: 'user-1',
  locations: [{ id: 'loc-mine' }],
  activeLocation: { id: 'loc-mine' },
  rolesByLocation: { 'loc-mine': 'manager' },
}

function props(id = 'evt-1') {
  return { params: Promise.resolve({ id }) }
}

beforeEach(() => vi.clearAllMocks())

describe('/bookings/event-types/[id]/edit page', () => {
  it('redirects to /login without a session', async () => {
    getCurrentUser.mockResolvedValue(null)
    createServerClient.mockReturnValue(mockDb({}))
    await expect(EditBookingTypePage(props())).rejects.toThrow(/^NEXT_REDIRECT:\/login$/)
  })

  it('renders the not-found panel for a foreign-location event (IDOR)', async () => {
    getCurrentUser.mockResolvedValue(user)
    createServerClient.mockReturnValue(
      mockDb({ event: { id: 'evt-1', location_id: 'loc-foreign', name: 'Foreign Secret Session' } })
    )
    const html = renderToStaticMarkup(await EditBookingTypePage(props()))
    expect(html).toContain('Booking type not found')
    expect(html).not.toContain('Foreign Secret Session')
  })

  it('renders the same not-found panel for a missing event', async () => {
    getCurrentUser.mockResolvedValue(user)
    createServerClient.mockReturnValue(mockDb({ event: null }))
    const html = renderToStaticMarkup(await EditBookingTypePage(props()))
    expect(html).toContain('Booking type not found')
  })

  it('renders the edit form for an event at an assigned location', async () => {
    getCurrentUser.mockResolvedValue(user)
    createServerClient.mockReturnValue(
      mockDb({ event: { id: 'evt-1', location_id: 'loc-mine', name: 'PT Consult' } })
    )
    const html = renderToStaticMarkup(await EditBookingTypePage(props()))
    expect(html).toContain('Edit booking type')
    expect(html).toContain('PT Consult')
  })

  // ROLEUI.1 — the form's PUT /api/bookings/event-types/[id] accepts a master
  // or MANAGER_ROLES at the booking type's location and 404s anyone else; the
  // page used to render the form for anyone at the location, whose Save then
  // answered "Not found". Now they get the page's own not-found panel.
  describe('ROLEUI.1 — only a caller the PUT would accept gets the form', () => {
    const myEvent = { id: 'evt-1', location_id: 'loc-mine', name: 'PT Consult' }

    it('staff at the booking type\'s studio get the not-found panel (main: the form)', async () => {
      getCurrentUser.mockResolvedValue({ ...user, rolesByLocation: { 'loc-mine': 'staff' } })
      createServerClient.mockReturnValue(mockDb({ event: myEvent }))
      const html = renderToStaticMarkup(await EditBookingTypePage(props()))
      expect(html).toContain('Booking type not found')
      expect(html).not.toContain('data-testid="event-form"')
    })

    it('a master gets the form', async () => {
      getCurrentUser.mockResolvedValue({ ...user, isMaster: true, profileRole: 'master', role: 'master', rolesByLocation: {} })
      createServerClient.mockReturnValue(mockDb({ event: myEvent }))
      const html = renderToStaticMarkup(await EditBookingTypePage(props()))
      expect(html).toContain('data-testid="event-form"')
    })
  })
})
