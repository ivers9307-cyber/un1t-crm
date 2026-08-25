// @vitest-environment jsdom
//
// WAVEGEN.1 — the staff wave editor's bulk generator: start, end,
// cadence, capacity → Generate populates the wave list (replacing what
// was there), and the rows remain individually editable.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent, screen } from '@testing-library/react'
import RaceEventForm from './RaceEventForm.jsx'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
}))

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('RaceEventForm — wave generator', () => {
  it('generates the wave rows from start/end/cadence/capacity and replaces the list', () => {
    const { container } = render(<RaceEventForm race={null} locationId="loc-1" />)

    const timeInputs = () => [...container.querySelectorAll('input[type="time"]')]
    // Generator's two time inputs are the first two inside the Generate panel;
    // find them by their titles to stay robust against other time inputs.
    const start = container.querySelector('input[title="First wave start time"]')
    const end = container.querySelector('input[title="Last wave start time"]')
    const every = container.querySelector('input[title="Minutes between wave starts"]')
    const cap = container.querySelector('input[title="Capacity per wave (empty = unlimited)"]')

    // Button is disabled until the inputs describe a real series.
    const button = screen.getByRole('button', { name: /^Generate/ })
    expect(button.disabled).toBe(true)

    fireEvent.change(start, { target: { value: '10:00' } })
    fireEvent.change(end, { target: { value: '10:21' } })
    fireEvent.change(every, { target: { value: '7' } })
    fireEvent.change(cap, { target: { value: '2' } })

    // Live count in the label, then generate.
    const armed = screen.getByRole('button', { name: /Generate 4 waves/ })
    expect(armed.disabled).toBe(false)
    fireEvent.click(armed)

    // The editable list now holds exactly the generated rows (the
    // default 09:00 seed row was replaced), each with capacity 2.
    const rowTimes = timeInputs()
      .filter((i) => i !== start && i !== end)
      .map((i) => i.value)
    expect(rowTimes).toEqual(['10:00', '10:07', '10:14', '10:21'])

    const capacityValues = [...container.querySelectorAll('input[title="Max teams in this wave (empty = unlimited)"]')]
      .map((i) => i.value)
    expect(capacityValues).toEqual(['2', '2', '2', '2'])
  })
})
