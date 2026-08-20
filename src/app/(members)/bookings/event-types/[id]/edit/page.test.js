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

vi.mock('@/components/EventForm', () => ({ default: () => null }))
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

const user = {
  id: 'user-1',
  locations: [{ id: 'loc-mine' }],
  activeLocation: { id: 'loc-mine' },
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
})
