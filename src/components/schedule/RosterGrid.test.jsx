// src/components/schedule/RosterGrid.test.jsx
// @vitest-environment jsdom
//
// GRID.1 — what the coach-by-day grid puts in the DOM. The decisions are
// roster-grid-model.test.js's; this is the layout of them.
// 🔴 NOT proof of layout: jsdom has no layout engine (memory
// `jsdom-cannot-see-layout`). The class pins below stop the sticky column and
// the scroller being dropped; the browser checks in the PR prove them.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react'
import RosterGrid from './RosterGrid'
import { buildRosterGrid } from '@/lib/roster-grid-model'

afterEach(() => cleanup())

const WEEK = '2026-09-21'
const S = (profile_id, block_date, start_time, end_time, over = {}) => ({
  assignment_id: `${profile_id}-${block_date}-${start_time}`, profile_id, block_id: `b-${block_date}`, block_date,
  location_id: 'loc-north', location_name: 'Studio North', here: true, kind: 'class', name: 'Strength', status: 'scheduled',
  start_time, end_time, start_time_override: null, end_time_override: null, shift_templates: { start_time, end_time }, ...over,
})
const M = (profile_id, full_name, employment_type, contracted_hours) => ({ profile_id, full_name, employment_type, contracted_hours, member: true })
const SOUTH = { location_id: 'loc-south', location_name: 'Studio South', here: false }

const GRID = {
  members: [M('p-emp', 'Alex Example', 'fte', 39), M('p-con', 'Jordan Sample', 'contractor', null), M('p-over', 'Max Beta', 'fte', 1)],
  shifts: [
    S('p-emp', '2026-09-21', '09:00:00', '12:00:00', { block_id: 'b-mon' }),
    S('p-emp', '2026-09-22', '18:00:00', '20:00:00', { ...SOUTH, block_id: 'b-south', name: 'Evening' }),
    S('p-emp', '2026-09-23', '13:00:00', '14:30:00', { block_id: 'b-wed', kind: 'admin', name: 'Front desk' }),
    S('p-con', '2026-09-24', '17:00:00', '18:00:00', { block_id: 'b-thu' }),
    S('p-over', '2026-09-25', '06:00:00', '07:30:00', { block_id: 'b-fri' }),
  ],
  contract_visible: true,
  cross_studio_checked: true,
}
const LEAVE = [{ id: 't1', profile_id: 'p-con', type: 'holiday', start_date: '2026-09-26', end_date: '2026-09-26', profiles: { full_name: 'Jordan Sample' } }]
const RULES = [{ id: 'r1', profile_id: 'p-emp', kind: 'weekly', weekday: 'mon', start_date: null, end_date: null, all_day: false, start_time: '10:00', end_time: '11:00', note: null }]
const model = (over = {}) => buildRosterGrid({ weekStart: WEEK, grid: { ...GRID, ...over }, timeOff: LEAVE, availability: RULES })
const rowEl = (id) => screen.getAllByTestId('roster-grid-row').find((r) => r.dataset.profileId === id)
const shown = (el) => el.querySelector('[aria-hidden="true"]')

