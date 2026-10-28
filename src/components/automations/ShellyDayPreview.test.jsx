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

describe('ShellyDayPreview zone maths (fails under plain-UTC maths)', () => {
  const only = (id, windows, date) => body(date, { classes: [], groups: [{ id: 'g1', windows }, { id: 'g2', windows: [] }] })
  const pct = (el, k) => parseFloat(el.style[k])
  const run = async (day, windows) => {
    vi.setSystemTime(new Date(`${day}T12:00:00.000Z`))
    global.fetch.mockResolvedValue(answer(200, only('g1', windows, day)))
    render(<ShellyDayPreview groups={groups} tz={TZ} />)
    await screen.findByText('Classes')
  }

  it('summer day (UTC+1): 05:45Z is 06:45 local, placed against a 23:00Z day start', async () => {
    await run('2026-07-15', [{ on_at: '2026-07-15T05:45:00.000Z', off_at: '2026-07-15T06:55:00.000Z' }])
    const b = screen.getByLabelText('Studio lights: On 06:45–07:55')
    expect(pct(b, 'left')).toBeCloseTo((6.75 / 24) * 100, 6)
    expect(pct(b, 'width')).toBeCloseTo((70 / 1440) * 100, 6)
    expect(pct(screen.getByText('12'), 'left')).toBeCloseTo((12 / 24) * 100, 6)
  })

  it('25-hour fall-back day (2026-10-25): spans divide by 25, ticks sit on real hours', async () => {
    await run('2026-10-25', [
      { on_at: '2026-10-24T22:00:00.000Z', off_at: '2026-10-25T02:00:00.000Z' }, // 23:00 IST the evening before -> 02:00 GMT
      { on_at: '2026-10-25T01:00:00.000Z', off_at: '2026-10-25T04:00:00.000Z' }, // 01:00-04:00 GMT, after the change
    ])
    const [cross, after] = screen.getAllByLabelText(/^Studio lights: On/)
    expect(pct(cross, 'left')).toBe(0)
    expect(pct(cross, 'width')).toBeCloseTo((3 / 25) * 100, 6) // day starts 23:00Z, so 23:00Z-02:00Z
    expect(pct(after, 'left')).toBeCloseTo((2 / 25) * 100, 6)
    expect(pct(after, 'width')).toBeCloseTo((3 / 25) * 100, 6)
    expect(pct(screen.getByText('12'), 'left')).toBeCloseTo((13 / 25) * 100, 6) // 12:00 GMT is 13 real hours in
  })

  it('23-hour spring-forward day (2026-03-29): 12:00-13:00 local is 11/23, width 1/23', async () => {
    await run('2026-03-29', [{ on_at: '2026-03-29T11:00:00.000Z', off_at: '2026-03-29T12:00:00.000Z' }])
    const b = screen.getByLabelText('Studio lights: On 12:00–13:00')
    expect(pct(b, 'left')).toBeCloseTo((11 / 23) * 100, 6)
    expect(pct(b, 'width')).toBeCloseTo((1 / 23) * 100, 6)
    expect(pct(screen.getByText('12'), 'left')).toBeCloseTo((11 / 23) * 100, 6)
  })
})

