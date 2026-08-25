// @vitest-environment jsdom
//
// SHELLY-UI.6 — the energy strip. The route zero-fills the whole range, so
// three values that look alike arrive together and must not render alike:
//   kwh 0 + samples 0  → a day with no reading
//   kwh 0 + samples >0 → a real, measured, flat day
//   kwh null           → a row whose wh_total could not be read

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import ShellyEnergyChart, { dayKind } from './ShellyEnergyChart.jsx'

const day = (d, kwh, samples = 24) => ({ day: d, kwh, samples, resets: 0 })

function mockEnergy(body, status = 200) {
  global.fetch = vi.fn(async () => ({ ok: status < 400, status, json: async () => body }))
}

beforeEach(() => { vi.clearAllMocks() })
afterEach(() => { cleanup(); delete global.fetch })

describe('ShellyEnergyChart', () => {
  it('fetches the device’s own energy for the requested range', async () => {
    mockEnergy({ success: true, device_id: 'dev-1', from: '2026-08-21', to: '2026-08-23', days: [day('2026-08-23', 1)] })
    render(<ShellyEnergyChart deviceId="dev-1" days={7} />)
    await waitFor(() => expect(global.fetch).toHaveBeenCalled())
    expect(String(global.fetch.mock.calls[0][0])).toBe('/api/shelly/devices/dev-1/energy?days=7')
  })

  it('shows the empty state when nothing has ever been sampled', async () => {
    mockEnergy({
      success: true, device_id: 'dev-1', from: '2026-08-21', to: '2026-08-23',
      days: [day('2026-08-21', 0, 0), day('2026-08-22', 0, 0), day('2026-08-23', 0, 0)],
    })
    render(<ShellyEnergyChart deviceId="dev-1" />)
    await waitFor(() => expect(screen.getByText(/No energy data yet — readings accrue once the plug is online/)).toBeTruthy())
  })

  it('a measured but flat day is NOT the empty state', async () => {
    mockEnergy({
      success: true, device_id: 'dev-1', from: '2026-08-22', to: '2026-08-23',
      days: [day('2026-08-22', 0, 24), day('2026-08-23', 0, 12)],
    })
    render(<ShellyEnergyChart deviceId="dev-1" />)
    await waitFor(() => expect(screen.getByText('0.0 kWh over 2 days')).toBeTruthy())
    expect(screen.queryByText(/No energy data yet/)).toBeNull()
  })

  it('totals the range to one decimal place and labels each bar', async () => {
    mockEnergy({
      success: true, device_id: 'dev-1', from: '2026-08-21', to: '2026-08-23',
      days: [day('2026-08-21', 1.25), day('2026-08-22', 2.5), day('2026-08-23', 0.4)],
    })
    render(<ShellyEnergyChart deviceId="dev-1" />)
    await waitFor(() => expect(screen.getByText('4.2 kWh over 3 days')).toBeTruthy())
    expect(screen.getByTitle('2026-08-22: 2.5 kWh')).toBeTruthy()
  })

  it('renders an unreadable day as "?" rather than as a zero bar', async () => {
    mockEnergy({
      success: true, device_id: 'dev-1', from: '2026-08-22', to: '2026-08-23',
      days: [{ day: '2026-08-22', kwh: null, samples: 6, resets: 0 }, day('2026-08-23', 3)],
    })
    render(<ShellyEnergyChart deviceId="dev-1" />)
    await waitFor(() => expect(screen.getByTitle('2026-08-22: reading unavailable')).toBeTruthy())
    expect(screen.getByTitle('2026-08-22: reading unavailable').textContent).toBe('?')
    // A null day contributes nothing to the total — it is the absence of a
    // measurement, not a measurement of zero.
    expect(screen.getByText('3.0 kWh over 2 days')).toBeTruthy()
  })

  it('marks today’s bar differently — it is a part-day, not a comparison', async () => {
    mockEnergy({
      success: true, device_id: 'dev-1', from: '2026-08-22', to: '2026-08-23',
      days: [day('2026-08-22', 4), day('2026-08-23', 1)],
    })
    render(<ShellyEnergyChart deviceId="dev-1" />)
    await waitFor(() => expect(screen.getByTitle('2026-08-23: 1.0 kWh')).toBeTruthy())
    // `to` is the LOCATION's today, computed by the route — never the
    // browser's clock.
    expect(screen.getByTitle('2026-08-23: 1.0 kWh').className).toContain('bg-un1t-accent/30')
    expect(screen.getByTitle('2026-08-22: 4.0 kWh').className).toContain('bg-un1t-accent/70')
  })

  it('tells a GAP, a FLAT day, an UNREADABLE day and a real value apart', async () => {
    mockEnergy({
      success: true, device_id: 'dev-1', from: '2026-08-20', to: '2026-08-23',
      days: [
        { day: '2026-08-20', kwh: 0, samples: 0, resets: 0 },   // no reading at all
        { day: '2026-08-21', kwh: 0, samples: 24, resets: 0 },  // measured, drew nothing
        { day: '2026-08-22', kwh: null, samples: 6, resets: 0 },// row we could not read
        { day: '2026-08-23', kwh: 2.5, samples: 12, resets: 0 },// a real value
      ],
    })
    render(<ShellyEnergyChart deviceId="dev-1" />)
    await waitFor(() => expect(screen.getByTitle('2026-08-23: 2.5 kWh')).toBeTruthy())

    const gap = screen.getByTitle('2026-08-20: No reading')
    const flat = screen.getByTitle('2026-08-21: 0.0 kWh')
    const unreadable = screen.getByTitle('2026-08-22: reading unavailable')
    const value = screen.getByTitle('2026-08-23: 2.5 kWh')

    // Four distinct titles, and three visually distinct non-proportional kinds.
    expect(new Set([gap, flat, unreadable, value]).size).toBe(4)
    expect(gap.className).toContain('border-dotted')
    expect(unreadable.className).toContain('border-dashed')
    expect(unreadable.textContent).toBe('?')
    // A measured zero is a SOLID bar — drawing it like the gap above would
    // read a month of outage as a month of an idle plug.
    expect(flat.className).toContain('bg-un1t-accent')
    expect(flat.className).not.toContain('border-dotted')
    expect(value.className).toContain('bg-un1t-accent')
    // Only the null day contributes nothing to the total.
    expect(screen.getByText('2.5 kWh over 4 days')).toBeTruthy()
  })

  it('dayKind classifies the four shapes the route can emit', () => {
    expect(dayKind({ kwh: null, samples: 6 })).toBe('unreadable')
    expect(dayKind({ kwh: 0, samples: 0 })).toBe('gap')
    expect(dayKind({ kwh: 0, samples: 24 })).toBe('flat')
    expect(dayKind({ kwh: 1.2, samples: 24 })).toBe('value')
    // A zero-filled day the route wrote with no row at all.
    expect(dayKind({ day: '2026-08-20', kwh: 0, samples: 0, resets: 0 })).toBe('gap')
  })

  it('surfaces a route failure instead of an empty chart', async () => {
    mockEnergy({ success: false, error: 'Could not load this device’s energy history' }, 500)
    render(<ShellyEnergyChart deviceId="dev-1" />)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('energy history'))
  })

  it('surfaces a 400 through issues[0].message', async () => {
    mockEnergy({ success: false, error: 'Invalid request', issues: [{ message: 'days must be 1–90' }] }, 400)
    render(<ShellyEnergyChart deviceId="dev-1" />)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('days must be 1–90'))
  })
})
