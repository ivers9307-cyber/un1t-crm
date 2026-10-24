// @vitest-environment jsdom
//
// SCREENMODE.11 — the screens section of /admin/fleet. The page resolves who
// may do what (canOverride, isMaster) server-side; this component only draws
// it, so the tests pin that no button renders that the API would refuse, the
// exact request each button sends, and the mismatch flag an operator reads.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor, within } from '@testing-library/react'
import ScreensSection from './ScreensSection.jsx'

const row = (over = {}) => ({
  device_name: 'hatch-screen1',
  label: 'Studio wall',
  location: 'UN1T Hatch Street',
  locationId: 'loc-hatch',
  displayLabel: 'Hatch main board',
  hasToken: true,
  lastHeartbeatAt: new Date(Date.now() - 3 * 60000).toISOString(),
  reportedMode: 'class_app',
  reportedVersion: '1.4.0',
  expectedMode: 'class_app',
  override: null,
  canOverride: true,
  ...over,
})

const locations = [
  { id: 'loc-hatch', name: 'UN1T Hatch Street' },
  { id: 'loc-still', name: 'UN1T Stillorgan' },
]
const displays = [
  { id: 'disp-h1', label: 'Hatch main board', location_id: 'loc-hatch' },
  { id: 'disp-s1', label: 'Stillorgan board', location_id: 'loc-still' },
]

function stubFetch(status = 200, body = { ok: true }) {
  const fn = vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body }))
  vi.stubGlobal('fetch', fn)
  return fn
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const show = (props = {}) => render(
  <ScreensSection
    screens={[row()]}
    locations={[]}
    displays={[]}
    isMaster={false}
    onChanged={() => {}}
    {...props}
  />,
)

describe('ScreensSection rows', () => {
  it('renders a screen with its modes and flags a mismatch', () => {
    show({ screens: [row({ reportedMode: 'marketing', expectedMode: 'class_app' })] })
    expect(screen.getByText(/showing marketing during a class/i)).toBeTruthy()
  })

  it('does not flag a screen that shows what it should', () => {
    show({ screens: [row({ reportedMode: 'marketing', expectedMode: 'marketing' })] })
    expect(screen.queryByText(/showing marketing during a class/i)).toBeNull()
  })

  it('does not flag a screen when no expectation is known', () => {
    show({ screens: [row({ reportedMode: 'marketing', expectedMode: null })] })
    expect(screen.queryByText(/showing marketing during a class/i)).toBeNull()
  })

  it('draws the device, studio, display, version and last seen', () => {
    show()
    expect(screen.getByText('Studio wall')).toBeTruthy()
    expect(screen.getByText(/hatch-screen1/)).toBeTruthy()
    expect(screen.getByText('UN1T Hatch Street')).toBeTruthy()
    expect(screen.getByText('Hatch main board')).toBeTruthy()
    expect(screen.getByText('3 min ago')).toBeTruthy()
    expect(screen.getByText(/1\.4\.0/)).toBeTruthy()
  })

  it('says a box that has never phoned in has never been seen', () => {
    show({ screens: [row({ lastHeartbeatAt: null, reportedMode: null, reportedVersion: null })] })
    expect(screen.getByText('Never')).toBeTruthy()
  })

  it('draws light-theme chips for what is showing and what should show', () => {
    show({ screens: [row({ reportedMode: 'class_app', expectedMode: 'marketing' })] })
    const showing = screen.getByText('Class app')
    expect(showing.className).toContain('bg-blue-500/10')
    expect(showing.className).toContain('text-blue-700')
    const should = screen.getByText('Marketing')
    expect(should.className).toContain('bg-green-500/10')
    expect(should.className).toContain('text-green-700')
  })

  it('reads an unreported mode as Unknown', () => {
    show({ screens: [row({ reportedMode: null })] })
    const chip = screen.getByText('Unknown')
    expect(chip.className).toContain('bg-slate-500/10')
  })

  it('renders an absent expectation as a dash with an explanatory title', () => {
    show({ screens: [row({ expectedMode: null })] })
    const dash = screen.getByTitle('Class screens automation is off at this studio')
    expect(dash.textContent).toBe('—')
  })

  it('shows an override in force with its end', () => {
    const until = new Date(Date.now() + 42 * 60000).toISOString()
    show({ screens: [row({ override: { mode: 'marketing', until } })] })
    expect(screen.getByText(/Override: Marketing/)).toBeTruthy()
    expect(screen.getByText(/42 min/)).toBeTruthy()
  })

  it('shows an empty state for a master with no screens yet', () => {
    show({ screens: [], isMaster: true, locations, displays })
    expect(screen.getByText(/no screens/i)).toBeTruthy()
    expect(screen.getByText('Register screen')).toBeTruthy()
  })
})

