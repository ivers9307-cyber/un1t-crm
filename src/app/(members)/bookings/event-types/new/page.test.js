// EVENTTYPERLS.1 — /bookings/event-types/new shows the form only to someone
// POST /api/bookings/event-types will let create at the active studio (a
// master, or MANAGER_ROLES there). Before, any signed-in person got the form,
// created through RLS, and then the reminders sync 403'd.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url) => { const err = new Error(`NEXT_REDIRECT:${url}`); err.digest = `NEXT_REDIRECT;${url}`; throw err }),
}))
vi.mock('@/components/EventForm', () => ({
  default: ({ locationId }) => <form data-testid="event-form" data-location={locationId} />,
}))
vi.mock('next/link', () => ({
  default: ({ href, children }) => <a href={typeof href === 'string' ? href : ''}>{children}</a>,
}))

import NewBookingTypePage from './page.js'
import { getCurrentUser } from '@/lib/auth'

const at = (role, active = 'loc-a') => ({
  id: 'user-1', isMaster: false, profileRole: 'staff',
  locations: [{ id: 'loc-a' }, { id: 'loc-b' }],
  activeLocation: { id: active },
  rolesByLocation: { 'loc-a': role, 'loc-b': 'staff' },
})
const html = async () => renderToStaticMarkup(await NewBookingTypePage())

beforeEach(() => vi.clearAllMocks())

describe('/bookings/event-types/new', () => {
  it('a manager at the active studio gets the form, for that studio', async () => {
    getCurrentUser.mockResolvedValue(at('manager'))
    const out = await html()
    expect(out).toContain('data-testid="event-form"')
    expect(out).toContain('data-location="loc-a"')
  })

  it('plain staff get the refusal panel, no form', async () => {
    getCurrentUser.mockResolvedValue(at('staff'))
    const out = await html()
    expect(out).not.toContain('event-form')
    expect(out).toContain('Only a manager at this studio can create booking types.')
    expect(out).toContain('href="/bookings/event-types"')
  })

  it('a manager elsewhere, with the studio where they are staff active, gets the panel', async () => {
    getCurrentUser.mockResolvedValue(at('manager', 'loc-b'))
    expect(await html()).not.toContain('event-form')
  })

  it('signed out → /login', async () => {
    getCurrentUser.mockResolvedValue(null)
    await expect(NewBookingTypePage()).rejects.toThrow(/^NEXT_REDIRECT:\/login$/)
  })
})
