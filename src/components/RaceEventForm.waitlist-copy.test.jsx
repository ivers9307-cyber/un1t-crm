// @vitest-environment jsdom
//
// EVENT-WAITLIST.1 — the event form edits the waitlist offer email's copy
// (race_events.waitlist_email_subject/intro): loads it, sends it, and a blank
// field saves as null (the default).
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import RaceEventForm from './RaceEventForm.jsx'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), back: vi.fn(), refresh: vi.fn() }) }))

const EVENT = {
  id: 'ev-1', kind: 'open_day', name: 'Opening Day', slug: 'opening-day', race_date: '2026-10-03',
  allowed_team_sizes: [1], capacity_mode: 'people', active: true,
  waves: [{ id: 'w9', start_time: '09:00:00', capacity: 28, label: null }],
  waitlist_email_subject: 'Room at {{event_name}}', waitlist_email_intro: null,
}

function stubFetch() {
  const calls = []
  vi.stubGlobal('fetch', vi.fn((url, opts) => {
    calls.push({ url: String(url), opts })
    if (opts?.method === 'PUT' || opts?.method === 'POST') return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true }) })
    return new Promise(() => {})
  }))
  return calls
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('RaceEventForm — waitlist offer copy', () => {
  it('shows the section with the {{claim_url}} tag, loads the saved subject, and saves both fields', async () => {
    const calls = stubFetch()
    const { container } = render(<RaceEventForm race={EVENT} locationId="loc-1" />)
    expect(screen.getByText('Waitlist offer')).toBeTruthy()
    const subject = screen.getByPlaceholderText('A spot opened up for {{event_name}}')
    expect(subject.value).toBe('Room at {{event_name}}')
    expect(container.textContent).toContain('{{claim_url}}')
    fireEvent.change(screen.getByPlaceholderText(/It goes to the first person to book/), { target: { value: 'Grab it: {{claim_url}}' } })
    fireEvent.submit(container.querySelector('form'))
    await waitFor(() => expect(calls.some((c) => c.opts?.method === 'PUT')).toBe(true))
    const body = JSON.parse(calls.find((c) => c.opts?.method === 'PUT').opts.body)
    expect(body.waitlist_email_subject).toBe('Room at {{event_name}}')
    expect(body.waitlist_email_intro).toBe('Grab it: {{claim_url}}')
  })

  it('a blank field saves as null (the default copy)', async () => {
    const calls = stubFetch()
    const { container } = render(<RaceEventForm race={{ ...EVENT, waitlist_email_subject: null }} locationId="loc-1" />)
    fireEvent.submit(container.querySelector('form'))
    await waitFor(() => expect(calls.some((c) => c.opts?.method === 'PUT')).toBe(true))
    const body = JSON.parse(calls.find((c) => c.opts?.method === 'PUT').opts.body)
    expect(body.waitlist_email_subject).toBeNull()
    expect(body.waitlist_email_intro).toBeNull()
  })
})
