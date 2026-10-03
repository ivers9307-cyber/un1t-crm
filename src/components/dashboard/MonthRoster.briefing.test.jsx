// @vitest-environment jsdom
// BLOCKEDIT.1 — Today's week list prints each future shift's briefing.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import MonthRoster from './MonthRoster'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))
afterEach(() => cleanup())

const shift = (date, briefing) => ({
  id: `s-${date}`, status: 'scheduled', shift_date: date, location_id: 'loc-1',
  start_time_override: null, end_time_override: null, block_start_time: '09:00:00', block_end_time: '12:00:00',
  shift_templates: { name: 'Morning', start_time: '09:00:00', end_time: '12:00:00' }, briefing,
})

function renderWeek(startIso, shifts) {
  render(<MonthRoster weeks={[]} monthLabel="" monthSummary="" weekPanels={[{ title: 'This week', startIso, endIso: startIso, shifts }]} />)
  fireEvent.click(screen.getByRole('button', { name: 'Week' }))
}

describe('MonthRoster — briefing (BLOCKEDIT.1)', () => {
  it('prints a future shift\'s briefing under its time', () => {
    renderWeek('2099-06-08', [shift('2099-06-10', 'Fire drill at 10')])
    expect(screen.getByTestId('shift-briefing-line').textContent).toMatch(/Fire drill at 10/)
  })

  it('prints nothing for a shift with none, or a past one', () => {
    renderWeek('2099-06-08', [shift('2099-06-10', null)])
    expect(screen.queryByTestId('shift-briefing-line')).toBeNull()
    cleanup()
    renderWeek('2000-01-03', [shift('2000-01-05', 'Old news')])
    expect(screen.queryByTestId('shift-briefing-line')).toBeNull()
  })
})
