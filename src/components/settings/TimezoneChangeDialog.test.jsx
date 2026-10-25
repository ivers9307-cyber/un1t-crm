// @vitest-environment jsdom
// TZ.3 — the change-timezone dialog (D2 = A: any time, preflight counts, typed name).
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import TimezoneChangeDialog from './TimezoneChangeDialog.jsx'

const LOCATION = { id: 'loc-1', name: 'Studio A', timezone: 'Europe/Dublin' }
const PREFLIGHT = {
  success: true,
  data: {
    location: LOCATION, today: '2026-10-25',
    future: { bookings: 12, shift_blocks: 30, race_events: 1, hyrox_blocks: 0, pending_enrolments: null,
      sonos_schedules: 2, shelly_devices: 0, drip_broadcasts: 1 },
    unknown: ['pending_enrolments'], hasFutureData: true,
  },
}

let fetchMock
const respond = (body, ok = true) => ({ ok, json: async () => body })
beforeEach(() => {
  fetchMock = vi.fn(async (url, init) => {
    if (!init || init.method === undefined) return respond(PREFLIGHT)
    return respond({ success: true, data: { timezone: 'America/New_York', previous: 'Europe/Dublin', changed: true, broadcasts: { followed: 1, kept: [] } } })
  })
  globalThis.fetch = fetchMock
})
afterEach(() => { cleanup() })

const open = (props = {}) => render(
  <TimezoneChangeDialog location={LOCATION} country="IE" onClose={vi.fn()} onChanged={vi.fn()} {...props} />,
)
const confirmButton = () => screen.getByRole('button', { name: /^Change timezone$/ })

describe('TimezoneChangeDialog', () => {
  it('loads the preflight and shows every count; a count that failed reads "unknown", never 0', async () => {
    open()
    expect(fetchMock).toHaveBeenCalledWith('/api/locations/loc-1/timezone', expect.anything())
    await screen.findByText('Future bookings')
    const row = (label) => screen.getByText(label).closest('li').textContent
    expect(row('Future bookings')).toMatch(/12$/)
    expect(row('Future shift blocks')).toMatch(/30$/)
    expect(row('Pending sequence steps')).toMatch(/unknown$/)
    expect(row('Running Hyrox blocks')).toMatch(/0$/)
  })

  it('says plainly that times keep their local clock time and that scheduled reminders may shift, with no em-dashes', async () => {
    open()
    await screen.findByText('Future bookings')
    const text = screen.getByRole('dialog').textContent
    expect(text).toMatch(/stay the same local clock time in the new timezone/i)
    expect(text).toMatch(/09:00 stays at 09:00/)
    expect(text).toMatch(/reminders and messages already scheduled may shift/i)
    expect(text).not.toMatch(/—/)
  })

  it('the confirm button stays disabled until a different zone is chosen AND the exact name is typed', async () => {
    open()
    await screen.findByText('Future bookings')
    expect(confirmButton().disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(/^New timezone/), { target: { value: 'America/New_York' } })
    expect(confirmButton().disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(/Type the location name/), { target: { value: 'studio a' } })
    expect(confirmButton().disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(/Type the location name/), { target: { value: 'Studio A' } })
    expect(confirmButton().disabled).toBe(false)
    fireEvent.change(screen.getByLabelText(/^New timezone/), { target: { value: 'Europe/Dublin' } })
    expect(confirmButton().disabled).toBe(true)
  })

  it('PUTs the zone and the typed name, then reports the change', async () => {
    const onChanged = vi.fn()
    open({ onChanged })
    await screen.findByText('Future bookings')
    fireEvent.change(screen.getByLabelText(/^New timezone/), { target: { value: 'America/New_York' } })
    fireEvent.change(screen.getByLabelText(/Type the location name/), { target: { value: 'Studio A' } })
    fireEvent.click(confirmButton())
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    const [url, init] = fetchMock.mock.calls[1]
    expect(url).toBe('/api/locations/loc-1/timezone')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body)).toEqual({ timezone: 'America/New_York', confirm_name: 'Studio A' })
    expect(onChanged.mock.calls[0][0]).toMatchObject({ timezone: 'America/New_York', changed: true })
  })

  it('shows the server\'s refusal and stays open', async () => {
    fetchMock.mockImplementation(async (url, init) => (init?.method === 'PUT'
      ? respond({ success: false, code: 'confirm_mismatch', error: 'Type the location name exactly as it is shown to confirm the change.' }, false)
      : respond(PREFLIGHT)))
    const onChanged = vi.fn()
    open({ onChanged })
    await screen.findByText('Future bookings')
    fireEvent.change(screen.getByLabelText(/^New timezone/), { target: { value: 'Asia/Tokyo' } })
    fireEvent.change(screen.getByLabelText(/Type the location name/), { target: { value: 'Studio A' } })
    fireEvent.click(confirmButton())
    expect((await screen.findByRole('alert')).textContent).toMatch(/Type the location name exactly/)
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('a failed preflight says so with Try again, and offers no confirm until it loads', async () => {
    fetchMock.mockImplementationOnce(async () => respond({ success: false, error: 'Could not read the location.' }, false))
    open()
    expect((await screen.findByRole('alert')).textContent).toMatch(/Could not read the location/)
    expect(screen.queryByRole('button', { name: /^Change timezone$/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }))
    await screen.findByText('Future bookings')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
