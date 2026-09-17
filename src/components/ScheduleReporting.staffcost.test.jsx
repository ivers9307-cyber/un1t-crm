// @vitest-environment jsdom
//
// STAFFCOST.1 — the Staff Cost table read hourly_rate / total_hours, which
// the generator stopped writing on 30 Apr, so every rate cell was €NaN and
// every hours cell 0. And the Staff Cost tile was offered to head coaches.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, act, fireEvent, within } from '@testing-library/react'

import ScheduleReporting, { StaffCostTable } from '@/components/ScheduleReporting'

afterEach(cleanup)

const CURRENT_ROWS = [
  { name: 'Anna', role: 'head_coach', employment_type: 'fte', regular_rate: 23.08, overtime_rate: 30, regular_hours: 40, overtime_hours: 4.5, regular_cost: 923.2, overtime_cost: 135, total_cost: 1058.2, weeks: {} },
  { name: 'Cara', role: 'staff', employment_type: 'contractor', regular_rate: 25, overtime_rate: null, regular_hours: 6, overtime_hours: 0, regular_cost: 150, overtime_cost: 0, total_cost: 150, weeks: {} },
]
const LEGACY_ROWS = [
  { name: 'Ben', role: 'staff', employment_type: 'contractor', hourly_rate: 25, total_hours: 12, total_cost: 300 },
]

function cellsOf(name) {
  const row = screen.getByText(name).closest('tr')
  return within(row).getAllByRole('cell').map(c => c.textContent)
}
function headers() {
  return screen.getAllByRole('columnheader').map(h => h.textContent)
}

describe('StaffCostTable', () => {
  it('reads the current fields and shows regular and overtime columns', () => {
    render(<StaffCostTable rows={CURRENT_ROWS} />)
    expect(headers()).toEqual(['Staff Member', 'Role', 'Type', 'Rate (€/hr)', 'OT Rate (€/hr)', 'Regular Hours', 'Overtime Hours', 'Total Hours', 'Total Cost'])
    expect(cellsOf('Anna')).toEqual(['Anna', 'head_coach', 'FTE', '€23.08', '€30.00', '40', '4.5', '44.5', '€1,058.20'])
    // No overtime premium → a dash, not €0.00.
    expect(cellsOf('Cara')).toEqual(['Cara', 'staff', 'Contractor', '€25.00', '—', '6', '0', '6', '€150.00'])
  })

  it('still renders an old stored report from hourly_rate / total_hours', () => {
    render(<StaffCostTable rows={LEGACY_ROWS} />)
    expect(headers()).toEqual(['Staff Member', 'Role', 'Type', 'Rate (€/hr)', 'Total Hours', 'Total Cost'])
    expect(cellsOf('Ben')).toEqual(['Ben', 'staff', 'Contractor', '€25.00', '12', '€300.00'])
  })

  it('never renders NaN — missing values are a dash', () => {
    const { container } = render(<StaffCostTable rows={[{ name: 'Dee', role: 'staff', employment_type: 'fte' }, { name: 'Eve', regular_rate: 'oops', regular_hours: 3 }]} />)
    expect(container.textContent).not.toMatch(/NaN/)
    expect(cellsOf('Dee')).toEqual(['Dee', 'staff', 'FTE', '—', '—', '—', '—', '—', '—'])
    expect(cellsOf('Eve')[3]).toBe('—')
  })
})

describe('ScheduleReporting — a generated staff_cost report end to end', () => {
  it('renders the report returned by the API without €NaN or zero hours', async () => {
    const report = {
      id: 'r1', report_type: 'staff_cost', period_start: '2026-09-01', period_end: '2026-09-07',
      report_data: { staff: CURRENT_ROWS },
      summary: { total_regular_hours: 46, total_overtime_hours: 4.5, total_cost: 1208.2, total_hours: 50.5, staff_count: 2, currency: 'EUR' },
    }
    global.fetch = vi.fn((url, opts) => {
      if (opts?.method === 'POST') return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: report }) })
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: [] }) })
    })
    const MANAGER = { id: 'u1', role: 'manager', profileRole: 'manager', rolesByLocation: { loc1: 'manager' }, activeLocation: { id: 'loc1', name: 'Stillorgan' } }
    await act(async () => { render(<ScheduleReporting user={MANAGER} />) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Staff Cost Breakdown/ })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Generate$/ })) })

    expect(document.body.textContent).not.toMatch(/NaN/)
    expect(cellsOf('Anna')).toContain('€23.08')
    expect(cellsOf('Anna')).toContain('44.5')
  })
})

describe('ScheduleReporting — Staff Cost tile visibility', () => {
  async function renderAs(user) {
    global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: [] }) }))
    await act(async () => { render(<ScheduleReporting user={user} />) })
  }

  it('is hidden from a head coach, who keeps the other four reports', async () => {
    await renderAs({ id: 'hc', role: 'head_coach', profileRole: 'head_coach', rolesByLocation: { loc1: 'head_coach' }, activeLocation: { id: 'loc1', name: 'Stillorgan' } })
    expect(screen.queryByRole('button', { name: /Staff Cost Breakdown/ })).toBeNull()
    for (const label of ['Staff Hours Worked', 'Time Off Summary', 'Roster Coverage', 'Staff Utilisation']) {
      expect(screen.getByRole('button', { name: new RegExp(label) })).toBeTruthy()
    }
  })

  it('is hidden when the head coach role is at the ACTIVE location, even if they manage another', async () => {
    await renderAs({ id: 'x', role: 'head_coach', profileRole: 'manager', rolesByLocation: { loc1: 'head_coach', loc2: 'manager' }, activeLocation: { id: 'loc1', name: 'Stillorgan' } })
    expect(screen.queryByRole('button', { name: /Staff Cost Breakdown/ })).toBeNull()
  })

  it('is shown to a manager and to master', async () => {
    await renderAs({ id: 'm', role: 'manager', profileRole: 'manager', rolesByLocation: { loc1: 'manager' }, activeLocation: { id: 'loc1', name: 'Stillorgan' } })
    expect(screen.getByRole('button', { name: /Staff Cost Breakdown/ })).toBeTruthy()
    cleanup()
    await renderAs({ id: 'ms', role: 'master', profileRole: 'master', rolesByLocation: {}, activeLocation: { id: 'loc1', name: 'Stillorgan' } })
    expect(screen.getByRole('button', { name: /Staff Cost Breakdown/ })).toBeTruthy()
  })
})
