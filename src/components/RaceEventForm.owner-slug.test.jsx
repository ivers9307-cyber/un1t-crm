// @vitest-environment jsdom
//
// EVENT-OWNER.1 + EVENT-SLUG.2 — the new-event form lets staff pick the
// owning studio, and leaves the public link to the server's place-date-time
// rule unless someone types one. "Sean Noble - Hyrox Workshop in Hatch
// Street" (12 Oct 2026) was created owned by the switcher's studio with a
// name-based link the form had filled in.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react'
import RaceEventForm from './RaceEventForm.jsx'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
}))

const OPTIONS = [
  { id: 'loc-h', name: 'UN1T Hatch Street' },
  { id: 'loc-s', name: 'UN1T Stillorgan' },
]

function stubFetch() {
  const calls = []
  vi.stubGlobal('fetch', vi.fn((url, opts) => {
    calls.push({ url: String(url), opts })
    if (opts?.method === 'PUT' || opts?.method === 'POST') {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: { id: 'ev-new' } }) })
    }
    return new Promise(() => {})
  }))
  return calls
}

const sent = (calls, method) => JSON.parse(calls.find((c) => c.opts?.method === method).opts.body)

function fillWorkshop(container) {
  fireEvent.click([...container.querySelectorAll('button')].find((b) => /Workshop/.test(b.textContent)))
  fireEvent.change(container.querySelector('input[placeholder^="Mobility workshop"]'), { target: { value: 'Sean Noble - Hyrox Workshop' } })
  fireEvent.change(container.querySelector('input[type="date"]'), { target: { value: '2026-10-24' } })
  fireEvent.change(container.querySelector('input[title="Start time"]'), { target: { value: '10:00' } })
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('RaceEventForm — owning studio and link on create', () => {
  it('previews the place-date-time link and does NOT send a name-based slug', async () => {
    const calls = stubFetch()
    const { container } = render(<RaceEventForm locationId="loc-s" ownerName="UN1T Stillorgan" ownerOptions={OPTIONS} />)
    fillWorkshop(container)
    const slugInput = container.querySelector('input[pattern]')
    expect(slugInput.value).toBe('')
    expect(slugInput.placeholder).toBe('stillorgan-oct24-1000')

    fireEvent.submit(container.querySelector('form'))
    await waitFor(() => expect(calls.some((c) => c.opts?.method === 'POST')).toBe(true))
    const body = sent(calls, 'POST')
    expect(body.slug).toBeUndefined()
    expect(body.location_id).toBe('loc-s')
  })

  it('picking Hatch Street sends it as the owner and the preview follows', async () => {
    const calls = stubFetch()
    const { container } = render(<RaceEventForm locationId="loc-s" ownerName="UN1T Stillorgan" ownerOptions={OPTIONS} />)
    fillWorkshop(container)
    fireEvent.change(container.querySelector('#event-owner'), { target: { value: 'loc-h' } })
    expect(container.querySelector('input[pattern]').placeholder).toBe('hatch-oct24-1000')

    fireEvent.submit(container.querySelector('form'))
    await waitFor(() => expect(calls.some((c) => c.opts?.method === 'POST')).toBe(true))
    expect(sent(calls, 'POST').location_id).toBe('loc-h')
  })

  it('a typed slug is still sent', async () => {
    const calls = stubFetch()
    const { container } = render(<RaceEventForm locationId="loc-s" ownerName="UN1T Stillorgan" ownerOptions={OPTIONS} />)
    fillWorkshop(container)
    fireEvent.change(container.querySelector('input[pattern]'), { target: { value: 'sean-noble' } })
    fireEvent.submit(container.querySelector('form'))
    await waitFor(() => expect(calls.some((c) => c.opts?.method === 'POST')).toBe(true))
    expect(sent(calls, 'POST').slug).toBe('sean-noble')
  })

  it('one studio on offer is shown, not chosen', () => {
    stubFetch()
    const { container } = render(<RaceEventForm locationId="loc-s" ownerName="UN1T Stillorgan" ownerOptions={[]} />)
    expect(container.querySelector('select#event-owner')).toBeNull()
    expect(container.querySelector('#event-owner').textContent).toBe('UN1T Stillorgan')
  })
})

describe('RaceEventForm — moving an existing event', () => {
  const EVENT = {
    id: 'ev-1', kind: 'workshop', name: 'Sean Noble', slug: 'sean-noble-hyrox-workshop',
    location_id: 'loc-s', race_date: '2026-10-24', allowed_team_sizes: [1], capacity_mode: 'people', active: true,
    confirmation_email_template_id: 'tpl-stillorgan',
    waves: [{ id: 'w1', start_time: '10:00:00', capacity: 32, label: null }],
  }

  it('sends location_id only when the studio changed, and drops the old studio template', async () => {
    const calls = stubFetch()
    const { container, getByText } = render(<RaceEventForm race={EVENT} locationId="loc-s" ownerName="UN1T Stillorgan" ownerOptions={OPTIONS} />)
    fireEvent.submit(container.querySelector('form'))
    await waitFor(() => expect(calls.some((c) => c.opts?.method === 'PUT')).toBe(true))
    expect(sent(calls, 'PUT').location_id).toBeUndefined()

    calls.length = 0
    fireEvent.change(container.querySelector('#event-owner'), { target: { value: 'loc-h' } })
    expect(getByText(/Saving moves this event to UN1T Hatch Street/)).toBeTruthy()
    fireEvent.submit(container.querySelector('form'))
    await waitFor(() => expect(calls.some((c) => c.opts?.method === 'PUT')).toBe(true))
    const body = sent(calls, 'PUT')
    expect(body.location_id).toBe('loc-h')
    expect(body.confirmation_email_template_id ?? null).toBeNull()
  })
})
