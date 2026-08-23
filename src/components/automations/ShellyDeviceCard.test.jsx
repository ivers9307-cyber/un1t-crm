// @vitest-environment jsdom
//
// SHELLY-UI.6 — the device card. Every test below pins a rule the SHIPPED
// routes depend on, and each one is a lie the card could tell:
//
//   * output:null renders "Unknown", never "Off" — an offline plug reports
//     nothing about its relay, and "Off" would say a heater is safe when
//     nobody knows that it is
//   * a { pending: true } toggle DOES NOT paint the new state — the override
//     is saved, the relay has not moved
//   * an UNMANAGED device gets no duration presets and no countdown: plan.js
//     rule 2 returns before rule 4, so its override is never expired and the
//     relay stays as set
//   * `auto` has three reasons, not two
//   * Remove is two-step and names the energy history it destroys

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import ShellyDeviceCard, { overrideUntilLabel } from './ShellyDeviceCard.jsx'

const NOW = Date.now()
const iso = (offsetMs = 0) => new Date(NOW + offsetMs).toISOString()

const state = (over = {}) => ({
  online: true, output: true, apower: 42.4, aenergy_wh: 1200,
  temperature_c: 31, source: 'schedule', at: iso(-30_000), ...over,
})

// MANAGED: enabled AND a schedule — `until` is a real expiry.
const managed = (over = {}) => ({
  id: 'row-1',
  location_id: 'loc-1',
  device_id: 'aabbccddeeff',
  channel: 0,
  name: 'Sauna plug',
  model: 'SNPL-00112EU',
  gen: 2,
  zone: null,
  enabled: true,
  schedule_mode: 'fixed',
  fixed_windows: [{ days: [1, 2, 3, 4, 5], on: '06:00', off: '21:00' }],
  class_rule: {},
  override: null,
  last_applied: null,
  last_state: state(),
  last_seen_at: iso(-30_000),
  created_at: iso(-86_400_000),
  updated_at: iso(-30_000),
  ...over,
})

// UNMANAGED: no schedule runs it, so nothing will ever put it back.
const unmanaged = (over = {}) => managed({ enabled: false, schedule_mode: 'none', fixed_windows: [], ...over })

const json = (status, body) => ({ ok: status < 400, status, json: async () => body })

function routes(handler) {
  global.fetch = vi.fn(async (url, init = {}) => handler(String(url), init))
}

beforeEach(() => { vi.clearAllMocks() })
afterEach(() => { cleanup(); delete global.fetch })

describe('ShellyDeviceCard — what it is doing', () => {
  it('renders "Unknown" for output:null, never "Off"', () => {
    render(<ShellyDeviceCard device={managed({ last_state: state({ output: null, apower: null }) })} connected glofoxConnected />)
    expect(screen.getByText('Unknown')).toBeTruthy()
    expect(screen.queryByText('Off', { selector: 'span' })).toBeNull()
  })

  it('renders On / Off for the two known states', () => {
    const { unmount } = render(<ShellyDeviceCard device={managed()} connected glofoxConnected />)
    expect(screen.getByText('On', { selector: 'span' })).toBeTruthy()
    unmount()
    render(<ShellyDeviceCard device={managed({ last_state: state({ output: false }) })} connected glofoxConnected />)
    expect(screen.getByText('Off', { selector: 'span' })).toBeTruthy()
  })

  it('rounds watts, and shows a dash rather than a zero when there is no reading', () => {
    const { unmount } = render(<ShellyDeviceCard device={managed()} connected glofoxConnected />)
    expect(screen.getByText(/42 W/)).toBeTruthy()
    unmount()
    render(<ShellyDeviceCard device={managed({ last_state: state({ apower: null }) })} connected glofoxConnected />)
    expect(screen.getByText(/—/)).toBeTruthy()
  })

  it('composes a placeholder name at render time when the row has none', () => {
    render(<ShellyDeviceCard device={managed({ name: null })} connected glofoxConnected />)
    expect(screen.getByRole('button', { name: /SNPL-00112EU · eeff/ })).toBeTruthy()
  })

  it('badges a non-zero channel', () => {
    const { unmount } = render(<ShellyDeviceCard device={managed({ channel: 2 })} connected glofoxConnected />)
    expect(screen.getByText('Channel 2')).toBeTruthy()
    unmount()
    render(<ShellyDeviceCard device={managed({ channel: 0 })} connected glofoxConnected />)
    expect(screen.queryByText(/^Channel /)).toBeNull()
  })

  it('grades health off the connection first — a disconnected location is dormant, not stale', () => {
    render(<ShellyDeviceCard device={managed({ last_seen_at: iso(-3 * 3600_000) })} connected={false} glofoxConnected />)
    expect(screen.getByText('Not connected')).toBeTruthy()
    expect(screen.queryByText(/Stale/)).toBeNull()
  })
})

