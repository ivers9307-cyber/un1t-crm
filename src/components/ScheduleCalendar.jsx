'use client'

// Roster v2 phase 2 — calendar now reads from /api/schedule/blocks
// (block-shaped data with nested shift_assignments) instead of the
// legacy flat /api/schedule/shifts. Each block renders as a single
// card showing template + time + capacity badge + assigned coaches.
// Empty future blocks get a red unstaffed flag.
//
// The legacy public.shifts table is still kept in sync via the
// mig 068 + mig 069 bidirectional triggers, so mobile + reports
// keep working unchanged.
//
// Writes:
//   - Assign coach: POST /api/schedule/blocks/[id]/assignments
//   - Remove coach: DELETE /api/schedule/assignments/[id]
//   - Remove block: DELETE /api/schedule/blocks/[id]   (rare)
// Copy-week / copy-month / publish hit /api/schedule/shifts/* — these
// now write the block/assignment model directly (RETIRE-SHIFTS-MIRROR.5b);
// public.shifts is kept in sync by the mig 068 forward trigger for the
// readers that haven't migrated yet. Swap requests POST the
// shift_assignment id as requester_shift_id (RETIRE-SHIFTS-MIRROR.5c).

import { useState, useEffect, useCallback } from 'react'
import { ChevronLeft, ChevronRight, Copy, Send, Plus, Users, User, Clock, X, ArrowLeftRight, CalendarOff, Palmtree, ThermometerSun, Ban, AlertTriangle, AlertCircle, CalendarDays, CalendarRange, Pencil, Check, Settings } from 'lucide-react'
import Link from 'next/link'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import { computeWeeklyCost } from '@/lib/payroll'
import { indexByDate } from '@/lib/bank-holidays'
import { MANAGER_ROLES, ADMIN_ROLES } from '@/lib/schemas'
import RosterSummaryPanel from './RosterSummaryPanel'

const TIME_OFF_CONFIG = {
  holiday:     { label: 'Holiday',     color: '#22C55E', icon: Palmtree },
  sick:        { label: 'Sick',        color: '#EF4444', icon: ThermometerSun },
  unavailable: { label: 'Unavailable', color: '#F59E0B', icon: Ban },
}

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const canManage = (role) => MANAGER_ROLES.includes(role)

function getMonday(date) {
  const d = new Date(date)
  const day = d.getDay()
  const diff = d.getDate() - day + (day === 0 ? -6 : 1)
  d.setDate(diff)
  d.setHours(0, 0, 0, 0)
  return d
}