// SHELLYGROUPS.8 — the strip follows the groups it is handed, without losing
// the chosen day, and the poll's identical data costs no request.
describe('ShellyDayPreview — refetches when the groups change', () => {
  const previewCalls = () => urls().filter((u) => String(u).startsWith('/api/shelly/preview'))

  it('a changed schedule refetches the SAME chosen day', async () => {
    global.fetch.mockImplementation(async (u) => answer(200, body(String(u).split('date=')[1])))
    const { rerender } = render(<ShellyDayPreview groups={groups} tz={TZ} />)
    expect(await screen.findByText('Preview · Monday')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Next day' }))
    expect(await screen.findByText('Preview · Tuesday')).toBeTruthy()
    await waitFor(() => expect(previewCalls()).toHaveLength(2))

    const changed = groups.map((g) => (g.id === 'g2' ? { ...g, fixed_windows: [{ days: [2], on: '07:00', off: '09:00' }] } : g))
    rerender(<ShellyDayPreview groups={changed} tz={TZ} />)
    await waitFor(() => expect(previewCalls()).toHaveLength(3))
    expect(previewCalls()[2]).toBe('/api/shelly/preview?date=2026-10-27')
    expect(screen.getByText('Preview · Tuesday')).toBeTruthy()
  })

  it('identical group data (a new array from the poll) does not refetch', async () => {
    global.fetch.mockImplementation(async (u) => answer(200, body(String(u).split('date=')[1])))
    const { rerender } = render(<ShellyDayPreview groups={groups} tz={TZ} />)
    expect(await screen.findByText('Preview · Monday')).toBeTruthy()
    await waitFor(() => expect(previewCalls()).toHaveLength(1))
    rerender(<ShellyDayPreview groups={groups.map((g) => ({ ...g }))} tz={TZ} />)
    rerender(<ShellyDayPreview groups={JSON.parse(JSON.stringify(groups))} tz={TZ} />)
    await Promise.resolve()
    expect(previewCalls()).toHaveLength(1)
  })
})

describe('ShellyDayPreview — final-review fixes (SHELLYGROUPS.8)', () => {
  const withNow = (mode) => groups.map((g) => (g.id === 'g2'
    ? { ...g, now: { mode, on_count: 1, member_count: 1, until: mode === 'override' ? '2026-10-27T00:00:00.000Z' : null } }
    : { ...g, now: { mode: 'window', on_count: 1, member_count: 1 } }))
  const previewCalls = () => urls().filter((u) => String(u).startsWith('/api/shelly/preview'))

  it('today\'s "Manual override not shown" follows the groups prop, with no new request', async () => {
    global.fetch.mockImplementation(async (u) => answer(200, body(String(u).split('date=')[1])))
    const { rerender } = render(<ShellyDayPreview groups={withNow('window')} tz={TZ} />)
    expect(await screen.findByText('Classes')).toBeTruthy()
    expect(screen.queryByText('Manual override not shown')).toBeNull()

    rerender(<ShellyDayPreview groups={withNow('override')} tz={TZ} />)
    expect(screen.getByText('Manual override not shown')).toBeTruthy()

    rerender(<ShellyDayPreview groups={withNow('window')} tz={TZ} />)
    expect(screen.queryByText('Manual override not shown')).toBeNull()
    await Promise.resolve()
    expect(previewCalls()).toHaveLength(1)
  })

  it('names the shared gap when every class group has the same one', async () => {
    global.fetch.mockResolvedValue(answer(200, body('2026-10-26')))
    const two = [
      { id: 'g1', name: 'Studio lights', enabled: true, schedule_mode: 'class', class_rule: { merge_gap_min: 45 } },
      { id: 'g3', name: 'Fans', enabled: true, schedule_mode: 'class', class_rule: { merge_gap_min: 45 } },
    ]
    render(<ShellyDayPreview groups={two} tz={TZ} />)
    expect(await screen.findByText('Classes under 45 min apart keep the lights on')).toBeTruthy()
  })

  it('words the gap per group when they differ, and never claims 30', async () => {
    global.fetch.mockResolvedValue(answer(200, body('2026-10-26')))
    const two = [
      { id: 'g1', name: 'Studio lights', enabled: true, schedule_mode: 'class', class_rule: { merge_gap_min: 15 } },
      { id: 'g3', name: 'Fans', enabled: true, schedule_mode: 'class', class_rule: { merge_gap_min: 60 } },
    ]
    render(<ShellyDayPreview groups={two} tz={TZ} />)
    await screen.findByText('Classes')
    const caption = screen.getByText(/apart stay on/)
    // Lane order (sort_order, then name).
    expect(caption.textContent).toBe('Fans: classes under 60 min apart stay on; Studio lights: under 15 min')
    expect(caption.textContent).not.toContain('30')
  })

  it('an off group with a live override shows only "Never automatic", never two labels', async () => {
    global.fetch.mockResolvedValue(answer(200, body('2026-10-26', { ignored_overrides: ['g5'] })))
    const gs = [
      ...groups,
      { id: 'g5', name: 'Hall', enabled: false, schedule_mode: 'fixed', now: { mode: 'override', on_count: 1, member_count: 1 } },
    ]
    render(<ShellyDayPreview groups={gs} tz={TZ} />)
    await screen.findByText('Classes')
    expect(screen.getAllByText('Never automatic')).toHaveLength(1)
    expect(screen.queryByText('Manual override not shown')).toBeNull()
  })

  it('a refusal that is not about the timetable says "Couldn\'t load the preview"', async () => {
    global.fetch.mockResolvedValue(answer(500, { success: false, error: 'boom' }))
    render(<ShellyDayPreview groups={groups} tz={TZ} />)
    expect(await screen.findByText(/Couldn.t load the preview/)).toBeTruthy()
    expect(screen.queryByText(/timetable/)).toBeNull()
  })

  it('a "Never automatic" or switched-off group\'s lane says so', async () => {
    global.fetch.mockResolvedValue(answer(200, body('2026-10-26')))
    const gs = [
      ...groups,
      { id: 'g4', name: 'Office', enabled: true, schedule_mode: 'none' },
      { id: 'g5', name: 'Hall', enabled: false, schedule_mode: 'fixed' },
    ]
    render(<ShellyDayPreview groups={gs} tz={TZ} />)
    await screen.findByText('Classes')
    expect(screen.getAllByText('Never automatic')).toHaveLength(2)
  })

  it('group names in the lanes use the readable subtle token', async () => {
    global.fetch.mockResolvedValue(answer(200, body('2026-10-26')))
    render(<ShellyDayPreview groups={groups} tz={TZ} />)
    const label = await screen.findByText('Studio lights')
    expect(label.className).toContain('text-un1t-subtle')
    expect(label.className).not.toContain('text-un1t-muted')
  })
})