describe('RosterGrid', () => {
  it('a header, then one row per coach with the week, the contract and the admin balance', () => {
    render(<RosterGrid model={model()} onOpenBlock={vi.fn()} />)
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'Coach', 'Week', 'Contract', 'Admin balance', 'Mon 21', 'Tue 22', 'Wed 23', 'Thu 24', 'Fri 25', 'Sat 26', 'Sun 27',
    ])
    expect(screen.getAllByRole('rowheader').map((h) => h.textContent)).toEqual(['Alex Example', 'Jordan Sample', 'Max Beta'])
    const alex = rowEl('p-emp')
    // 180 + 120 (Studio South) + 90 = 390.
    expect(within(alex).getByTestId('grid-week-total').textContent).toBe('6h 30m2h other studio')
    expect(within(alex).getByTestId('grid-contract').textContent).toBe('39h')
    expect(shown(within(alex).getByTestId('grid-balance')).textContent).toBe('32h 30m')
    expect(within(alex).getByTestId('grid-balance').getAttribute('title')).toBe('39h contract − 5h class − 1h 30m placed admin = 32h 30m to place')
  })

  it('a shift here is a button that opens its block; a shift at the other studio is a marker, not a control', () => {
    const onOpenBlock = vi.fn()
    render(<RosterGrid model={model()} onOpenBlock={onOpenBlock} />)
    const alex = rowEl('p-emp')
    fireEvent.click(within(alex).getByRole('button', { name: /9am–12pm/ }))
    expect(onOpenBlock).toHaveBeenCalledWith('b-mon')
    expect(within(alex).queryByRole('button', { name: /6–8pm/ })).toBeNull()
    const marker = within(alex).getByTestId('grid-elsewhere')
    expect(marker.textContent).toMatch(/6–8pm/)
    expect(marker.textContent).toMatch(/Studio South/)
    expect(within(alex).getByRole('button', { name: /1–2:30pm/ }).textContent).toMatch(/Admin · Front desk/)
  })

  it('a shift whose block is not on screen cannot be opened', () => {
    const onOpenBlock = vi.fn()
    render(<RosterGrid model={model()} onOpenBlock={onOpenBlock} canOpenBlock={() => false} />)
    const button = within(rowEl('p-emp')).getByRole('button', { name: /9am–12pm/ })
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    expect(onOpenBlock).not.toHaveBeenCalled()
  })

  it('over contract reads as a minus and says so in words; a contractor has no contract and no balance', () => {
    render(<RosterGrid model={model()} onOpenBlock={vi.fn()} />)
    const balance = within(rowEl('p-over')).getByTestId('grid-balance')
    expect(shown(balance).textContent).toBe('−30m')
    expect(shown(balance).className).toMatch(/text-amber-700/)
    expect(balance.querySelector('.sr-only').textContent).toBe('30m over contract')
    const jordan = rowEl('p-con')
    expect(within(jordan).getByTestId('grid-contract').textContent).toBe('—')
    expect(shown(within(jordan).getByTestId('grid-balance')).textContent).toBe('Contractor')
  })

  // GRID.1 review 1 — a head coach's grid: the columns stay (so the table
  // does not change shape), each cell is a dash that a screen reader hears as
  // "hidden", and nothing reads "No contract hours" or "Contractor".
  it('contract hidden: Contract and Admin balance are a dash, "hidden" to a screen reader', () => {
    render(<RosterGrid model={model({ contract_visible: false })} onOpenBlock={vi.fn()} />)
    for (const id of ['p-emp', 'p-con', 'p-over']) {
      for (const testId of ['grid-contract', 'grid-balance']) {
        const cell = within(rowEl(id)).getByTestId(testId)
        expect(shown(cell).textContent).toBe('—')
        expect(cell.querySelector('.sr-only').textContent).toBe('hidden')
      }
    }
    const text = screen.getByTestId('roster-grid').textContent
    expect(text).not.toMatch(/No contract hours|Contractor|39h|to place/)
    expect(within(rowEl('p-emp')).getByTestId('grid-week-total').textContent).toBe('6h 30m2h other studio')
    expect(text).toMatch(/owners and managers/)
  })

  it('leave and unavailability sit in their day; a shift inside a window says so', () => {
    render(<RosterGrid model={model()} onOpenBlock={vi.fn()} />)
    expect(within(rowEl('p-con')).getByTestId('grid-leave').textContent).toBe('Holiday')
    const unavailable = within(rowEl('p-emp')).getByTestId('grid-unavailable')
    expect(unavailable.textContent).toBe('Unavailable 10am–11am')
    expect(unavailable.getAttribute('title')).toBe('Mondays, 10am–11am')
    // Not an admin shift's slate surface (AVAIL.1b's reason): dashed, like the Days view's bar.
    expect(unavailable.className).toMatch(/\bborder-dashed\b/)
    expect(unavailable.className).not.toMatch(/bg-slate/)
    expect(within(rowEl('p-emp')).getByRole('button', { name: /9am–12pm/ }).textContent).toMatch(/Unavailable$/)
  })

  it('working-time flags sit under the name, with both ends of a short rest in the title', () => {
    const heavy = buildRosterGrid({
      weekStart: WEEK,
      grid: {
        members: [M('p-emp', 'Alex Example', 'fte', 39)],
        shifts: [
          S('p-emp', '2026-09-21', '20:00:00', '22:00:00', SOUTH),
          S('p-emp', '2026-09-22', '06:00:00', '07:00:00'),
          ...['2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26'].map((d) => S('p-emp', d, '08:00:00', '20:00:00')),
        ],
        contract_visible: true,
        cross_studio_checked: true,
      },
    })
    render(<RosterGrid model={heavy} onOpenBlock={vi.fn()} />)
    expect(screen.getByTestId('grid-long-week').textContent).toBe('51h week')
    const rest = screen.getByTestId('grid-short-rest')
    expect(rest.textContent).toBe('8h rest')
    expect(rest.getAttribute('title')).toMatch(/^8h rest: ends Mon 21 Sep 10pm \(Studio South\), starts Tue 22 Sep 6am/)
  })

  it('says when the other studios, leave or availability could not be read', () => {
    render(<RosterGrid model={model({ cross_studio_checked: false })} leaveMissing availabilityMissing onOpenBlock={vi.fn()} />)
    const text = screen.getByTestId('roster-grid').textContent
    expect(text).toMatch(/other studios could not be read/)
    expect(text).toMatch(/nobody is shown on leave/)
    expect(text).toMatch(/nobody is shown as unavailable/)
  })

  it('first load says so; a failed first load offers Retry; a failed refresh keeps the grid and says so', () => {
    const onRetry = vi.fn()
    const { rerender } = render(<RosterGrid model={null} loading onOpenBlock={vi.fn()} />)
    expect(screen.getByTestId('roster-grid-loading').textContent).toBe('Loading coaches…')
    rerender(<RosterGrid model={null} error="Request failed (500)" onRetry={onRetry} onOpenBlock={vi.fn()} />)
    expect(screen.getByText('Could not load the coach grid')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
    rerender(<RosterGrid model={model()} error="Request failed (500)" onRetry={onRetry} onOpenBlock={vi.fn()} />)
    expect(screen.getByText(/Showing the last grid that loaded/)).toBeTruthy()
    expect(screen.getAllByTestId('roster-grid-row')).toHaveLength(3)
  })

  it("My shifts: only the viewer's row", () => {
    render(<RosterGrid model={model()} onlyProfileId="p-over" onOpenBlock={vi.fn()} />)
    expect(screen.getAllByRole('rowheader').map((h) => h.textContent)).toEqual(['Max Beta'])
  })

  it('select mode marks the selected shift pressed', () => {
    render(<RosterGrid model={model()} selectMode selectedBlockIds={new Set(['b-mon'])} onOpenBlock={vi.fn()} />)
    expect(within(rowEl('p-emp')).getByRole('button', { name: /9am–12pm/ }).getAttribute('aria-pressed')).toBe('true')
    expect(within(rowEl('p-emp')).getByRole('button', { name: /1–2:30pm/ }).getAttribute('aria-pressed')).toBe('false')
  })

  it('layout classes jsdom can pin: its own relative scroller, a sticky opaque first column, separate borders; no pay', () => {
    render(<RosterGrid model={model()} onOpenBlock={vi.fn()} />)
    const scroller = screen.getByTestId('roster-grid-scroller')
    expect(scroller.className).toMatch(/\boverflow-x-auto\b/)
    expect(scroller.className).toMatch(/\brelative\b/)
    for (const el of [screen.getByTestId('roster-grid-corner'), ...screen.getAllByRole('rowheader')]) {
      expect(el.className).toMatch(/\bsticky\b/)
      expect(el.className).toMatch(/\bleft-0\b/)
      expect(el.className).toMatch(/\bbg-un1t-(bg|surface)\b/)
    }
    expect(screen.getByRole('table').className).toMatch(/\bborder-separate\b/)
    expect(screen.getByTestId('roster-grid').textContent).not.toMatch(/€|salary|hourly/i)
  })
})
