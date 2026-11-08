// @vitest-environment jsdom
// HOSTSERIES.1 — the host form lists sessions: hydrates from initial.sessions,
// "Add a session" adds a row, and the body carries sessions[] only.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'

const push = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh: vi.fn() }) }))

const { default: HostEventForm } = await import('./HostEventForm.jsx')

const W1 = 'f0000000-0000-4000-8000-0000000000f1'
const W2 = 'f0000000-0000-4000-8000-0000000000f2'
const initial = {
  kind: 'workshop', name: 'Mobility', venue_name: 'Studio 1', race_date: '2026-12-05', allowed_team_sizes: [1, 2],
  non_member_fee_cents: 2500,
  sessions: [{ id: W1, start_time: '10:00', label: null, capacity: 20 }, { id: W2, start_time: '14:00', label: 'Afternoon', capacity: 15 }],
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); push.mockClear() })

describe('HostEventForm sessions', () => {
  it('hydrates two sessions, adds a third, and submits sessions[] without the retired keys', async () => {
    // The form also fetches /api/host/series on mount (HOSTSERIES.1): answer
    // it empty and find the save call by its URL.
    const fetchMock = vi.fn(async (url) => (String(url) === '/api/host/series'
      ? { ok: true, status: 200, json: async () => ({ success: true, data: [] }) }
      : { ok: true, status: 200, json: async () => ({ success: true, data: { id: 'E1' } }) }))
    vi.stubGlobal('fetch', fetchMock)
    render(<HostEventForm mode="edit" eventId="E1" initial={initial} brandName="UN1T" />)

    expect(screen.getAllByLabelText(/Start time/)).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: /Add a session/ }))
    const times = screen.getAllByLabelText(/Start time/)
    expect(times).toHaveLength(3)
    fireEvent.change(times[2], { target: { value: '18:00' } })
    fireEvent.change(screen.getAllByLabelText(/^Capacity/)[2], { target: { value: '8' } })

    fireEvent.click(screen.getByRole('button', { name: /Save changes|Save event|Create event/ }))
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u) === '/api/host/events/E1')).toBe(true))
    const [url, init] = fetchMock.mock.calls.find(([u]) => String(u) === '/api/host/events/E1')
    expect(url).toBe('/api/host/events/E1')
    const body = JSON.parse(init.body)
    expect(body.sessions).toEqual([
      { id: W1, start_time: '10:00', label: null, capacity: 20 },
      { id: W2, start_time: '14:00', label: 'Afternoon', capacity: 15 },
      { start_time: '18:00', label: null, capacity: 8 },
    ])
    expect(body).not.toHaveProperty('session_start_time')
    expect(body).not.toHaveProperty('session_capacity')
  })

  it('the only session cannot be removed; a second one can', () => {
    render(<HostEventForm mode="create" brandName="UN1T" />)
    expect(screen.getByRole('button', { name: /Remove session 1/ }).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: /Add a session/ }))
    expect(screen.getByRole('button', { name: /Remove session 2/ }).disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: /Remove session 2/ }))
    expect(screen.getAllByLabelText(/Start time/)).toHaveLength(1)
  })

  it('refuses to submit when a session has no start time', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { container } = render(<HostEventForm mode="edit" eventId="E1" initial={{ ...initial, sessions: [{ id: W1, start_time: '', capacity: 20 }] }} brandName="UN1T" />)
    // The browser's own `required` check would stop a click here (jsdom
    // enforces it too); submit the form directly to exercise clientValidate.
    fireEvent.submit(container.querySelector('form'))
    expect(await screen.findByText(/Please set a start time for session 1/)).toBeTruthy()
    expect(fetchMock.mock.calls.some(([u]) => String(u) === '/api/host/events/E1')).toBe(false)
  })
})

// HOSTSERIES.1 — a Series select appears when the host has series; the pick
// travels as series_id.
describe('HostEventForm series select', () => {
  it('lists the host\'s series and sends the chosen id', async () => {
    const fetchMock = vi.fn(async (url) => {
      if (String(url) === '/api/host/series') return { ok: true, status: 200, json: async () => ({ success: true, data: [{ id: 'd0000000-0000-4000-8000-0000000000d1', name: 'Monthly Mobility', slug: 'monthly-mobility', upcoming_count: 2 }] }) }
      return { ok: true, status: 200, json: async () => ({ success: true, data: { id: 'E1' } }) }
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<HostEventForm mode="edit" eventId="E1" initial={initial} brandName="UN1T" />)
    const select = await screen.findByLabelText(/^Series/)
    fireEvent.change(select, { target: { value: 'd0000000-0000-4000-8000-0000000000d1' } })
    fireEvent.click(screen.getByRole('button', { name: /Save changes/ }))
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u) === '/api/host/events/E1')).toBe(true))
    const [, init] = fetchMock.mock.calls.find(([u]) => String(u) === '/api/host/events/E1')
    expect(JSON.parse(init.body).series_id).toBe('d0000000-0000-4000-8000-0000000000d1')
  })
  it('with no series the select is absent and the body carries no series_id', async () => {
    const fetchMock = vi.fn(async (url) => {
      if (String(url) === '/api/host/series') return { ok: true, status: 200, json: async () => ({ success: true, data: [] }) }
      return { ok: true, status: 200, json: async () => ({ success: true, data: { id: 'E1' } }) }
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<HostEventForm mode="edit" eventId="E1" initial={initial} brandName="UN1T" />)
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u) === '/api/host/series')).toBe(true))
    expect(screen.queryByLabelText(/^Series/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Save changes/ }))
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u) === '/api/host/events/E1')).toBe(true))
    const [, init] = fetchMock.mock.calls.find(([u]) => String(u) === '/api/host/events/E1')
    expect(JSON.parse(init.body)).not.toHaveProperty('series_id')
  })
})