describe('override buttons', () => {
  it('appear only with canOverride', () => {
    show({ screens: [row({ canOverride: false })] })
    expect(screen.queryByRole('button', { name: 'Show class app for 1 h' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Show marketing for 1 h' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Back to schedule' })).toBeNull()
  })

  it('post the class app body and refresh', async () => {
    const fetchFn = stubFetch()
    const onChanged = vi.fn()
    show({ onChanged })
    fireEvent.click(screen.getByRole('button', { name: 'Show class app for 1 h' }))
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1))
    expect(fetchFn).toHaveBeenCalledWith(
      '/api/admin/fleet/devices/hatch-screen1/screen-override',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'class_app', minutes: 60 }),
      },
    )
  })

  it('post the marketing body', async () => {
    const fetchFn = stubFetch()
    const onChanged = vi.fn()
    show({ onChanged })
    fireEvent.click(screen.getByRole('button', { name: 'Show marketing for 1 h' }))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(fetchFn.mock.calls[0][1].body).toBe(JSON.stringify({ mode: 'marketing', minutes: 60 }))
  })

  it('Back to schedule posts a clear', async () => {
    const fetchFn = stubFetch()
    const onChanged = vi.fn()
    show({ onChanged })
    fireEvent.click(screen.getByRole('button', { name: 'Back to schedule' }))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(fetchFn.mock.calls[0][1].body).toBe(JSON.stringify({ clear: true }))
  })

  it('encodes the device name in the path', async () => {
    const fetchFn = stubFetch()
    const onChanged = vi.fn()
    show({ screens: [row({ device_name: 'a b/c' })], onChanged })
    fireEvent.click(screen.getByRole('button', { name: 'Back to schedule' }))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(fetchFn.mock.calls[0][0]).toBe('/api/admin/fleet/devices/a%20b%2Fc/screen-override')
  })

  it('show the error from a refused request and do not refresh', async () => {
    stubFetch(404, { ok: false, error: 'Not found' })
    const onChanged = vi.fn()
    show({ onChanged })
    fireEvent.click(screen.getByRole('button', { name: 'Show class app for 1 h' }))
    expect(await screen.findByText('Not found')).toBeTruthy()
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('say so when the server cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    const onChanged = vi.fn()
    show({ onChanged })
    fireEvent.click(screen.getByRole('button', { name: 'Back to schedule' }))
    expect(await screen.findByText('Could not reach the server')).toBeTruthy()
    expect(onChanged).not.toHaveBeenCalled()
  })
})

describe('agent token', () => {
  it('is offered to masters only, and calls the handler', () => {
    const onIssueToken = vi.fn()
    show({ isMaster: true, locations, displays, onIssueToken, screens: [row({ hasToken: false })] })
    fireEvent.click(screen.getByRole('button', { name: 'Issue agent token' }))
    expect(onIssueToken).toHaveBeenCalledWith('hatch-screen1')
  })

  it('reads Rotate once a token exists, and is absent for non-masters', () => {
    const { unmount } = show({ isMaster: true, locations, displays, onIssueToken: vi.fn() })
    expect(screen.getByRole('button', { name: 'Rotate agent token' })).toBeTruthy()
    unmount()
    show({ isMaster: false, onIssueToken: vi.fn() })
    expect(screen.queryByRole('button', { name: /agent token/ })).toBeNull()
  })
})

