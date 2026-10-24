// @vitest-environment jsdom
//
// SCREENMODE.12 — the "Class screens" card on the automations hub. The card
// builds the exact config the screen_mode route validates, so these tests pin
// the enable gate (timetable + valid package + a ticked screen), the shape of
// the PUT, the blank-package-is-null rule and the client-side plan.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))

import ScreenModeCard from './ScreenModeCard.jsx'

const LOC = '00000000-0000-4000-8000-000000000001'
const SCREENS = [
  { device_name: 'hatch-screen1', label: 'Studio wall' },
  { device_name: 'hatch-screen2', label: null },
]
const ZONE = 'Europe/Dublin'

// Two touching classes (10:00-11:00, 11:00-12:00) on a Monday in January, so
// the default 10/5 minute leads merge them into one window.
const CLASSES = [
  { glofox_event_id: 'e1', name: 'UN1T Strength', starts_at: '2027-01-04T10:00:00.000Z', ends_at: '2027-01-04T11:00:00.000Z' },
  { glofox_event_id: 'e2', name: 'UN1T Conditioning', starts_at: '2027-01-04T11:00:00.000Z', ends_at: '2027-01-04T12:00:00.000Z' },
]

function stubFetch({ classes = CLASSES, put = { status: 200, body: { success: true } } } = {}) {
  const fn = vi.fn(async (url, init) => {
    if (init?.method === 'PUT') {
      return { ok: put.status < 300, status: put.status, json: async () => put.body }
    }
    return { ok: true, status: 200, json: async () => ({ success: true, classes, last_synced: null }) }
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

const putCall = (fn) => fn.mock.calls.find(([, init]) => init?.method === 'PUT')

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const show = (props = {}) => render(
  <ScreenModeCard
    locationId={LOC}
    timezone={ZONE}
    screens={SCREENS}
    hasTimetable
    initialEnabled={false}
    initialConfig={{}}
    {...props}
  />,
)

const toggle = () => screen.getByRole('button', { name: /turn automation (on|off)/i })

describe('ScreenModeCard', () => {
  it('shows the heading and the registry description', () => {
    stubFetch()
    show()
    expect(screen.getByRole('heading', { name: 'Class screens' })).toBeTruthy()
    expect(screen.getByText(/Show the class app on the floor screens during each class/)).toBeTruthy()
  })

  it('cannot be enabled without a valid package name', () => {
    stubFetch()
    show()
    expect(toggle().disabled).toBe(true)
    expect(toggle().title).toMatch(/package/i)

    fireEvent.click(screen.getByRole('checkbox', { name: /Studio wall/ }))
    expect(toggle().disabled).toBe(true)

    fireEvent.change(screen.getByLabelText(/class app package/i), { target: { value: 'not a package' } })
    expect(toggle().disabled).toBe(true)

    fireEvent.change(screen.getByLabelText(/class app package/i), { target: { value: 'com.franchise.app' } })
    expect(toggle().disabled).toBe(false)
  })

  it('cannot be enabled with no screen ticked', () => {
    stubFetch()
    show({ initialConfig: { class_app_package: 'com.franchise.app' } })
    expect(toggle().disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: /Studio wall/ }))
    expect(toggle().disabled).toBe(false)
  })

  it('cannot be enabled without a timetable', () => {
    stubFetch()
    show({ hasTimetable: false, initialConfig: { class_app_package: 'com.franchise.app', device_names: ['hatch-screen1'] } })
    expect(toggle().disabled).toBe(true)
    expect(toggle().title).toMatch(/timetable/i)
  })

  it('can always be turned off once on', () => {
    stubFetch()
    show({ hasTimetable: false, initialEnabled: true, initialConfig: {} })
    expect(toggle().disabled).toBe(false)
  })

  it('shows merged windows from the schedule', async () => {
    stubFetch()
    show({ initialConfig: { class_app_package: 'com.franchise.app', device_names: ['hatch-screen1'] } })
    const row = await screen.findByTestId('plan-window')
    expect(screen.getAllByTestId('plan-window')).toHaveLength(1)
    expect(row.textContent).toMatch(/→/)
    expect(row.textContent).toMatch(/UN1T Strength/)
    expect(row.textContent).toMatch(/UN1T Conditioning/)
  })

  it('says so when no timetable is synced', () => {
    const fetchFn = stubFetch()
    show({ hasTimetable: false })
    expect(screen.getByText('No class timetable is being synced for this studio.')).toBeTruthy()
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('excludes a class slot when it is clicked, and the window goes away', async () => {
    const fetchFn = stubFetch({ classes: [CLASSES[0]] })
    show({ initialConfig: { class_app_package: 'com.franchise.app', device_names: ['hatch-screen1'] } })
    const cls = await screen.findByRole('button', { name: /UN1T Strength/ })
    fireEvent.click(cls)
    await waitFor(() => expect(screen.queryByTestId('plan-window')).toBeNull())

    fireEvent.click(toggle())
    await waitFor(() => expect(putCall(fetchFn)).toBeTruthy())
    const body = JSON.parse(putCall(fetchFn)[1].body)
    expect(body.config.excluded_slots).toEqual(['Mon 10:00'])
  })

  it('saves the config shape the route expects', async () => {
    const fetchFn = stubFetch()
    show({ initialConfig: { lead_in_min: 15, lead_out_min: 7, class_filter: ['strength'] } })
    fireEvent.click(screen.getByRole('checkbox', { name: /Studio wall/ }))
    fireEvent.change(screen.getByLabelText(/class app package/i), { target: { value: ' com.franchise.app ' } })
    fireEvent.click(toggle())

    await waitFor(() => expect(putCall(fetchFn)).toBeTruthy())
    const [url, init] = putCall(fetchFn)
    expect(url).toBe('/api/automations/screen_mode')
    expect(JSON.parse(init.body)).toEqual({
      location_id: LOC,
      enabled: true,
      config: {
        device_names: ['hatch-screen1'],
        class_app_package: 'com.franchise.app',
        lead_in_min: 15,
        lead_out_min: 7,
        class_filter: ['strength'],
        excluded_slots: [],
      },
    })
    expect(await screen.findByText(/Saved/)).toBeTruthy()
  })

  it('saves a blank package as null, never an empty string', async () => {
    const fetchFn = stubFetch()
    show()
    fireEvent.click(screen.getByRole('button', { name: /save settings/i }))
    await waitFor(() => expect(putCall(fetchFn)).toBeTruthy())
    const body = JSON.parse(putCall(fetchFn)[1].body)
    expect(body.config.class_app_package).toBeNull()
    expect(body.enabled).toBe(false)
  })

  it('shows the error the route refused with', async () => {
    stubFetch({ put: { status: 400, body: { success: false, error: 'unknown_device' } } })
    show()
    fireEvent.click(screen.getByRole('button', { name: /save settings/i }))
    expect(await screen.findByText('unknown_device')).toBeTruthy()
  })
})
