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
// Copy-week / copy-month / publish still hit /api/schedule/shifts/*
// which writes to public.shifts; the reverse trigger propagates
// those writes back into shift_blocks/shift_assignments.

import { useState, useEffect, useCallback } from 'react'
import { ChevronLeft, ChevronRight, Copy, Send, Plus, Users, User, Clock, X, ArrowLeftRight, CalendarOff, Palmtree, ThermometerSun, Ban, AlertTriangle, AlertCircle, CalendarDays, CalendarRange } from 'lucide-react'
import Link from 'next/link'
import { computeWeeklyCost } from '@/lib/payroll'
import { indexByDate } from '@/lib/bank-holidays'
import { MANAGER_ROLES } from '@/lib/schemas'
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

export default function ScheduleCalendar({ user }) {
  const [weekStart, setWeekStart] = useState(() => getMonday(new Date()))
  const [monthStart, setMonthStart] = useState(() => getMonthStart(new Date()))
  const [viewType, setViewType] = useState('week')
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
  const [timeOff, setTimeOff] = useState([])
  const [holidays, setHolidays] = useState([])

  const locationId = user.activeLocation?.id
  const isManager = canManage(user.role)
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

    const [blocksRes, templatesRes, staffRes, timeOffRes, holidaysRes] = await Promise.all([
      fetch(`/api/schedule/blocks?location_id=${locationId}&start_date=${start}&end_date=${end}`).then(r => r.json()),
      fetch(`/api/schedule/templates?location_id=${locationId}`).then(r => r.json()),
      fetch('/api/staff').then(r => r.json()),
      fetch(`/api/schedule/time-off?location_id=${locationId}&start_date=${start}&end_date=${end}&status=approved`).then(r => r.json()),
      fetch(`/api/locations/${locationId}/holidays?start=${start}&end=${end}`).then(r => r.json()),
    ])

    setBlocks(blocksRes.data || [])
    setTemplates((templatesRes.data || []).filter(t => t.active))
    setStaff(staffRes.data || [])
    setTimeOff(timeOffRes.data || [])
    setHolidays(holidaysRes.data || [])
    setLoading(false)
  }, [locationId, viewType, weekStart, monthStart])

  useEffect(() => { fetchData() }, [fetchData])

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
  // modal (which still hits POST /api/schedule/swaps with a shift id).
  const flatShifts = flattenBlocksToShifts(blocks)

  // Unstaffed-block count for the publish toolbar — surfaces "you
  // still have empty slots" as a friction signal before publishing.
  const unstaffedThisWeek = blocks.filter(b => {
    const inWeek = b.block_date >= formatDate(weekStart) && b.block_date <= formatDate(weekEnd)
    return inWeek && isBlockUnstaffedFuture(b, todayStr)
  }).length

  async function handleAssignCoach(blockId, profileId) {
    const res = await fetch(`/api/schedule/blocks/${blockId}/assignments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile_id: profileId }),
    })
    const data = await res.json()
    if (data.success) {
      if (data.warnings?.length > 0) {
        alert('Assigned with warning:\n\n' + data.warnings.join('\n'))
      }
      setAssignTarget(null)
      fetchData()
    } else {
      alert(data.error || 'Failed to assign coach')
    }
  }

  async function handleUnassign(assignmentId) {
    if (!confirm('Remove this coach from the shift?')) return
    const res = await fetch(`/api/schedule/assignments/${assignmentId}`, { method: 'DELETE' })
    const data = await res.json()
    if (data.success) fetchData()
    else alert(data.error || 'Failed to remove')
  }

  async function handleDeleteBlock(blockId) {
    if (!confirm('Delete this entire shift slot? Any assigned coaches are removed too. (The template will regenerate it on next save unless you remove the matching weekday from the template.)')) return
    const res = await fetch(`/api/schedule/blocks/${blockId}`, { method: 'DELETE' })
    const data = await res.json()
    if (data.success) fetchData()
    else alert(data.error || 'Failed to delete block')
  }

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
      fetchData()
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
      fetchData()
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
    if (data.success) fetchData()
    else alert(data.error || 'Failed to copy week')
  }

  async function handleCopyMonth() {
    const prevMonthStart = addMonths(monthStart, -1)
    const sourceLabel = prevMonthStart.toLocaleDateString('en-IE', { month: 'long', year: 'numeric' })
    if (!confirm(`Copy last month's roster (${sourceLabel}) to ${monthLabel}?`)) return
    setCopying(true)
    const res = await fetch('/api/schedule/shifts/copy-month', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        location_id: locationId,
        source_month_start: formatDate(prevMonthStart),
        target_month_start: formatDate(monthStart),
      }),
    })
    const data = await res.json()
    setCopying(false)
    if (data.success) {
      const skipped = data.skipped || 0
      if (skipped > 0) {
        alert(`Copied ${data.copied} shifts. ${skipped} skipped (day-of-month doesn't exist in target — usually Jan 31 → Feb).`)
      }
      fetchData()
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
          <p className="text-sm text-un1t-light mt-1">
            {user.activeLocation?.name} — Staff roster
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/schedule/time-off"
            className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg border border-un1t-gray text-un1t-light hover:text-un1t-white hover:border-un1t-white/30 transition-colors"
          >
            <CalendarOff size={14} /> Time Off
          </Link>

          <div className="flex bg-un1t-dark border border-un1t-gray rounded-lg overflow-hidden text-xs">
            <button
              onClick={() => setViewMode('my')}
              className={`flex items-center gap-1.5 px-3 py-2 transition-colors ${viewMode === 'my' ? 'bg-un1t-white text-un1t-black' : 'text-un1t-light hover:text-un1t-white'}`}
            >
              <User size={14} /> My Shifts
            </button>
            <button
              onClick={() => setViewMode('all')}
              className={`flex items-center gap-1.5 px-3 py-2 transition-colors ${viewMode === 'all' ? 'bg-un1t-white text-un1t-black' : 'text-un1t-light hover:text-un1t-white'}`}
            >
              <Users size={14} /> All Staff
            </button>
          </div>

          <div className="flex bg-un1t-dark border border-un1t-gray rounded-lg overflow-hidden text-xs">
            <button
              onClick={() => {
                if (viewType === 'month') setWeekStart(getMonday(monthStart))
                setViewType('week')
              }}
              className={`flex items-center gap-1.5 px-3 py-2 transition-colors ${viewType === 'week' ? 'bg-un1t-white text-un1t-black' : 'text-un1t-light hover:text-un1t-white'}`}
            >
              <CalendarDays size={14} /> Week
            </button>
            <button
              onClick={() => {
                if (viewType === 'week') setMonthStart(getMonthStart(weekStart))
                setViewType('month')
              }}
              className={`flex items-center gap-1.5 px-3 py-2 transition-colors ${viewType === 'month' ? 'bg-un1t-white text-un1t-black' : 'text-un1t-light hover:text-un1t-white'}`}
            >
              <CalendarRange size={14} /> Month
            </button>
          </div>

          {isManager && (
            <>
              <button
                onClick={viewType === 'month' ? handleCopyMonth : handleCopyWeek}
                disabled={copying}
                className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg border border-un1t-gray text-un1t-light hover:text-un1t-white hover:border-un1t-white/30 transition-colors disabled:opacity-50"
              >
                <Copy size={14} /> {copying ? 'Copying...' : viewType === 'month' ? 'Copy Last Month' : 'Copy Last Week'}
              </button>
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
          className="p-2 rounded-lg hover:bg-un1t-gray/50 text-un1t-light hover:text-un1t-white transition-colors"
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
          className="p-2 rounded-lg hover:bg-un1t-gray/50 text-un1t-light hover:text-un1t-white transition-colors"
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
                      : 'border-un1t-gray bg-un1t-dark/40 text-un1t-light'
                    }`}
                  >
                    <span className="font-medium text-un1t-white">{s.full_name}</span>
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
            <p className="text-[11px] text-un1t-mid mt-2">
              FTE staff scheduled at or above their contracted hours for {weekLabel}.
            </p>
          </div>
        )
      })()}

      {/* Calendar Grid */}
      {loading ? (
        <div className="text-center py-20 text-un1t-light">Loading roster...</div>
      ) : viewType === 'month' ? (
        // ── MONTH VIEW ──
        // Renders a 6x7 grid; each cell shows the date + count of
        // assignments + count of unstaffed blocks. Clicking drills
        // into the week view. Roster v2: separately surfaces empty
        // blocks as a red badge.
        <div>
          <div className="grid grid-cols-7 gap-1.5 mb-1.5">
            {DAY_LABELS.map(label => (
              <div key={label} className="text-[11px] font-semibold text-un1t-light uppercase tracking-wider text-center py-1">
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
                    className={`text-left bg-un1t-dark border rounded-md p-1.5 min-h-[88px] transition-colors hover:border-un1t-white/30 ${
                      inFocusedMonth ? 'border-un1t-gray' : 'border-un1t-gray/50 opacity-60'
                    } ${isToday ? 'ring-1 ring-blue-400/50' : ''} ${holiday ? 'bg-amber-500/[0.06]' : ''}`}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className={`text-xs font-semibold ${isToday ? 'text-blue-400' : inFocusedMonth ? 'text-un1t-white' : 'text-un1t-mid'}`}>
                        {date.getDate()}
                      </span>
                      <div className="flex items-center gap-1">
                        {unstaffedCount > 0 && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/20 text-red-300" title={`${unstaffedCount} unstaffed`}>
                            !{unstaffedCount}
                          </span>
                        )}
                        {totalAssignmentCount > 0 && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-un1t-gray/60 text-un1t-light">
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
                        <div className="text-[10px] text-un1t-mid">+{visibleBlocks.length - 3} more</div>
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
                  : 'bg-un1t-dark text-un1t-light'

              return (
                <div key={i} className="min-h-[200px]">
                  <div className={`text-center py-2 rounded-t-lg text-xs font-semibold ${headerCls}`} title={holiday?.name || undefined}>
                    <div>{label}</div>
                    <div className={`text-lg font-bold ${isToday ? 'text-white' : 'text-un1t-white'}`}>{date.getDate()}</div>
                    {holiday && (
                      <div className={`mt-0.5 text-[10px] font-medium leading-tight px-1 truncate ${isToday ? 'text-white/80' : 'text-amber-300'}`}>
                        {holiday.source === 'national' ? '🇮🇪 ' : '🏷 '}{holiday.name}
                      </div>
                    )}
                  </div>

                  <div className={`bg-un1t-dark/50 border border-un1t-gray border-t-0 rounded-b-lg p-1.5 space-y-1.5 min-h-[160px] ${holiday ? 'bg-amber-500/[0.04]' : ''}`}>
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
                      <div className="text-center py-6 text-xs text-un1t-mid">No shifts</div>
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

                      return (
                        <div
                          key={block.id}
                          className={`rounded-md p-2 text-xs relative group ${myAssignment ? 'ring-1 ring-blue-400/50' : ''} ${unstaffed ? 'border border-red-500/50' : ''}`}
                          style={{ backgroundColor: unstaffed ? '#7F1D1D20' : blockColor + '20', borderLeft: `3px solid ${unstaffed ? '#EF4444' : blockColor}` }}
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
                                    ? 'bg-un1t-gray/60 text-un1t-white'
                                    : ''
                              }`}
                              style={!unstaffed && !atCapacity ? { backgroundColor: blockColor + '30', color: blockColor } : undefined}
                            >
                              {count}/{max}
                            </span>
                          </div>
                          <div className="text-un1t-light mt-0.5 flex items-center gap-1">
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
                                return (
                                  <div key={a.id} className="flex items-center justify-between gap-1 text-[11px]">
                                    <span className={`truncate ${isMe ? 'text-blue-300 font-medium' : 'text-un1t-white'}`}>
                                      {a.profiles?.full_name || 'Unknown'}
                                    </span>
                                    {(isManager || isMe) && (
                                      <button
                                        onClick={(e) => { e.stopPropagation(); handleUnassign(a.id) }}
                                        className="opacity-0 group-hover:opacity-100 text-un1t-mid hover:text-red-400 flex-shrink-0"
                                        title="Remove coach"
                                      >
                                        <X size={10} />
                                      </button>
                                    )}
                                  </div>
                                )
                              })}
                            </div>
                          )}

                          {/* Action row */}
                          <div className="mt-1.5 flex items-center justify-end gap-1">
                            {myAssignment && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation()
                                  // Swap modal expects a legacy shift-shaped row
                                  const shiftShape = flatShifts.find(fs => fs.id === myAssignment.id)
                                  if (shiftShape) setSwapModal(shiftShape)
                                }}
                                className="text-[10px] text-un1t-light hover:text-un1t-white"
                                title="Request swap"
                              >
                                <ArrowLeftRight size={11} />
                              </button>
                            )}
                            {isManager && !atCapacity && (
                              <button
                                onClick={() => setAssignTarget({ block })}
                                className="text-[10px] text-blue-400 hover:text-blue-300 px-1.5 py-0.5 rounded border border-blue-500/30 hover:border-blue-500/60"
                              >
                                + Assign
                              </button>
                            )}
                            {isManager && (
                              <button
                                onClick={() => handleDeleteBlock(block.id)}
                                className="opacity-0 group-hover:opacity-100 text-un1t-mid hover:text-red-400"
                                title="Remove this shift slot"
                              >
                                <X size={11} />
                              </button>
                            )}
                          </div>
                        </div>
                      )
                    })}

                    {/* Add ad-hoc block button (manager only) */}
                    {isManager && (
                      <button
                        onClick={() => setCreateTarget({ date: dateStr })}
                        className="w-full py-2 rounded-md border border-dashed border-un1t-gray text-un1t-mid hover:text-un1t-white hover:border-un1t-white/30 text-xs transition-colors flex items-center justify-center gap-1"
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
      {!loading && isManager && (
        <RosterSummaryPanel
          blocks={blocks}
          staff={locationStaff}
          weekStart={weekStart}
          monthStart={monthStart}
          location={user.activeLocation}
          timeOff={timeOff}
        />
      )}

      {/* Assign Coach Popover */}
      {assignTarget && (
        <AssignCoachModal
          block={assignTarget.block}
          staff={locationStaff}
          onAssign={(profileId) => handleAssignCoach(assignTarget.block.id, profileId)}
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
    </div>
  )
}

function AssignCoachModal({ block, staff, onAssign, onClose }) {
  const [profileId, setProfileId] = useState('')
  const [saving, setSaving] = useState(false)
  const tmpl = block.shift_templates || {}
  const assignedIds = new Set((block.shift_assignments || []).map(a => a.profile_id))
  const available = staff.filter(s => !assignedIds.has(s.id))
  const dayLabel = new Date(block.block_date + 'T00:00:00').toLocaleDateString('en-IE', { weekday: 'long', day: 'numeric', month: 'long' })

  async function handleClick() {
    if (!profileId) return
    setSaving(true)
    await onAssign(profileId)
    setSaving(false)
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-un1t-dark border border-un1t-gray rounded-xl p-6 w-full max-w-md" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold">Assign Coach</h3>
          <button onClick={onClose} className="text-un1t-light hover:text-un1t-white"><X size={18} /></button>
        </div>
        <div className="bg-black/30 rounded-lg p-3 mb-4 text-sm">
          <div className="font-medium">{tmpl.name || 'Shift'} — {dayLabel}</div>
          <div className="text-un1t-light text-xs mt-1">
            {formatTime(block.start_time)}–{formatTime(block.end_time)} · {(block.shift_assignments?.length || 0)}/{block.max_coaches} assigned
          </div>
        </div>
        <div>
          <label className="block text-xs text-un1t-light mb-1">Coach *</label>
          <select value={profileId} onChange={e => setProfileId(e.target.value)} className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white">
            <option value="">Select coach...</option>
            {available.map(s => (
              <option key={s.id} value={s.id}>{s.full_name} ({s.role})</option>
            ))}
          </select>
          {available.length === 0 && (
            <p className="text-[11px] text-un1t-light mt-1.5">All staff already assigned to this slot.</p>
          )}
        </div>
        <button
          onClick={handleClick}
          disabled={!profileId || saving}
          className="w-full mt-4 bg-un1t-white text-un1t-black font-medium text-sm py-2.5 rounded-md hover:bg-un1t-accent transition-colors disabled:opacity-50"
        >
          {saving ? 'Assigning...' : 'Assign Coach'}
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
      <div className="bg-un1t-dark border border-un1t-gray rounded-xl p-6 w-full max-w-md" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold">Add Shift Slot — {dayLabel}</h3>
          <button onClick={onClose} className="text-un1t-light hover:text-un1t-white"><X size={18} /></button>
        </div>
        <p className="text-xs text-un1t-light mb-3">
          Adds a one-off block for this day. To make a slot recur, edit the template and add this weekday to its days_of_week.
        </p>
        <div>
          <label className="block text-xs text-un1t-light mb-1">Template *</label>
          <select value={templateId} onChange={e => setTemplateId(e.target.value)} className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white">
            <option value="">Select template...</option>
            {templates.map(t => (
              <option key={t.id} value={t.id}>{t.name} ({formatTime(t.start_time)}–{formatTime(t.end_time)})</option>
            ))}
          </select>
        </div>
        <button
          onClick={handleClick}
          disabled={!templateId || saving}
          className="w-full mt-4 bg-un1t-white text-un1t-black font-medium text-sm py-2.5 rounded-md hover:bg-un1t-accent transition-colors disabled:opacity-50"
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
      <div className="bg-un1t-dark border border-un1t-gray rounded-xl p-6 w-full max-w-lg" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold">Publish roster</h3>
          <button onClick={onClose} className="text-un1t-light hover:text-un1t-white"><X size={18} /></button>
        </div>

        <div className="bg-black/30 rounded-lg p-3 mb-4 text-sm">
          <div className="text-un1t-light text-xs">Period</div>
          <div className="font-medium">{period.periodStart} – {period.periodEnd}</div>
        </div>

        {loading && (
          <div className="text-center py-6 text-sm text-un1t-light">Calculating budget impact…</div>
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
              <div className="rounded-lg border border-un1t-gray p-3">
                <div className="text-[10px] uppercase tracking-wider text-un1t-light">Blocks in period</div>
                <div className="text-xl font-semibold">{impact.blockCount}</div>
              </div>
              <div className="rounded-lg border border-un1t-gray p-3">
                <div className="text-[10px] uppercase tracking-wider text-un1t-light">Period contractor cost</div>
                <div className="text-xl font-semibold">{fmtEur(impact.periodProjectedEur)}</div>
              </div>
              <div className="rounded-lg border border-un1t-gray p-3 col-span-2">
                <div className="text-[10px] uppercase tracking-wider text-un1t-light">Month total after publish (vs budget)</div>
                <div className={`text-xl font-semibold ${overBudget ? 'text-red-700' : 'text-un1t-white'}`}>
                  {fmtEur(impact.monthProjectedTotalEur)}
                  <span className="text-xs text-un1t-light font-normal ml-2">
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
                className="px-3 py-2 rounded-md text-sm border border-un1t-gray text-un1t-light hover:text-un1t-white hover:border-un1t-white/30"
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
      <div className="bg-un1t-dark border border-un1t-gray rounded-xl p-6 w-full max-w-md" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold">Request Shift Swap</h3>
          <button onClick={onClose} className="text-un1t-light hover:text-un1t-white"><X size={18} /></button>
        </div>
        <div className="bg-black/30 rounded-lg p-3 mb-4 text-sm">
          <div className="font-medium">{tmpl.name} — {new Date(shift.shift_date + 'T00:00:00').toLocaleDateString('en-IE', { weekday: 'long', day: 'numeric', month: 'long' })}</div>
          <div className="text-un1t-light text-xs mt-1">
            {formatTime(shift.start_time_override || tmpl.start_time)}–{formatTime(shift.end_time_override || tmpl.end_time)}
            {shift.role_label && ` · ${shift.role_label}`}
          </div>
        </div>
        <div>
          <label className="block text-xs text-un1t-light mb-1">Reason (optional)</label>
          <textarea
            value={reason}
            onChange={e => setReason(e.target.value)}
            rows={3}
            placeholder="Why do you need to swap this shift?"
            className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white resize-none"
          />
        </div>
        <button
          onClick={() => onSubmit(shift.id, reason)}
          className="w-full mt-4 bg-un1t-white text-un1t-black font-medium text-sm py-2.5 rounded-md hover:bg-un1t-accent transition-colors"
        >
          Submit Swap Request
        </button>
      </div>
    </div>
  )
}
