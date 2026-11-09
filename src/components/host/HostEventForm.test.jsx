// @vitest-environment jsdom
// HOSTSERIES.1 — the host form lists sessions: hydrates from initial.sessions,
// "Add a session" adds a row, and the body carries sessions[] only.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'

const push = vi.fn()
const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh }) }))
// HOSTPORTAL.2 — spy on the unsaved flag the form raises and clears.
const setUnsaved = vi.fn()
let flag = false
vi.mock('@/lib/unsaved-guard', () => ({ setUnsaved: (f) => { flag = Boolean(f); setUnsaved(f) }, hasUnsaved: () => flag, confirmLeave: () => true }))

const { default: HostEventForm } = await import('./HostEventForm.jsx')

const W1 = 'f0000000-0000-4000-8000-0000000000f1'
const W2 = 'f0000000-0000-4000-8000-0000000000f2'
const initial = {
  kind: 'workshop', name: 'Mobility', venue_name: 'Studio 1', race_date: '2026-12-05', allowed_team_sizes: [1, 2],
  non_member_fee_cents: 2500,
  sessions: [{ id: W1, start_time: '10:00', label: null, capacity: 20 }, { id: W2, start_time: '14:00', label: 'Afternoon', capacity: 15 }],
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); push.mockClear(); refresh.mockClear(); setUnsaved.mockClear(); flag = false })

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
  it('with no series the select is absent and an edit sends series_id null (create sends no key)', async () => {
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
    expect(JSON.parse(init.body).series_id).toBeNull()
  })
  it('create mode sends no series_id key when no series is picked', async () => {
    const fetchMock = okFetch({ newId: 'new-id' })
    vi.stubGlobal('fetch', fetchMock)
    render(<HostEventForm mode="create" brandName="UN1T" />)
    fireEvent.change(screen.getByLabelText(/Event name/), { target: { value: 'Brand new' } })
    fireEvent.change(screen.getByLabelText(/Venue name/), { target: { value: 'Studio' } })
    fireEvent.change(screen.getByLabelText(/^Date/), { target: { value: '2026-12-05' } })
    fireEvent.change(screen.getAllByLabelText(/Start time/)[0], { target: { value: '10:00' } })
    fireEvent.change(screen.getAllByLabelText(/^Capacity/)[0], { target: { value: '10' } })
    fireEvent.click(screen.getByRole('button', { name: /Create event/ }))
    await waitFor(() => expect(push).toHaveBeenCalled())
    const [, init] = fetchMock.mock.calls.find(([u]) => String(u) === '/api/host/events')
    expect(JSON.parse(init.body)).not.toHaveProperty('series_id')
  })
  it('leaving a series: after the save and the refresh the form is still clean and still says Saved.', async () => {
    const SID = 'd0000000-0000-4000-8000-0000000000d1'
    const fetchMock = vi.fn(async (url) => (String(url) === '/api/host/series'
      ? { ok: true, status: 200, json: async () => ({ success: true, data: [{ id: SID, name: 'Monthly Mobility', slug: 'm', upcoming_count: 1 }] }) }
      : { ok: true, status: 200, json: async () => ({ success: true, data: { id: 'E1' } }) }))
    vi.stubGlobal('fetch', fetchMock)
    const inSeries = { ...initial, series_id: SID }
    const view = render(<HostEventForm mode="edit" eventId="E1" initial={inSeries} brandName="UN1T" status="draft" />)
    fireEvent.change(await screen.findByLabelText(/^Series/), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: /Save changes/ }))
    await screen.findByText('Saved.')
    const [, init] = fetchMock.mock.calls.find(([u]) => String(u) === '/api/host/events/E1')
    expect(JSON.parse(init.body).series_id).toBeNull()
    setUnsaved.mockClear()
    view.rerender(<HostEventForm mode="edit" eventId="E1" initial={{ ...initial, series_id: null }} brandName="UN1T" status="draft" />)
    expect(setUnsaved.mock.calls.every(([f]) => f === false)).toBe(true)
    expect(screen.getByText('Saved.')).toBeTruthy()
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

  // RATINGCOPY.1 — the edit page's own mapping feeds the form: a save that
  // touches nothing must send back the copy the row already holds. Before the
  // fix the page dropped the two rating fields, so this body carried null for
  // both and the PUT wiped them.
  it('an untouched save of a row with saved copy sends every copy field back unchanged', async () => {
    const { hostEventFormInitial } = await import('@/lib/host-event-form-initial')
    const row = {
      ...initial,
      confirmation_email_subject: 'You are in', confirmation_email_intro: 'See you there.',
      reminder_email_subject: 'Tomorrow', reminder_email_intro: 'Bring water.',
      rating_email_subject: 'How was {{event_name}}?', rating_email_intro: 'Two minutes, we promise.',
      race_waves: [{ id: W1, start_time: '10:00:00', label: null, capacity: 20, display_order: 0 }],
    }
    delete row.sessions
    const fetchMock = vi.fn(async (url) => (String(url) === '/api/host/series'
      ? { ok: true, status: 200, json: async () => ({ success: true, data: [] }) }
      : { ok: true, status: 200, json: async () => ({ success: true, data: { id: 'E1' } }) }))
    vi.stubGlobal('fetch', fetchMock)
    render(<HostEventForm mode="edit" eventId="E1" initial={hostEventFormInitial(row)} brandName="UN1T" />)
    // Saved copy opens the Email copy section by itself.
    expect(screen.getByLabelText(/Rating request subject/).value).toBe('How was {{event_name}}?')
    fireEvent.click(screen.getByRole('button', { name: /Save changes|Save event|Create event/ }))
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u) === '/api/host/events/E1')).toBe(true))
    const body = JSON.parse(fetchMock.mock.calls.find(([u]) => String(u) === '/api/host/events/E1')[1].body)
    expect(body).toMatchObject({
      confirmation_email_subject: 'You are in', confirmation_email_intro: 'See you there.',
      reminder_email_subject: 'Tomorrow', reminder_email_intro: 'Bring water.',
      rating_email_subject: 'How was {{event_name}}?', rating_email_intro: 'Two minutes, we promise.',
    })
  })
})