// Local calendar-day formatter. toISOString() would shift to UTC and
// move Monday-at-local-midnight back to Sunday's date in any tz east
// of UTC (Ireland BST = +1) — Monday column then keys off Sunday and
// no blocks match. Mirror src/lib/roster.js#formatDate.
function formatDate(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

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

function addDays(date, days) {
  const d = new Date(date)
  d.setDate(d.getDate() + days)
  return d
}

function getMonthStart(date) {
  const d = new Date(date)
  d.setDate(1)
  d.setHours(0, 0, 0, 0)
  return d
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

function formatTime(time) {
  if (!time) return ''
  const [h, m] = time.split(':')
  const hour = parseInt(h)
  const suffix = hour >= 12 ? 'pm' : 'am'
  const display = hour > 12 ? hour - 12 : hour === 0 ? 12 : hour
  return m === '00' ? `${display}${suffix}` : `${display}:${m}${suffix}`
}

// Roster v2: a block is "unstaffed" when it has zero assignments
// AND its date is today or later. Past blocks may legitimately
// have empty assignments (coaches called out, never replaced) —
// flagging those is noise.
function isBlockUnstaffedFuture(block, todayStr) {
  if ((block.shift_assignments?.length || 0) > 0) return false
  return block.block_date >= todayStr
}

// Adapter — flatten a list of blocks-with-assignments into the
// legacy shift-row shape. Used by the payroll cost calculator
// (which expects one row per coach-day) without rewriting it.
function flattenBlocksToShifts(blocks) {
  const rows = []
  for (const block of blocks) {
    const tpl = block.shift_templates || {}
    for (const a of block.shift_assignments || []) {
      rows.push({
        id: a.id,
        block_id: block.id,
        location_id: block.location_id,
        profile_id: a.profile_id,
        shift_template_id: block.template_id,
        shift_date: block.block_date,
        start_time_override: block.start_time !== tpl.start_time ? block.start_time : null,
        end_time_override: block.end_time !== tpl.end_time ? block.end_time : null,
        role_label: tpl.role_label || null,
        notes: a.notes || block.notes || null,
        status: a.status,
        published: true, // assignments are always live in the new model
        shift_templates: tpl,
        profiles: a.profiles,
      })
    }
  }
  return rows
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

  const [blocks, setBlocks] = useState([])
  const [templates, setTemplates] = useState([])
  const [staff, setStaff] = useState([])
  const [loading, setLoading] = useState(true)
  const [viewMode, setViewMode] = useState('all') // 'my' or 'all'
  const [assignTarget, setAssignTarget] = useState(null) // { block } when picking a coach
  const [createTarget, setCreateTarget] = useState(null) // { date } when adding an ad-hoc block
  const [publishing, setPublishing] = useState(false)
  const [copying, setCopying] = useState(false)
  const [swapModal, setSwapModal] = useState(null) // legacy shift-shaped row to swap
  const [publishModal, setPublishModal] = useState(null) // { periodStart, periodEnd }
  // SCHEDULE-PUBLISH-GUARD.1 — roster edits made since the last publish.
  // Drives the "you have unpublished changes" exit guard below. Set by any
  // edit (via refreshAfterMutation) and cleared on a successful publish.
  const [hasUnpublishedChanges, setHasUnpublishedChanges] = useState(false)
  const [timeOff, setTimeOff] = useState([])
  const [holidays, setHolidays] = useState([])
  // Block detail modal — clicking on a block card opens a popout
  // listing every assignment with edit affordances (override times,
  // remove, etc.). Replaces the cramped inline pencil/X icons.
  const [blockDetail, setBlockDetail] = useState(null) // shift_block row

  // BULK-ASSIGN.1 — multi-select mode for staffing a week's worth
  // of recurring shifts in one go. Toggle button in the header
  // flips clicks into selection-toggle behaviour; floating action
  // bar at the bottom takes a coach + posts /bulk-assign.
  const [selectMode, setSelectMode] = useState(false)
  const [selectedBlockIds, setSelectedBlockIds] = useState(new Set())
  const [bulkAssignBusy, setBulkAssignBusy] = useState(false)
  const [bulkAssignProfile, setBulkAssignProfile] = useState('')
  const [bulkToast, setBulkToast] = useState(null) // { kind, message }
  // SCHEDULE-SPEND-AGG.1 — contractor spend totals for the focused
  // month, fetched server-side so head_coach (who can't see
  // hourly_rate client-side) still sees real numbers + over-budget
  // signals on the summary panel.
  const [contractorSpend, setContractorSpend] = useState(null)

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
    setBulkToast(null)
    try {
      const res = await fetch('/api/schedule/blocks/bulk-assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          block_ids: [...selectedBlockIds],
          profile_id: bulkAssignProfile,
        }),
      })
      const j = await res.json()
      if (!j.success) {
        setBulkToast({ kind: 'error', message: j.error || 'Bulk assign failed' })
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
      setBulkToast({
        kind: j.warnings.length > 0 ? 'warning' : 'success',
        message: j.warnings.length > 0 ? `${message}. ${j.warnings.join('. ')}` : message,
      })
      exitSelectMode()
      await refreshAfterMutation()
    } catch (e) {
      setBulkToast({ kind: 'error', message: e.message || 'Bulk assign failed' })
    } finally {
      setBulkAssignBusy(false)
    }
  }

  const locationId = user.activeLocation?.id
  const isManager = canManage(user.role)
  // SCHEDULE-SPEND-AGG.1 — admin roles see HR-sensitive pay data
  // client-side; head_coach + manager-but-not-admin do not (the
  // /api/staff slim payload). Drives the "pay data missing"
  // warning in RosterSummaryPanel — silenced for non-admins where
  // the warning would fire on every coach (uselessly).
  const canSeePay = ADMIN_ROLES.includes(user.role)
  const todayStr = formatDate(new Date())

  const weekEnd = addDays(weekStart, 6)
  const weekLabel = `${weekStart.toLocaleDateString('en-IE', { day: 'numeric', month: 'short' })} – ${weekEnd.toLocaleDateString('en-IE', { day: 'numeric', month: 'short', year: 'numeric' })}`
  const monthGrid = getMonthGridRange(monthStart)
  const monthLabel = monthStart.toLocaleDateString('en-IE', { month: 'long', year: 'numeric' })

  const fetchData = useCallback(async () => {
    if (!locationId) return
    setLoading(true)

    const innerStart = viewType === 'month' ? getMonthGridRange(monthStart).start : weekStart
    const innerEnd = viewType === 'month' ? getMonthGridRange(monthStart).end : addDays(weekStart, 6)
    const start = formatDate(innerStart)
    const end = formatDate(innerEnd)

    // SCHEDULE-SPEND-AGG.1 — refetch the month's contractor-spend
    // aggregate alongside the other data. Scoped to monthStart so
    // "Contractor spend — May 2026" tracks whichever month was last
    // focused (same convention RosterSummaryPanel has always used).
    const spendRefDate = formatDate(monthStart)
    const [blocksRes, templatesRes, staffRes, timeOffRes, holidaysRes, spendRes] = await Promise.all([
      fetch(`/api/schedule/blocks?location_id=${locationId}&start_date=${start}&end_date=${end}`).then(r => r.json()),
      fetch(`/api/schedule/templates?location_id=${locationId}`).then(r => r.json()),
      fetch('/api/staff').then(r => r.json()),
      fetch(`/api/schedule/time-off?location_id=${locationId}&start_date=${start}&end_date=${end}&status=approved`).then(r => r.json()),
      fetch(`/api/locations/${locationId}/holidays?start=${start}&end=${end}`).then(r => r.json()),
      fetch(`/api/schedule/contractor-spend?location_id=${locationId}&reference_date=${spendRefDate}`).then(r => r.json()),
    ])

    setBlocks(blocksRes.data || [])
    setTemplates((templatesRes.data || []).filter(t => t.active))
    setStaff(staffRes.data || [])
    setTimeOff(timeOffRes.data || [])
    setHolidays(holidaysRes.data || [])
    setContractorSpend(spendRes?.success ? spendRes.data : null)
    setLoading(false)
  }, [locationId, viewType, weekStart, monthStart])

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
    onDataChange?.()
    // Every edit marks the roster dirty so the exit guard fires until the
    // operator publishes. Publish opts out (markDirty: false) and clears it.
    if (opts.markDirty !== false) setHasUnpublishedChanges(true)
  }, [fetchData, onDataChange])

  useEffect(() => { fetchData() }, [fetchData])

  // SCHEDULE-PUBLISH-GUARD.1 — warn before leaving with unpublished roster
  // changes. beforeunload covers tab close / refresh / external navigation;
  // the capture-phase click handler covers in-app link clicks (App Router
  // has no built-in route-change block).
  useEffect(() => {
    if (!hasUnpublishedChanges) return undefined
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
  }, [hasUnpublishedChanges])

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
        return (b.shift_assignments || []).some(a => a.profile_id === user.id)
      })
      .sort((a, b) => (a.start_time || '').localeCompare(b.start_time || ''))
    return dayBlocks
  })

  // Legacy-shape shifts for the payroll calculator + the swap-request
  // modal. flatShifts[].id is the shift_assignment id, which is exactly
  // what POST /api/schedule/swaps now wants as requester_shift_id
  // (RETIRE-SHIFTS-MIRROR.5c).
  const flatShifts = flattenBlocksToShifts(blocks)

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
    const res = await fetch(`/api/schedule/blocks/${blockId}/assignments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile_ids: profileIds }),
    })
    const data = await res.json()
    if (!data.success) {
      alert(data.error || 'Failed to assign coaches')
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
      alert(`Assigned ${n} coach${n === 1 ? '' : 'es'}.\n\n${lines.join('\n')}`)
    }
    setAssignTarget(null)
    refreshAfterMutation()
  }

  // (handleUnassign was dead code — assignment-removal logic now lives
  // inline as the onUnassign={async ...} prop on BlockDetailModal further
  // down. Removed during CODEQUAL.1.)

  // Partial shift save — used by BlockDetailModal. payload is
  // { start, end, reason } where null on any field clears the
  // override and returns to the block default.
  async function handlePartialSave(assignmentId, payload) {
    const res = await fetch(`/api/schedule/assignments/${assignmentId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        start_time_override: payload.start || null,
        end_time_override: payload.end || null,
        partial_reason: payload.reason || null,
      }),
    })
    const data = await res.json()
    if (data.success) {
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
    const res = await fetch('/api/schedule/blocks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        location_id: locationId,
        template_id: templateId,
        block_date: date,
      }),
    })
    const data = await res.json()
    if (data.success) {
      setCreateTarget(null)
      refreshAfterMutation()
    } else {
      alert(data.error || 'Failed to add slot')
    }
  }

  // Phase 5 publish: opens the modal, which then calls
  // submitPublish({ force_over_budget }). The modal handles the
  // owner-confirms-over-budget retry flow itself.
  function handlePublishClick() {
    setPublishModal({
      periodStart: formatDate(weekStart),
      periodEnd: formatDate(weekEnd),
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
      const data = await res.json()
      // 409 with `over_budget_confirmation_required` is not a
      // real error — it's the modal's signal to show the
      // confirmation step. The modal will call us back with
      // forceOverBudget=true.
      if (!data.success && data.error === 'over_budget_confirmation_required') {
        return { confirmRequired: true, impact: data.impact }
      }
      if (!data.success) {
        alert(data.error || 'Publish failed')
        return { error: data.error }
      }
      // Tell mobile + staff the roster is live, same as before.
      // The legacy /api/schedule/shifts/publish route handled
      // notifications; we trigger that here as a follow-up so
      // the comm pattern stays consistent.
      if (!data.needs_approval) {
        await fetch('/api/schedule/shifts/publish', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            location_id: locationId,
            start_date: periodStart,
            end_date: periodEnd,
            notify: true,
          }),
        })
      }
      setPublishModal(null)
      // Publish is the one mutation that should NOT re-arm the exit guard.
      // A real publish clears it; a needs-approval draft stays dirty (it's
      // still pending an owner's sign-off).
      refreshAfterMutation({ markDirty: false })
      if (!data.needs_approval) setHasUnpublishedChanges(false)
      return data.needs_approval
        ? { needsApproval: true }
        : { published: true, impact: data.impact }
    } finally {
      setPublishing(false)
    }
  }

  async function handleCopyWeek() {
    const prevWeekStart = addDays(weekStart, -7)
    if (!confirm(`Copy last week's roster (${formatDate(prevWeekStart)}) to this week?`)) return
    setCopying(true)
    // Legacy endpoint still writes to public.shifts; mig 069's
    // reverse trigger propagates the writes back into
    // shift_blocks + shift_assignments.
    const res = await fetch('/api/schedule/shifts/copy-week', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        location_id: locationId,
        source_start: formatDate(prevWeekStart),
        target_start: formatDate(weekStart),
      }),
    })
    const data = await res.json()
    setCopying(false)
    if (data.success) refreshAfterMutation()
    else alert(data.error || 'Failed to copy week')
  }

  async function handleCopyMonth() {
    // Both buttons are shown in week view too, so derive the
    // effective month from whichever primary state the operator is
    // working in. Without this, clicking "Copy Last Month" from
    // week view would target whatever monthStart was set to last
    // (possibly stale from an earlier month-view session).
    const effectiveMonthStart = viewType === 'month' ? monthStart : getMonthStart(weekStart)
    const targetLabel = effectiveMonthStart.toLocaleDateString('en-IE', { month: 'long', year: 'numeric' })
    const prevMonthStart = addMonths(effectiveMonthStart, -1)
    const sourceLabel = prevMonthStart.toLocaleDateString('en-IE', { month: 'long', year: 'numeric' })
    if (!confirm(`Copy last month's roster (${sourceLabel}) to ${targetLabel}?`)) return
    setCopying(true)
    const res = await fetch('/api/schedule/shifts/copy-month', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        location_id: locationId,
        source_month_start: formatDate(prevMonthStart),
        target_month_start: formatDate(effectiveMonthStart),
      }),
    })
    const data = await res.json()
    setCopying(false)
    if (data.success) {
      const skipped = data.skipped || 0
      if (skipped > 0) {
        alert(`Copied ${data.copied} shifts. ${skipped} skipped (day-of-month doesn't exist in target — usually Jan 31 → Feb).`)
      }
      refreshAfterMutation()
    } else {
      alert(data.error || 'Failed to copy month')
    }
  }

  async function handleSwapRequest(shiftId, reason) {
    const res = await fetch('/api/schedule/swaps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requester_shift_id: shiftId, reason }),
    })
    const data = await res.json()
    if (data.success) {
      setSwapModal(null)
      alert('Swap request submitted — waiting for manager approval')
    } else {
      alert(data.error || 'Failed to submit swap request')
    }
  }

  return (
    <div>
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
              onClick={() => setViewMode('my')}
              className={`flex items-center gap-1.5 px-3 py-2 transition-colors ${viewMode === 'my' ? 'bg-un1t-text text-un1t-bg' : 'text-un1t-subtle hover:text-un1t-text'}`}
            >
              <User size={14} /> My Shifts
            </button>
            <button
              onClick={() => setViewMode('all')}
              className={`flex items-center gap-1.5 px-3 py-2 transition-colors ${viewMode === 'all' ? 'bg-un1t-text text-un1t-bg' : 'text-un1t-subtle hover:text-un1t-text'}`}
            >
              <Users size={14} /> All Staff
            </button>
          </div>

          <div className="flex bg-un1t-surface border border-un1t-border rounded-lg overflow-hidden text-xs">
            <button
              onClick={() => {
                if (viewType === 'month') setWeekStart(getMonday(monthStart))
                setViewType('week')
              }}
              className={`flex items-center gap-1.5 px-3 py-2 transition-colors ${viewType === 'week' ? 'bg-un1t-text text-un1t-bg' : 'text-un1t-subtle hover:text-un1t-text'}`}
            >
              <CalendarDays size={14} /> Week
            </button>
            <button
              onClick={() => {
                if (viewType === 'week') setMonthStart(getMonthStart(weekStart))
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
                onClick={() => {
                  if (selectMode) exitSelectMode()
                  else setSelectMode(true)
                }}
                className={`flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg border transition-colors ${
                  selectMode
                    ? 'bg-amber-500/20 border-amber-500/50 text-amber-300'
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
                onClick={handleCopyWeek}
                disabled={copying}
                className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg border border-un1t-border text-un1t-subtle hover:text-un1t-text hover:border-un1t-text/30 transition-colors disabled:opacity-50"
                title="Duplicate last week's shifts into this week"
              >
                <Copy size={14} /> {copying ? 'Copying...' : 'Copy Last Week'}
              </button>
              <button
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
          onClick={() => {
            if (viewType === 'month') setMonthStart(addMonths(monthStart, -1))
            else setWeekStart(addDays(weekStart, -7))
          }}
          className="p-2 rounded-lg hover:bg-un1t-border/50 text-un1t-subtle hover:text-un1t-text transition-colors"
        >
          <ChevronLeft size={20} />
        </button>
        <div className="text-center">
          <span className="font-semibold">{viewType === 'month' ? monthLabel : weekLabel}</span>
          <button
            onClick={() => {
              const now = new Date()
              if (viewType === 'month') setMonthStart(getMonthStart(now))
              else setWeekStart(getMonday(now))
            }}
            className="ml-3 text-xs text-blue-400 hover:text-blue-300"
          >
            Today
          </button>
        </div>
        <button
          onClick={() => {
            if (viewType === 'month') setMonthStart(addMonths(monthStart, 1))
            else setWeekStart(addDays(weekStart, 7))
          }}
          className="p-2 rounded-lg hover:bg-un1t-border/50 text-un1t-subtle hover:text-un1t-text transition-colors"
        >
          <ChevronRight size={20} />
        </button>
      </div>

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

      {/* Overtime warning panel */}
      {!loading && canManage(user.role) && (() => {
        const summaries = locationStaff
          .filter(s => s.employment_type === 'fte' && (s.contracted_hours_per_week || 0) > 0)
          .map(s => {
            const own = flatShifts.filter(sh => sh.profile_id === s.id)
            const cost = computeWeeklyCost({ shifts: own, profile: s })
            return { staff: s, cost }
          })
          .filter(({ cost }) => cost.actual_hours > 0)

        const overOrAt = summaries.filter(({ cost }) =>
          cost.actual_hours >= cost.contracted_hours
        )
        if (overOrAt.length === 0) return null

        return (
          <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
            <div className="flex items-center gap-2 text-amber-400 font-medium text-sm mb-2">
              <AlertTriangle size={16} /> Weekly hours notice
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
              {overOrAt.map(({ staff: s, cost }) => {
                const isOver = cost.over_threshold
                return (
                  <div
                    key={s.id}
                    className={`text-xs rounded-md px-2.5 py-1.5 border ${isOver
                      ? 'border-amber-500/40 bg-amber-500/10 text-amber-700'
                      : 'border-un1t-border bg-un1t-surface/40 text-un1t-subtle'
                    }`}
                  >
                    <span className="font-medium text-un1t-text">{s.full_name}</span>
                    {' — '}
                    <span>{cost.actual_hours.toFixed(1)}h / {cost.contracted_hours}h</span>
                    {isOver && (
                      <span className="ml-1 font-semibold">
                        +{cost.overtime_hours.toFixed(1)}h OT
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
        <div>
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
                  : dayBlocks.filter(b => (b.shift_assignments || []).some(a => a.profile_id === user.id))
                const dayTimeOff = timeOff.filter(t => t.start_date <= dateStr && t.end_date >= dateStr)
                const inFocusedMonth = date.getMonth() === focusedMonth
                const isToday = dateStr === todayStr
                const holiday = holidayByDate.get(dateStr)
                const totalAssignmentCount = visibleBlocks.reduce((sum, b) => sum + (b.shift_assignments?.length || 0), 0)
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
                      <span className={`text-xs font-semibold ${isToday ? 'text-blue-400' : inFocusedMonth ? 'text-un1t-text' : 'text-un1t-muted'}`}>
                        {date.getDate()}
                      </span>
                      <div className="flex items-center gap-1">
                        {unstaffedCount > 0 && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/20 text-red-300" title={`${unstaffedCount} unstaffed`}>
                            !{unstaffedCount}
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
                      <div className="text-[9px] text-amber-500 mb-1 truncate" title={holiday.name}>
                        {holiday.name}
                      </div>
                    )}
                    <div className="space-y-0.5">
                      {visibleBlocks.slice(0, 3).map(b => {
                        const tmpl = b.shift_templates || {}
                        const count = b.shift_assignments?.length || 0
                        const unstaffed = isBlockUnstaffedFuture(b, todayStr)
                        return (
                          <div
                            key={b.id}
                            className={`text-[10px] truncate rounded px-1 py-0.5 ${unstaffed ? 'border border-red-500/40' : ''}`}
                            style={{ backgroundColor: (tmpl.color || '#3B82F6') + '20', color: tmpl.color || '#3B82F6' }}
                            title={`${tmpl.name || 'Shift'} · ${formatTime(b.start_time)}–${formatTime(b.end_time)} · ${count}/${b.max_coaches}`}
                          >
                            {formatTime(b.start_time)} {count}/{b.max_coaches}
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
      ) : (
        // ── WEEK VIEW ──
        // Roster v2: one card per BLOCK. Each card shows the
        // template colour + name + time + capacity badge + a list
        // of assigned coaches (or an empty-state with a red flag
        // for future unstaffed demand windows). Click opens the
        // assign popover.
        <div className="grid grid-cols-7 gap-2">
          {(() => {
            const holidayByDate = indexByDate(holidays)
            return DAY_LABELS.map((label, i) => {
              const date = addDays(weekStart, i)
              const dateStr = formatDate(date)
              const isToday = formatDate(new Date()) === dateStr
              const dayBlocks = blocksByDay[i]
              const holiday = holidayByDate.get(dateStr)

              const headerCls = isToday
                ? 'bg-blue-600 text-white'
                : holiday
                  ? 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
                  : 'bg-un1t-surface text-un1t-subtle'

              return (
                <div key={i} className="min-h-[200px]">
                  <div className={`text-center py-2 rounded-t-lg text-xs font-semibold ${headerCls}`} title={holiday?.name || undefined}>
                    <div>{label}</div>
                    <div className={`text-lg font-bold ${isToday ? 'text-white' : 'text-un1t-text'}`}>{date.getDate()}</div>
                    {holiday && (
                      <div className={`mt-0.5 text-[10px] font-medium leading-tight px-1 truncate ${isToday ? 'text-white/80' : 'text-amber-300'}`}>
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
                      const assignments = block.shift_assignments || []
                      const count = assignments.length
                      const max = block.max_coaches || 15
                      const unstaffed = isBlockUnstaffedFuture(block, todayStr)
                      const myAssignment = assignments.find(a => a.profile_id === user.id)
                      const blockColor = tmpl.color || '#3B82F6'
                      const atCapacity = count >= max

                      const isSelected = selectedBlockIds.has(block.id)
                      return (
                        <div
                          key={block.id}
                          onClick={() => {
                            // BULK-ASSIGN.1 — in select mode, clicks
                            // toggle selection instead of opening
                            // the detail modal. The action bar at
                            // the bottom takes the bulk-assign call.
                            if (selectMode) toggleBlockSelection(block.id)
                            else setBlockDetail(block)
                          }}
                          className={`rounded-md p-2 text-xs relative group cursor-pointer hover:ring-1 hover:ring-un1t-subtle/40 ${myAssignment ? 'ring-1 ring-blue-400/50' : ''} ${unstaffed ? 'border border-red-500/50' : ''} ${isSelected ? 'ring-2 ring-amber-400 ring-offset-1 ring-offset-un1t-bg' : ''}`}
                          style={{ backgroundColor: unstaffed ? '#7F1D1D20' : blockColor + '20', borderLeft: `3px solid ${unstaffed ? '#EF4444' : blockColor}` }}
                          title={selectMode ? 'Click to select / deselect' : 'Click to manage this shift'}
                        >
                          <div className="flex items-center justify-between gap-1">
                            <div className="font-semibold truncate" style={{ color: unstaffed ? '#FCA5A5' : 'inherit' }}>
                              {tmpl.name || 'Shift'}
                            </div>
                            <span
                              className={`text-[10px] px-1.5 py-0.5 rounded font-medium flex-shrink-0 ${
                                unstaffed
                                  ? 'bg-red-500/20 text-red-300'
                                  : atCapacity
                                    ? 'bg-un1t-border/60 text-un1t-text'
                                    : ''
                              }`}
                              style={!unstaffed && !atCapacity ? { backgroundColor: blockColor + '30', color: blockColor } : undefined}
                            >
                              {count}/{max}
                            </span>
                          </div>
                          <div className="text-un1t-subtle mt-0.5 flex items-center gap-1">
                            <Clock size={10} />
                            {formatTime(block.start_time)}–{formatTime(block.end_time)}
                          </div>

                          {/* Assigned coaches list */}
                          {count === 0 ? (
                            <div className="mt-1.5 text-[11px] text-red-300 italic">
                              {unstaffed ? 'Unstaffed — assign a coach' : 'No coach (past)'}
                            </div>
                          ) : (
                            <div className="mt-1.5 space-y-0.5">
                              {assignments.map(a => {
                                const isMe = a.profile_id === user.id
                                const hasOverride = !!(a.start_time_override || a.end_time_override)
                                return (
                                  <div key={a.id} className="flex items-center justify-between gap-1 text-[11px]">
                                    <span className={`truncate ${isMe ? 'text-blue-300 font-medium' : 'text-un1t-text'}`}>
                                      {a.profiles?.full_name || 'Unknown'}
                                      {hasOverride && (
                                        <span
                                          className="ml-1 text-amber-300"
                                          title={
                                            `Adjusted: ${formatTime(a.start_time_override || block.start_time)}–${formatTime(a.end_time_override || block.end_time)}` +
                                            (a.partial_reason ? ` · ${a.partial_reason}` : '')
                                          }
                                        >
                                          ●
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
                            <div className="mt-1.5 text-[10px] text-un1t-muted italic text-right opacity-0 group-hover:opacity-100 transition-opacity">
                              Click to manage
                            </div>
                          )}
                        </div>
                      )
                    })}

                    {/* Add ad-hoc block button (manager only) */}
                    {isManager && (
                      <button
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
      )}

      {/* Roster v2 phase 4 — week + month summary. Manager-only. */}
      {/* Phase 6: passes `timeOff` so FTE utilisation is leave-aware. */}
      {/* SCHEDULE-SPEND-AGG.1: contractorSpend comes from a server-
          computed aggregate so head_coach sees real totals + over-
          budget signals without being granted hourly_rate visibility. */}
      {!loading && isManager && (
        <RosterSummaryPanel
          blocks={blocks}
          staff={locationStaff}
          weekStart={weekStart}
          monthStart={monthStart}
          location={user.activeLocation}
          timeOff={timeOff}
          contractorSpend={contractorSpend}
          canSeePay={canSeePay}
        />
      )}

      {/* Assign Coach Popover */}
      {assignTarget && (
        <AssignCoachModal
          block={assignTarget.block}
          staff={locationStaff}
          onAssign={(profileIds) => handleAssignCoaches(assignTarget.block.id, profileIds)}
          onClose={() => setAssignTarget(null)}
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
          flatShifts={flatShifts}
          onClose={() => setBlockDetail(null)}
          onAddCoach={() => setAssignTarget({ block: blockDetail })}
          onUnassign={async (assignmentId) => {
            if (!confirm('Remove this coach from the shift?')) return
            const res = await fetch(`/api/schedule/assignments/${assignmentId}`, { method: 'DELETE' })
            const data = await res.json()
            if (data.success) await refreshAfterMutation()
            else alert(data.error || 'Failed to remove')
          }}
          onPartialSave={handlePartialSave}
          onDeleteBlock={async () => {
            if (!confirm('Delete this entire shift slot? Any assigned coaches are removed too.')) return
            const res = await fetch(`/api/schedule/blocks/${blockDetail.id}`, { method: 'DELETE' })
            const data = await res.json()
            if (data.success) { setBlockDetail(null); refreshAfterMutation() }
            else alert(data.error || 'Failed to delete')
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
              <Check size={16} className="text-amber-400" />
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
          {bulkToast && (
            <div className={`max-w-7xl mx-auto px-4 pb-2 text-xs ${
              bulkToast.kind === 'error' ? 'text-red-400' :
              bulkToast.kind === 'warning' ? 'text-amber-300' :
              'text-emerald-400'
            }`}>
              {bulkToast.message}
            </div>
          )}
        </div>
      )}
      {/* Standalone toast — shows after a successful assign that
          closed select mode, so the operator sees what happened. */}
      {!selectMode && bulkToast && (
        <div className={`fixed bottom-4 right-4 z-40 max-w-md rounded-md border px-4 py-3 text-sm shadow-2xl ${
          bulkToast.kind === 'error' ? 'border-red-500/50 bg-red-950/80 text-red-200' :
          bulkToast.kind === 'warning' ? 'border-amber-500/50 bg-amber-950/80 text-amber-200' :
          'border-emerald-500/50 bg-emerald-950/80 text-emerald-200'
        }`}>
          <div className="flex items-start justify-between gap-3">
            <span>{bulkToast.message}</span>
            <button type="button" onClick={() => setBulkToast(null)} className="text-current opacity-70 hover:opacity-100">
              <X size={14} />
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
function AssignCoachModal({ block, staff, onAssign, onClose }) {
  const [selectedIds, setSelectedIds] = useState(() => new Set())
  const [saving, setSaving] = useState(false)
  const tmpl = block.shift_templates || {}
  const assignedIds = new Set((block.shift_assignments || []).map((a) => a.profile_id))
  const available = staff.filter((s) => !assignedIds.has(s.id))
  const dayLabel = new Date(block.block_date + 'T00:00:00').toLocaleDateString('en-IE', { weekday: 'long', day: 'numeric', month: 'long' })
  const currentCount = block.shift_assignments?.length || 0
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
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-un1t-surface border border-un1t-border rounded-xl p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold">Assign coaches</h3>
          <button onClick={onClose} className="text-un1t-subtle hover:text-un1t-text"><X size={18} /></button>
        </div>
        <div className="bg-black/30 rounded-lg p-3 mb-4 text-sm">
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
                return (
                  <li key={s.id}>
                    <label className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-un1t-border/30">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggle(s.id)}
                        className="accent-un1t-text"
                      />
                      <span className="text-sm text-un1t-text flex-1">{s.full_name}</span>
                      <span className="text-[10px] text-un1t-subtle">{s.role}</span>
                    </label>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
        {overCapacity && (
          <p className="mt-2 text-[11px] text-amber-400">
            {selectedIds.size} selected but only {slotsLeft} slot{slotsLeft === 1 ? '' : 's'} left — the extras will be skipped.
          </p>
        )}
        <button
          onClick={handleClick}
          disabled={selectedIds.size === 0 || saving || available.length === 0}
          className="w-full mt-4 bg-un1t-text text-un1t-bg font-medium text-sm py-2.5 rounded-md hover:bg-un1t-accent transition-colors disabled:opacity-50"
        >
          {submitLabel}
        </button>
      </div>
    </div>
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
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-un1t-surface border border-un1t-border rounded-xl p-6 w-full max-w-md" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold">Add Shift Slot — {dayLabel}</h3>
          <button onClick={onClose} className="text-un1t-subtle hover:text-un1t-text"><X size={18} /></button>
        </div>
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
          onClick={handleClick}
          disabled={!templateId || saving}
          className="w-full mt-4 bg-un1t-text text-un1t-bg font-medium text-sm py-2.5 rounded-md hover:bg-un1t-accent transition-colors disabled:opacity-50"
        >
          {saving ? 'Adding...' : 'Add Slot'}
        </button>
      </div>
    </div>
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
  const [impact, setImpact] = useState(null)
  const [loading, setLoading] = useState(true)
  const [submitResult, setSubmitResult] = useState(null)

  useEffect(() => {
    let cancelled = false
    async function loadPreview() {
      try {
        const res = await fetch('/api/schedule/rosters', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            location_id: locationId,
            period_start: period.periodStart,
            period_end: period.periodEnd,
            dry_run: true,
          }),
        })
        const data = await res.json()
        if (cancelled) return
        if (!data.success) {
          setSubmitResult({ error: data.error || 'Failed to load preview' })
        } else {
          setImpact(data.impact)
        }
      } catch (e) {
        if (!cancelled) setSubmitResult({ error: e.message })
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    loadPreview()
    return () => { cancelled = true }
  }, [locationId, period.periodStart, period.periodEnd])

  async function handleConfirm() {
    const result = await onSubmit({
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
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
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-un1t-surface border border-un1t-border rounded-xl p-6 w-full max-w-lg" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold">Publish roster</h3>
          <button onClick={onClose} className="text-un1t-subtle hover:text-un1t-text"><X size={18} /></button>
        </div>

        <div className="bg-black/30 rounded-lg p-3 mb-4 text-sm">
          <div className="text-un1t-subtle text-xs">Period</div>
          <div className="font-medium">{period.periodStart} – {period.periodEnd}</div>
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
                onClick={onClose}
                className="px-3 py-2 rounded-md text-sm border border-un1t-border text-un1t-subtle hover:text-un1t-text hover:border-un1t-text/30"
              >
                Cancel
              </button>
              <button
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
    </div>
  )
}

function SwapModal({ shift, onSubmit, onClose }) {
  const [reason, setReason] = useState('')
  const tmpl = shift.shift_templates || {}

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-un1t-surface border border-un1t-border rounded-xl p-6 w-full max-w-md" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold">Request Shift Swap</h3>
          <button onClick={onClose} className="text-un1t-subtle hover:text-un1t-text"><X size={18} /></button>
        </div>
        <div className="bg-black/30 rounded-lg p-3 mb-4 text-sm">
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
          onClick={() => onSubmit(shift.id, reason)}
          className="w-full mt-4 bg-un1t-text text-un1t-bg font-medium text-sm py-2.5 rounded-md hover:bg-un1t-accent transition-colors"
        >
          Submit Swap Request
        </button>
      </div>
    </div>
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
  block, user, isManager, flatShifts: _flatShifts,
  onClose, onAddCoach, onUnassign, onPartialSave, onDeleteBlock, onSwapRequest,
}) {
  const tmpl = block.shift_templates || {}
  const assignments = block.shift_assignments || []
  const max = block.max_coaches || 15
  const atCapacity = assignments.length >= max
  const dateLabel = new Date(block.block_date + 'T00:00:00').toLocaleDateString('en-IE', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  })

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-un1t-surface border border-un1t-border rounded-lg p-5 max-w-lg w-full max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 mb-4">
          <div className="min-w-0">
            <h3 className="font-semibold text-un1t-text">{tmpl.name || 'Shift'}</h3>
            <p className="text-xs text-un1t-subtle mt-0.5">{dateLabel}</p>
            <p className="text-xs text-un1t-muted mt-1 inline-flex items-center gap-1.5">
              <Clock size={11} />
              {formatTime(block.start_time)}–{formatTime(block.end_time)}
              <span className="mx-1">·</span>
              {assignments.length}/{max} assigned
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-un1t-subtle hover:text-un1t-text shrink-0"
            title="Close"
          >
            <X size={18} />
          </button>
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
              <AssignmentRow
                key={a.id}
                assignment={a}
                block={block}
                isMe={a.profile_id === user.id}
                canEdit={isManager || a.profile_id === user.id}
                onUnassign={() => onUnassign(a.id)}
                onSave={(payload) => onPartialSave(a.id, payload)}
                onSwapRequest={
                  a.profile_id === user.id
                    ? () => onSwapRequest(a.id)
                    : null
                }
              />
            ))
          )}
        </div>

        {/* Action footer */}
        <div className="border-t border-un1t-border pt-4 flex items-center justify-between gap-2">
          {isManager && !atCapacity ? (
            <button
              onClick={onAddCoach}
              className="text-xs bg-blue-500/20 text-blue-300 border border-blue-500/40 hover:bg-blue-500/30 px-3 py-2 rounded-md font-medium inline-flex items-center gap-1.5"
            >
              <Plus size={12} /> Add coach
            </button>
          ) : <span />}
          {isManager && (
            <button
              onClick={onDeleteBlock}
              className="text-xs bg-red-500/15 text-red-300 border border-red-500/30 hover:bg-red-500/25 px-3 py-2 rounded-md font-medium inline-flex items-center gap-1.5"
              title="Delete this entire shift slot"
            >
              <X size={12} /> Delete this slot
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// One coach's row inside BlockDetailModal — shows their effective
// times, lets a manager (or the coach themselves) override the
// times for partial shifts, request a swap, or be removed.
function AssignmentRow({ assignment, block, isMe, canEdit, onUnassign, onSave, onSwapRequest }) {
  const blockStart = (block.start_time || '').slice(0, 5)
  const blockEnd = (block.end_time || '').slice(0, 5)
  const overrideStart = (assignment.start_time_override || '').slice(0, 5)
  const overrideEnd = (assignment.end_time_override || '').slice(0, 5)
  const hasOverride = !!(assignment.start_time_override || assignment.end_time_override)

  const [editing, setEditing] = useState(false)
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
          <div className={`text-sm font-medium ${isMe ? 'text-blue-300' : 'text-un1t-text'}`}>
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
              onClick={onSwapRequest}
              className="text-[11px] text-un1t-subtle hover:text-un1t-text inline-flex items-center gap-1 px-2 py-1 rounded hover:bg-un1t-border/40"
              title="Request swap"
            >
              <ArrowLeftRight size={11} />
            </button>
          )}
          {canEdit && !editing && (
            <button
              onClick={() => setEditing(true)}
              className="text-[11px] font-semibold text-white inline-flex items-center gap-1 px-2.5 py-1 rounded bg-amber-600 hover:bg-amber-700 border border-amber-700"
              title={hasOverride ? 'Edit adjusted times' : 'Adjust this coach’s actual times'}
            >
              <Pencil size={11} />
              {hasOverride ? 'Edit' : 'Adjust'}
            </button>
          )}
          {canEdit && !editing && (
            <button
              onClick={onUnassign}
              className="text-[11px] text-un1t-subtle hover:text-red-400 inline-flex items-center gap-1 px-2 py-1 rounded hover:bg-red-500/10"
              title="Remove coach"
            >
              <X size={11} />
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
            <div className="text-xs text-red-400 inline-flex items-start gap-1.5">
              <AlertCircle size={11} className="mt-0.5 shrink-0" /> {error}
            </div>
          )}
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <button
                onClick={handleSave}
                disabled={saving}
                className="text-xs bg-amber-500/20 text-amber-200 border border-amber-500/40 hover:bg-amber-500/30 px-3 py-1.5 rounded-md font-medium inline-flex items-center gap-1.5 disabled:opacity-50"
              >
                <Check size={11} /> {saving ? 'Saving…' : 'Save'}
              </button>
              <button
                onClick={() => { setEditing(false); setError(null); setStart(overrideStart || blockStart); setEnd(overrideEnd || blockEnd); setReason(assignment.partial_reason || '') }}
                disabled={saving}
                className="text-xs text-un1t-subtle hover:text-un1t-text px-2 py-1.5"
              >
                Cancel
              </button>
            </div>
            {hasOverride && (
              <button
                onClick={handleClear}
                disabled={saving}
                className="text-[11px] text-un1t-muted hover:text-red-300"
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
