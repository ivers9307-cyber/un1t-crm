// @vitest-environment jsdom
//
// SCHED.9 — ScheduleTabs becomes a pure Link-based nav strip (CalendlyTabs/
// HubTabs semantics) over the real /schedule/* sibling pages, replacing
// the old useState tab-swap. Pins:
//   - every visible tab renders as a real <a href>
//   - per-tab gates match the pre-SCHED.9 ScheduleTabs.jsx exactly (carried
//     forward from FU-INVOICES-APPROVER's fixture/assertions), plus the new
//     Reporting/Time Off/Swaps/Attendance gates
//   - active state is longest-match, including the /schedule?view=reporting
//     pseudo-route the two root tabs share
//   - no panel content renders here any more — deliberately NOT mocking
//     ScheduleCalendar/ScheduleReporting/InvoicesManager/etc: if ScheduleTabs
//     regressed to importing and rendering one of them again, its own
//     fetch/data-fetching effects would blow up jsdom (no fetch stubbed in
//     this file) rather than quietly passing.

import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

const mockPathname = vi.fn(() => '/schedule')
const mockSearchParams = vi.fn(() => new URLSearchParams())
vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname(),
  useSearchParams: () => mockSearchParams(),
}))

import ScheduleTabs from './ScheduleTabs.jsx'

// employment_type deliberately neither 'fte' nor 'contractor' by default —
// isolates the approver-only path from the (legitimate, unrelated)
// submitter-side tab visibility those two values also grant.
function user({ role = 'staff', employment_type = 'volunteer', perms = {} } = {}) {
  return {
    id: 'u1',
    role,
    employment_type,
    activeLocation: { id: 'loc1', features: {} },
    activeAssignment: {
      permissions: {
        approvals_contractor_invoices: false,
        approvals_fte_expenses: false,
        attendance_reports: false,
        ...perms,
      },
    },
    locations: [],
  }
}

function linkFor(label) {
  return screen.getByText(label).closest('a')
}

afterEach(() => {
  cleanup()
  mockPathname.mockReturnValue('/schedule')
  mockSearchParams.mockReturnValue(new URLSearchParams())
})