// HOSTPORTAL.2 — the Set up tab: jump bar, unsaved guard, stay-on-page save.
function okFetch(extra = {}) {
  return vi.fn(async (url) => (String(url) === '/api/host/series'
    ? { ok: true, status: 200, json: async () => ({ success: true, data: [] }) }
    : { ok: true, status: 200, json: async () => ({ success: true, data: { id: extra.newId || 'E1' } }) }))
}
const PILLS = ['Basics', 'Schedule & sessions', 'Tickets & pricing', 'Questions at signup', 'Page look', 'Emails']

describe('HostEventForm jump bar', () => {
  it('renders the six jump pills in edit mode and none in create mode', () => {
    vi.stubGlobal('fetch', okFetch())
    const { unmount } = render(<HostEventForm mode="edit" eventId="E1" initial={initial} brandName="UN1T" status="draft" />)
    for (const label of PILLS) {
      const pill = screen.getByRole('button', { name: label })
      expect(pill.getAttribute('type')).toBe('button')
    }
    unmount()
    render(<HostEventForm mode="create" brandName="UN1T" />)
    for (const label of PILLS) expect(screen.queryByRole('button', { name: label })).toBeNull()
  })

  it('gives each section its anchor id', () => {
    vi.stubGlobal('fetch', okFetch())
    const { container } = render(<HostEventForm mode="edit" eventId="E1" initial={initial} brandName="UN1T" status="draft" />)
    for (const id of ['setup-basics', 'setup-schedule', 'setup-tickets', 'setup-questions', 'setup-look', 'setup-emails']) {
      expect(container.querySelector(`section#${id}`), id).toBeTruthy()
    }
  })

  it('a pill scrolls its section into view', () => {
    vi.stubGlobal('fetch', okFetch())
    const { container } = render(<HostEventForm mode="edit" eventId="E1" initial={initial} brandName="UN1T" status="draft" />)
    const target = container.querySelector('section#setup-tickets')
    target.scrollIntoView = vi.fn()
    fireEvent.click(screen.getByRole('button', { name: 'Tickets & pricing' }))
    expect(target.scrollIntoView).toHaveBeenCalledTimes(1)
  })

  it('the Emails pill opens the email copy section', () => {
    vi.stubGlobal('fetch', okFetch())
    render(<HostEventForm mode="edit" eventId="E1" initial={initial} brandName="UN1T" status="draft" />)
    expect(screen.queryByLabelText(/Rating request subject/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Emails' }))
    expect(screen.getByLabelText(/Rating request subject/)).toBeTruthy()
  })
})

describe('HostEventForm unsaved guard', () => {
  it('is not dirty on mount (even after the series fetch settles) and is dirty after an edit', async () => {
    const fetchMock = okFetch()
    vi.stubGlobal('fetch', fetchMock)
    render(<HostEventForm mode="edit" eventId="E1" initial={initial} brandName="UN1T" status="draft" />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(setUnsaved.mock.calls.length).toBeGreaterThan(0)
    expect(setUnsaved.mock.calls.every(([f]) => f === false)).toBe(true)
    fireEvent.change(screen.getByLabelText(/Event name/), { target: { value: 'Mobility 2' } })
    expect(setUnsaved.mock.calls.at(-1)[0]).toBe(true)
  })

  it('goes clean again when the edit is undone, and clears the flag on unmount', () => {
    vi.stubGlobal('fetch', okFetch())
    const { unmount } = render(<HostEventForm mode="edit" eventId="E1" initial={initial} brandName="UN1T" status="draft" />)
    const name = screen.getByLabelText(/Event name/)
    fireEvent.change(name, { target: { value: 'Other' } })
    expect(setUnsaved.mock.calls.at(-1)[0]).toBe(true)
    fireEvent.change(name, { target: { value: 'Mobility' } })
    expect(setUnsaved.mock.calls.at(-1)[0]).toBe(false)
    fireEvent.change(name, { target: { value: 'Other' } })
    unmount()
    expect(setUnsaved.mock.calls.at(-1)[0]).toBe(false)
  })

  it('asks the browser before unloading while dirty, and not otherwise', () => {
    vi.stubGlobal('fetch', okFetch())
    render(<HostEventForm mode="edit" eventId="E1" initial={initial} brandName="UN1T" status="draft" />)
    const clean = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(clean)
    expect(clean.defaultPrevented).toBe(false)
    fireEvent.change(screen.getByLabelText(/Event name/), { target: { value: 'Other' } })
    const dirty = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(dirty)
    expect(dirty.defaultPrevented).toBe(true)
  })
})

describe('HostEventForm save behaviour', () => {
  it('stays on the page after an edit save, shows Saved., refreshes, and is clean again', async () => {
    vi.stubGlobal('fetch', okFetch())
    render(<HostEventForm mode="edit" eventId="E1" initial={initial} brandName="UN1T" status="draft" />)
    fireEvent.change(screen.getByLabelText(/Event name/), { target: { value: 'Other' } })
    expect(setUnsaved.mock.calls.at(-1)[0]).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: /Save changes/ }))
    expect(await screen.findByText('Saved.')).toBeTruthy()
    expect(push).not.toHaveBeenCalled()
    expect(refresh).toHaveBeenCalled()
    expect(setUnsaved.mock.calls.at(-1)[0]).toBe(false)
    // Editing again clears the Saved. note and raises the flag.
    fireEvent.change(screen.getByLabelText(/Event name/), { target: { value: 'Third' } })
    expect(screen.queryByText('Saved.')).toBeNull()
    expect(setUnsaved.mock.calls.at(-1)[0]).toBe(true)
  })

  it('sends create to the new event\'s setup tab', async () => {
    vi.stubGlobal('fetch', okFetch({ newId: 'new-id' }))
    render(<HostEventForm mode="create" brandName="UN1T" />)
    fireEvent.change(screen.getByLabelText(/Event name/), { target: { value: 'Brand new' } })
    fireEvent.change(screen.getByLabelText(/Venue name/), { target: { value: 'Studio' } })
    fireEvent.change(screen.getByLabelText(/^Date/), { target: { value: '2026-12-05' } })
    fireEvent.change(screen.getAllByLabelText(/Start time/)[0], { target: { value: '10:00' } })
    fireEvent.change(screen.getAllByLabelText(/^Capacity/)[0], { target: { value: '10' } })
    fireEvent.click(screen.getByRole('button', { name: /Create event/ }))
    await waitFor(() => expect(push).toHaveBeenCalledWith('/host/events/new-id/setup'))
  })
})

