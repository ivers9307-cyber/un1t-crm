'use client'

// SCHED.9 — the Schedule tab's own content, split out of ScheduleTabs.jsx
// so ScheduleTabs can become a pure nav strip. Mounted by the /schedule
// root page as the default (non-reporting) view. Carries forward the
// state ScheduleTabs used to own for this panel unchanged.

import { useState, useCallback, useRef } from 'react'
import ScheduleCalendar from './ScheduleCalendar'
import StudioOverviewDialog from './schedule/StudioOverviewDialog'
import { MANAGER_ROLES } from '@/lib/schemas'

const canManage = (role) => MANAGER_ROLES.includes(role)

export default function ScheduleRosterView({ user }) {
  const isManager = canManage(user.role)

  // Mig 125: studio overview date range. ScheduleCalendar holds
  // the operator's view (week / month / current date) internally and
  // pipes the resulting visible range up here via onRangeChange so the
  // Studio Overview dialog can fetch its per-day demand summary for the
  // same range.
  const [scheduleRange, setScheduleRange] = useState(null)

  // OVERVIEW-REFRESH.1 — monotonic counter the calendar bumps after
  // every successful mutation (assign / unassign / create / delete /
  // bulk-assign / publish / copy week / partial save). Pass into
  // the overview dialog's useEffect deps so it auto-refetches when
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

  // CAL-UI-LOW.2 — a shift the overview dialog names, handed to the
  // calendar. The dialog knows the block id and the date; only the
  // calendar can navigate to that date and open the block-detail dialog,
  // and the two are siblings, so the request passes through here.
  //
  // The `seq` counter is what makes a REPEAT request work: asking for the
  // same shift twice is two requests, and a payload compared by value
  // would look unchanged the second time and do nothing.
  const [shiftFocus, setShiftFocus] = useState(null)
  const shiftFocusSeq = useRef(0)
  const openShift = useCallback((date, blockId) => {
    shiftFocusSeq.current += 1
    setShiftFocus({ date, blockId, seq: shiftFocusSeq.current })
  }, [])

  // ROSTERLOOK.1 — which day's Studio Overview is open. The strip of tiles
  // that used to open it is gone; the calendar's day headers ask for it
  // through onOpenDayOverview, and the dialog is rendered here because this
  // component already owns everything it needs (the range, the data version,
  // and the openShift relay back into the calendar).
  //
  // The header hands over its own element with the date. It is kept in a ref
  // and given to the dialog as restoreFocusRef, the way the calendar's stacked
  // modals do: Safari does not focus a button on click, so "whatever was
  // focused when the dialog opened" is not reliably the header.
  const [overviewDate, setOverviewDate] = useState(null)
  const overviewOpenerRef = useRef(null)
  const openDayOverview = useCallback((dateStr, headerEl) => {
    overviewOpenerRef.current = headerEl || null
    setOverviewDate(dateStr)
  }, [])
  const showOverview = isManager && !!user.activeLocation?.id

  return (
    <>
      <ScheduleCalendar
        user={user}
        onRangeChange={setScheduleRange}
        onDataChange={bumpDataVersion}
        focusShift={shiftFocus}
        onOpenDayOverview={showOverview ? openDayOverview : undefined}
      />
      {/* Studio overview — demand-vs-supply for one day (mig 125), opened
          from that day's header. Manager only, as the strip was. */}
      {showOverview && (
        <StudioOverviewDialog
          // Week view only. The dialog opens from a WEEK day header; month
          // view has none, so its 42-day range would be fetched (on every
          // navigation and every mutation) for nobody.
          range={scheduleRange?.viewType === 'month' ? null : scheduleRange}
          locationId={user.activeLocation.id}
          dataVersion={scheduleDataVersion}
          openDate={overviewDate}
          onClose={() => setOverviewDate(null)}
          onOpenShift={openShift}
          restoreFocusRef={overviewOpenerRef}
        />
      )}
    </>
  )
}
