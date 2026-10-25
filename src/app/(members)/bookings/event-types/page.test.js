// EVENTTYPERLS.1 — the "New booking type" / "Create booking type" links show
// only where POST /api/bookings/event-types would create (canCreateEventType:
// a master, or MANAGER_ROLES at the active studio). Everyone keeps the list.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url) => { const err = new Error(`NEXT_REDIRECT:${url}`); err.digest = `NEXT_REDIRECT;${url}`; throw err }),
}))
vi.mock('next/link', () => ({
  default: ({ href, children, className }) => <a href={typeof href === 'string' ? href : ''} className={className}>{children}</a>,
}))
vi.mock('@/components/EventActions', () => ({ default: () => null }))
vi.mock('@/components/CalendlyTabs', () => ({ default: () => null }))

import BookingTypesPage from './page.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

// getEvents: from('event_types').select('*').eq(...).order(...) → no rows, so
// no bookings read and the active tab shows its empty state (the second link).
function emptyDb() {
  const order = vi.fn(async () => ({ data: [], error: null }))
  return { from: vi.fn(() => ({ select: () => ({ eq: () => ({ order }) }) })) }
}
const at = (role) => ({
  id: 'user-1', isMaster: false, profileRole: 'staff',
  locations: [{ id: 'loc-a' }], activeLocation: { id: 'loc-a' }, rolesByLocation: { 'loc-a': role },
})
const newLinks = (out) => out.split('href="/bookings/event-types/new"').length - 1
const render = async () => renderToStaticMarkup(await BookingTypesPage({ searchParams: Promise.resolve({}) }))

beforeEach(() => {
  vi.clearAllMocks()
  createServerClient.mockReturnValue(emptyDb())
})

describe('/bookings/event-types — New buttons', () => {
  it('a manager at the active studio sees both (header + empty state)', async () => {
    getCurrentUser.mockResolvedValue(at('manager'))
    expect(newLinks(await render())).toBe(2)
  })

  it('plain staff see neither, and still see the page', async () => {
    getCurrentUser.mockResolvedValue(at('staff'))
    const out = await render()
    expect(newLinks(out)).toBe(0)
    expect(out).toContain('Booking types')
    expect(out).toContain('No booking types yet')
  })
})