// TIERS.1 — the Pricing section carries tiers; the body sends pricing_tiers.
describe('HostEventForm pricing tiers', () => {
  it('hydrates tiers from initial and posts them; an empty list posts null', async () => {
    const tiers = [{ id: 'tier-a', name: 'Early bird', price_cents: 2500, capacity: 20, starts_at: null, ends_at: null, min_people: null }]
    const fetchMock = vi.fn(async (url) => (String(url) === '/api/host/series'
      ? { ok: true, status: 200, json: async () => ({ success: true, data: [] }) }
      : { ok: true, status: 200, json: async () => ({ success: true, data: { id: 'E1' } }) }))
    vi.stubGlobal('fetch', fetchMock)
    render(<HostEventForm mode="edit" eventId="E1" initial={{ ...initial, pricing_tiers: tiers }} brandName="UN1T" />)
    expect(screen.getByLabelText(/Tier 1 name/).value).toBe('Early bird')
    fireEvent.click(screen.getByRole('button', { name: /Save changes/ }))
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u) === '/api/host/events/E1')).toBe(true))
    const [, init] = fetchMock.mock.calls.find(([u]) => String(u) === '/api/host/events/E1')
    expect(JSON.parse(init.body).pricing_tiers).toEqual(tiers)
  })
})

// QUESTIONS.1 — the Questions section; the body carries registration_questions.
describe('HostEventForm registration questions', () => {
  it('hydrates questions and posts them; none posts null', async () => {
    const qs = [{ id: 'q-diet', label: 'Dietary needs', type: 'text', required: false, per: 'person' }]
    const fetchMock = vi.fn(async (url) => (String(url) === '/api/host/series'
      ? { ok: true, status: 200, json: async () => ({ success: true, data: [] }) }
      : { ok: true, status: 200, json: async () => ({ success: true, data: { id: 'E1' } }) }))
    vi.stubGlobal('fetch', fetchMock)
    render(<HostEventForm mode="edit" eventId="E1" initial={{ ...initial, registration_questions: qs }} brandName="UN1T" />)
    expect(screen.getByLabelText(/Question 1 label/).value).toBe('Dietary needs')
    fireEvent.click(screen.getByRole('button', { name: /Save changes/ }))
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u) === '/api/host/events/E1')).toBe(true))
    const [, init] = fetchMock.mock.calls.find(([u]) => String(u) === '/api/host/events/E1')
    expect(JSON.parse(init.body).registration_questions).toEqual(qs)
  })
})

// CALENDAR.1 — a Duration field in Schedule; minutes travel as duration_minutes.
describe('HostEventForm duration', () => {
  it('hydrates and posts duration_minutes; blank posts null', async () => {
    const fetchMock = vi.fn(async (url) => (String(url) === '/api/host/series'
      ? { ok: true, status: 200, json: async () => ({ success: true, data: [] }) }
      : { ok: true, status: 200, json: async () => ({ success: true, data: { id: 'E1' } }) }))
    vi.stubGlobal('fetch', fetchMock)
    render(<HostEventForm mode="edit" eventId="E1" initial={{ ...initial, duration_minutes: 90 }} brandName="UN1T" />)
    const field = screen.getByLabelText(/Duration/)
    expect(field.value).toBe('90')
    fireEvent.change(field, { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: /Save changes/ }))
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u) === '/api/host/events/E1')).toBe(true))
    const [, init] = fetchMock.mock.calls.find(([u]) => String(u) === '/api/host/events/E1')
    expect(JSON.parse(init.body).duration_minutes).toBeNull()
  })
})

// HOSTPAGE.2 — the rating request's subject/intro ride the email section.
describe('HostEventForm rating request copy', () => {
  it('hydrates and submits rating_email_subject / rating_email_intro', async () => {
    const fetchMock = vi.fn(async (url) => (String(url) === '/api/host/series'
      ? { ok: true, status: 200, json: async () => ({ success: true, data: [] }) }
      : { ok: true, status: 200, json: async () => ({ success: true, data: { id: 'E1' } }) }))
    vi.stubGlobal('fetch', fetchMock)
    render(<HostEventForm mode="edit" eventId="E1" initial={{ ...initial, rating_email_subject: 'Tell us about {{event_name}}' }} brandName="UN1T" />)
    // The email section opens itself when any copy is set.
    const subject = screen.getByLabelText(/Rating request subject/)
    expect(subject.value).toBe('Tell us about {{event_name}}')
    fireEvent.change(screen.getByLabelText(/Rating request intro/), { target: { value: 'Two minutes, we promise.' } })
    fireEvent.click(screen.getByRole('button', { name: /Save changes|Save event|Create event/ }))
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u) === '/api/host/events/E1')).toBe(true))
    const body = JSON.parse(fetchMock.mock.calls.find(([u]) => String(u) === '/api/host/events/E1')[1].body)
    expect(body.rating_email_subject).toBe('Tell us about {{event_name}}')
    expect(body.rating_email_intro).toBe('Two minutes, we promise.')
  })
})
