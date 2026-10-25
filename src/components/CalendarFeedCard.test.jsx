// @vitest-environment jsdom
//
// ICSFEED.1 — the /account calendar card. Pins the flows: create shows the
// link once; "Make a new link" asks first and sends replace:true; "Turn off"
// asks first and DELETEs; a 409 is surfaced, not swallowed.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import CalendarFeedCard from './CalendarFeedCard'

const LINKS = {
  url: 'https://crm.example.test/api/calendar-feed/rcf_x.ics',
  webcal_url: 'webcal://crm.example.test/api/calendar-feed/rcf_x.ics',
  google_url: 'https://calendar.google.com/calendar/render?cid=webcal%3A%2F%2Fcrm.example.test%2Fapi%2Fcalendar-feed%2Frcf_x.ics',
  replaced: false,
}
const OFF = { active: false, created_at: null, rotated_at: null, last_fetched_at: null }
const ON = { active: true, created_at: '2026-09-01T09:00:00Z', rotated_at: null, last_fetched_at: '2026-09-25T09:00:00Z' }
const ok = (data) => ({ ok: true, status: 200, json: async () => ({ success: true, data }) })

function mockFetch(handlers) {
  global.fetch = vi.fn(async (url, init = {}) => {
    const method = init.method || 'GET'
    const h = handlers[method]
    if (!h) throw new Error(`unexpected ${method} ${url}`)
    return typeof h === 'function' ? h(url, init) : h
  })
}

beforeEach(() => { vi.clearAllMocks() })
afterEach(() => { cleanup(); delete global.fetch; vi.restoreAllMocks() })

describe('CalendarFeedCard', () => {
  it('with no link: one button, and the link appears once it is made', async () => {
    let state = OFF
    mockFetch({ GET: () => ok(state), POST: () => { state = ON; return ok(LINKS) } })
    render(<CalendarFeedCard />)
    fireEvent.click(await screen.findByRole('button', { name: 'Get my calendar link' }))
    expect(await screen.findByDisplayValue(LINKS.url)).toBeTruthy()
    const post = global.fetch.mock.calls.find(([, i]) => i?.method === 'POST')
    expect(JSON.parse(post[1].body)).toEqual({ replace: false })
    expect(screen.getByRole('link', { name: 'Open in Apple Calendar or Outlook' }).getAttribute('href')).toBe(LINKS.webcal_url)
    expect(screen.getByRole('link', { name: 'Add to Google Calendar' }).getAttribute('href')).toBe(LINKS.google_url)
    expect(screen.getByText(/shown once/i)).toBeTruthy()
  })

  it('with a link: shows it is on, and "Make a new link" does nothing unless confirmed', async () => {
    mockFetch({ GET: () => ok(ON), POST: () => ok({ ...LINKS, replaced: true }) })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<CalendarFeedCard />)
    expect(await screen.findByText(/last checked by your calendar/i)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Make a new link' }))
    expect(confirm).toHaveBeenCalled()
    expect(global.fetch.mock.calls.some(([, i]) => i?.method === 'POST')).toBe(false)

    confirm.mockReturnValue(true)
    fireEvent.click(screen.getByRole('button', { name: 'Make a new link' }))
    await waitFor(() => expect(global.fetch.mock.calls.some(([, i]) => i?.method === 'POST')).toBe(true))
    const post = global.fetch.mock.calls.find(([, i]) => i?.method === 'POST')
    expect(JSON.parse(post[1].body)).toEqual({ replace: true })
  })

  it('"Turn off" asks, then DELETEs', async () => {
    let state = ON
    mockFetch({ GET: () => ok(state), DELETE: () => { state = OFF; return ok({ revoked: true }) } })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<CalendarFeedCard />)
    fireEvent.click(await screen.findByRole('button', { name: 'Turn off' }))
    expect(await screen.findByRole('button', { name: 'Get my calendar link' })).toBeTruthy()
    expect(global.fetch.mock.calls.some(([, i]) => i?.method === 'DELETE')).toBe(true)
  })

  it('a 409 shows the server\'s message', async () => {
    mockFetch({
      GET: () => ok(OFF),
      POST: () => ({ ok: false, status: 409, json: async () => ({ success: false, code: 'feed_exists', error: 'You already have a calendar link. Make a new one to replace it.' }) }),
    })
    render(<CalendarFeedCard />)
    fireEvent.click(await screen.findByRole('button', { name: 'Get my calendar link' }))
    expect((await screen.findByRole('alert')).textContent).toContain('You already have a calendar link')
  })
})