describe('ShellyDeviceCard — managed vs unmanaged toggling', () => {
  it('a managed device offers the duration presets and Back to schedule', () => {
    render(<ShellyDeviceCard device={managed()} connected glofoxConnected />)
    expect(screen.getByLabelText('How long')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Back to schedule/ })).toBeTruthy()
    expect(screen.queryByText(/stays as you set it until you change it/)).toBeNull()
  })

  it('an unmanaged device has NO presets, NO back-to-schedule, and says it holds', () => {
    render(<ShellyDeviceCard device={unmanaged()} connected glofoxConnected />)
    expect(screen.queryByLabelText('How long')).toBeNull()
    expect(screen.queryByRole('button', { name: /Back to schedule/ })).toBeNull()
    expect(screen.getByText('No schedule runs this plug — it stays as you set it until you change it.')).toBeTruthy()
  })

  it('an enabled device with schedule_mode none is still unmanaged', () => {
    render(<ShellyDeviceCard device={managed({ schedule_mode: 'none' })} connected glofoxConnected />)
    expect(screen.queryByLabelText('How long')).toBeNull()
  })

  it('"Until midnight" sends NO until — the route computes the location’s midnight', async () => {
    let body = null
    routes((url, init) => {
      if (url.endsWith('/toggle')) { body = JSON.parse(init.body); return json(200, { success: true, device: managed(), applied: true, holds_until_changed: false }) }
      return json(200, { success: true })
    })
    render(<ShellyDeviceCard device={managed()} connected glofoxConnected onChanged={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'On' }))
    await waitFor(() => expect(body).toEqual({ state: 'on' }))
  })

  it('an hour preset sends an explicit until', async () => {
    let body = null
    routes((url, init) => {
      if (url.endsWith('/toggle')) { body = JSON.parse(init.body); return json(200, { success: true, device: managed(), applied: true }) }
      return json(200, { success: true })
    })
    render(<ShellyDeviceCard device={managed()} connected glofoxConnected onChanged={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('How long'), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: 'Off' }))
    await waitFor(() => expect(body?.state).toBe('off'))
    const deltaH = (Date.parse(body.until) - Date.now()) / 3600_000
    expect(deltaH).toBeGreaterThan(2.9)
    expect(deltaH).toBeLessThan(3.1)
  })

  it('the toggle strip is dead with no connection', () => {
    render(<ShellyDeviceCard device={managed()} connected={false} glofoxConnected />)
    expect(screen.getByRole('button', { name: 'On' }).disabled).toBe(true)
    expect(screen.getByRole('button', { name: 'Off' }).disabled).toBe(true)
  })

  it('an OFFLINE plug can still be pre-set — the override is queued, not lost', () => {
    // The toggle route writes the override BEFORE it sends anything and the
    // cron applies a live override to every adopted device, so this is a real
    // instruction that lands when the plug wakes up.
    render(<ShellyDeviceCard device={managed({ last_state: state({ online: false, output: null }) })} connected glofoxConnected />)
    const on = screen.getByRole('button', { name: 'On' })
    expect(on.disabled).toBe(false)
    expect(on.getAttribute('title')).toBe('Offline — your choice is queued and applied when the plug is back')
  })

  it('no connection is the ONLY thing that kills the toggle strip, and it says why', () => {
    render(<ShellyDeviceCard device={managed()} connected={false} glofoxConnected />)
    const on = screen.getByRole('button', { name: 'On' })
    expect(on.disabled).toBe(true)
    expect(on.getAttribute('title')).toBe('Connect your Shelly account first')
  })

  it('an uncertain connection leaves the controls ENABLED — it is our read that failed, not the plug', () => {
    render(<ShellyDeviceCard device={managed()} connected={null} glofoxConnected />)
    expect(screen.getByRole('button', { name: 'On' }).disabled).toBe(false)
  })
})