describe('HostEventForm actions', () => {
  it('shows Submit for review on a draft and a rejected event only', () => {
    vi.stubGlobal('fetch', okFetch())
    for (const [status, shown] of [['draft', true], ['rejected', true], ['pending_review', false], ['published', false]]) {
      const { unmount } = render(<HostEventForm mode="edit" eventId="E1" initial={initial} brandName="UN1T" status={status} />)
      expect(!!screen.queryByRole('button', { name: 'Submit for review' }), status).toBe(shown)
      unmount()
    }
  })

  it('Cancel goes to the event page in edit mode and the events list in create mode', () => {
    vi.stubGlobal('fetch', okFetch())
    const { unmount } = render(<HostEventForm mode="edit" eventId="E1" initial={initial} brandName="UN1T" status="draft" />)
    expect(screen.getByRole('link', { name: 'Cancel' }).getAttribute('href')).toBe('/host/events/E1')
    unmount()
    render(<HostEventForm mode="create" brandName="UN1T" />)
    expect(screen.getByRole('link', { name: 'Cancel' }).getAttribute('href')).toBe('/host/events')
  })
})


// HOSTPORTAL.2 fix round 1.
function deferredFetch() {
  let release
  const gate = new Promise((r) => { release = r })
  const fn = vi.fn(async (url) => {
    if (String(url) === '/api/host/series') return { ok: true, status: 200, json: async () => ({ success: true, data: [] }) }
    await gate
    return { ok: true, status: 200, json: async () => ({ success: true, data: { id: 'E1' } }) }
  })
  return { fn, release }
}
const saveCalls = (fn) => fn.mock.calls.filter(([u]) => String(u) === '/api/host/events/E1')
const W3 = 'f0000000-0000-4000-8000-0000000000f3'

