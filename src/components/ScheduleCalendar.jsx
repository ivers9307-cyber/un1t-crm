'use client'

// Roster v2 phase 2 — calendar now reads from /api/schedule/blocks
// (block-shaped data with nested shift_assignments) instead of the
// legacy flat /api/schedule/shifts. Each block renders as a single
// card showing template + time + capacity badge + assigned coaches.
// Empty future blocks get a red unstaffed flag.
//
// (Historical: public.shifts was kept in sync via the mig 068/069
// bidirectional triggers during cutover; the table + triggers were
// dropped in mig 238 — every reader is on shift_blocks +
// shift_assignments now.)
//
// Writes:
//   - Assign coach: POST /api/schedule/blocks/[id]/assignments
//   - Remove coach: DELETE /api/schedule/assignments/[id]
//   - Remove block: DELETE /api/schedule/blocks/[id]   (rare)
// Copy-week / copy-month / publish hit /api/schedule/shifts/* — these
// now write the block/assignment model directly (RETIRE-SHIFTS-MIRROR.5b).
// Swap requests POST the shift_assignment id as requester_shift_id
// (RETIRE-SHIFTS-MIRROR.5c). The legacy public.shifts mirror is gone (mig 238).

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { ChevronLeft, ChevronRight, Copy, Send, Plus, Users, User, Clock, X, ArrowLeftRight, CalendarOff, Palmtree, ThermometerSun, Ban, AlertTriangle, AlertCircle, CalendarDays, CalendarRange, Pencil, Check, Settings } from 'lucide-react'
import Link from 'next/link'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import { indexByDate } from '@/lib/bank-holidays'
import { MANAGER_ROLES } from '@/lib/schemas'
// ROSTER-FIX.6c — getMonday / addDays / formatDate were re-implemented here,
// byte-for-byte, beside the lib copies this file already imported from. One
// definition now: a change to the local-day rule cannot land on the server
// and miss the calendar.
import { addDays, formatDate, getMonday, isBlockUnstaffedFuture as libUnstaffed, liveAssignments, getMonthStart, monthStartForWeek, weekStartForMonth, periodsOverlap, periodCovers } from '@/lib/roster'
// ROSTER-FIX.4 — the server refuses a publish that would leave two published
// rosters over the same days. `overlapping_roster` is a code, not copy; the
// sentence it becomes is shared with the approvals queue so one refusal reads
// the same wherever the operator meets it.
import { OVERLAP_ERROR, overlapMessage } from '@/lib/roster-overlap-message'
// ROSTER-FIX.6c — this file had its own copy of this flattener
// (flattenBlocksToShifts), which is now the exported lib one; see the note on
// it for which of the two behaviours survived the merge.
import { blocksToShiftRows } from '@/lib/roster-summary'
// ROSTER-FIX.6c — the 12-hour shift label, previously a local copy here and
// two more in the manager screens. NOT fmtTime: see the note beside it.
import { coachConflictsForBlock, formatTime12h as formatTime } from '@/lib/schedule-overlap'
import Modal from '@/components/ui/Modal'
import RosterSummaryPanel from './RosterSummaryPanel'
import ScheduleErrorBanner from './schedule/ScheduleErrorBanner'
// ROSTER-FIX.6a — the six-endpoint fan-out, its error handling and its
// request-ordering guard live in the hook now; see its header for why.
import { useScheduleData } from './schedule/useScheduleData'
import { useWeekCost } from './schedule/useWeekCost'

const TIME_OFF_CONFIG = {
  holiday:     { label: 'Holiday',     color: '#22C55E', icon: Palmtree },
  sick:        { label: 'Sick',        color: '#EF4444', icon: ThermometerSun },
  unavailable: { label: 'Unavailable', color: '#F59E0B', icon: Ban },
}

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
// ROSTER-FIX.6a-8 — how long a success/warning toast stays up. Errors never
// expire; see the effect that consumes this.
const TOAST_TTL_MS = 6000
const canManage = (role) => MANAGER_ROLES.includes(role)

// Inverse of formatDate — parse a YYYY-MM-DD URL param into a local
// Date at midnight. Critical for SCHEDULE-PERSIST.1: `new Date('2026-
// 05-20')` parses as UTC midnight which becomes 01:00 Sunday in BST
// — the wrong day. We split the string and use the (y, m, d) ctor
// which is timezone-naive.
function parseLocalDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null
  const [y, m, d] = s.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  return Number.isNaN(dt.getTime()) ? null : dt
}

function addMonths(date, months) {
  const d = new Date(date)
  d.setMonth(d.getMonth() + months)
  return d
}

function getMonthGridRange(monthStart) {
  const start = getMonday(monthStart)
  const end = addDays(start, 41)
  return { start, end }
}

// Roster v2: a block is "unstaffed" when it has zero assignments
// AND its date is today or later. Past blocks may legitimately
// have empty assignments (coaches called out, never replaced) —
// flagging those is noise.
//
// ROSTER-FIX.1 — this was a local re-implementation that counted EVERY
// assignment row, so a cancelled one (an approved swap-drop) made an empty
// block look staffed and the red marker never appeared. Delegate to the one
// lib definition and count live rows only.
function isBlockUnstaffedFuture(block, todayStr) {
  return libUnstaffed(block, liveAssignments(block.shift_assignments).length, todayStr)
}

