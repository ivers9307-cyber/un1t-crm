// @vitest-environment jsdom
//
// SHELLYGROUPS.7 — the day preview strip: a Classes lane, one lane per group,
// % positions on the studio's local day (DST days included), a window across
// local midnight, the joined-windows caption, the override caption (today
// only) and a 502 that never looks like an empty day.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import ShellyDayPreview from './ShellyDayPreview.jsx'

const TZ = 'Europe/Dublin'
const answer = (status, json) => ({ ok: status >= 200 && status < 300, status, json: async () => json })
const groups = [
  { id: 'g1', name: 'Studio lights', sort_order: 0, enabled: true, schedule_mode: 'class', class_rule: { merge_gap_min: 30 } },
  { id: 'g2', name: 'Sauna', sort_order: 1, enabled: true, schedule_mode: 'fixed' },
]
const body = (date, over = {}) => ({
  success: true, date,
  classes: [{ starts_at: `${date}T06:00:00.000Z`, ends_at: `${date}T07:00:00.000Z`, name: 'HIIT' }],
  groups: [{ id: 'g1', windows: [{ on_at: `${date}T05:45:00.000Z`, off_at: `${date}T07:55:00.000Z` }] }, { id: 'g2', windows: [] }],
  ignored_overrides: [],
  ...over,
})

const originalFetch = global.fetch
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-26T12:00:00.000Z')); global.fetch = vi.fn() })
afterEach(() => { cleanup(); vi.useRealTimers(); global.fetch = originalFetch })

const urls = () => global.fetch.mock.calls.map((c) => c[0])

describe('ShellyDayPreview', () => {
  it('draws a Classes lane and one lane per group, with titled blocks', async () => {
    global.fetch.mockResolvedValue(answer(200, body('2026-10-26')))
    render(<ShellyDayPreview groups={groups} tz={TZ} />)
    expect(await screen.findByText('Preview · Monday')).toBeTruthy()
    expect(await screen.findByText('Classes')).toBeTruthy()
    expect(screen.getByText('Studio lights')).toBeTruthy()
    expect(screen.getByText('Sauna')).toBeTruthy()
    expect(urls()[0]).toBe('/api/shelly/preview?date=2026-10-26')
    const block = screen.getByLabelText('Studio lights: On 05:45–07:55')
    expect(block.style.left).toBe(`${(5.75 / 24) * 100}%`)
    expect(screen.getByLabelText('Class HIIT, 06:00–07:00')).toBeTruthy()
  })

  it('steps the local date forwards and back', async () => {
    global.fetch.mockImplementation(async (u) => answer(200, body(String(u).split('=')[1])))
    render(<ShellyDayPreview groups={groups} tz={TZ} />)
    await screen.findByText('Classes')
    fireEvent.click(screen.getByRole('button', { name: 'Next day' }))
    await waitFor(() => expect(urls()).toContain('/api/shelly/preview?date=2026-10-27'))
    expect(await screen.findByText('Preview · Tuesday')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Previous day' }))
    fireEvent.click(screen.getByRole('button', { name: 'Previous day' }))
    await waitFor(() => expect(urls()).toContain('/api/shelly/preview?date=2026-10-25'))
    expect(await screen.findByText('Preview · Sunday')).toBeTruthy()
  })

  it('walks local dates across the clock change (25-hour day) and fills the strip', async () => {
    vi.setSystemTime(new Date('2026-10-24T12:00:00.000Z'))
    // Sun 25 Oct 2026: clocks go back, day is 00:00 IST (23:00Z) → 00:00 GMT next day (00:00Z 26th) = 25 h.
    global.fetch.mockImplementation(async (u) => {
      const d = String(u).split('=')[1]
      return answer(200, body(d, { groups: [{ id: 'g1', windows: [{ on_at: '2026-10-24T23:00:00.000Z', off_at: '2026-10-26T00:00:00.000Z' }] }, { id: 'g2', windows: [] }], classes: [] }))
    })
    render(<ShellyDayPreview groups={groups} tz={TZ} />)
    await screen.findByText('Classes')
    fireEvent.click(screen.getByRole('button', { name: 'Next day' }))
    fireEvent.click(screen.getByRole('button', { name: 'Next day' }))
    await waitFor(() => expect(urls()).toContain('/api/shelly/preview?date=2026-10-26'))
    fireEvent.click(screen.getByRole('button', { name: 'Previous day' }))
    await waitFor(() => expect(urls().filter((x) => x.endsWith('2026-10-25')).length).toBeGreaterThan(0))
    const block = await screen.findByLabelText('Studio lights: On 00:00–00:00')
    expect(block.style.left).toBe('0%')
    expect(block.style.width).toBe('100%')
  })

  it('clips a window that crosses local midnight to the day shown', async () => {
    global.fetch.mockResolvedValue(answer(200, body('2026-10-26', {
      groups: [{ id: 'g1', windows: [{ on_at: '2026-10-25T23:00:00.000Z', off_at: '2026-10-26T03:00:00.000Z' }, { on_at: '2026-10-26T22:00:00.000Z', off_at: '2026-10-27T02:00:00.000Z' }] }, { id: 'g2', windows: [] }],
    })))
    render(<ShellyDayPreview groups={groups} tz={TZ} />)
    await screen.findByText('Classes')
    const blocks = screen.getAllByLabelText(/^Studio lights: On/)
    expect(blocks).toHaveLength(2)
    expect(blocks[0].style.left).toBe('0%')
    expect(blocks[0].style.width).toBe(`${(3 / 24) * 100}%`)
    expect(parseFloat(blocks[1].style.left) + parseFloat(blocks[1].style.width)).toBeCloseTo(100, 6)
  })

  it('explains joined windows when a group is in class mode', async () => {
    global.fetch.mockResolvedValue(answer(200, body('2026-10-26')))
    render(<ShellyDayPreview groups={groups} tz={TZ} />)
    expect(await screen.findByText('Classes under 30 min apart keep the lights on')).toBeTruthy()
  })

  it('says "Manual override not shown" for an ignored override, today only', async () => {
    global.fetch.mockImplementation(async (u) => answer(200, body(String(u).split('=')[1], { ignored_overrides: ['g2'] })))
    render(<ShellyDayPreview groups={groups} tz={TZ} />)
    expect(await screen.findByText('Manual override not shown')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Next day' }))
    await screen.findByText('Preview · Tuesday')
    await waitFor(() => expect(screen.queryByText('Manual override not shown')).toBeNull())
  })

  it('shows a friendly error, not empty lanes, when the timetable cannot be read', async () => {
    global.fetch.mockResolvedValue(answer(502, { success: false, error: 'Could not read the timetable for that day', code: 'occurrences' }))
    render(<ShellyDayPreview groups={groups} tz={TZ} />)
    expect(await screen.findByText(/Couldn.t read the timetable for this day/)).toBeTruthy()
    expect(screen.queryByText('Classes')).toBeNull()
  })
})