describe('ShellyDeviceCard — pending is not applied', () => {
  it('does NOT paint the new state and shows the queued copy', async () => {
    routes((url) => url.endsWith('/toggle')
      ? json(200, {
        success: true,
        device: managed({ override: { state: 'on', until: iso(3600_000), set_by: 'u1', set_at: iso() } }),
        applied: false, pending: true, code: 'pending', kind: 'device',
        message: 'Saved. The plug is not answering — it will follow as soon as it is back online.',
        holds_until_changed: false,
      })
      : json(200, { success: true }))
    render(<ShellyDeviceCard device={managed({ last_state: state({ output: false }) })} connected glofoxConnected onChanged={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'On' }))
    // The ROUTE's sentence wins — it was written against the failure it saw.
    await waitFor(() => expect(screen.getByRole('status').textContent)
      .toContain('Saved. The plug is not answering — it will follow as soon as it is back online.'))
    // The rendered relay state still comes from the ROW, which nobody moved.
    expect(screen.getByText('Off', { selector: 'span' })).toBeTruthy()
    expect(screen.queryByText('Switched on.')).toBeNull()
  })

  it('falls back to our own queued copy when the body carried no message', async () => {
    routes((url) => url.endsWith('/toggle')
      ? json(200, { success: true, device: managed(), applied: false, pending: true, code: 'pending' })
      : json(200, { success: true }))
    render(<ShellyDeviceCard device={managed()} connected glofoxConnected onChanged={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'On' }))
    await waitFor(() => expect(screen.getByText('Queued — the plug will follow when it is back online.')).toBeTruthy())
  })

  it('key_rejected points at the key, rate_limited at the wait, bad_host at the settings', async () => {
    for (const [code, needle] of [
      ['key_rejected', 're-paste the Shelly key above'],
      ['rate_limited', 'Shelly is busy right now'],
      ['bad_host', 'fix the Shelly server in the connection settings'],
    ]) {
      routes((url) => url.endsWith('/toggle')
        ? json(code === 'rate_limited' ? 429 : 200, { success: true, device: managed(), applied: false, pending: true, code })
        : json(200, { success: true }))
      render(<ShellyDeviceCard device={managed()} connected glofoxConnected onChanged={vi.fn()} />)
      fireEvent.click(screen.getByRole('button', { name: 'On' }))
      await waitFor(() => expect(screen.getByRole('status').textContent).toContain(needle))
      cleanup()
    }
  })

  it('an unmapped pending code still says something true — the route’s own sentence', async () => {
    routes((url) => url.endsWith('/toggle')
      ? json(200, { success: true, device: managed(), applied: false, pending: true, code: 'something_new', message: 'Saved. Shelly cloud is not answering.' })
      : json(200, { success: true }))
    render(<ShellyDeviceCard device={managed()} connected glofoxConnected onChanged={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'On' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Saved. Shelly cloud is not answering.'))
  })
})