export default function ScheduleCalendar({ user, onRangeChange, onDataChange }) {
  // SCHEDULE-PERSIST.1 — week / month / view persisted in the URL so
  // refresh keeps the operator's position. Before this, the state
  // initialised from `new Date()` on every mount, so a page refresh
  // bounced back to "this week". URL params (`?view=...&week=...&
  // month=...`) also enable bookmarking and link-sharing — managers
  // can paste "look at this week's staffing" links to colleagues.
  //
  // Reads on mount, writes on every state change via router.replace
  // (no history entries so back-button doesn't have to undo N week
  // clicks). Both date params are normalised at parse time —
  // weekStart snaps to its Monday, monthStart snaps to its first.
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const [weekStart, setWeekStart] = useState(() => {
    const parsed = parseLocalDate(searchParams.get('week'))
    return getMonday(parsed || new Date())
  })
  const [monthStart, setMonthStart] = useState(() => {
    const parsed = parseLocalDate(searchParams.get('month'))
    return getMonthStart(parsed || new Date())
  })
  const [viewType, setViewType] = useState(() => {
    const v = searchParams.get('view')
    return v === 'month' || v === 'week' ? v : 'week'
  })

  // Mirror state → URL whenever the operator navigates / switches
  // view. Uses window.location.search (not the searchParams hook) to
  // build off the current URL because including searchParams in the
  // dep array would re-fire this effect every time `router.replace`
  // updates the URL, creating a churn loop. window.location.search is
  // safe inside useEffect (client-only). Preserves any unrelated query
  // params (defensive — the /schedule route doesn't have any today).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    params.set('view', viewType)
    params.set('week', formatDate(weekStart))
    params.set('month', formatDate(monthStart))
    router.replace(`${pathname}?${params.toString()}`, { scroll: false })
  }, [viewType, weekStart, monthStart, pathname, router])

  // Mig 125: notify parent (ScheduleTabs) of the visible date range
  // so the StudioOverviewStrip above us can re-fetch its per-day demand
  // summary. Fires every time the operator switches week / month or
  // navigates date. Uses formatDate(YYYY-MM-DD) for the wire shape.
  useEffect(() => {
    if (typeof onRangeChange !== 'function') return
    const innerStart = viewType === 'month' ? getMonthGridRange(monthStart).start : weekStart
    const innerEnd   = viewType === 'month' ? getMonthGridRange(monthStart).end   : addDays(weekStart, 6)
    onRangeChange({
      from: formatDate(innerStart),
      to:   formatDate(innerEnd),
      viewType,
    })
  }, [weekStart, monthStart, viewType, onRangeChange])

  const [viewMode, setViewMode] = useState('all') // 'my' or 'all'
  const [assignTarget, setAssignTarget] = useState(null) // { block } when picking a coach
  const [createTarget, setCreateTarget] = useState(null) // { date } when adding an ad-hoc block
  const [publishing, setPublishing] = useState(false)
  const [copying, setCopying] = useState(false)
  const [swapModal, setSwapModal] = useState(null) // legacy shift-shaped row to swap
  const [publishModal, setPublishModal] = useState(null) // { week, month: {start,end,label}, defaultScope }
  // SCHEDULE-PUBLISH-GUARD.1 — roster edits made since the last publish.
  // Drives the "you have unpublished changes" exit guard below.
  //
  // ROSTER-FIX.6a — this was one boolean for the whole screen, so editing
  // next week and then publishing THIS week cleared it and the operator
  // walked away from real unpublished changes with no warning; equally, a
  // published week kept nagging because an unrelated month was dirty. It is
  // now a set of 'YYYY-MM-DD..YYYY-MM-DD' period keys: an edit marks the
  // visible period, a publish clears every period it fully covers, and the
  // exit guard fires only when the period ON SCREEN is dirty.
  const [dirtyPeriods, setDirtyPeriods] = useState(() => new Set())
  // Block detail modal — clicking on a block card opens a popout
  // listing every assignment with edit affordances (override times,
  // remove, etc.). Replaces the cramped inline pencil/X icons.
  const [blockDetail, setBlockDetail] = useState(null) // shift_block row

  // ROSTER-FIX.6b-7 — where focus goes when a dialog closes and the control
  // that opened it no longer exists. Two flows do that: Add-coach is clicked
  // INSIDE the block-detail dialog (which then hides), and the swap icon
  // closes that dialog outright. Without somewhere real to land, the operator
  // is dropped on document.body and has to Tab from the top of the page.
  const calendarRef = useRef(null)

  // BULK-ASSIGN.1 — multi-select mode for staffing a week's worth
  // of recurring shifts in one go. Toggle button in the header
  // flips clicks into selection-toggle behaviour; floating action
  // bar at the bottom takes a coach + posts /bulk-assign.
  const [selectMode, setSelectMode] = useState(false)
  const [selectedBlockIds, setSelectedBlockIds] = useState(new Set())
  const [bulkAssignBusy, setBulkAssignBusy] = useState(false)
  const [bulkAssignProfile, setBulkAssignProfile] = useState('')
  // ROSTER-FIX.6a — this started life as the bulk-assign toast; it is now the
  // one place every mutation on this screen reports success or failure, so a
  // dropped request can no longer vanish into a discarded promise.
  const [toast, setToast] = useState(null) // { id, kind, message }
  // ROSTER-FIX.6a-8 — a monotonic id per toast. Without it, two identical
  // failures in a row wrote the same object shape into state: React saw no
  // change worth remounting, so the second click looked like it had done
  // nothing at all. The id keys the container, so every report is a fresh node
  // even when the sentence is identical.
  const toastSeq = useRef(0)
  // Single-flight guard for the destructive actions in the block detail modal
  // (remove coach, delete slot). Double-clicking either used to fire two
  // DELETEs, the second 404ing into an alert about a row that was already gone.
  const [rowBusy, setRowBusy] = useState(false)
  function showToast(message, kind = 'error') {
    setToast({ id: ++toastSeq.current, kind, message })
  }

  // ROSTER-FIX.6a-8 — success and warning toasts expire on their own; an
  // error stays until the operator dismisses it, because a failed mutation is
  // something they still have to act on and a toast that vanishes is a
  // discarded error with extra steps. Keying the effect on the toast id means
  // a replacement toast cancels the outgoing one's timer, and unmount clears
  // it, so a late timer can never blank a newer message.
  useEffect(() => {
    if (!toast || toast.kind === 'error') return undefined
    const timer = setTimeout(() => {
      setToast((current) => (current && current.id === toast.id ? null : current))
    }, TOAST_TTL_MS)
    return () => clearTimeout(timer)
  }, [toast])

  function toggleBlockSelection(blockId) {
    setSelectedBlockIds((prev) => {
      const next = new Set(prev)
      if (next.has(blockId)) next.delete(blockId)
      else next.add(blockId)
      return next
    })
  }

  function exitSelectMode() {
    setSelectMode(false)
    setSelectedBlockIds(new Set())
    setBulkAssignProfile('')
  }

  async function bulkAssign() {
    if (!bulkAssignProfile || selectedBlockIds.size === 0) return
    setBulkAssignBusy(true)
    setToast(null)
    try {
      const res = await fetch('/api/schedule/blocks/bulk-assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          block_ids: [...selectedBlockIds],
          profile_id: bulkAssignProfile,
        }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok || !j.success) {
        showToast(j.error || 'Bulk assign failed')
        return
      }
      const parts = [`${j.assigned.length} assigned`]
      if (j.skipped.length > 0) {
        // Group skipped by reason for a compact summary.
        const counts = j.skipped.reduce((acc, s) => {
          acc[s.reason] = (acc[s.reason] || 0) + 1
          return acc
        }, {})
        const skippedSummary = Object.entries(counts).map(([k, v]) => `${v} ${k.replace(/_/g, ' ')}`).join(', ')
        parts.push(`${j.skipped.length} skipped (${skippedSummary})`)
      }
      const message = parts.join(' · ')
      // Through showToast so this toast gets an id and an expiry like the rest.
      showToast(
        j.warnings.length > 0 ? `${message}. ${j.warnings.join('. ')}` : message,
        j.warnings.length > 0 ? 'warning' : 'success'
      )
      exitSelectMode()
      await refreshAfterMutation()
    } catch {
      // ROSTER-FIX.6a — a raw TypeError ("Failed to fetch") told the operator
      // nothing actionable; say what happened and what to do.
      showToast('Network error, please try again')
    } finally {
      setBulkAssignBusy(false)
    }
  }

  const locationId = user.activeLocation?.id
  const isManager = canManage(user.role)
  const todayStr = formatDate(new Date())

  const weekEnd = addDays(weekStart, 6)
  const weekLabel = `${weekStart.toLocaleDateString('en-IE', { day: 'numeric', month: 'short' })} – ${weekEnd.toLocaleDateString('en-IE', { day: 'numeric', month: 'short', year: 'numeric' })}`
  const monthGrid = getMonthGridRange(monthStart)
  const monthLabel = monthStart.toLocaleDateString('en-IE', { month: 'long', year: 'numeric' })

  // ROSTER-FIX.6a — the period the operator is looking at, in the same shape
  // the publish modal submits (week bounds, or calendar-month bounds, NOT the
  // month grid, which bleeds into the neighbouring months). One key format,
  // 'YYYY-MM-DD..YYYY-MM-DD', so a publish can clear exactly what it covered.
  const visibleMonthEnd = useMemo(
    () => new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0),
    [monthStart]
  )
  const visiblePeriodKey = useMemo(() => (
    viewType === 'month'
      ? `${formatDate(monthStart)}..${formatDate(visibleMonthEnd)}`
      : `${formatDate(weekStart)}..${formatDate(addDays(weekStart, 6))}`
  ), [viewType, weekStart, monthStart, visibleMonthEnd])
  // ROSTER-FIX.6a — warn on any INTERSECTION, not on an exact key match. Edit
  // in week view, switch to Month, and the visible key changes from the week
  // to the month while the unpublished edits stay on screen; exact equality
  // dropped the warning on that switch (and on the reverse), which was a
  // regression against the old screen-wide boolean. The asymmetry with
  // clearDirtyPeriodsCoveredBy below is deliberate and is spelled out beside
  // the two predicates in @/lib/roster: you warn on any overlap, you only
  // clear what a publish FULLY covered.
  const isVisiblePeriodDirty = useMemo(
    () => [...dirtyPeriods].some((key) => periodsOverlap(key, visiblePeriodKey)),
    [dirtyPeriods, visiblePeriodKey]
  )

  // A publish clears every dirty period it FULLY covers. Publishing the month
  // therefore clears the weeks inside it; publishing one week leaves a dirty
  // month alone, because the rest of that month is still unpublished.
  const clearDirtyPeriodsCoveredBy = useCallback((periodStart, periodEnd) => {
    const publishedKey = `${periodStart}..${periodEnd}`
    setDirtyPeriods((prev) => new Set([...prev].filter((key) => !periodCovers(publishedKey, key))))
  }, [])

  // ROSTER-FIX.6a — the fan-out, its try/catch and its request-ordering
  // guard now live in useScheduleData. Nothing else about the shapes changed.
  // SCHEDULE-SPEND-AGG.1 — contractor spend stays scoped to monthStart so
  // "Contractor spend, May 2026" tracks whichever month was last focused
  // (the convention RosterSummaryPanel has always used).
  const rangeStart = formatDate(viewType === 'month' ? monthGrid.start : weekStart)
  const rangeEnd = formatDate(viewType === 'month' ? monthGrid.end : weekEnd)
  const {
    blocks, templates, staff, timeOff, holidays, contractorSpend,
    loading, error, showingStaleData, successCount, refresh: fetchData,
  } = useScheduleData({
    locationId,
    startDate: rangeStart,
    endDate: rangeEnd,
    spendReferenceDate: formatDate(monthStart),
  })
  // ROSTER-FIX.6c — its own hook, not a seventh slice of the fan-out above: a
  // summary panel must not be able to take the roster down with it. See its
  // header. Manager-gated on the client too, so a coach's calendar never fires
  // a request the route would answer 403 anyway.
  const { weekCost, refreshWeekCost } = useWeekCost({
    locationId,
    weekStart: formatDate(weekStart),
    enabled: isManager,
  })
  // Dismissed separately from the hook's own state so the operator can clear a
  // banner without it reappearing until the next failure.
  //
  // 🔴 KEYED ON THE MESSAGE, NOT ON `error`'s IDENTITY, and the difference is
  // the whole feature. refresh() sets error to null and then back again on
  // EVERY cycle, so `[error]` re-armed the dismissal twice per refresh — the
  // operator cleared the banner, a background refresh they never asked for ran,
  // and the identical banner returned carrying no new information. The comment
  // above has always described the intent; the dependency did not deliver it.
  // Found because a test had to wait for the refreshes to settle before
  // dismissing, which is the shape of a test working around a product bug.
  //
  // A DIFFERENT failure still re-raises, because that is new information. So
  // does an explicit Retry: the operator asked, and they are owed the outcome
  // even when it is the same words. A successful load clears `error` outright,
  // so the banner goes on its own and there is nothing to re-arm.
  const [errorDismissed, setErrorDismissed] = useState(false)
  // What was on screen when they dismissed. Both halves are needed: the
  // message, so a DIFFERENT failure still speaks up, and the success count, so
  // the same message after a load that WORKED counts as new rather than as the
  // same old thing. Without the count, a failure dismissed this morning would
  // silence an identical failure this afternoon.
  const dismissedAt = useRef({ message: null, successCount: -1 })
  useEffect(() => {
    // A null between refreshes is not a new failure — it is refresh() clearing
    // the slot on its way to setting it again, and treating it as one is what
    // re-armed the dismissal twice per cycle.
    if (!error) return
    const seen = dismissedAt.current
    if (error === seen.message && successCount === seen.successCount) return
    setErrorDismissed(false)
  }, [error, successCount])
  const dismissError = useCallback(() => {
    dismissedAt.current = { message: error, successCount }
    setErrorDismissed(true)
  }, [error, successCount])
  const retryLoad = useCallback(() => {
    // The operator asked for this one, so its outcome is owed to them even if
    // the words come back identical.
    dismissedAt.current = { message: null, successCount: -1 }
    setErrorDismissed(false)
    fetchData()
  }, [fetchData])

  // OVERVIEW-REFRESH.1 — call this from mutation handlers (assign,
  // unassign, create, delete, bulk-assign, publish, copy-week, etc.)
  // instead of fetchData() directly. It refetches the calendar AND
  // bumps the parent's dataVersion counter so StudioOverviewStrip
  // refetches in lockstep. We deliberately don't put this in fetchData
  // itself because fetchData also runs on navigation (week / month /
  // date change) — and the overview strip already refetches on those
  // via its own `range` dep, so an extra bump there would just cause
  // a redundant overview fetch.
  const refreshAfterMutation = useCallback(async (opts = {}) => {
    await fetchData()
    // ROSTER-FIX.6c — the hours panel used to be derived from `blocks`, so it
    // moved on its own. It is a separate fetch now and has to be told.
    refreshWeekCost()
    onDataChange?.()
    // Every edit marks the VISIBLE period dirty so the exit guard fires until
    // the operator publishes that period. Publish opts out (markDirty: false)
    // and clears the periods it covered.
    if (opts.markDirty !== false) {
      setDirtyPeriods((prev) => new Set(prev).add(visiblePeriodKey))
    }
  }, [fetchData, refreshWeekCost, onDataChange, visiblePeriodKey])

  // ROSTER-FIX.6a — switching location swaps the whole roster out from under
  // the guard; the old location's unpublished edits are no longer reachable
  // from this screen, so keeping them dirty only produces a confusing prompt.
  useEffect(() => { setDirtyPeriods(new Set()) }, [locationId])

  // SCHEDULE-PUBLISH-GUARD.1 — warn before leaving with unpublished roster
  // changes. beforeunload covers tab close / refresh / external navigation;
  // the capture-phase click handler covers in-app link clicks (App Router
  // has no built-in route-change block).
  useEffect(() => {
    if (!isVisiblePeriodDirty) return undefined
    const onBeforeUnload = (e) => { e.preventDefault(); e.returnValue = '' }
    const onClickCapture = (e) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
      const a = e.target?.closest?.('a[href]')
      if (!a || a.target === '_blank' || a.hasAttribute('download')) return
      const href = a.getAttribute('href')
      if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return
      let url
      try { url = new URL(href, window.location.origin) } catch { return }
      if (url.origin !== window.location.origin || url.pathname === window.location.pathname) return
      if (!window.confirm('You have unpublished roster changes. Leave without publishing?')) {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    document.addEventListener('click', onClickCapture, true)
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload)
      document.removeEventListener('click', onClickCapture, true)
    }
  }, [isVisiblePeriodDirty])

  // Filter staff to those assigned to this location
  const locationStaff = staff.filter(s =>
    s.active && (s.profile_locations || []).some(pl => pl.location_id === locationId)
  )

  // Group blocks by day for the week view. "My" view filters to
  // blocks where the user has an assignment.
  const blocksByDay = DAY_LABELS.map((_, i) => {
    const date = formatDate(addDays(weekStart, i))
    const dayBlocks = blocks
      .filter(b => b.block_date === date)
      .filter(b => {
        if (viewMode === 'all') return true
        return liveAssignments(b.shift_assignments).some(a => a.profile_id === user.id)
      })
      .sort((a, b) => (a.start_time || '').localeCompare(b.start_time || ''))
    return dayBlocks
  })

  // Legacy-shape shifts for the swap-request modal. flatShifts[].id is the
  // shift_assignment id, which is exactly what POST /api/schedule/swaps wants
  // as requester_shift_id (RETIRE-SHIFTS-MIRROR.5c). The payroll calculator was
  // the other consumer until ROSTER-FIX.6c moved it to the server.
  const flatShifts = blocksToShiftRows(blocks)

  // Unstaffed-block count for the publish toolbar — surfaces "you
  // still have empty slots" as a friction signal before publishing.
  const unstaffedThisWeek = blocks.filter(b => {
    const inWeek = b.block_date >= formatDate(weekStart) && b.block_date <= formatDate(weekEnd)
    return inWeek && isBlockUnstaffedFuture(b, todayStr)
  }).length

  // SCHEDULE-MULTI-COACH.1 — assign N coaches in one round-trip. The
  // server returns per-coach outcomes; surface skipped reasons + any
  // time-off warnings in a single alert rather than burying them.
  async function handleAssignCoaches(blockId, profileIds) {
    try {
      const res = await fetch(`/api/schedule/blocks/${blockId}/assignments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile_ids: profileIds }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success) {
        showToast(data.error || 'Failed to assign coaches')
        return
      }
      const lines = []
      if (data.warnings?.length > 0) lines.push(...data.warnings)
      if (data.skipped?.length > 0) {
        const REASONS = {
          already_assigned: 'already on this block',
          at_capacity: 'block is at capacity',
        }
        for (const s of data.skipped) {
          const coach = staff.find((c) => c.id === s.profile_id)
          const name = coach?.full_name || s.profile_id
          lines.push(`${name}: skipped (${REASONS[s.reason] || s.reason})`)
        }
      }
      if (lines.length > 0) {
        const n = data.assigned?.length ?? 0
        showToast(`Assigned ${n} coach${n === 1 ? '' : 'es'}. ${lines.join('. ')}`, 'warning')
      }
      setAssignTarget(null)
      refreshAfterMutation()
    } catch {
      showToast('Network error, please try again')
    }
  }

  // (handleUnassign was dead code — assignment-removal logic now lives
  // inline as the onUnassign={async ...} prop on BlockDetailModal further
  // down. Removed during CODEQUAL.1.)

  // Partial shift save — used by BlockDetailModal. payload is
  // { start, end, reason } where null on any field clears the
  // override and returns to the block default.
  async function handlePartialSave(assignmentId, payload) {
    let res
    let data
    try {
      res = await fetch(`/api/schedule/assignments/${assignmentId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          start_time_override: payload.start || null,
          end_time_override: payload.end || null,
          partial_reason: payload.reason || null,
        }),
      })
      data = await res.json().catch(() => ({}))
    } catch {
      // The row renders this string inline, so it must read as copy.
      return { ok: false, error: 'Network error, please try again' }
    }
    if (res.ok && data.success) {
      await refreshAfterMutation()
      // Re-pull the latest block from the freshly-fetched list so
      // the modal shows the updated override values without the
      // operator having to close and reopen.
      if (blockDetail?.id) {
        // fetchData mutates blocks state on next tick; we use a
        // closure-friendly pattern via setBlocks below.
      }
      return { ok: true }
    }
    return { ok: false, error: data.error || 'Failed to save partial shift' }
  }

  // Refresh the modal's view when blocks state changes (after a
  // save fired fetchData).
  useEffect(() => {
    if (!blockDetail) return
    const updated = blocks.find((b) => b.id === blockDetail.id)
    if (updated) setBlockDetail(updated)
    // If the block was deleted, close the modal.
    else setBlockDetail(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocks])

  // (handleDeleteBlock was dead code — block-deletion logic now lives
  // inline as the onDeleteBlock={async () => ...} prop on BlockDetailModal.
  // Removed during CODEQUAL.1.)

  async function handleCreateBlock(date, templateId) {
    try {
      const res = await fetch('/api/schedule/blocks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          location_id: locationId,
          template_id: templateId,
          block_date: date,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success) {
        showToast(data.error || 'Failed to add slot')
        return
      }
      setCreateTarget(null)
      refreshAfterMutation()
    } catch {
      showToast('Network error, please try again')
    }
  }

  // Phase 5 publish: opens the modal, which then calls
  // submitPublish({ force_over_budget }). The modal handles the
  // owner-confirms-over-budget retry flow itself.
  function handlePublishClick() {
    // Offer both scopes. Month uses the calendar-month bounds (1st → last
    // day) — the same window the contractor budget is measured over — not
    // the month-grid (which bleeds into adjacent months). In week view the
    // "month" option targets the month the visible week falls in, mirroring
    // the copy-last-month button.
    // ROSTER-FIX.6a-9 — monthStartForWeek, the SAME midweek rule the Month
    // toggle uses. getMonthStart(weekStart) took the month of the week's
    // MONDAY, so on the week of Mon 31 Aug 2026 the toggle said September
    // while this modal offered to publish August: two different answers to
    // "which month am I looking at" on one screen.
    const effMonthStart = viewType === 'month' ? monthStart : monthStartForWeek(weekStart)
    const effMonthEnd = new Date(effMonthStart.getFullYear(), effMonthStart.getMonth() + 1, 0)
    setPublishModal({
      week: {
        start: formatDate(weekStart),
        end: formatDate(weekEnd),
        label: `${formatDate(weekStart)} – ${formatDate(weekEnd)}`,
      },
      month: {
        start: formatDate(effMonthStart),
        end: formatDate(effMonthEnd),
        label: effMonthStart.toLocaleDateString('en-IE', { month: 'long', year: 'numeric' }),
      },
      defaultScope: viewType === 'month' ? 'month' : 'week',
    })
  }

  async function submitPublish({ periodStart, periodEnd, forceOverBudget }) {
    setPublishing(true)
    try {
      const res = await fetch('/api/schedule/rosters', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          location_id: locationId,
          period_start: periodStart,
          period_end: periodEnd,
          force_over_budget: !!forceOverBudget,
        }),
      })
      const data = await res.json().catch(() => ({}))
      // 409 with `over_budget_confirmation_required` is not a
      // real error — it's the modal's signal to show the
      // confirmation step. The modal will call us back with
      // forceOverBudget=true.
      if (!data.success && data.error === 'over_budget_confirmation_required') {
        return { confirmRequired: true, impact: data.impact }
      }
      if (!data.success && data.error === OVERLAP_ERROR) {
        const message = overlapMessage(data)
        showToast(message)
        return { error: message }
      }
      if (!res.ok || !data.success) {
        const message = data.error || 'Publish failed'
        showToast(message)
        return { error: message }
      }
      // RETIRE-SHIFTS-MIRROR.6 — POST /rosters now notifies the rostered
      // coaches itself (it knows which blocks were newly published), so the
      // old follow-up call to /api/schedule/shifts/publish is gone. That
      // endpoint was a redundant second flip + notify; it has been removed.
      // ROSTER-FIX.4 — a partial success (roster row written, block tagging
      // failed) comes back as 201 + warning; surface it instead of refreshing
      // silently as if everything landed.
      if (data.warning) showToast(data.warning, 'warning')
      setPublishModal(null)
      // Publish is the one mutation that should NOT re-arm the exit guard.
      // A real publish clears the period it covered; a needs-approval draft
      // stays dirty (it's still pending an owner's sign-off).
      refreshAfterMutation({ markDirty: false })
      if (!data.needs_approval) clearDirtyPeriodsCoveredBy(periodStart, periodEnd)
      return data.needs_approval
        ? { needsApproval: true }
        : { published: true, impact: data.impact }
    } catch {
      // ROSTER-FIX.6a — without this the modal's Publish button spun on
      // `publishing` forever and the roster looked half-submitted.
      const message = 'Network error, the roster was not published. Please try again.'
      showToast(message)
      return { error: message }
    } finally {
      setPublishing(false)
    }
  }

  async function handleCopyWeek() {
    const prevWeekStart = addDays(weekStart, -7)
    if (!confirm(`Copy last week's roster (${formatDate(prevWeekStart)}) to this week?`)) return
    setCopying(true)
    // copy-week writes shift_blocks + shift_assignments directly
    // (RETIRE-SHIFTS-MIRROR.5b); the legacy public.shifts table is gone.
    try {
      const res = await fetch('/api/schedule/shifts/copy-week', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          location_id: locationId,
          source_start: formatDate(prevWeekStart),
          target_start: formatDate(weekStart),
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success) {
        showToast(data.error || 'Failed to copy week')
        return
      }
      refreshAfterMutation()
    } catch {
      showToast('Network error, please try again')
    } finally {
      // ROSTER-FIX.6a — setCopying(false) used to sit on the happy path, so a
      // thrown fetch left both copy buttons disabled until a full reload.
      setCopying(false)
    }
  }

  async function handleCopyMonth() {
    // Both buttons are shown in week view too, so derive the
    // effective month from whichever primary state the operator is
    // working in. Without this, clicking "Copy Last Month" from
    // week view would target whatever monthStart was set to last
    // (possibly stale from an earlier month-view session).
    // ROSTER-FIX.6a-9 — same midweek rule as the toggle and the publish modal;
    // see handlePublishClick. On the week of Mon 31 Aug 2026 this used to copy
    // into August while the header said September.
    const effectiveMonthStart = viewType === 'month' ? monthStart : monthStartForWeek(weekStart)
    const targetLabel = effectiveMonthStart.toLocaleDateString('en-IE', { month: 'long', year: 'numeric' })
    const prevMonthStart = addMonths(effectiveMonthStart, -1)
    const sourceLabel = prevMonthStart.toLocaleDateString('en-IE', { month: 'long', year: 'numeric' })
    if (!confirm(`Copy last month's roster (${sourceLabel}) to ${targetLabel}?`)) return
    setCopying(true)
    try {
      const res = await fetch('/api/schedule/shifts/copy-month', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          location_id: locationId,
          source_month_start: formatDate(prevMonthStart),
          target_month_start: formatDate(effectiveMonthStart),
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success) {
        showToast(data.error || 'Failed to copy month')
        return
      }
      const skipped = data.skipped || 0
      if (skipped > 0) {
        showToast(`Copied ${data.copied} shifts. ${skipped} skipped, that day of the month does not exist in the target (usually 31 Jan into Feb).`, 'warning')
      }
      refreshAfterMutation()
    } catch {
      showToast('Network error, please try again')
    } finally {
      setCopying(false)
    }
  }

  async function handleSwapRequest(shiftId, reason) {
    try {
      const res = await fetch('/api/schedule/swaps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requester_shift_id: shiftId, reason }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success) {
        showToast(data.error || 'Failed to submit swap request')
        return
      }
      setSwapModal(null)
      showToast('Swap request submitted, waiting for manager approval', 'success')
    } catch {
      showToast('Network error, please try again')
    }
  }

  return (
    <div ref={calendarRef}>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold">Schedule</h2>
          <p className="text-sm text-un1t-subtle mt-1">
            {user.activeLocation?.name} — Staff roster
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/schedule/time-off"
            className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg border border-un1t-border text-un1t-subtle hover:text-un1t-text hover:border-un1t-text/30 transition-colors"
          >
            <CalendarOff size={14} /> Time Off
          </Link>

          <div className="flex bg-un1t-surface border border-un1t-border rounded-lg overflow-hidden text-xs">
            <button
              type="button"
              onClick={() => setViewMode('my')}
              className={`flex items-center gap-1.5 px-3 py-2 transition-colors ${viewMode === 'my' ? 'bg-un1t-text text-un1t-bg' : 'text-un1t-subtle hover:text-un1t-text'}`}
            >
              <User size={14} /> My Shifts
            </button>
            <button
              type="button"
              onClick={() => setViewMode('all')}
              className={`flex items-center gap-1.5 px-3 py-2 transition-colors ${viewMode === 'all' ? 'bg-un1t-text text-un1t-bg' : 'text-un1t-subtle hover:text-un1t-text'}`}
            >
              <Users size={14} /> All Staff
            </button>
          </div>

          <div className="flex bg-un1t-surface border border-un1t-border rounded-lg overflow-hidden text-xs">
            <button
              type="button"
              onClick={() => {
                // ROSTER-FIX.6a — see weekStartForMonth: getMonday(monthStart)
                // used to land on the previous month whenever the 1st fell on
                // a weekend, and the next Month click then kept that month.
                if (viewType === 'month') setWeekStart(weekStartForMonth(monthStart, weekStart))
                setViewType('week')
              }}
              className={`flex items-center gap-1.5 px-3 py-2 transition-colors ${viewType === 'week' ? 'bg-un1t-text text-un1t-bg' : 'text-un1t-subtle hover:text-un1t-text'}`}
            >
              <CalendarDays size={14} /> Week
            </button>
            <button
              type="button"
              onClick={() => {
                // Midweek decides which month a straddling week belongs to.
                if (viewType === 'week') setMonthStart(monthStartForWeek(weekStart))
                setViewType('month')
              }}
              className={`flex items-center gap-1.5 px-3 py-2 transition-colors ${viewType === 'month' ? 'bg-un1t-text text-un1t-bg' : 'text-un1t-subtle hover:text-un1t-text'}`}
            >
              <CalendarRange size={14} /> Month
            </button>
          </div>

          {isManager && (
            <>
              {/* BULK-ASSIGN.1 — multi-select mode toggle. Off by
                  default so single-block edits still work as
                  before. On entry, the floating action bar at the
                  bottom of the page takes over until the operator
                  hits Cancel or Assign. */}
              <button
                type="button"
                onClick={() => {
                  if (selectMode) exitSelectMode()
                  else setSelectMode(true)
                }}
                className={`flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg border transition-colors ${
                  selectMode
                    ? 'bg-amber-500/20 border-amber-500/50 text-amber-700'
                    : 'border-un1t-border text-un1t-subtle hover:text-un1t-text hover:border-un1t-text/30'
                }`}
                title={selectMode ? 'Exit multi-select' : 'Select multiple shifts to assign a coach in bulk'}
              >
                <Check size={14} /> {selectMode ? `Selecting (${selectedBlockIds.size})` : 'Select multiple'}
              </button>
              {/* SCHEDULE-COPY-VISIBILITY.1 — both copy actions are
                  surfaced regardless of view. The copy-month endpoint
                  has always existed but was only visible in month
                  view, so operators working in week view never
                  discovered it. handleCopyMonth derives the target
                  month from the effective view state. */}
              <button
                type="button"
                onClick={handleCopyWeek}
                disabled={copying}
                className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg border border-un1t-border text-un1t-subtle hover:text-un1t-text hover:border-un1t-text/30 transition-colors disabled:opacity-50"
                title="Duplicate last week's shifts into this week"
              >
                <Copy size={14} /> {copying ? 'Copying...' : 'Copy Last Week'}
              </button>
              <button
                type="button"
                onClick={handleCopyMonth}
                disabled={copying}
                className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg border border-un1t-border text-un1t-subtle hover:text-un1t-text hover:border-un1t-text/30 transition-colors disabled:opacity-50"
                title="Duplicate last month's shifts into this month"
              >
                <Copy size={14} /> {copying ? 'Copying...' : 'Copy Last Month'}
              </button>
              {/* SCHEDULE-TEMPLATES-SHORTCUT.1 — direct path to the
                  shift-template editor. /settings/shifts has always
                  been MANAGER_ROLES-gated (head_coach included), but
                  the only link to it lived inside /settings/locations/
                  [id], which is master/owner-only — so head_coach
                  could never reach it. Surfacing the link here gives
                  every manager-class role a one-click entry point
                  from the view where they think about templates. */}
              <Link
                href="/settings/shifts"
                className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg border border-un1t-border text-un1t-subtle hover:text-un1t-text hover:border-un1t-text/30 transition-colors"
                title="Add, edit, or retire the shift templates that build this roster"
              >
                <Settings size={14} /> Manage templates
              </Link>
              {viewType === 'week' && (
                <button
                  type="button"
                  onClick={handlePublishClick}
                  disabled={publishing}
                  className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition-colors disabled:opacity-50"
                >
                  <Send size={14} /> {publishing ? 'Publishing...' : 'Publish'}
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {/* Range Navigation */}
      <div className="flex items-center justify-between mb-4">
        <button
          type="button"
          onClick={() => {
            if (viewType === 'month') setMonthStart(addMonths(monthStart, -1))
            else setWeekStart(addDays(weekStart, -7))
          }}
          aria-label={viewType === 'month' ? 'Previous month' : 'Previous week'}
          className="p-2 rounded-lg hover:bg-un1t-border/50 text-un1t-subtle hover:text-un1t-text transition-colors"
        >
          <ChevronLeft size={20} aria-hidden="true" />
        </button>
        <div className="text-center">
          <span className="font-semibold">{viewType === 'month' ? monthLabel : weekLabel}</span>
          <button
            type="button"
            onClick={() => {
              const now = new Date()
              if (viewType === 'month') setMonthStart(getMonthStart(now))
              else setWeekStart(getMonday(now))
            }}
            className="ml-3 text-xs text-blue-700 hover:text-blue-800"
          >
            Today
          </button>
        </div>
        <button
          type="button"
          onClick={() => {
            if (viewType === 'month') setMonthStart(addMonths(monthStart, 1))
            else setWeekStart(addDays(weekStart, 7))
          }}
          aria-label={viewType === 'month' ? 'Next month' : 'Next week'}
          className="p-2 rounded-lg hover:bg-un1t-border/50 text-un1t-subtle hover:text-un1t-text transition-colors"
        >
          <ChevronRight size={20} aria-hidden="true" />
        </button>
      </div>

      {/* ROSTER-FIX.6a — a failed load used to leave the screen on
          "Loading roster..." forever with nothing said. The banner names the
          failure, offers a retry, and can be dismissed.
          ROSTER-FIX.6a-9 — this was a hand-inlined copy of ScheduleErrorBanner,
          so the manager screens and this one could drift apart on the one thing
          they exist to do the same way. And when the hook keeps the last good
          data under the banner, SAY so: otherwise the grid quietly reads as
          the current week's roster. */}
      {error && !errorDismissed && (
        <ScheduleErrorBanner
          title="Could not load the roster"
          message={showingStaleData ? `${error} Showing the last data that loaded.` : error}
          onRetry={retryLoad}
          busy={loading}
          onDismiss={dismissError}
        />
      )}

      {/* Unstaffed-blocks summary — week view only, manager only */}
      {!loading && isManager && viewType === 'week' && unstaffedThisWeek > 0 && (
        <div className="mb-4 flex items-start gap-3 p-3 rounded-lg border border-red-500/40 bg-red-500/10 text-sm">
          <AlertCircle size={16} className="text-red-600 mt-0.5 flex-shrink-0" />
          <div>
            <div className="font-medium text-red-700">
              {unstaffedThisWeek} unstaffed block{unstaffedThisWeek === 1 ? '' : 's'} this week
            </div>
            <div className="text-xs text-red-700/80 mt-0.5">
              Demand windows with no coach assigned. Customers will be in the studio either way — assign coaches or remove the block.
            </div>
          </div>
        </div>
      )}

      {/* Overtime warning panel.
          ROSTER-FIX.6c — the arithmetic ran HERE, over annual_salary /
          hourly_rate / overtime_rate fetched from /api/staff, to render a panel
          that prints no money at all. It comes off /api/schedule/week-cost now:
          hours in the payload, rates never leaving the server. The endpoint is
          scoped to one Mon-Sun week, which is what the caption underneath has
          always claimed — the browser version summed whatever range was loaded,
          so in month view it billed six weeks against a weekly contract. */}
      {!loading && canManage(user.role) && (() => {
        const overOrAt = (weekCost?.coaches || []).filter((c) => c.status !== 'under')
        if (overOrAt.length === 0) return null

        return (
          <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
            <div className="flex items-center gap-2 text-amber-700 font-medium text-sm mb-2">
              <AlertTriangle size={16} /> Weekly hours notice
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
              {overOrAt.map((c) => {
                const isOver = c.over_threshold
                return (
                  <div
                    key={c.profile_id}
                    className={`text-xs rounded-md px-2.5 py-1.5 border ${isOver
                      ? 'border-amber-500/40 bg-amber-500/10 text-amber-700'
                      : 'border-un1t-border bg-un1t-surface/40 text-un1t-subtle'
                    }`}
                  >
                    <span className="font-medium text-un1t-text">{c.full_name}</span>
                    {' — '}
                    <span>{c.allocated_hours.toFixed(1)}h / {c.contracted_hours}h</span>
                    {isOver && (
                      <span className="ml-1 font-semibold">
                        +{c.overtime_hours.toFixed(1)}h OT
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
            <p className="text-[11px] text-un1t-muted mt-2">
              FTE staff scheduled at or above their contracted hours for {weekLabel}.
            </p>
          </div>
        )
      })()}

      {/* Calendar Grid */}
      {loading ? (
        <div className="text-center py-20 text-un1t-subtle">Loading roster...</div>
      ) : viewType === 'month' ? (
        // ── MONTH VIEW ──
        // Renders a 6x7 grid; each cell shows the date + count of
        // assignments + count of unstaffed blocks. Clicking drills
        // into the week view. Roster v2: separately surfaces empty
        // blocks as a red badge.
        // ROSTER-FIX.6b — seven columns with no breakpoint. On a 390px phone
        // each day cell was ~50px wide and every block label inside it was an
        // ellipsis. The grid keeps its seven columns and gets a floor instead;
        // the page scrolls the calendar sideways rather than crushing it.
        // Header row and cells share ONE scroller so the weekday labels stay
        // over their own columns.
        <div className="overflow-x-auto">
          <div className="min-w-[840px]">
          <div className="grid grid-cols-7 gap-1.5 mb-1.5">
            {DAY_LABELS.map(label => (
              <div key={label} className="text-[11px] font-semibold text-un1t-subtle uppercase tracking-wider text-center py-1">
                {label}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-1.5">
            {(() => {
              const holidayByDate = indexByDate(holidays)
              const focusedMonth = monthStart.getMonth()
              const cells = []
              for (let i = 0; i < 42; i++) {
                const date = addDays(monthGrid.start, i)
                const dateStr = formatDate(date)
                const dayBlocks = blocks.filter(b => b.block_date === dateStr)
                const visibleBlocks = viewMode === 'all'
                  ? dayBlocks
                  : dayBlocks.filter(b => liveAssignments(b.shift_assignments).some(a => a.profile_id === user.id))
                const dayTimeOff = timeOff.filter(t => t.start_date <= dateStr && t.end_date >= dateStr)
                const inFocusedMonth = date.getMonth() === focusedMonth
                const isToday = dateStr === todayStr
                const holiday = holidayByDate.get(dateStr)
                const totalAssignmentCount = visibleBlocks.reduce((sum, b) => sum + liveAssignments(b.shift_assignments).length, 0)
                const unstaffedCount = visibleBlocks.filter(b => isBlockUnstaffedFuture(b, todayStr)).length

                cells.push(
                  <button
                    key={dateStr}
                    type="button"
                    onClick={() => {
                      setWeekStart(getMonday(date))
                      setViewType('week')
                    }}
                    className={`text-left bg-un1t-surface border rounded-md p-1.5 min-h-[88px] transition-colors hover:border-un1t-text/30 ${
                      inFocusedMonth ? 'border-un1t-border' : 'border-un1t-border/50 opacity-60'
                    } ${isToday ? 'ring-1 ring-blue-400/50' : ''} ${holiday ? 'bg-amber-500/[0.06]' : ''}`}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className={`text-xs font-semibold ${isToday ? 'text-blue-700' : inFocusedMonth ? 'text-un1t-text' : 'text-un1t-muted'}`}>
                        {date.getDate()}
                      </span>
                      <div className="flex items-center gap-1">
                        {/* ROSTER-FIX.2 — unstaffed is a manager cue; coaches get a capacity-free feed and no red flags. */}
                        {isManager && unstaffedCount > 0 && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/20 text-red-700" title={`${unstaffedCount} unstaffed`}>
                            <span aria-hidden="true">!{unstaffedCount}</span>
                            <span className="sr-only">{unstaffedCount} unstaffed</span>
                          </span>
                        )}
                        {totalAssignmentCount > 0 && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-un1t-border/60 text-un1t-subtle">
                            {totalAssignmentCount}
                          </span>
                        )}
                      </div>
                    </div>
                    {holiday && (
                      <div className="text-[9px] text-amber-700 mb-1 truncate" title={holiday.name}>
                        {holiday.name}
                      </div>
                    )}
                    <div className="space-y-0.5">
                      {visibleBlocks.slice(0, 3).map(b => {
                        const tmpl = b.shift_templates || {}
                        const count = liveAssignments(b.shift_assignments).length
                        const unstaffed = isBlockUnstaffedFuture(b, todayStr)
                        // ROSTER-FIX.6b — unstaffed was a red hairline border and
                        // nothing else. It survives neither greyscale nor the
                        // ~8% of male operators with a red/green deficiency, and
                        // there is no text for a screen reader to reach at all.
                        // The warning glyph and the sr-only word carry it now;
                        // the border stays as the at-a-glance cue for everyone else.
                        const showUnstaffed = isManager && unstaffed
                        return (
                          <div
                            key={b.id}
                            className={`text-[10px] truncate rounded px-1 py-0.5 ${showUnstaffed ? 'border border-red-500/40' : ''}`}
                            style={{ backgroundColor: (tmpl.color || '#3B82F6') + '20', color: tmpl.color || '#3B82F6' }}
                            title={`${tmpl.name || 'Shift'} · ${formatTime(b.start_time)}–${formatTime(b.end_time)}${isManager ? ` · ${count}/${b.max_coaches}` : ''}${showUnstaffed ? ' · Unstaffed' : ''}`}
                          >
                            {showUnstaffed && (
                              <>
                                <AlertTriangle size={9} className="inline-block mr-0.5 -mt-px text-red-700" aria-hidden="true" />
                                <span className="sr-only">Unstaffed. </span>
                              </>
                            )}
                            {formatTime(b.start_time)}{isManager ? ` ${count}/${b.max_coaches}` : ''}
                          </div>
                        )
                      })}
                      {visibleBlocks.length > 3 && (
                        <div className="text-[10px] text-un1t-muted">+{visibleBlocks.length - 3} more</div>
                      )}
                      {dayTimeOff.slice(0, 1).map(t => {
                        const conf = TIME_OFF_CONFIG[t.type] || TIME_OFF_CONFIG.unavailable
                        return (
                          <div
                            key={`to-${t.id}`}
                            className="text-[10px] truncate rounded px-1 py-0.5"
                            style={{ backgroundColor: conf.color + '18', color: conf.color }}
                          >
                            {t.profiles?.full_name?.split(' ')[0]} {conf.label}
                          </div>
                        )
                      })}
                    </div>
                  </button>
                )
              }
              return cells
            })()}
          </div>
          </div>
        </div>
      ) : (
        // ── WEEK VIEW ──
        // Roster v2: one card per BLOCK. Each card shows the
        // template colour + name + time + capacity badge + a list
        // of assigned coaches (or an empty-state with a red flag
        // for future unstaffed demand windows). Click opens the
        // assign popover.
        // ROSTER-FIX.6b — same floor as the month grid; a week card carries a
        // template name, a time range and a coach list, none of which survive
        // a 50px column.
        <div className="overflow-x-auto">
        <div className="grid grid-cols-7 gap-2 min-w-[840px]">
          {(() => {
            const holidayByDate = indexByDate(holidays)
            return DAY_LABELS.map((label, i) => {
              const date = addDays(weekStart, i)
              const dateStr = formatDate(date)
              const isToday = formatDate(new Date()) === dateStr
              const dayBlocks = blocksByDay[i]
              const holiday = holidayByDate.get(dateStr)
              // ROSTER-FIX.6b-7 — "Monday 4 May", so a block card's button
              // names its own day. In a controls list every card would
              // otherwise read "Manage the 09:30 Morning shift", seven times.
              const cardDayLabel = date.toLocaleDateString('en-IE', { weekday: 'long', day: 'numeric', month: 'long' })

              const headerCls = isToday
                ? 'bg-blue-600 text-white'
                : holiday
                  ? 'bg-amber-500/15 text-amber-700 border border-amber-500/30'
                  : 'bg-un1t-surface text-un1t-subtle'

              return (
                <div key={i} className="min-h-[200px]">
                  <div className={`text-center py-2 rounded-t-lg text-xs font-semibold ${headerCls}`} title={holiday?.name || undefined}>
                    <div>{label}</div>
                    <div className={`text-lg font-bold ${isToday ? 'text-white' : 'text-un1t-text'}`}>{date.getDate()}</div>
                    {holiday && (
                      <div className={`mt-0.5 text-[10px] font-medium leading-tight px-1 truncate ${isToday ? 'text-white/80' : 'text-amber-700'}`}>
                        {holiday.source === 'national' ? '🇮🇪 ' : '🏷 '}{holiday.name}
                      </div>
                    )}
                  </div>

                  <div className={`bg-un1t-surface/50 border border-un1t-border border-t-0 rounded-b-lg p-1.5 space-y-1.5 min-h-[160px] ${holiday ? 'bg-amber-500/[0.04]' : ''}`}>
                    {/* Time-off bars */}
                    {timeOff
                      .filter(t => t.start_date <= dateStr && t.end_date >= dateStr)
                      .filter(t => viewMode === 'all' || t.profile_id === user.id)
                      .map(t => {
                        const conf = TIME_OFF_CONFIG[t.type] || TIME_OFF_CONFIG.unavailable
                        const Icon = conf.icon
                        return (
                          <div
                            key={`to-${t.id}`}
                            className="rounded-md px-2 py-1.5 text-xs flex items-center gap-1.5"
                            style={{ backgroundColor: conf.color + '18', borderLeft: `3px solid ${conf.color}` }}
                          >
                            <Icon size={12} style={{ color: conf.color }} />
                            <span className="font-medium truncate" style={{ color: conf.color }}>
                              {t.profiles?.full_name} — {conf.label}
                            </span>
                          </div>
                        )
                      })
                    }

                    {dayBlocks.length === 0 && timeOff.filter(t => t.start_date <= dateStr && t.end_date >= dateStr).length === 0 && (
                      <div className="text-center py-6 text-xs text-un1t-muted">No shifts</div>
                    )}

                    {dayBlocks.map(block => {
                      const tmpl = block.shift_templates || {}
                      const assignments = liveAssignments(block.shift_assignments)
                      const count = assignments.length
                      const max = block.max_coaches || 15
                      const unstaffed = isBlockUnstaffedFuture(block, todayStr)
                      // ROSTER-FIX.2 — same reason: the red unstaffed styling is manager-only, coaches see the neutral card.
                      const showUnstaffed = isManager && unstaffed
                      const myAssignment = assignments.find(a => a.profile_id === user.id)
                      const blockColor = tmpl.color || '#3B82F6'
                      const atCapacity = count >= max

                      const isSelected = selectedBlockIds.has(block.id)
                      // ROSTER-FIX.6b-7 — the card's own short name, spoken by
                      // the overlay button below. It is deliberately NOT the
                      // card's contents: the coach list, the capacity chip and
                      // the "Unstaffed."/"Adjusted hours…" text stay in the
                      // card so a screen reader can browse them line by line.
                      const cardLabel = `${formatTime(block.start_time)} ${tmpl.name || 'Shift'} shift, ${cardDayLabel}`
                      return (
                        <div
                          key={block.id}
                          className={`rounded-md p-2 text-xs relative group hover:ring-1 hover:ring-un1t-subtle/40 ${myAssignment ? 'ring-1 ring-blue-400/50' : ''} ${showUnstaffed ? 'border border-red-500/50' : ''} ${isSelected ? 'ring-2 ring-amber-400 ring-offset-1 ring-offset-un1t-bg' : ''}`}
                          style={{ backgroundColor: showUnstaffed ? '#7F1D1D20' : blockColor + '20', borderLeft: `3px solid ${showUnstaffed ? '#EF4444' : blockColor}` }}
                        >
                          {/* ROSTER-FIX.6b-7 — this card used to BE the button:
                              role="button" + tabIndex on the wrapper. That is
                              the a11y trap 6b walked into — an element with a
                              button role has its whole subtree flattened into
                              ONE accessible name, so the sr-only "Unstaffed."
                              and "Adjusted hours: …" this PR added for exactly
                              this card, plus every coach's name, were read as a
                              single run-on string and nothing inside it could
                              be reached on its own. The wrapper goes back to
                              being a plain container and the click target
                              becomes a real <button> stretched over it with a
                              short label of its own. Enter and Space (with the
                              scroll suppressed) come free with a real button —
                              no hand-rolled key handler, and nothing to bubble
                              up from a child. */}
                          <button
                            type="button"
                            aria-pressed={selectMode ? isSelected : undefined}
                            onClick={() => {
                              // BULK-ASSIGN.1 — in select mode, clicks
                              // toggle selection instead of opening
                              // the detail modal. The action bar at
                              // the bottom takes the bulk-assign call.
                              if (selectMode) toggleBlockSelection(block.id)
                              else setBlockDetail(block)
                            }}
                            className="absolute inset-0 z-10 w-full rounded-md cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-un1t-accent"
                          >
                            <span className="sr-only">
                              {selectMode ? `Select ${cardLabel}` : `Manage ${cardLabel}`}
                            </span>
                          </button>
                          <div className="flex items-center justify-between gap-1">
                            <div className="font-semibold truncate" style={{ color: showUnstaffed ? '#FCA5A5' : 'inherit' }}>
                              {/* ROSTER-FIX.6b — the card said "unstaffed" with a red
                                  wash and a red left rule. Both vanish in greyscale
                                  and neither is announced. The glyph plus the
                                  visually-hidden word say it in text. */}
                              {showUnstaffed && (
                                <>
                                  <AlertTriangle size={11} className="inline-block mr-1 -mt-0.5 text-red-700" aria-hidden="true" />
                                  <span className="sr-only">Unstaffed. </span>
                                </>
                              )}
                              {tmpl.name || 'Shift'}
                            </div>
                            {/* ROSTER-FIX.2 — capacity is a manager fact. A coach
                                sees the shift, its time and who is on it; how many
                                bodies it is budgeted for is not their business, and
                                the API no longer sends max_coaches to them anyway. */}
                            {isManager && (
                              <span
                                className={`text-[10px] px-1.5 py-0.5 rounded font-medium flex-shrink-0 ${
                                  unstaffed
                                    ? 'bg-red-500/20 text-red-700'
                                    : atCapacity
                                      ? 'bg-un1t-border/60 text-un1t-text'
                                      : ''
                                }`}
                                style={!unstaffed && !atCapacity ? { backgroundColor: blockColor + '30', color: blockColor } : undefined}
                              >
                                {count}/{max}
                              </span>
                            )}
                          </div>
                          <div className="text-un1t-subtle mt-0.5 flex items-center gap-1">
                            <Clock size={10} />
                            {formatTime(block.start_time)}–{formatTime(block.end_time)}
                          </div>

                          {/* Assigned coaches list */}
                          {count === 0 ? (
                            <div className="mt-1.5 text-[11px] text-red-700 italic">
                              {!isManager ? 'No coach assigned' : unstaffed ? 'Unstaffed — assign a coach' : 'No coach (past)'}
                            </div>
                          ) : (
                            <div className="mt-1.5 space-y-0.5">
                              {assignments.map(a => {
                                const isMe = a.profile_id === user.id
                                const hasOverride = !!(a.start_time_override || a.end_time_override)
                                return (
                                  <div key={a.id} className="flex items-center justify-between gap-1 text-[11px]">
                                    <span className={`truncate ${isMe ? 'text-blue-700 font-medium' : 'text-un1t-text'}`}>
                                      {a.profiles?.full_name || 'Unknown'}
                                      {hasOverride && (
                                        // ROSTER-FIX.6b — a bare bullet with a colour
                                        // and a tooltip. Screen readers say "black
                                        // circle" or nothing at all, and the amber is
                                        // the only thing separating it from the name
                                        // beside it. It gets a real name and its
                                        // detail moves into a visually-hidden span so
                                        // the tooltip is no longer the only copy.
                                        <span
                                          className="ml-1 text-amber-700"
                                          title={
                                            `Adjusted: ${formatTime(a.start_time_override || block.start_time)}–${formatTime(a.end_time_override || block.end_time)}` +
                                            (a.partial_reason ? ` · ${a.partial_reason}` : '')
                                          }
                                        >
                                          <span aria-hidden="true">●</span>
                                          <span className="sr-only">
                                            {' '}Adjusted hours: {formatTime(a.start_time_override || block.start_time)} to {formatTime(a.end_time_override || block.end_time)}
                                            {a.partial_reason ? `. ${a.partial_reason}` : ''}
                                          </span>
                                        </span>
                                      )}
                                    </span>
                                  </div>
                                )
                              })}
                            </div>
                          )}

                          {/* Subtle "click to manage" hint at the bottom.
                              Everything actionable (assign coach, partial-shift
                              edits, remove coach, delete block, swap) lives in
                              the modal that opens on click. */}
                          {(isManager || myAssignment) && (
                            // ROSTER-FIX.6b-7 — aria-hidden: it says "Click",
                            // it only appears on hover, and the button above
                            // already says "Manage …". Left visible, taken out
                            // of the accessibility tree.
                            <div aria-hidden="true" className="mt-1.5 text-[10px] text-un1t-muted italic text-right opacity-0 group-hover:opacity-100 transition-opacity">
                              Click to manage
                            </div>
                          )}
                        </div>
                      )
                    })}

                    {/* Add ad-hoc block button (manager only) */}
                    {isManager && (
                      <button
                        type="button"
                        onClick={() => setCreateTarget({ date: dateStr })}
                        className="w-full py-2 rounded-md border border-dashed border-un1t-border text-un1t-muted hover:text-un1t-text hover:border-un1t-text/30 text-xs transition-colors flex items-center justify-center gap-1"
                      >
                        <Plus size={12} /> Add Slot
                      </button>
                    )}
                  </div>
                </div>
              )
            })
          })()}
        </div>
        </div>
      )}

      {/* Roster v2 phase 4 — week + month summary. Manager-only. */}
      {/* Phase 6: passes `timeOff` so FTE utilisation is leave-aware. */}
      {/* SCHEDULE-SPEND-AGG.1: contractorSpend comes from a server-
          computed aggregate so head_coach sees real totals + over-
          budget signals without being granted hourly_rate visibility. */}
      {/* ROSTER-FIX.6c: `staff` is the pay-free picker shape now, so no role
          gets rates here and the canSeePay prop had nothing left to gate. */}
      {!loading && isManager && (
        <RosterSummaryPanel
          blocks={blocks}
          staff={locationStaff}
          weekStart={weekStart}
          monthStart={monthStart}
          location={user.activeLocation}
          timeOff={timeOff}
          contractorSpend={contractorSpend}
        />
      )}

      {/* Assign Coach Popover */}
      {assignTarget && (
        <AssignCoachModal
          block={assignTarget.block}
          staff={locationStaff}
          blocks={blocks}
          timeOff={timeOff}
          onAssign={(profileIds) => handleAssignCoaches(assignTarget.block.id, profileIds)}
          onClose={() => setAssignTarget(null)}
          // ROSTER-FIX.6b-7 — the Add-coach button that opened this lives in
          // the block-detail dialog, which is unmounted while this one is up.
          restoreFocusRef={calendarRef}
        />
      )}

      {/* Add Block (ad-hoc) Modal */}
      {createTarget && (
        <CreateBlockModal
          date={createTarget.date}
          templates={templates}
          onCreate={(templateId) => handleCreateBlock(createTarget.date, templateId)}
          onClose={() => setCreateTarget(null)}
        />
      )}

      {/* Block Detail Modal — opens on block-card click. Houses all
          per-assignment edits (partial-shift overrides, remove coach,
          self-swap-request) plus block-level actions (assign, delete).
          Hidden while the assign-coach modal is up so the operator
          isn't staring at a doubled overlay; re-renders automatically
          (with the new assignment baked in via the blocks-sync effect)
          once the assign-coach modal closes. */}
      {blockDetail && !assignTarget && (
        <BlockDetailModal
          block={blockDetail}
          user={user}
          isManager={isManager}
          onClose={() => setBlockDetail(null)}
          onAddCoach={() => setAssignTarget({ block: blockDetail })}
          busy={rowBusy}
          onUnassign={async (assignmentId) => {
            if (rowBusy) return
            if (!confirm('Remove this coach from the shift?')) return
            setRowBusy(true)
            try {
              const res = await fetch(`/api/schedule/assignments/${assignmentId}`, { method: 'DELETE' })
              const data = await res.json().catch(() => ({}))
              if (!res.ok || !data.success) {
                showToast(data.error || 'Failed to remove')
                return
              }
              await refreshAfterMutation()
            } catch {
              showToast('Network error, please try again')
            } finally {
              setRowBusy(false)
            }
          }}
          onPartialSave={handlePartialSave}
          onDeleteBlock={async () => {
            if (rowBusy) return
            if (!confirm('Delete this entire shift slot? Any assigned coaches are removed too.')) return
            setRowBusy(true)
            try {
              const res = await fetch(`/api/schedule/blocks/${blockDetail.id}`, { method: 'DELETE' })
              const data = await res.json().catch(() => ({}))
              if (!res.ok || !data.success) {
                showToast(data.error || 'Failed to delete')
                return
              }
              setBlockDetail(null)
              refreshAfterMutation()
            } catch {
              showToast('Network error, please try again')
            } finally {
              setRowBusy(false)
            }
          }}
          onSwapRequest={(myAssignmentId) => {
            const shiftShape = flatShifts.find((fs) => fs.id === myAssignmentId)
            if (shiftShape) {
              setSwapModal(shiftShape)
              setBlockDetail(null)
            }
          }}
        />
      )}

      {/* Swap Request Modal */}
      {swapModal && (
        <SwapModal
          shift={swapModal}
          onSubmit={handleSwapRequest}
          onClose={() => setSwapModal(null)}
          // ROSTER-FIX.6b-7 — same shape: onSwapRequest closes the block-detail
          // dialog, so the swap icon is gone by the time this one closes.
          restoreFocusRef={calendarRef}
        />
      )}

      {/* Publish Roster Modal — phase 5 */}
      {publishModal && (
        <PublishRosterModal
          locationId={locationId}
          isOwner={user.role === 'master' || user.role === 'owner'}
          period={publishModal}
          onSubmit={submitPublish}
          onClose={() => setPublishModal(null)}
          publishing={publishing}
        />
      )}

      {/* BULK-ASSIGN.1 — floating action bar. Appears whenever
          select mode is on; coach picker becomes active once at
          least one block is selected. Sits fixed at the bottom of
          the viewport so the operator can keep clicking blocks to
          add/remove from the selection without losing the picker.
          Cancel exits select mode + clears selection. */}
      {selectMode && (
        <div className="fixed bottom-0 left-0 right-0 z-40 bg-un1t-surface border-t border-amber-500/50 shadow-2xl shadow-amber-500/10">
          <div className="max-w-7xl mx-auto px-4 py-3 flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-2 text-sm">
              <Check size={16} className="text-amber-700" />
              <span className="font-semibold text-un1t-text">
                {selectedBlockIds.size === 0
                  ? 'Click shifts on the calendar to select'
                  : `${selectedBlockIds.size} shift${selectedBlockIds.size === 1 ? '' : 's'} selected`}
              </span>
            </div>
            <div className="flex-1 min-w-[200px]">
              <select
                value={bulkAssignProfile}
                onChange={(e) => setBulkAssignProfile(e.target.value)}
                disabled={selectedBlockIds.size === 0 || bulkAssignBusy}
                className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text disabled:opacity-50"
              >
                <option value="">— Select a coach —</option>
                {locationStaff.map((s) => (
                  <option key={s.id} value={s.id}>{s.full_name}</option>
                ))}
              </select>
            </div>
            <button
              type="button"
              onClick={bulkAssign}
              disabled={!bulkAssignProfile || selectedBlockIds.size === 0 || bulkAssignBusy}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-amber-500 text-un1t-bg text-sm font-semibold hover:bg-amber-400 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {bulkAssignBusy ? 'Assigning…' : `Assign to ${selectedBlockIds.size || 0}`}
            </button>
            <button
              type="button"
              onClick={exitSelectMode}
              disabled={bulkAssignBusy}
              className="text-sm text-un1t-subtle hover:text-un1t-text disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
          {toast && (
            <div key={toast.id} data-toast-id={toast.id} className={`max-w-7xl mx-auto px-4 pb-2 text-xs ${
              toast.kind === 'error' ? 'text-red-700' :
              toast.kind === 'warning' ? 'text-amber-700' :
              'text-emerald-700'
            }`}>
              {toast.message}
            </div>
          )}
        </div>
      )}
      {/* Standalone toast — shows after a successful assign that
          closed select mode, so the operator sees what happened. */}
      {!selectMode && toast && (
        <div key={toast.id} data-toast-id={toast.id} className={`fixed bottom-4 right-4 z-40 max-w-md rounded-md border px-4 py-3 text-sm shadow-2xl ${
          toast.kind === 'error' ? 'border-red-500/50 bg-red-500/10 text-red-700' :
          toast.kind === 'warning' ? 'border-amber-500/50 bg-amber-500/10 text-amber-700' :
          'border-emerald-500/50 bg-emerald-500/10 text-emerald-700'
        }`}>
          <div className="flex items-start justify-between gap-3">
            <span>{toast.message}</span>
            <button type="button" onClick={() => setToast(null)} aria-label="Dismiss this message" className="text-current opacity-70 hover:opacity-100">
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// SCHEDULE-MULTI-COACH.1 — the operator picks any number of coaches
// in one shot (checkbox list) rather than re-opening the modal once
// per coach. The handler bundles every pick into a single
// /assignments POST whose response shape lists per-coach outcomes
// so 'one of these is already assigned' becomes a footnote in the
// confirmation rather than an interruption.
function AssignCoachModal({ block, staff, blocks, timeOff, onAssign, onClose, restoreFocusRef }) {
  const [selectedIds, setSelectedIds] = useState(() => new Set())
  const [saving, setSaving] = useState(false)
  const tmpl = block.shift_templates || {}
  const assignedIds = new Set(liveAssignments(block.shift_assignments).map((a) => a.profile_id))
  const available = staff.filter((s) => !assignedIds.has(s.id))
  const dayLabel = new Date(block.block_date + 'T00:00:00').toLocaleDateString('en-IE', { weekday: 'long', day: 'numeric', month: 'long' })
  const currentCount = liveAssignments(block.shift_assignments).length
  const slotsLeft = Math.max(0, (block.max_coaches || 0) - currentCount)

  function toggle(id) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function handleClick() {
    if (selectedIds.size === 0) return
    setSaving(true)
    await onAssign(Array.from(selectedIds))
    setSaving(false)
  }

  const overCapacity = selectedIds.size > slotsLeft
  const submitLabel = saving
    ? 'Assigning…'
    : selectedIds.size === 0
      ? 'Assign coaches'
      : `Assign ${selectedIds.size} coach${selectedIds.size === 1 ? '' : 'es'}`

  return (
    // ROSTER-FIX.6b — dismissOnBackdrop goes false the moment a coach is
    // ticked: the operator has made a selection they would have to redo.
    <Modal open onClose={onClose} title="Assign coaches" dismissOnBackdrop={selectedIds.size === 0} restoreFocusRef={restoreFocusRef}>
      <div>
        {/* ROSTER-FIX.6b-8 — this summary block was `bg-black/30`, which was a
            legible dark inset while the overlay was a hand-rolled dark div.
            Converting the overlay to the Modal primitive put it on a WHITE
            panel, where a 30%-black wash over white is a mid grey that the
            un1t-subtle sub-line underneath it no longer reads on. It becomes
            the ordinary light card recipe: the surface token plus a hairline.
            `bg-un1t-bg` would be invisible here (the panel is already white)
            and `bg-un1t-muted` is dark enough to fail its own sub-line. */}
        <div className="bg-un1t-surface border border-un1t-border rounded-lg p-3 mb-4 text-sm text-un1t-text">
          <div className="font-medium">{tmpl.name || 'Shift'} — {dayLabel}</div>
          <div className="text-un1t-subtle text-xs mt-1">
            {formatTime(block.start_time)}–{formatTime(block.end_time)} · {currentCount}/{block.max_coaches} assigned · {slotsLeft} slot{slotsLeft === 1 ? '' : 's'} open
          </div>
        </div>
        <div>
          <label className="block text-xs text-un1t-subtle mb-2">Pick one or more coaches</label>
          {available.length === 0 ? (
            <p className="text-[11px] text-un1t-subtle">All staff already assigned to this slot.</p>
          ) : (
            <ul className="max-h-72 overflow-y-auto border border-un1t-border rounded-md divide-y divide-un1t-border/50">
              {available.map((s) => {
                const checked = selectedIds.has(s.id)
                // ROSTER-FIX.6c — advisory, never a block: the row stays
                // tickable. A coach really does cover two adjacent slots
                // sometimes, and the manager staffing the studio is the judge.
                const { clash, onLeave } = coachConflictsForBlock({
                  coachId: s.id, block, blocks, timeOff,
                })
                return (
                  <li key={s.id}>
                    <label className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-un1t-border/30">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggle(s.id)}
                        className="accent-un1t-text"
                      />
                      <span className="text-sm text-un1t-text flex-1">
                        {s.full_name}
                        {onLeave && (
                          <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-red-500/15 text-red-700 whitespace-nowrap">
                            on approved leave
                          </span>
                        )}
                        {clash && (
                          <span
                            className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-700 whitespace-nowrap"
                            title={`Already on ${clash.name}, ${clash.startTime}–${clash.endTime}`}
                          >
                            clashes with {clash.startTime} {clash.name}
                          </span>
                        )}
                      </span>
                      <span className="text-[10px] text-un1t-subtle">{s.role}</span>
                    </label>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
        {overCapacity && (
          <p className="mt-2 text-[11px] text-amber-700">
            {selectedIds.size} selected but only {slotsLeft} slot{slotsLeft === 1 ? '' : 's'} left — the extras will be skipped.
          </p>
        )}
        <button
          type="button"
          onClick={handleClick}
          disabled={selectedIds.size === 0 || saving || available.length === 0}
          className="w-full mt-4 bg-un1t-text text-un1t-bg font-medium text-sm py-2.5 rounded-md hover:bg-un1t-accent transition-colors disabled:opacity-50"
        >
          {submitLabel}
        </button>
      </div>
    </Modal>
  )
}

function CreateBlockModal({ date, templates, onCreate, onClose }) {
  const [templateId, setTemplateId] = useState('')
  const [saving, setSaving] = useState(false)
  const dayLabel = new Date(date + 'T00:00:00').toLocaleDateString('en-IE', { weekday: 'long', day: 'numeric', month: 'long' })

  async function handleClick() {
    if (!templateId) return
    setSaving(true)
    await onCreate(templateId)
    setSaving(false)
  }

  return (
    <Modal open onClose={onClose} title={`Add Shift Slot — ${dayLabel}`} dismissOnBackdrop={!templateId}>
      <div>
        <p className="text-xs text-un1t-subtle mb-3">
          Adds a one-off block for this day. To make a slot recur, edit the template and add this weekday to its days_of_week.
        </p>
        <div>
          <label className="block text-xs text-un1t-subtle mb-1">Template *</label>
          <select value={templateId} onChange={e => setTemplateId(e.target.value)} className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text">
            <option value="">Select template...</option>
            {templates.map(t => (
              <option key={t.id} value={t.id}>{t.name} ({formatTime(t.start_time)}–{formatTime(t.end_time)})</option>
            ))}
          </select>
        </div>
        <button
          type="button"
          onClick={handleClick}
          disabled={!templateId || saving}
          className="w-full mt-4 bg-un1t-text text-un1t-bg font-medium text-sm py-2.5 rounded-md hover:bg-un1t-accent transition-colors disabled:opacity-50"
        >
          {saving ? 'Adding...' : 'Add Slot'}
        </button>
      </div>
    </Modal>
  )
}

// Roster v2 phase 5 — publish modal with budget impact preview
// + owner-confirm-over-budget retry flow.
//
// Open lifecycle:
//   1. Component mounts with the period (Mon-Sun by default).
//      It fetches the budget impact via a "dry run" — POST to
//      /api/schedule/rosters with force_over_budget=false; the
//      server may return 409 with an `impact` payload, which we
//      render verbatim. (Avoids replicating the cost math
//      client-side.)
//      We do this lazily on a hook in render so the user sees
//      a "calculating…" state.
//   2. Operator clicks Publish:
//      - Under budget OR owner-confirms-over → submitPublish
//        with force=true → roster created, modal closes.
//      - Manager clicks "Request approval" → submitPublish
//        with force=false → status='draft', modal shows
//        approval-pending message, owner is emailed.
function PublishRosterModal({ locationId, isOwner, period, onSubmit, onClose, publishing }) {
  // Week / month scope toggle. The active range drives both the budget
  // preview and the publish. Re-publishing a period only re-notifies the
  // coaches whose shifts changed since the last publish (server-side
  // change-log), so "month" doubles as "push my changes for the month".
  const [scope, setScope] = useState(period.defaultScope || 'week')
  const active = period[scope]
  const [impact, setImpact] = useState(null)
  const [loading, setLoading] = useState(true)
  const [submitResult, setSubmitResult] = useState(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setImpact(null)
    setSubmitResult(null)
    async function loadPreview() {
      try {
        const res = await fetch('/api/schedule/rosters', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            location_id: locationId,
            period_start: active.start,
            period_end: active.end,
            dry_run: true,
          }),
        })
        const data = await res.json().catch(() => ({}))
        if (cancelled) return
        if (!res.ok || !data.success) {
          setSubmitResult({
            error: data.error === OVERLAP_ERROR
              ? overlapMessage(data)
              : (data.error || 'Failed to load preview'),
          })
        } else {
          setImpact(data.impact)
        }
      } catch {
        // ROSTER-FIX.6a — this used to print e.message, so a dropped
        // connection reached the operator as "Failed to fetch".
        if (!cancelled) setSubmitResult({ error: 'Network error, could not load the budget preview.' })
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    loadPreview()
    return () => { cancelled = true }
  }, [locationId, active.start, active.end])

  async function handleConfirm() {
    const result = await onSubmit({
      periodStart: active.start,
      periodEnd: active.end,
      forceOverBudget: true,
    })
    if (result?.needsApproval) {
      setSubmitResult({ needsApproval: true })
    }
  }

  const overBudget = impact?.overBudget
  const fmtEur = n => n == null
    ? '—'
    : new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(n)

  return (
    // ROSTER-FIX.6b — no backdrop dismiss mid-publish: the click would close
    // the modal over a request that is still going to land.
    <Modal open onClose={onClose} title="Publish roster" dismissOnBackdrop={!publishing}>
      <div>
        {/* Scope toggle — publish the visible week or the whole month. */}
        <div className="mb-3">
          <div className="text-un1t-subtle text-xs mb-1.5">Publish</div>
          <div className="inline-flex rounded-lg border border-un1t-border p-0.5 bg-black/20">
            {[
              { key: 'week', label: 'This week' },
              { key: 'month', label: 'This month' },
            ].map(opt => (
              <button
                key={opt.key}
                type="button"
                onClick={() => setScope(opt.key)}
                disabled={publishing}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors disabled:opacity-50 ${
                  scope === opt.key
                    ? 'bg-blue-600 text-white'
                    : 'text-un1t-subtle hover:text-un1t-text'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <div className="text-xs text-un1t-subtle mt-1.5">{active.label}</div>
          {scope === 'month' && (
            <p className="text-[11px] text-un1t-subtle mt-1">
              Already published this month? Only coaches whose shifts changed since the last publish are re-notified.
            </p>
          )}
        </div>

        {loading && (
          <div className="text-center py-6 text-sm text-un1t-subtle">Calculating budget impact…</div>
        )}

        {!loading && submitResult?.needsApproval && (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
            <div className="font-medium text-amber-800 mb-1">Approval requested</div>
            <p className="text-amber-700/90 text-xs">
              The roster is held in draft. Owners at this location have been emailed and can approve it from <span className="font-medium">Schedule → Approvals</span>. Staff won&apos;t see their shifts until an owner signs off.
            </p>
          </div>
        )}

        {!loading && submitResult?.error && (
          <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-700">
            {submitResult.error}
          </div>
        )}

        {!loading && impact && !submitResult && (
          <>
            <div className="grid grid-cols-2 gap-3 mb-4 text-sm">
              <div className="rounded-lg border border-un1t-border p-3">
                <div className="text-[10px] uppercase tracking-wider text-un1t-subtle">Blocks in period</div>
                <div className="text-xl font-semibold">{impact.blockCount}</div>
              </div>
              <div className="rounded-lg border border-un1t-border p-3">
                <div className="text-[10px] uppercase tracking-wider text-un1t-subtle">Period contractor cost</div>
                <div className="text-xl font-semibold">{fmtEur(impact.periodProjectedEur)}</div>
              </div>
              <div className="rounded-lg border border-un1t-border p-3 col-span-2">
                <div className="text-[10px] uppercase tracking-wider text-un1t-subtle">Month total after publish (vs budget)</div>
                <div className={`text-xl font-semibold ${overBudget ? 'text-red-700' : 'text-un1t-text'}`}>
                  {fmtEur(impact.monthProjectedTotalEur)}
                  <span className="text-xs text-un1t-subtle font-normal ml-2">
                    of {fmtEur(impact.monthlyBudgetEur)}
                  </span>
                </div>
                {overBudget && (
                  <div className="text-xs text-red-700 mt-1">
                    {fmtEur(impact.overrunEur)} over the monthly contractor budget.
                  </div>
                )}
              </div>
            </div>

            {overBudget && !isOwner && (
              <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 mb-4">
                Publishing this will exceed the monthly contractor budget. As a manager, you can&apos;t publish over budget directly — clicking below will create a draft and email the owners for approval.
              </div>
            )}

            {overBudget && isOwner && (
              <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 mb-4">
                As an owner, you can publish over budget. Your approval will be recorded against the roster row.
              </div>
            )}

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="px-3 py-2 rounded-md text-sm border border-un1t-border text-un1t-subtle hover:text-un1t-text hover:border-un1t-text/30"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirm}
                disabled={publishing}
                className={`px-3 py-2 rounded-md text-sm font-medium text-white disabled:opacity-50 ${
                  overBudget && isOwner
                    ? 'bg-red-600 hover:bg-red-500'
                    : overBudget
                      ? 'bg-amber-600 hover:bg-amber-500'
                      : 'bg-blue-600 hover:bg-blue-500'
                }`}
              >
                {publishing
                  ? 'Working…'
                  : overBudget && isOwner
                    ? `Publish €${Math.round(impact.overrunEur)} over budget`
                    : overBudget
                      ? 'Request owner approval'
                      : 'Publish'}
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}

function SwapModal({ shift, onSubmit, onClose, restoreFocusRef }) {
  const [reason, setReason] = useState('')
  const tmpl = shift.shift_templates || {}

  return (
    <Modal open onClose={onClose} title="Request Shift Swap" dismissOnBackdrop={!reason.trim()} restoreFocusRef={restoreFocusRef}>
      <div>
        {/* ROSTER-FIX.6b-8 — same `bg-black/30` inset, same white panel. */}
        <div className="bg-un1t-surface border border-un1t-border rounded-lg p-3 mb-4 text-sm text-un1t-text">
          <div className="font-medium">{tmpl.name} — {new Date(shift.shift_date + 'T00:00:00').toLocaleDateString('en-IE', { weekday: 'long', day: 'numeric', month: 'long' })}</div>
          <div className="text-un1t-subtle text-xs mt-1">
            {formatTime(shift.start_time_override || tmpl.start_time)}–{formatTime(shift.end_time_override || tmpl.end_time)}
            {shift.role_label && ` · ${shift.role_label}`}
          </div>
        </div>
        <div>
          <label className="block text-xs text-un1t-subtle mb-1">Reason (optional)</label>
          <textarea
            value={reason}
            onChange={e => setReason(e.target.value)}
            rows={3}
            placeholder="Why do you need to swap this shift?"
            className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text resize-none"
          />
        </div>
        <button
          type="button"
          onClick={() => onSubmit(shift.id, reason)}
          className="w-full mt-4 bg-un1t-text text-un1t-bg font-medium text-sm py-2.5 rounded-md hover:bg-un1t-accent transition-colors"
        >
          Submit Swap Request
        </button>
      </div>
    </Modal>
  )
}


// BlockDetailModal — opens when an operator clicks a block card.
//
// Replaces the old inline pencil + cramped buttons on the block
// card. One pop-out, plenty of room, all the relevant actions:
//   - Add a coach (manager + below capacity)
//   - For each assigned coach: their effective times + per-row
//     partial-shift override editor + remove button
//   - Self-only "Request swap" if the operator is on this block
//   - Manager-only "Delete this slot" at the bottom
//
// We re-fetch on every save (parent's fetchData) and the parent
// useEffect keeps `block` here in sync with the latest data. So the
// modal updates live as overrides are saved without a re-mount.
function BlockDetailModal({
  block, user, isManager, busy,
  onClose, onAddCoach, onUnassign, onPartialSave, onDeleteBlock, onSwapRequest,
}) {
  const tmpl = block.shift_templates || {}
  const assignments = liveAssignments(block.shift_assignments)
  const max = block.max_coaches || 15
  const atCapacity = assignments.length >= max
  const dateLabel = new Date(block.block_date + 'T00:00:00').toLocaleDateString('en-IE', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  })

  // ROSTER-FIX.6b-7 — this was the ONE converted dialog left dismissing on a
  // backdrop click while it could be holding a half-filled form. The inline
  // times-and-reason editor lives one component down in AssignmentRow, so the
  // flag is lifted here as the set of rows currently editing: a stray click
  // outside must not throw away times a manager has just typed. Escape and the
  // close button still work, which is why this is not `dismissable={false}`.
  const [editingRowIds, setEditingRowIds] = useState(() => new Set())
  const anyRowEditing = editingRowIds.size > 0

  return (
    <Modal open onClose={onClose} title={tmpl.name || 'Shift'} dismissOnBackdrop={!anyRowEditing}>
      <div>
        {/* Sub-header — the template name is the dialog's accessible title. */}
        <div className="mb-4">
          <div className="min-w-0">
            <p className="text-xs text-un1t-subtle mt-0.5">{dateLabel}</p>
            <p className="text-xs text-un1t-muted mt-1 inline-flex items-center gap-1.5">
              <Clock size={11} />
              {formatTime(block.start_time)}–{formatTime(block.end_time)}
              {/* ROSTER-FIX.2 — capacity stays manager-only here too; coaches
                  reach this modal for their own shift. */}
              {isManager && (
                <>
                  <span className="mx-1">·</span>
                  {assignments.length}/{max} assigned
                </>
              )}
            </p>
          </div>
        </div>

        {/* Assigned coaches */}
        <div className="space-y-2 mb-4">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-un1t-subtle">
            Coaches
          </div>
          {assignments.length === 0 ? (
            <p className="text-xs text-un1t-subtle italic">No coaches assigned yet.</p>
          ) : (
            assignments.map((a) => (
              // ROSTER-FIX.3 (D2, D3) — canEdit is managers only. A coach could
              // adjust their own times and remove themselves from the block here;
              // both are manager-only on PUT/DELETE /api/schedule/assignments/[id]
              // now, so the affordance goes with them. The swap button below is a
              // coach's route out of a shift, and the amber "Adjusted" badge in
              // AssignmentRow keeps a manager's change visible to them.
              <AssignmentRow
                key={a.id}
                assignment={a}
                block={block}
                isMe={a.profile_id === user.id}
                canEdit={isManager}
                busy={busy}
                onUnassign={() => onUnassign(a.id)}
                onSave={(payload) => onPartialSave(a.id, payload)}
                onSwapRequest={
                  a.profile_id === user.id
                    ? () => onSwapRequest(a.id)
                    : null
                }
                onEditingChange={(on) => setEditingRowIds((prev) => {
                  const next = new Set(prev)
                  if (on) next.add(a.id)
                  else next.delete(a.id)
                  return next
                })}
              />
            ))
          )}
        </div>

        {/* Action footer */}
        <div className="border-t border-un1t-border pt-4 flex items-center justify-between gap-2">
          {isManager && !atCapacity ? (
            <button
              type="button"
              onClick={onAddCoach}
              className="text-xs bg-blue-500/20 text-blue-700 border border-blue-500/40 hover:bg-blue-500/30 px-3 py-2 rounded-md font-medium inline-flex items-center gap-1.5"
            >
              <Plus size={12} /> Add coach
            </button>
          ) : <span />}
          {isManager && (
            <button
              type="button"
              onClick={onDeleteBlock}
              disabled={busy}
              className="text-xs bg-red-500/15 text-red-700 border border-red-500/30 hover:bg-red-500/25 disabled:opacity-50 px-3 py-2 rounded-md font-medium inline-flex items-center gap-1.5"
              title="Delete this entire shift slot"
            >
              <X size={12} aria-hidden="true" /> {busy ? 'Working…' : 'Delete this slot'}
            </button>
          )}
        </div>
      </div>
    </Modal>
  )
}

// One coach's row inside BlockDetailModal — shows their effective
// times, lets a manager (or the coach themselves) override the
// times for partial shifts, request a swap, or be removed.
function AssignmentRow({ assignment, block, isMe, canEdit, busy, onUnassign, onSave, onSwapRequest, onEditingChange }) {
  const blockStart = (block.start_time || '').slice(0, 5)
  const blockEnd = (block.end_time || '').slice(0, 5)
  const coachName = assignment.profiles?.full_name || 'this coach'
  const overrideStart = (assignment.start_time_override || '').slice(0, 5)
  const overrideEnd = (assignment.end_time_override || '').slice(0, 5)
  const hasOverride = !!(assignment.start_time_override || assignment.end_time_override)

  const [editing, setEditingState] = useState(false)
  // ROSTER-FIX.6b-7 — every editing flip is reported upward so BlockDetailModal
  // can turn backdrop dismissal off while this row holds unsaved times.
  const setEditing = useCallback((next) => {
    setEditingState(next)
    onEditingChange?.(next)
  }, [onEditingChange])
  const [start, setStart] = useState(overrideStart || blockStart)
  const [end, setEnd] = useState(overrideEnd || blockEnd)
  const [reason, setReason] = useState(assignment.partial_reason || '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  // Effective display times — what payroll will actually compute.
  const effStart = formatTime(assignment.start_time_override || block.start_time)
  const effEnd = formatTime(assignment.end_time_override || block.end_time)

  async function handleSave() {
    setSaving(true)
    setError(null)
    // Treat "same as block default" as inherit (null).
    const payload = {
      start: start && start !== blockStart ? start : null,
      end: end && end !== blockEnd ? end : null,
      reason: reason.trim() || null,
    }
    const result = await onSave(payload)
    setSaving(false)
    if (result?.ok === false) {
      setError(result.error || 'Save failed')
    } else {
      setEditing(false)
    }
  }

  async function handleClear() {
    setSaving(true)
    setError(null)
    const result = await onSave({ start: null, end: null, reason: null })
    setSaving(false)
    if (result?.ok === false) {
      setError(result.error || 'Clear failed')
    } else {
      setStart(blockStart)
      setEnd(blockEnd)
      setReason('')
      setEditing(false)
    }
  }

  return (
    <div className="bg-un1t-bg/40 border border-un1t-border rounded-md p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className={`text-sm font-medium ${isMe ? 'text-blue-700' : 'text-un1t-text'}`}>
            {assignment.profiles?.full_name || 'Unknown'}
            {hasOverride && (
              <span className="ml-1.5 text-[10px] uppercase font-bold bg-amber-400 text-amber-950 px-1.5 py-0.5 rounded">
                Adjusted
              </span>
            )}
          </div>
          <div className="text-xs text-un1t-subtle mt-0.5 inline-flex items-center gap-1">
            <Clock size={10} />
            {effStart}–{effEnd}
            {hasOverride && (
              <span className="text-un1t-muted ml-1">(block default {formatTime(block.start_time)}–{formatTime(block.end_time)})</span>
            )}
          </div>
          {assignment.partial_reason && !editing && (
            <div className="text-[11px] text-un1t-muted mt-1 italic">
              &ldquo;{assignment.partial_reason}&rdquo;
            </div>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {onSwapRequest && !editing && (
            <button
              type="button"
              onClick={onSwapRequest}
              className="text-[11px] text-un1t-subtle hover:text-un1t-text inline-flex items-center gap-1 px-2 py-1 rounded hover:bg-un1t-border/40"
              aria-label={`Request a swap for ${coachName}`}
              title="Request swap"
            >
              <ArrowLeftRight size={11} aria-hidden="true" />
            </button>
          )}
          {canEdit && !editing && (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="text-[11px] font-semibold text-white inline-flex items-center gap-1 px-2.5 py-1 rounded bg-amber-600 hover:bg-amber-700 border border-amber-700"
              aria-label={`${hasOverride ? 'Edit adjusted times' : 'Adjust actual times'} for ${coachName}`}
              title={hasOverride ? 'Edit adjusted times' : 'Adjust this coach’s actual times'}
            >
              <Pencil size={11} aria-hidden="true" />
              {hasOverride ? 'Edit' : 'Adjust'}
            </button>
          )}
          {canEdit && !editing && (
            <button
              type="button"
              onClick={onUnassign}
              disabled={busy}
              className="text-[11px] text-un1t-subtle hover:text-red-700 disabled:opacity-50 inline-flex items-center gap-1 px-2 py-1 rounded hover:bg-red-500/10"
              aria-label={`Remove ${coachName} from this shift`}
              title="Remove coach"
            >
              <X size={11} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      {editing && (
        <div className="mt-3 pt-3 border-t border-un1t-border space-y-2">
          <div className="text-[11px] text-un1t-subtle">
            Set the actual times this coach worked. Leave equal to the block default
            ({formatTime(block.start_time)}–{formatTime(block.end_time)}) to inherit.
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-un1t-subtle w-12">Start</label>
            <input
              type="time"
              value={start}
              onChange={(e) => setStart(e.target.value)}
              className="flex-1 bg-un1t-bg border border-un1t-border rounded-md px-2 py-1.5 text-sm text-un1t-text focus:outline-none focus:border-amber-500/50"
            />
            <label className="text-xs text-un1t-subtle w-8 text-center">End</label>
            <input
              type="time"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
              className="flex-1 bg-un1t-bg border border-un1t-border rounded-md px-2 py-1.5 text-sm text-un1t-text focus:outline-none focus:border-amber-500/50"
            />
          </div>
          <div>
            <label className="text-xs text-un1t-subtle block mb-1">Reason (optional)</label>
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={200}
              placeholder="e.g. left early — sick, covered until 1pm for Mike"
              className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-1.5 text-sm text-un1t-text focus:outline-none focus:border-amber-500/50"
            />
          </div>
          {error && (
            <div className="text-xs text-red-700 inline-flex items-start gap-1.5">
              <AlertCircle size={11} className="mt-0.5 shrink-0" /> {error}
            </div>
          )}
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              {/* ROSTER-FIX.6b-8 — `text-amber-200` is a dark-theme ramp; on
                  the primitive's white panel this Save button read as pale
                  cream on near-white. The light recipe is a -700 text ramp
                  over a 10% tint, which is what its Add-coach and Delete
                  siblings in BlockDetailModal already use. */}
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                className="text-xs bg-amber-500/10 text-amber-700 border border-amber-500/40 hover:bg-amber-500/20 px-3 py-1.5 rounded-md font-medium inline-flex items-center gap-1.5 disabled:opacity-50"
              >
                <Check size={11} /> {saving ? 'Saving…' : 'Save'}
              </button>
              <button
                type="button"
                onClick={() => { setEditing(false); setError(null); setStart(overrideStart || blockStart); setEnd(overrideEnd || blockEnd); setReason(assignment.partial_reason || '') }}
                disabled={saving}
                className="text-xs text-un1t-subtle hover:text-un1t-text px-2 py-1.5"
              >
                Cancel
              </button>
            </div>
            {hasOverride && (
              <button
                type="button"
                onClick={handleClear}
                disabled={saving}
                className="text-[11px] text-un1t-muted hover:text-red-700"
                title="Remove the override and inherit the block default"
              >
                Clear override
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