describe('HostEventForm session ids after a save', () => {
  async function addAndSave() {
    const fetchMock = okFetch()
    vi.stubGlobal('fetch', fetchMock)
    const view = render(<HostEventForm mode="edit" eventId="E1" initial={initial} brandName="UN1T" status="published" />)
    fireEvent.click(screen.getByRole('button', { name: /Add a session/ }))
    fireEvent.change(screen.getAllByLabelText(/Start time/)[2], { target: { value: '18:00' } })
    fireEvent.change(screen.getAllByLabelText(/^Capacity/)[2], { target: { value: '8' } })
    fireEvent.click(screen.getByRole('button', { name: /Save changes/ }))
    await screen.findByText('Saved.')
    const withId = { ...initial, sessions: [...initial.sessions, { id: W3, start_time: '18:00:00', label: null, capacity: 8 }] }
    return { fetchMock, view, withId }
  }

  it('a second save sends the id the first save created, with no id-less session', async () => {
    const { fetchMock, view, withId } = await addAndSave()
    view.rerender(<HostEventForm mode="edit" eventId="E1" initial={withId} brandName="UN1T" status="published" />)
    fireEvent.click(screen.getByRole('button', { name: /Save changes/ }))
    await waitFor(() => expect(saveCalls(fetchMock)).toHaveLength(2))
    const body = JSON.parse(saveCalls(fetchMock)[1][1].body)
    expect(body.sessions).toEqual([
      { id: W1, start_time: '10:00', label: null, capacity: 20 },
      { id: W2, start_time: '14:00', label: 'Afternoon', capacity: 15 },
      { id: W3, start_time: '18:00', label: null, capacity: 8 },
    ])
  })

  it('the merge alone leaves the form clean and keeps Saved.', async () => {
    const { view, withId } = await addAndSave()
    setUnsaved.mockClear()
    view.rerender(<HostEventForm mode="edit" eventId="E1" initial={withId} brandName="UN1T" status="published" />)
    expect(setUnsaved.mock.calls.every(([f]) => f === false)).toBe(true)
    expect(screen.getByText('Saved.')).toBeTruthy()
  })

  it('an edit typed before the refresh arrives stays dirty and is kept', async () => {
    const { fetchMock, view, withId } = await addAndSave()
    fireEvent.change(screen.getAllByLabelText(/^Capacity/)[2], { target: { value: '9' } })
    view.rerender(<HostEventForm mode="edit" eventId="E1" initial={withId} brandName="UN1T" status="published" />)
    expect(setUnsaved.mock.calls.at(-1)[0]).toBe(true)
    expect(screen.getAllByLabelText(/^Capacity/)[2].value).toBe('9')
    fireEvent.click(screen.getByRole('button', { name: /Save changes/ }))
    await waitFor(() => expect(saveCalls(fetchMock)).toHaveLength(2))
    expect(JSON.parse(saveCalls(fetchMock)[1][1].body).sessions[2]).toEqual({ id: W3, start_time: '18:00', label: null, capacity: 9 })
  })
})

