// @vitest-environment jsdom
//
// CHECKINLAYOUT.1 — the door roster: one list for a single time, folding
// start-time groups for several, To arrive / In / All tabs, Undo toast.
// Fictional names only.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor, within } from '@testing-library/react'
import EventCheckinClient from './EventCheckinClient.jsx'

const reg = (id, wave, order, time, people) => ({
  id, wave_id: wave, wave_label: `Wave ${order + 1}`, wave_time: time, _order: order,
  team: { name: `Team ${id}`, team_members: people.map(([name, inn], i) => ({ id: `${id}-${i}`, name, email: `${name.split(" ")[0].toLowerCase()}@example.test`, checked_in: !!inn })) },
})
const ONE_TIME = [reg('r1', 'w', 0, '12:30', [['Zoe Example', false]]), reg('r2', 'w', 0, '12:30', [['Ben Walsh', false], ['Cara Walsh', false]]), reg('r3', 'w', 0, '12:30', [['Amy Done', true]])]
const WAVES = [
  reg('r1', 'w1', 0, '09:00', [['Ann First', true]]),
  reg('r2', 'w2', 1, '09:20', [['Bo Second', false]]),
  reg('r3', 'w3', 2, '09:40', [['Cy Third', false]]),
]
const ok = () => ({ ok: true, status: 200, json: async () => ({ success: true }) })

let fetchMock
beforeEach(() => {
  fetchMock = vi.fn(async () => ok())
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('EventCheckinClient — one time', () => {
  it('lists people still to arrive, by first name, with no time headers', () => {
    render(<EventCheckinClient eventId="e1" isRace={false} registrations={ONE_TIME} />)
    expect(screen.getByText('1 of 4 in')).toBeTruthy()
    const names = screen.getAllByRole('button', { pressed: false }).map((b) => b.textContent)
    expect(names[0]).toMatch(/^Ben Walsh/)
    expect(names.at(-1)).toMatch(/^Zoe Example/)
    expect(screen.queryByText('Amy Done')).toBeNull()
    expect(screen.queryByRole('button', { expanded: true })).toBeNull()
    expect(screen.getByText(/with Ben/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Check in both' })).toBeTruthy()
  })

  it('tapping checks them in, drops them from To arrive, and Undo reverses it', async () => {
    render(<EventCheckinClient eventId="e1" isRace={false} registrations={ONE_TIME} />)
    fireEvent.click(screen.getByRole('button', { name: /^Zoe Example/ }))
    await screen.findByText('Zoe Example checked in')
    expect(fetchMock).toHaveBeenCalledWith('/api/events/e1/checkin', expect.objectContaining({ method: 'POST' }))
    expect(screen.queryByRole('button', { name: /^Zoe Example/ })).toBeNull()
    expect(screen.getByText('2 of 4 in')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith(expect.stringContaining('/api/events/e1/checkin?team_member_id=r1-0'), { method: 'DELETE' }))
    expect(await screen.findByRole('button', { name: /^Zoe Example/ })).toBeTruthy()
  })

  it('a failed tap reverts and says so', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({ success: false }) })
    render(<EventCheckinClient eventId="e1" isRace={false} registrations={ONE_TIME} />)
    fireEvent.click(screen.getByRole('button', { name: /^Zoe Example/ }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/Could not update Zoe Example/)
    expect(screen.getByText('1 of 4 in')).toBeTruthy()
  })

  it('the In tab lists who is in; search shows the email it matched', () => {
    render(<EventCheckinClient eventId="e1" isRace={false} registrations={ONE_TIME} />)
    fireEvent.click(screen.getByRole('tab', { name: 'In 1' }))
    expect(screen.getByText('Amy Done')).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: 'All 4' }))
    fireEvent.change(screen.getByLabelText('Search attendees'), { target: { value: 'zoe@' } })
    expect(screen.getByText('zoe@example.test')).toBeTruthy()
    expect(screen.queryByText(/Ben Walsh/)).toBeNull()
  })
})

describe('EventCheckinClient — several times', () => {
  it('groups by time with counts; finished times fold and the next one opens', () => {
    render(<EventCheckinClient eventId="e1" isRace registrations={WAVES} />)
    const first = screen.getByRole('button', { name: /09:00 · Wave 1/ })
    expect(first.getAttribute('aria-expanded')).toBe('false')
    expect(within(first).getByText('All 1 in')).toBeTruthy()
    const second = screen.getByRole('button', { name: /09:20 · Wave 2/ })
    expect(second.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('button', { name: /^Bo Second/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Cy Third/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /09:40 · Wave 3/ }))
    expect(screen.getByRole('button', { name: /^Cy Third/ })).toBeTruthy()
  })

  it('search reaches into folded times', () => {
    render(<EventCheckinClient eventId="e1" isRace registrations={WAVES} />)
    fireEvent.change(screen.getByLabelText('Search attendees'), { target: { value: 'cy' } })
    expect(screen.getByRole('button', { name: /^Cy Third/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /09:20 · Wave 2/ })).toBeNull()
  })
})