describe('ShellyDeviceCard — the override banner', () => {
  it('a managed override shows its expiry', () => {
    const until = iso(4 * 3600_000)
    render(<ShellyDeviceCard connected glofoxConnected
      device={managed({ override: { state: 'on', until, set_by: 'u1', set_at: iso(-120_000) } })} />)
    const banner = screen.getByText(/Forced ON until/)
    expect(banner.textContent).toContain('— set')
  })

  it('an UNMANAGED override shows no time at all — nothing will expire it', () => {
    render(<ShellyDeviceCard connected glofoxConnected
      device={unmanaged({ override: { state: 'on', until: iso(4 * 3600_000), set_by: 'u1', set_at: iso(-120_000) } })} />)
    expect(screen.getByText('Forced ON — stays until changed')).toBeTruthy()
    expect(screen.queryByText(/Forced ON until/)).toBeNull()
  })

  it('an UNMANAGED override outlives its `until` — nothing ever closes it', () => {
    // plan.js rule 2 returns before rule 4, so the relay is STILL held long
    // after the timestamp passes. A banner that vanished then would leave a
    // plug forced on with nothing on screen saying so.
    render(<ShellyDeviceCard connected glofoxConnected
      device={unmanaged({ override: { state: 'on', until: iso(-6 * 3600_000), set_by: 'u1', set_at: iso(-8 * 3600_000) } })} />)
    expect(screen.getByText('Forced ON — stays until changed')).toBeTruthy()
  })

  it('a managed override DOES expire at its `until`', () => {
    render(<ShellyDeviceCard connected glofoxConnected
      device={managed({ override: { state: 'on', until: iso(-60_000), set_by: 'u1', set_at: iso(-3600_000) } })} />)
    expect(screen.queryByText(/Forced/)).toBeNull()
  })

  it('an override the planner cannot read is not live either, managed or not', () => {
    const { unmount } = render(<ShellyDeviceCard connected glofoxConnected
      device={managed({ override: { state: 'weird', until: iso(3600_000) } })} />)
    expect(screen.queryByText(/Forced/)).toBeNull()
    unmount()
    render(<ShellyDeviceCard connected glofoxConnected
      device={unmanaged({ override: { state: 'weird', until: iso(3600_000) } })} />)
    expect(screen.queryByText(/Forced/)).toBeNull()
  })

  it('takes holds_until_changed from the toggle RESPONSE for the render right after it', async () => {
    // The row on screen still says managed; the route says this override will
    // hold. The route saw the row as it was when it acted.
    routes((url) => url.endsWith('/toggle')
      ? json(200, {
        success: true,
        device: managed({ override: { state: 'on', until: iso(3600_000), set_by: 'u1', set_at: iso() } }),
        applied: true, holds_until_changed: true,
        notice: 'No schedule is running this plug, so it stays as you set it until you change it',
      })
      : json(200, { success: true }))
    render(<ShellyDeviceCard connected glofoxConnected onChanged={vi.fn()}
      device={managed({ override: { state: 'on', until: iso(3600_000), set_by: 'u1', set_at: iso() } })} />)
    expect(screen.getByText(/Forced ON until/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'On' }))
    await waitFor(() => expect(screen.getByText('Forced ON — stays until changed')).toBeTruthy())
  })
})

