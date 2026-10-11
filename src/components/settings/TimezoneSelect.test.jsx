// @vitest-environment jsdom
// TZ.2 — the searchable location timezone picker (D1 = A) and its D8 country hint.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react'
import { renderToString } from 'react-dom/server'
import TimezoneSelect from './TimezoneSelect.jsx'
import { COMMON_ZONES } from '@/lib/timezone-options'

afterEach(() => cleanup())

const JULY = Date.parse('2026-07-01T12:00:00Z')
const optionValues = () => within(screen.getByLabelText(/^Timezone/)).getAllByRole('option').map((o) => o.value)

describe('TimezoneSelect', () => {
  it('lists the common zones first, then the rest, with the current offset beside each', () => {
    render(<TimezoneSelect value="Europe/Dublin" onChange={() => {}} nowMs={JULY} />)
    const values = optionValues()
    expect(values.slice(0, COMMON_ZONES.length)).toEqual([...COMMON_ZONES])
    expect(values.length).toBeGreaterThan(300)
    expect(screen.getByRole('option', { name: 'Europe/Dublin (GMT+1)' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'America/New York (GMT-4)' })).toBeTruthy()
    expect(screen.getByLabelText(/^Timezone/).value).toBe('Europe/Dublin')
  })

  it('typing "york" filters to America/New_York; choosing it calls onChange with the zone', () => {
    const onChange = vi.fn()
    render(<TimezoneSelect value="Europe/Dublin" onChange={onChange} nowMs={JULY} />)
    fireEvent.change(screen.getByLabelText('Search timezones'), { target: { value: 'york' } })
    // The current value stays selectable so the select never shows a value it lacks.
    expect(optionValues()).toEqual(['Europe/Dublin', 'America/New_York'])
    fireEvent.change(screen.getByLabelText(/^Timezone/), { target: { value: 'America/New_York' } })
    expect(onChange).toHaveBeenCalledWith('America/New_York')
  })

  it('says so when nothing matches', () => {
    render(<TimezoneSelect value="Europe/Dublin" onChange={() => {}} nowMs={JULY} />)
    fireEvent.change(screen.getByLabelText('Search timezones'), { target: { value: 'atlantis' } })
    expect(screen.getByText(/No timezone matches/)).toBeTruthy()
  })

  it('country AU on Europe/Dublin shows the mismatch hint (a warning, the value stays)', () => {
    render(<TimezoneSelect value="Europe/Dublin" country="AU" onChange={() => {}} nowMs={JULY} />)
    expect(screen.getByRole('status').textContent).toMatch(/Country is AU but the timezone is Europe\/Dublin\. Is that right\?/)
    expect(screen.getByLabelText(/^Timezone/).value).toBe('Europe/Dublin')
  })

  it('no hint when the zone fits the country', () => {
    render(<TimezoneSelect value="Australia/Perth" country="AU" onChange={() => {}} nowMs={JULY} />)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('the select is required', () => {
    render(<TimezoneSelect value="Europe/Dublin" onChange={() => {}} nowMs={JULY} />)
    expect(screen.getByLabelText(/^Timezone/).required).toBe(true)
  })

  it('the server render lists only the common zones plus the value (no runtime-specific list to mismatch on hydration)', () => {
    const html = renderToString(<TimezoneSelect value="Asia/Tokyo" onChange={() => {}} nowMs={JULY} />)
    const values = [...html.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1])
    expect(values).toEqual([...COMMON_ZONES, 'Asia/Tokyo'])
  })
})
