'use client'

// SCHED.9 — the Schedule tab's own content, split out of ScheduleTabs.jsx
// so ScheduleTabs can become a pure nav strip. Mounted by the /schedule
// root page as the default (non-reporting) view. Carries forward the
// state ScheduleTabs used to own for this panel unchanged.

import { useState, useCallback } from 'react'
import ScheduleCalendar from './ScheduleCalendar'
import StudioOverviewStrip from './StudioOverviewStrip'
import { MANAGER_ROLES } from '@/lib/schemas'

const canManage = (role) => MANAGER_ROLES.includes(role)

export default function ScheduleRosterView({ user }) {
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

  return (
    <>
      {/* Studio overview — demand-vs-supply summary scoped to whatever
          date range the calendar is showing. Mig 125. */}
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
  )
}