describe('ShellyDeviceCard — back to schedule', () => {
  const autoReply = (reason) => json(200, { success: true, device: managed({ override: null }), applied: null, reason })

  it('renders all three noop reasons distinctly', async () => {
    for (const [reason, copy] of [
      ['disabled', 'Schedule is switched off — turn it on first.'],
      ['no_schedule', 'No schedule to return to.'],
      ['nothing_to_do', 'Already on schedule.'],
    ]) {
      routes((url) => (url.endsWith('/toggle') ? autoReply(reason) : json(200, { success: true })))
      render(<ShellyDeviceCard device={managed()} connected glofoxConnected onChanged={vi.fn()} />)
      fireEvent.click(screen.getByRole('button', { name: /Back to schedule/ }))
      await waitFor(() => expect(screen.getByRole('status').textContent).toContain(copy))
      cleanup()
    }
  })

  it('reports the action when the schedule did move the relay', async () => {
    routes((url) => (url.endsWith('/toggle')
      ? json(200, { success: true, device: managed(), applied: 'off', reason: 'window_closed' })
      : json(200, { success: true })))
    render(<ShellyDeviceCard device={managed()} connected glofoxConnected onChanged={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Back to schedule/ }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Back on schedule — switched off.'))
  })

  it('a failure body’s reassurance is rendered — it lives in `error`', async () => {
    routes((url) => (url.endsWith('/toggle')
      ? json(409, {
        success: false, code: 'key_rejected',
        error: 'Shelly rejected the stored key — re-paste it from the Shelly app. The device is back on its schedule and will resume at the next boundary.',
      })
      : json(200, { success: true })))
    render(<ShellyDeviceCard device={managed()} connected glofoxConnected onChanged={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Back to schedule/ }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('will resume at the next boundary'))
  })
})

describe('ShellyDeviceCard — the schedule switch and run now', () => {
  it('cannot be enabled with a fixed mode and no windows', () => {
    render(<ShellyDeviceCard connected glofoxConnected
      device={managed({ enabled: false, fixed_windows: [] })} />)
    expect(screen.getByLabelText('Schedule on').disabled).toBe(true)
  })

  it('can be enabled with a fixed mode and a window', () => {
    render(<ShellyDeviceCard device={managed({ enabled: false })} connected glofoxConnected />)
    expect(screen.getByLabelText('Schedule on').disabled).toBe(false)
  })

  it('class mode needs Glofox to be enableable', () => {
    const { unmount } = render(<ShellyDeviceCard connected glofoxConnected={false}
      device={managed({ enabled: false, schedule_mode: 'class', fixed_windows: [] })} />)
    expect(screen.getByLabelText('Schedule on').disabled).toBe(true)
    unmount()
    render(<ShellyDeviceCard connected glofoxConnected
      device={managed({ enabled: false, schedule_mode: 'class', fixed_windows: [] })} />)
    expect(screen.getByLabelText('Schedule on').disabled).toBe(false)
  })

  it('turning a schedule OFF is never blocked by the state it is in', () => {
    render(<ShellyDeviceCard connected glofoxConnected={false}
      device={managed({ enabled: true, schedule_mode: 'class', fixed_windows: [] })} />)
    expect(screen.getByLabelText('Schedule on').disabled).toBe(false)
  })

  it('shows the route’s notice when switching the schedule off leaves the relay on', async () => {
    const notice = 'Schedule switched off — the plug stays as it is until you toggle it'
    routes((url, init) => (init.method === 'PATCH'
      ? json(200, { success: true, device: managed({ enabled: false }), notice })
      : json(200, { success: true })))
    render(<ShellyDeviceCard device={managed()} connected glofoxConnected onChanged={vi.fn()} />)
    fireEvent.click(screen.getByLabelText('Schedule on'))
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain(notice))
  })

  it('Run now is dead only when there is definitely no connection', () => {
    const { unmount } = render(<ShellyDeviceCard device={managed()} connected={false} glofoxConnected />)
    const dead = screen.getByRole('button', { name: /Run now/ })
    expect(dead.disabled).toBe(true)
    expect(dead.getAttribute('title')).toBe('Connect your Shelly account first')
    unmount()
    render(<ShellyDeviceCard device={managed()} connected glofoxConnected />)
    expect(screen.getByRole('button', { name: /Run now/ }).disabled).toBe(false)
  })

  it('an UNKNOWN connection leaves Run now alive — the route answers its own 409', () => {
    // connected:null is our read failing, not the studio's. Disabling here
    // would turn a database blip on our side into a dead control.
    render(<ShellyDeviceCard device={managed()} connected={null} glofoxConnected />)
    expect(screen.getByRole('button', { name: /Run now/ }).disabled).toBe(false)
  })

  it('Run now is dead for a device with no schedule, and names the reason', () => {
    const { unmount } = render(<ShellyDeviceCard device={unmanaged()} connected glofoxConnected />)
    const noSchedule = screen.getByRole('button', { name: /Run now/ })
    expect(noSchedule.disabled).toBe(true)
    expect(noSchedule.getAttribute('title')).toBe('This plug has no schedule to apply')
    unmount()
    render(<ShellyDeviceCard device={managed({ enabled: false })} connected glofoxConnected />)
    const off = screen.getByRole('button', { name: /Run now/ })
    expect(off.disabled).toBe(true)
    expect(off.getAttribute('title')).toBe('Turn the schedule on first')
  })

  it('Run now renders applied and the already-correct noop', async () => {
    routes((url) => (url.endsWith('/run-now')
      ? json(200, { success: true, applied: 'on', reason: 'window_open' })
      : json(200, { success: true })))
    const { unmount } = render(<ShellyDeviceCard device={managed()} connected glofoxConnected onChanged={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Run now/ }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Applied — switched on.'))
    unmount()

    routes((url) => (url.endsWith('/run-now') ? json(200, { success: true, applied: null, reason: null }) : json(200, { success: true })))
    render(<ShellyDeviceCard device={managed()} connected glofoxConnected onChanged={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Run now/ }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Already matching its schedule.'))
  })

  it('Run now surfaces the 409 refusals as the route worded them', async () => {
    routes((url) => (url.endsWith('/run-now')
      ? json(409, { success: false, code: 'disabled', error: "This device's schedule is switched off — turn it on first" })
      : json(200, { success: true })))
    render(<ShellyDeviceCard device={managed()} connected glofoxConnected onChanged={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Run now/ }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('switched off — turn it on first'))
  })
})

describe('ShellyDeviceCard — rename', () => {
  it('PATCHes the new name', async () => {
    let body = null
    routes((url, init) => {
      if (init.method === 'PATCH') { body = JSON.parse(init.body); return json(200, { success: true, device: managed({ name: 'Sauna' }) }) }
      return json(200, { success: true })
    })
    render(<ShellyDeviceCard device={managed()} connected glofoxConnected onChanged={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Sauna plug/ }))
    fireEvent.change(screen.getByLabelText('Device name'), { target: { value: 'Sauna' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(body).toEqual({ name: 'Sauna' }))
  })

  it('refuses an empty name locally — no PATCH is spent on a guaranteed 400', async () => {
    routes(() => json(200, { success: true }))
    render(<ShellyDeviceCard device={managed()} connected glofoxConnected onChanged={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Sauna plug/ }))
    fireEvent.change(screen.getByLabelText('Device name'), { target: { value: '  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Give the device a name'))
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('an unchanged name just closes the editor — a no-op PATCH would still bump updated_at', async () => {
    routes(() => json(200, { success: true }))
    render(<ShellyDeviceCard device={managed()} connected glofoxConnected onChanged={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Sauna plug/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.queryByLabelText('Device name')).toBeNull())
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('Enter saves and Escape cancels', async () => {
    let body = null
    routes((url, init) => {
      if (init.method === 'PATCH') { body = JSON.parse(init.body); return json(200, { success: true, device: managed({ name: 'Sauna' }) }) }
      return json(200, { success: true })
    })
    const { unmount } = render(<ShellyDeviceCard device={managed()} connected glofoxConnected onChanged={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Sauna plug/ }))
    fireEvent.change(screen.getByLabelText('Device name'), { target: { value: 'Sauna' } })
    fireEvent.keyDown(screen.getByLabelText('Device name'), { key: 'Enter' })
    await waitFor(() => expect(body).toEqual({ name: 'Sauna' }))
    unmount()

    routes(() => json(200, { success: true }))
    render(<ShellyDeviceCard device={managed()} connected glofoxConnected onChanged={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Sauna plug/ }))
    fireEvent.change(screen.getByLabelText('Device name'), { target: { value: 'Something else' } })
    fireEvent.keyDown(screen.getByLabelText('Device name'), { key: 'Escape' })
    expect(screen.queryByLabelText('Device name')).toBeNull()
    expect(screen.getByRole('button', { name: /Sauna plug/ })).toBeTruthy()
    expect(global.fetch).not.toHaveBeenCalled()
  })
})

describe('overrideUntilLabel — the STUDIO’s clock, not the reader’s', () => {
  // A New York studio read from a Dublin laptop. The route computed `until`
  // as NY's next local midnight; rendering it in the browser's zone would
  // print 05:00 and be five hours wrong about what the engine will do.
  const NY = 'America/New_York'
  const nowNy = Date.parse('2026-08-23T18:00:00Z') // 14:00 Sun in NY

  it('shows a bare time when it lands on the studio’s today', () => {
    // 21:00 EDT the same NY day.
    expect(overrideUntilLabel('2026-08-24T01:00:00Z', nowNy, NY)).toBe('21:00')
  })

  it('says "tomorrow" for the studio’s next day — which is what "until midnight" is', () => {
    // 00:00 EDT Monday: midnight in NY, and the default preset's answer.
    expect(overrideUntilLabel('2026-08-24T04:00:00Z', nowNy, NY)).toBe('00:00 tomorrow')
  })

  it('names the weekday when it is further out than tomorrow', () => {
    // 02:00 EDT on Tuesday.
    expect(overrideUntilLabel('2026-08-25T06:00:00Z', nowNy, NY)).toBe('Tue 02:00')
  })

  it('the same instant reads differently in the two zones — which is the point', () => {
    const instant = '2026-08-24T04:00:00Z'
    expect(overrideUntilLabel(instant, nowNy, NY)).toBe('00:00 tomorrow')
    expect(overrideUntilLabel(instant, nowNy, 'Europe/Dublin')).toBe('05:00 tomorrow')
  })

  it('an unusable zone costs the day qualifier, never the banner', () => {
    expect(overrideUntilLabel('2026-08-24T04:00:00Z', nowNy, 'Not/AZone')).toBe('04:00')
  })

  it('an unparseable until renders nothing rather than "Invalid Date"', () => {
    expect(overrideUntilLabel('nonsense', nowNy, NY)).toBe('')
    expect(overrideUntilLabel(null, nowNy, NY)).toBe('')
  })
})

describe('ShellyDeviceCard — the override banner names its zone', () => {
  it('renders the studio’s time and says which clock it is', () => {
    const nowMs = Date.now()
    render(<ShellyDeviceCard connected glofoxConnected locationTz="America/New_York"
      device={managed({ override: { state: 'on', until: new Date(nowMs + 3 * 3600_000).toISOString(), set_by: 'u1', set_at: iso(-60_000) } })} />)
    const banner = screen.getByText(/Forced ON until/)
    expect(banner.getAttribute('title')).toBe('Times shown in America/New_York')
  })

  it('an unmanaged banner carries no zone title — it shows no time to qualify', () => {
    render(<ShellyDeviceCard connected glofoxConnected locationTz="America/New_York"
      device={unmanaged({ override: { state: 'on', until: iso(3600_000), set_by: 'u1', set_at: iso(-60_000) } })} />)
    expect(screen.getByText('Forced ON — stays until changed').getAttribute('title')).toBeNull()
  })
})

describe('ShellyDeviceCard — remove', () => {
  it('is two-step and names the energy history it destroys', async () => {
    routes(() => json(200, { success: true, message: 'Removed.' }))
    const onChanged = vi.fn()
    render(<ShellyDeviceCard device={managed()} connected glofoxConnected onChanged={onChanged} />)

    fireEvent.click(screen.getByRole('button', { name: 'Remove plug' }))
    expect(global.fetch).not.toHaveBeenCalled()
    expect(screen.getByText(/Its energy history is deleted with it/)).toBeTruthy()
    expect(screen.getByText(/remove it here and adopt it there/)).toBeTruthy()

    fireEvent.click(screen.getAllByRole('button', { name: 'Remove plug' }).at(-1))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(global.fetch.mock.calls[0][1].method).toBe('DELETE')
  })

  it('treats a 404 as done — the row was already gone', async () => {
    routes(() => json(404, { success: false, error: 'Not found' }))
    const onChanged = vi.fn()
    render(<ShellyDeviceCard device={managed()} connected glofoxConnected onChanged={onChanged} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remove plug' }))
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove plug' }).at(-1))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('backing out sends nothing', () => {
    routes(() => json(200, { success: true }))
    render(<ShellyDeviceCard device={managed()} connected glofoxConnected />)
    fireEvent.click(screen.getByRole('button', { name: 'Remove plug' }))
    fireEvent.click(screen.getByRole('button', { name: /Keep it/ }))
    expect(global.fetch).not.toHaveBeenCalled()
  })
})

describe('ShellyDeviceCard — energy is lazy', () => {
  it('fetches nothing until Energy is expanded', async () => {
    routes(() => json(200, { success: true, device_id: 'row-1', from: '2026-08-01', to: '2026-08-23', days: [] }))
    render(<ShellyDeviceCard device={managed()} connected glofoxConnected />)
    expect(global.fetch).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /Energy/ }))
    await waitFor(() => expect(global.fetch).toHaveBeenCalled())
    expect(String(global.fetch.mock.calls[0][0])).toContain('/api/shelly/devices/row-1/energy?days=30')
  })
})
