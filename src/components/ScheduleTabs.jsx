'use client'

import { useState, useCallback } from 'react'
import { CalendarClock, CheckCircle, BarChart3, Receipt, UserCheck, Wallet } from 'lucide-react'
import ScheduleCalendar from './ScheduleCalendar'
import ScheduleApprovals from './ScheduleApprovals'
import ScheduleReporting from './ScheduleReporting'
import InvoicesManager from './InvoicesManager'
import ExpensesManager from './ExpensesManager'
import AttendanceReportClient from './AttendanceReportClient'
import StudioOverviewStrip from './StudioOverviewStrip'
import { MANAGER_ROLES } from '@/lib/schemas'
import { hasPermission } from '@/lib/permissions'

const canManage = (role) => MANAGER_ROLES.includes(role)

export default function ScheduleTabs({ user }) {
  const [activeTab, setActiveTab] = useState('schedule')
  const isManager = canManage(user.role)

  // Mig 125: studio overview strip date range. ScheduleCalendar holds
  // the operator's view (week / month / current date) internally and
  // pipes the resulting visible range up here via onRangeChange so the
  // strip above can re-fetch its per-day demand summary in sync.
  const [scheduleRange, setScheduleRange] = useState(null)

  // OVERVIEW-REFRESH.1 — monotonic counter the calendar bumps after
  // every successful mutation (assign / unassign / create / delete /
  // bulk-assign / publish / copy week / partial save). Pass into
  // the overview strip's useEffect deps so it auto-refetches when
  // the underlying data changes — operators no longer need to hard-
  // refresh the page to see updated coverage / under-min flags.
  //
  // Note: bumpDataVersion is wrapped in useCallback so the callback
  // identity is stable across renders. ScheduleCalendar puts it in
  // its fetchData useCallback deps; without the stable identity
  // we'd churn the memo and re-fire fetchData on every parent render.
  const [scheduleDataVersion, setScheduleDataVersion] = useState(0)
  const bumpDataVersion = useCallback(() => {
    setScheduleDataVersion((v) => v + 1)
  }, [])

  // Invoices is shown to:
  //   - contractors (employment_type = 'contractor') — to submit
  //   - master + owner — to approve/decline + audit
  // Hidden for FTE managers / head_coaches / staff who are neither.
  const isContractor = user.employment_type === 'contractor'
  const isApprover = user.role === 'master' || user.role === 'owner'
  const showInvoices = isContractor || isApprover

  // FTE-EXPENSES.1 — Expenses tab. Same gate pattern as Invoices but
  // flipped on the employment_type side: FTE staff submit; master +
  // owner review. Contractors use the Invoices tab instead (and pay
  // themselves via their own service invoice rather than receipt-
  // based reimbursement).
  const isFte = user.employment_type === 'fte'
  const showExpenses = isFte || isApprover

  // Attendance: same gate as the standalone /schedule/attendance page
  // (still reachable directly — this is just an additional surface).
  // attendance_reports defaults on for owner/manager/master, off for
  // staff + head_coach (see DEFAULT_WEB_PERMISSIONS_BY_ROLE in
  // shared/permissions.js).
  const showAttendance = hasPermission(user, 'attendance_reports')

  const tabs = [
    { key: 'schedule',   label: 'Schedule',   icon: CalendarClock, show: true },
    { key: 'approvals',  label: 'Approvals',  icon: CheckCircle,   show: isManager },
    { key: 'reporting',  label: 'Reporting',  icon: BarChart3,     show: isManager },
    { key: 'invoices',   label: 'Invoices',   icon: Receipt,       show: showInvoices },
    { key: 'expenses',   label: 'Expenses',   icon: Wallet,        show: showExpenses },
    { key: 'attendance', label: 'Attendance', icon: UserCheck,     show: showAttendance },
  ].filter(t => t.show)

  return (
    <div>
      {/* Tab bar */}
      <div className="flex items-center gap-1 mb-6 border-b border-un1t-gray">
        {tabs.map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors -mb-px ${
              activeTab === tab.key
                ? 'border-un1t-white text-un1t-white'
                : 'border-transparent text-un1t-light hover:text-un1t-white'
            }`}
          >
            <tab.icon size={16} />
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === 'schedule' && (
        <>
          {/* Studio overview — visible only on the Schedule tab.
              Sits above the calendar; demand-vs-supply summary scoped
              to whatever date range the calendar is showing. Mig 125. */}
          {isManager && user.activeLocation?.id && (
            <StudioOverviewStrip
              range={scheduleRange}
              locationId={user.activeLocation.id}
              dataVersion={scheduleDataVersion}
            />
          )}
          <ScheduleCalendar
            user={user}
            onRangeChange={setScheduleRange}
            onDataChange={bumpDataVersion}
          />
        </>
      )}
      {activeTab === 'approvals' && isManager && <ScheduleApprovals user={user} />}
      {activeTab === 'reporting' && isManager && <ScheduleReporting user={user} />}
      {activeTab === 'invoices' && <InvoicesManager user={user} />}
      {activeTab === 'expenses' && (
        <ExpensesManager
          userId={user.id}
          isFte={isFte}
          isApprover={isApprover}
          locations={user.locations || []}
        />
      )}
      {activeTab === 'attendance' && showAttendance && (
        <AttendanceReportClient activeLocationName={user.activeLocation?.name || ''} />
      )}
    </div>
  )
}
