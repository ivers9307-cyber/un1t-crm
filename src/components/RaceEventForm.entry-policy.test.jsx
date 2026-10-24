// @vitest-environment jsdom
//
// ENTRYPOLICY.1 — the event form's "Entry policy" section: loads
// race_events.entry_policy, saves { switches, hours when set, non-blank copy }
// on every save of a kind with entries, and does not appear for lead_gen.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import RaceEventForm from './RaceEventForm.jsx'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), back: vi.fn(), refresh: vi.fn() }) }))

const RACE = {
  id: 'ev-1', kind: 'race', name: 'Hyrox Sim', slug: 'hyrox-sim', race_date: '2026-11-03',
  allowed_team_sizes: [1, 2], capacity_mode: 'teams', active: true,
  waves: [{ id: 'w9', start_time: '09:00:00', capacity: 28, label: null }],
  entry_policy: { self_cancel_enabled: false, cutoff_hours: 24, cutoff_message: 'Too late for {{event_name}}.' },
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

async function submitAndGetBody(container, calls) {
  fireEvent.submit(container.querySelector('form'))
  await waitFor(() => expect(calls.some((c) => c.opts?.method === 'PUT')).toBe(true))
  return JSON.parse(calls.find((c) => c.opts?.method === 'PUT').opts.body)
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('RaceEventForm — Entry policy', () => {
  it('loads the saved switches, hours and copy and sends them back', async () => {
    const calls = stubFetch()
    const { container } = render(<RaceEventForm race={RACE} locationId="loc-1" />)
    expect(screen.getByRole('switch', { name: 'Let customers cancel their own entry' }).getAttribute('aria-checked')).toBe('false')
    expect(screen.getByRole('switch', { name: 'Let customers change their date or time' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByLabelText('Self-service closes (hours before start)').value).toBe('24')
    expect(screen.getByLabelText('Unpaid entry holds its place for (hours)').value).toBe('')
    expect(screen.getByLabelText('Too close to the start').value).toBe('Too late for {{event_name}}.')
    const body = await submitAndGetBody(container, calls)
    expect(body.entry_policy).toEqual({ self_cancel_enabled: false, self_reschedule_enabled: true, cutoff_hours: 24, cutoff_message: 'Too late for {{event_name}}.' })
  })

  it('omits blank hours and copy so the defaults apply; never sends null', async () => {
    const calls = stubFetch()
    const { container } = render(<RaceEventForm race={{ ...RACE, entry_policy: null }} locationId="loc-1" />)
    expect(screen.getByRole('switch', { name: 'Let customers cancel their own entry' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByLabelText('Self-service closes (hours before start)').placeholder).toBe('48')
    expect(screen.getByLabelText('Unpaid entry holds its place for (hours)').placeholder).toBe('48')
    const body = await submitAndGetBody(container, calls)
    expect(body.entry_policy).toEqual({ self_cancel_enabled: true, self_reschedule_enabled: true })
    expect(JSON.stringify(body.entry_policy)).not.toContain('null')
  })

  it('sends typed hours as integers, trimmed copy, and a switched-off reschedule', async () => {
    const calls = stubFetch()
    const { container } = render(<RaceEventForm race={{ ...RACE, entry_policy: null }} locationId="loc-1" />)
    fireEvent.change(screen.getByLabelText('Self-service closes (hours before start)'), { target: { value: '0' } })
    fireEvent.change(screen.getByLabelText('Unpaid entry holds its place for (hours)'), { target: { value: '72' } })
    fireEvent.change(screen.getByLabelText('Self-service switched off'), { target: { value: '  Ask the desk.  ' } })
    fireEvent.change(screen.getByLabelText('Unpaid entry lapsed'), { target: { value: 'Lapsed after {{hours}}h.' } })
    fireEvent.click(screen.getByRole('switch', { name: 'Let customers change their date or time' }))
    const body = await submitAndGetBody(container, calls)
    expect(body.entry_policy).toEqual({
      self_cancel_enabled: true, self_reschedule_enabled: false, cutoff_hours: 0, unpaid_hold_hours: 72,
      disabled_message: 'Ask the desk.', lapsed_message: 'Lapsed after {{hours}}h.',
    })
  })

  it('a non-race kind with entries (workshop) still has the section', async () => {
    const calls = stubFetch()
    const { container } = render(<RaceEventForm race={{ ...RACE, kind: 'workshop', allowed_team_sizes: [1], capacity_mode: 'people', entry_policy: null }} locationId="loc-1" />)
    expect(screen.getByRole('switch', { name: 'Let customers cancel their own entry' })).toBeTruthy()
    const body = await submitAndGetBody(container, calls)
    expect(body.entry_policy).toEqual({ self_cancel_enabled: true, self_reschedule_enabled: true })
  })

  it('lead_gen shows no section and sends no entry_policy', async () => {
    const calls = stubFetch()
    const { container } = render(<RaceEventForm race={{ ...RACE, kind: 'lead_gen', race_date: null, waves: [], allowed_team_sizes: [1], capacity_mode: 'people', entry_policy: null }} locationId="loc-1" />)
    expect(screen.queryByRole('switch', { name: 'Let customers cancel their own entry' })).toBeNull()
    const body = await submitAndGetBody(container, calls)
    expect('entry_policy' in body).toBe(false)
  })
})