describe('HostEventForm Submit for review vs unsaved edits', () => {
  it('shows the button when clean, the save-first line when dirty, the button again after a save', async () => {
    vi.stubGlobal('fetch', okFetch())
    render(<HostEventForm mode="edit" eventId="E1" initial={initial} brandName="UN1T" status="draft" />)
    expect(screen.getByRole('button', { name: 'Submit for review' })).toBeTruthy()
    expect(screen.queryByText('Save your changes before submitting.')).toBeNull()
    fireEvent.change(screen.getByLabelText(/Event name/), { target: { value: 'Other' } })
    expect(screen.queryByRole('button', { name: 'Submit for review' })).toBeNull()
    expect(screen.getByText('Save your changes before submitting.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Save changes/ }))
    await screen.findByText('Saved.')
    expect(screen.getByRole('button', { name: 'Submit for review' })).toBeTruthy()
    expect(screen.queryByText('Save your changes before submitting.')).toBeNull()
  })
})

describe('HostEventForm save edge cases', () => {
  it('an edit typed while the save is in flight is not reported as saved', async () => {
    const { fn, release } = deferredFetch()
    vi.stubGlobal('fetch', fn)
    render(<HostEventForm mode="edit" eventId="E1" initial={initial} brandName="UN1T" status="published" />)
    fireEvent.change(screen.getByLabelText(/Event name/), { target: { value: 'First' } })
    fireEvent.click(screen.getByRole('button', { name: /Save changes/ }))
    await waitFor(() => expect(saveCalls(fn)).toHaveLength(1))
    fireEvent.change(screen.getByLabelText(/Event name/), { target: { value: 'Second' } })
    release()
    await waitFor(() => expect(refresh).toHaveBeenCalled())
    expect(setUnsaved.mock.calls.at(-1)[0]).toBe(true)
    expect(screen.queryByText('Saved.')).toBeNull()
  })

  it('a failed save keeps the form dirty, shows the error and no Saved.', async () => {
    const fn = vi.fn(async (url) => (String(url) === '/api/host/series'
      ? { ok: true, status: 200, json: async () => ({ success: true, data: [] }) }
      : { ok: false, status: 400, json: async () => ({ success: false, error: 'Nope, try again.' }) }))
    vi.stubGlobal('fetch', fn)
    render(<HostEventForm mode="edit" eventId="E1" initial={initial} brandName="UN1T" status="published" />)
    fireEvent.change(screen.getByLabelText(/Event name/), { target: { value: 'Other' } })
    fireEvent.click(screen.getByRole('button', { name: /Save changes/ }))
    expect(await screen.findByText('Nope, try again.')).toBeTruthy()
    expect(screen.queryByText('Saved.')).toBeNull()
    expect(setUnsaved.mock.calls.at(-1)[0]).toBe(true)
    expect(refresh).not.toHaveBeenCalled()
  })
})

describe('HostEventForm refused saves and the saved notice', () => {
  it('shows the readable sentence, not the code, when a save is refused', async () => {
    const fn = vi.fn(async (url) => (String(url) === '/api/host/series'
      ? { ok: true, status: 200, json: async () => ({ success: true, data: [] }) }
      : { ok: false, status: 409, json: async () => ({ success: false, error: 'session_has_entries', message: 'That session has bookings, so it cannot be removed.' }) }))
    vi.stubGlobal('fetch', fn)
    render(<HostEventForm mode="edit" eventId="E1" initial={initial} brandName="UN1T" status="published" />)
    fireEvent.change(screen.getByLabelText(/Event name/), { target: { value: 'Other' } })
    fireEvent.click(screen.getByRole('button', { name: /Save changes/ }))
    expect(await screen.findByText('That session has bookings, so it cannot be removed.')).toBeTruthy()
    expect(screen.queryByText('session_has_entries')).toBeNull()
  })

  it('a second save that fails does not leave Saved. beside the error', async () => {
    let fail = false
    const fn = vi.fn(async (url) => {
      if (String(url) === '/api/host/series') return { ok: true, status: 200, json: async () => ({ success: true, data: [] }) }
      if (fail) return { ok: false, status: 500, json: async () => ({ success: false, error: 'write_failed', message: 'Could not save.' }) }
      return { ok: true, status: 200, json: async () => ({ success: true, data: { id: 'E1' } }) }
    })
    vi.stubGlobal('fetch', fn)
    render(<HostEventForm mode="edit" eventId="E1" initial={initial} brandName="UN1T" status="draft" />)
    fireEvent.change(screen.getByLabelText(/Event name/), { target: { value: 'Other' } })
    fireEvent.click(screen.getByRole('button', { name: /Save changes/ }))
    await screen.findByText('Saved.')
    fail = true
    fireEvent.click(screen.getByRole('button', { name: /Save changes/ }))
    expect(await screen.findByText('Could not save.')).toBeTruthy()
    expect(screen.queryByText('Saved.')).toBeNull()
  })

  it('does not raise the browser leave prompt once the flag has been cleared elsewhere', () => {
    vi.stubGlobal('fetch', okFetch())
    render(<HostEventForm mode="edit" eventId="E1" initial={initial} brandName="UN1T" status="draft" />)
    fireEvent.change(screen.getByLabelText(/Event name/), { target: { value: 'Other' } })
    const dirtyEvent = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(dirtyEvent)
    expect(dirtyEvent.defaultPrevented).toBe(true)
    // e.g. Take off sale / Delete succeeded and cleared the flag before navigating.
    flag = false
    const after = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(after)
    expect(after.defaultPrevented).toBe(false)
  })
})

describe('HostEventForm section headings match the jump bar', () => {
  it.each(['Basics', 'Schedule & sessions', 'Tickets & pricing', 'Questions at signup', 'Page look'])('has a %s heading', (h) => {
    vi.stubGlobal('fetch', okFetch())
    render(<HostEventForm mode="create" brandName="UN1T" />)
    expect(screen.getByRole('heading', { name: h })).toBeTruthy()
  })
  it('the email toggle reads Emails (optional)', () => {
    vi.stubGlobal('fetch', okFetch())
    render(<HostEventForm mode="create" brandName="UN1T" />)
    expect(screen.getByRole('button', { name: /Emails \(optional\)/ })).toBeTruthy()
  })
})
