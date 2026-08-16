'use client'

// SCHED.9 — the last state-only tab strip in the app becomes URL-driven.
//
// Was: a useState activeTab switch that rendered six inline panels
// (ScheduleCalendar / ScheduleApprovals / ScheduleReporting /
// InvoicesManager / ExpensesManager / AttendanceReportClient) — unshareable,
// un-deep-linkable, lost on refresh, while real standalone pages already
// existed at /schedule/{approvals,attendance,expenses,invoices,swaps,
// time-off} duplicating (or, for time-off/swaps, exceeding) that content.
//
// Now: CalendlyTabs/HubTabs semantics — every tab is a real <Link>, active
// state is longest-match on pathname, and ScheduleTabs itself renders NO
// panel content. It's mounted at the top of every /schedule/* page (root +
// all six siblings), exactly like CalendlyTabs is mounted on both
// /bookings pages, so the strip (and a way back to the roster) follows you
// across the whole area.
//
// Two decisions worth recording:
//
// 1. The old "Approvals" tab (ScheduleApprovals.jsx, now deleted) combined
//    PENDING time-off + swap requests into one manager-only approve/reject
//    view. That is NOT the same feature as the sibling page literally
//    named /schedule/approvals (RosterApprovalsPage — owner sign-off on
//    rosters published over the contractor budget; a third, unrelated
//    concept with its own reviewUrl from providers/rosters.js, its own
//    dashboard card, and its own roster-email link). The true, content-
//    matching convergence targets for "Approvals" turned out to be TWO
//    richer siblings that already existed with zero tab presence:
//    /schedule/time-off (TimeOffManager — submission + manager approve,
//    superset of the old panel's time-off half) and /schedule/swaps
//    (SwapRequestsManager — same superset relationship for swaps). So the
//    single Approvals tab splits into "Time Off" + "Swaps", both kept on
//    the same MANAGER_ROLES gate the old Approvals tab used. /schedule/
//    approvals (roster budget) is untouched and deliberately NOT added as
//    an eighth tab here — it never had inline-panel duplication to
//    converge, and stays reachable exactly as it is today (dashboard
//    card, roster-approval email).
//
// 2. Reporting has no sibling page at all (ScheduleReporting only ever
//    rendered inline) — nothing to converge onto. It stays on the /schedule
//    root, but "Reporting" is still a real link: /schedule?view=reporting
//    is bookmarkable/shareable/refresh-safe via the search param, so this
//    is not a reintroduction of local-state-only switching. See
//    src/app/(team)/schedule/page.js.
//
// Style: kept the existing underline (border-b-2) look rather than
// borrowing HubTabs' pill strip — (team)/layout.js already wraps every
// /schedule/* page in HubTabs' pill strip one level up, so a second pill
// strip directly underneath would read as one doubled control. The
// underline treatment (this file already had it; CalendlyTabs uses the
// same idiom) visually demotes this to a second-level strip, which is
// the accepted stacked pattern.

import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { CalendarClock, BarChart3, Receipt, UserCheck, Wallet, CalendarOff, ArrowLeftRight } from 'lucide-react'
import { MANAGER_ROLES } from '@/lib/schemas'
import { hasPermission } from '@/lib/permissions'

const canManage = (role) => MANAGER_ROLES.includes(role)

const ROOT_HREF = '/schedule'

export default function ScheduleTabs({ user }) {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const view = searchParams?.get('view') || null

  const isManager = canManage(user.role)

  // Invoices is shown to:
  //   - contractors (employment_type = 'contractor') — to submit
  //   - master + owner — to approve/decline + audit
  //   - anyone else explicitly granted approvals_contractor_invoices
  //     (FU-INVOICES-APPROVER — mirrors
  //     src/lib/approvals/providers/contractor-invoices.js's
  //     permissionKey). Hidden for FTE managers / head_coaches / staff
  //     who are neither.
  const isContractor = user.employment_type === 'contractor'
  const isInvoiceApprover = hasPermission(user, 'approvals_contractor_invoices')
    || user.role === 'master' || user.role === 'owner'
  const showInvoices = isContractor || isInvoiceApprover

  // FTE-EXPENSES.1 — Expenses tab. Same gate pattern as Invoices but
  // flipped on the employment_type side: FTE staff submit; master +
  // owner review, or anyone granted approvals_fte_expenses (mirrors
  // src/lib/approvals/providers/fte-expenses.js). Contractors use the
  // Invoices tab instead.
  const isFte = user.employment_type === 'fte'
  const isExpenseApprover = hasPermission(user, 'approvals_fte_expenses')
    || user.role === 'master' || user.role === 'owner'
  const showExpenses = isFte || isExpenseApprover

  // Attendance: same gate as the standalone /schedule/attendance page —
  // this tab just links to it now. attendance_reports defaults on for
  // owner/manager/master, off for staff + head_coach (see
  // DEFAULT_WEB_PERMISSIONS_BY_ROLE in shared/permissions.js). The
  // /schedule/attendance URL also has live external consumers (cron
  // emails) with no other in-repo link — never change it.
  const showAttendance = hasPermission(user, 'attendance_reports')

  const tabs = [
    { key: 'schedule',   label: 'Schedule',   icon: CalendarClock,  href: ROOT_HREF,                    show: true },
    { key: 'reporting',  label: 'Reporting',  icon: BarChart3,      href: `${ROOT_HREF}?view=reporting`, show: isManager },
    { key: 'time-off',   label: 'Time Off',   icon: CalendarOff,    href: '/schedule/time-off',          show: isManager },
    { key: 'swaps',      label: 'Swaps',      icon: ArrowLeftRight, href: '/schedule/swaps',             show: isManager },
    { key: 'invoices',   label: 'Invoices',   icon: Receipt,        href: '/schedule/invoices',          show: showInvoices },
    { key: 'expenses',   label: 'Expenses',   icon: Wallet,         href: '/schedule/expenses',          show: showExpenses },
    { key: 'attendance', label: 'Attendance', icon: UserCheck,      href: '/schedule/attendance',        show: showAttendance },
  ].filter(t => t.show)

  // Longest-match, CalendlyTabs/HubTabs style — with one wrinkle: Schedule
  // and Reporting both live at the /schedule pathname and are told apart
  // by the ?view= search param instead of the path.
  const isActive = (tab) => {
    if (tab.key === 'schedule') return pathname === ROOT_HREF && view !== 'reporting'
    if (tab.key === 'reporting') return pathname === ROOT_HREF && view === 'reporting'
    return pathname === tab.href || pathname.startsWith(`${tab.href}/`)
  }

  return (
    <div className="flex items-center gap-1 mb-6 border-b border-un1t-border">
      {tabs.map(tab => {
        const active = isActive(tab)
        return (
          <Link
            key={tab.key}
            href={tab.href}
            className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors -mb-px ${
              active
                ? 'border-un1t-text text-un1t-text'
                : 'border-transparent text-un1t-subtle hover:text-un1t-text'
            }`}
          >
            <tab.icon size={16} />
            {tab.label}
          </Link>
        )
      })}
    </div>
  )
}