describe('ScheduleTabs — tabs render as links to the real sibling pages', () => {
  it('renders only Schedule for a plain staffer with no grants', () => {
    render(<ScheduleTabs user={user()} />)
    const links = screen.getAllByRole('link')
    expect(links).toHaveLength(1)
    expect(links[0].textContent).toBe('Schedule')
    expect(links[0].getAttribute('href')).toBe('/schedule')
  })

  it('shows Reporting, Time Off and Swaps to managers, hidden from staff (MANAGER_ROLES gate carried over from the old Approvals tab)', () => {
    render(<ScheduleTabs user={user({ role: 'staff' })} />)
    expect(screen.queryByText('Reporting')).toBeNull()
    expect(screen.queryByText('Time Off')).toBeNull()
    expect(screen.queryByText('Swaps')).toBeNull()
    cleanup()

    render(<ScheduleTabs user={user({ role: 'manager' })} />)
    expect(linkFor('Reporting').getAttribute('href')).toBe('/schedule?view=reporting')
    expect(linkFor('Time Off').getAttribute('href')).toBe('/schedule/time-off')
    expect(linkFor('Swaps').getAttribute('href')).toBe('/schedule/swaps')
  })

  it('hides Invoices + Expenses for a plain FTE-less staffer with no grants', () => {
    render(<ScheduleTabs user={user()} />)
    expect(screen.queryByText('Invoices')).toBeNull()
    expect(screen.queryByText('Expenses')).toBeNull()
  })

  it('shows Invoices for a manager granted approvals_contractor_invoices, without granting Expenses', () => {
    render(<ScheduleTabs user={user({ role: 'manager', perms: { approvals_contractor_invoices: true } })} />)
    expect(linkFor('Invoices').getAttribute('href')).toBe('/schedule/invoices')
    expect(screen.queryByText('Expenses')).toBeNull()
  })

  it('shows Expenses for a manager granted approvals_fte_expenses, without granting Invoices', () => {
    render(<ScheduleTabs user={user({ role: 'manager', perms: { approvals_fte_expenses: true } })} />)
    expect(linkFor('Expenses').getAttribute('href')).toBe('/schedule/expenses')
    expect(screen.queryByText('Invoices')).toBeNull()
  })

  it('keeps both Invoices and Expenses for owner/master regardless of the grants (safety-net OR)', () => {
    render(<ScheduleTabs user={user({ role: 'owner' })} />)
    expect(screen.getByText('Invoices')).toBeTruthy()
    expect(screen.getByText('Expenses')).toBeTruthy()
  })

  it('shows Invoices to a contractor submitter even without any approver grant', () => {
    render(<ScheduleTabs user={user({ employment_type: 'contractor' })} />)
    expect(linkFor('Invoices').getAttribute('href')).toBe('/schedule/invoices')
  })

  it('shows Expenses to an FTE submitter even without any approver grant', () => {
    render(<ScheduleTabs user={user({ employment_type: 'fte' })} />)
    expect(linkFor('Expenses').getAttribute('href')).toBe('/schedule/expenses')
  })

  it('shows Attendance only when attendance_reports is granted', () => {
    render(<ScheduleTabs user={user({ perms: { attendance_reports: false } })} />)
    expect(screen.queryByText('Attendance')).toBeNull()
    cleanup()

    render(<ScheduleTabs user={user({ perms: { attendance_reports: true } })} />)
    expect(linkFor('Attendance').getAttribute('href')).toBe('/schedule/attendance')
  })

  it('shows every tab to a master, including Attendance (master defaults attendance_reports true)', () => {
    render(<ScheduleTabs user={user({ role: 'master' })} />)
    for (const label of ['Schedule', 'Reporting', 'Time Off', 'Swaps', 'Invoices', 'Expenses', 'Attendance']) {
      expect(screen.getByText(label)).toBeTruthy()
    }
  })
})

describe('ScheduleTabs — active state (longest-match, incl. the reporting pseudo-route)', () => {
  it('marks Schedule active on the bare root with no view param', () => {
    mockPathname.mockReturnValue('/schedule')
    mockSearchParams.mockReturnValue(new URLSearchParams())
    render(<ScheduleTabs user={user({ role: 'manager' })} />)
    expect(linkFor('Schedule').className).toContain('border-un1t-text')
    expect(linkFor('Reporting').className).not.toContain('border-un1t-text')
  })

  it('marks Reporting active on /schedule?view=reporting, not Schedule', () => {
    mockPathname.mockReturnValue('/schedule')
    mockSearchParams.mockReturnValue(new URLSearchParams('view=reporting'))
    render(<ScheduleTabs user={user({ role: 'manager' })} />)
    expect(linkFor('Reporting').className).toContain('border-un1t-text')
    expect(linkFor('Schedule').className).not.toContain('border-un1t-text')
  })

  it('marks Invoices active while on /schedule/invoices', () => {
    mockPathname.mockReturnValue('/schedule/invoices')
    render(<ScheduleTabs user={user({ employment_type: 'contractor' })} />)
    expect(linkFor('Invoices').className).toContain('border-un1t-text')
    expect(linkFor('Schedule').className).not.toContain('border-un1t-text')
  })

  it('keeps a sibling active on a deep-linked child path (longest-match)', () => {
    mockPathname.mockReturnValue('/schedule/attendance/anything')
    render(<ScheduleTabs user={user({ perms: { attendance_reports: true } })} />)
    expect(linkFor('Attendance').className).toContain('border-un1t-text')
  })
})

describe('ScheduleTabs — no local-state panel swapping remains', () => {
  it('renders nothing but the nav strip', () => {
    const { container } = render(<ScheduleTabs user={user({ role: 'master' })} />)
    expect(container.querySelectorAll('a').length).toBeGreaterThan(0)
    // No form/table/button content — the old inline panels all rendered
    // at least one of these; the strip itself never does.
    expect(container.querySelectorAll('button, form, table').length).toBe(0)
  })
})
