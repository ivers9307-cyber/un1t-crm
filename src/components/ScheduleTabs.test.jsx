// @vitest-environment jsdom
//
// FU-INVOICES-APPROVER — ScheduleTabs (the Team → Schedule hub) hid the
// Invoices/Expenses tabs behind a role-only isApprover check
// (master/owner), the same bug fixed in InvoicesManager.jsx and
// src/app/(team)/schedule/expenses/page.js: a manager explicitly granted
// approvals_contractor_invoices / approvals_fte_expenses could reach
// those surfaces via the Money hub but never saw the tab here. All child
// tab components are stubbed — this file only pins tab VISIBILITY, not
// their internals (each has its own tests).

import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

vi.mock('./ScheduleCalendar', () => ({ default: () => <div>calendar-stub</div> }))
vi.mock('./ScheduleApprovals', () => ({ default: () => <div>approvals-stub</div> }))
vi.mock('./ScheduleReporting', () => ({ default: () => <div>reporting-stub</div> }))
vi.mock('./InvoicesManager', () => ({ default: () => <div>invoices-stub</div> }))
vi.mock('./ExpensesManager', () => ({ default: () => <div>expenses-stub</div> }))
vi.mock('./AttendanceReportClient', () => ({ default: () => <div>attendance-stub</div> }))
vi.mock('./StudioOverviewStrip', () => ({ default: () => <div>overview-stub</div> }))

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
    activeAssignment: { permissions: { approvals_contractor_invoices: false, approvals_fte_expenses: false, ...perms } },
    locations: [],
  }
}

afterEach(() => cleanup())

describe('ScheduleTabs approver-driven tab visibility', () => {
  it('hides Invoices + Expenses for a plain FTE staffer with no grants', () => {
    render(<ScheduleTabs user={user()} />)
    expect(screen.queryByText('Invoices')).toBeNull()
    expect(screen.queryByText('Expenses')).toBeNull()
  })

  it('shows Invoices for a manager granted approvals_contractor_invoices, without granting Expenses', () => {
    render(<ScheduleTabs user={user({ role: 'manager', perms: { approvals_contractor_invoices: true } })} />)
    expect(screen.getByText('Invoices')).toBeTruthy()
    expect(screen.queryByText('Expenses')).toBeNull()
  })

  it('shows Expenses for a manager granted approvals_fte_expenses, without granting Invoices', () => {
    render(<ScheduleTabs user={user({ role: 'manager', perms: { approvals_fte_expenses: true } })} />)
    expect(screen.getByText('Expenses')).toBeTruthy()
    expect(screen.queryByText('Invoices')).toBeNull()
  })

  it('keeps both tabs for owner/master regardless of the grants (safety-net OR)', () => {
    render(<ScheduleTabs user={user({ role: 'owner' })} />)
    expect(screen.getByText('Invoices')).toBeTruthy()
    expect(screen.getByText('Expenses')).toBeTruthy()
  })
})