describe('register form', () => {
  it('is master-only', () => {
    show({ isMaster: false, locations, displays })
    expect(screen.queryByText('Register screen')).toBeNull()
    cleanup()
    show({ isMaster: true, locations, displays })
    expect(screen.getByText('Register screen')).toBeTruthy()
  })

  it('filters the displays by the chosen location', () => {
    show({ isMaster: true, locations, displays })
    const display = screen.getByLabelText('Display')
    // No location chosen yet: only the no-display option.
    expect(within(display).queryByText('Hatch main board')).toBeNull()
    expect(within(display).getByText('No display (box shows its own idle screen)')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Location'), { target: { value: 'loc-hatch' } })
    expect(within(display).getByText('Hatch main board')).toBeTruthy()
    expect(within(display).queryByText('Stillorgan board')).toBeNull()

    fireEvent.change(screen.getByLabelText('Location'), { target: { value: 'loc-still' } })
    expect(within(display).getByText('Stillorgan board')).toBeTruthy()
    expect(within(display).queryByText('Hatch main board')).toBeNull()
  })

  it('forgets a chosen display when the location changes', async () => {
    const fetchFn = stubFetch(201, { ok: true })
    show({ isMaster: true, locations, displays })
    fireEvent.change(screen.getByLabelText('Device name'), { target: { value: 'hatch-screen2' } })
    fireEvent.change(screen.getByLabelText('Location'), { target: { value: 'loc-hatch' } })
    fireEvent.change(screen.getByLabelText('Display'), { target: { value: 'disp-h1' } })
    fireEvent.change(screen.getByLabelText('Location'), { target: { value: 'loc-still' } })
    fireEvent.click(screen.getByRole('button', { name: 'Register screen' }))
    await waitFor(() => expect(fetchFn).toHaveBeenCalled())
    expect(JSON.parse(fetchFn.mock.calls[0][1].body)).toEqual({
      device_name: 'hatch-screen2', location_id: 'loc-still', role: 'screen',
    })
  })

  it('posts the registration and refreshes on success', async () => {
    const fetchFn = stubFetch(201, { ok: true })
    const onChanged = vi.fn()
    show({ isMaster: true, locations, displays, onChanged })
    fireEvent.change(screen.getByLabelText('Device name'), { target: { value: ' hatch-screen2 ' } })
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Back wall' } })
    fireEvent.change(screen.getByLabelText('Location'), { target: { value: 'loc-hatch' } })
    fireEvent.change(screen.getByLabelText('Display'), { target: { value: 'disp-h1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Register screen' }))
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1))
    expect(fetchFn.mock.calls[0][0]).toBe('/api/admin/fleet/devices')
    expect(fetchFn.mock.calls[0][1].method).toBe('POST')
    expect(JSON.parse(fetchFn.mock.calls[0][1].body)).toEqual({
      device_name: 'hatch-screen2',
      location_id: 'loc-hatch',
      role: 'screen',
      label: 'Back wall',
      tv_display_id: 'disp-h1',
    })
  })

  it('does not submit without a device name and a location', () => {
    const fetchFn = stubFetch()
    show({ isMaster: true, locations, displays })
    fireEvent.click(screen.getByRole('button', { name: 'Register screen' }))
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('says a duplicate name already exists', async () => {
    stubFetch(409, { ok: false, error: 'exists' })
    const onChanged = vi.fn()
    show({ isMaster: true, locations, displays, onChanged })
    fireEvent.change(screen.getByLabelText('Device name'), { target: { value: 'hatch-screen1' } })
    fireEvent.change(screen.getByLabelText('Location'), { target: { value: 'loc-hatch' } })
    fireEvent.click(screen.getByRole('button', { name: 'Register screen' }))
    expect(await screen.findByText('A device with that name already exists.')).toBeTruthy()
    expect(onChanged).not.toHaveBeenCalled()
  })
})
