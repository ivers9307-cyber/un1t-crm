// /dashboard/today — Personal dashboard. Web mirror of the mobile
// PersonalDashboard. Same data fetched from shared/dashboard-data.js.
//
// Permission: dashboard_personal (cross-platform).

import { redirect } from 'next/navigation'
import Link from 'next/link'
import { Calendar, ArrowLeftRight, AlertCircle, AlertTriangle, ClipboardCheck } from 'lucide-react'
import { getCurrentUser, getUserLocationIds } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import {
  fetchPersonalDashboardData,
  fetchUnstaffedBlocksThisWeek,
  fetchIncompletePayProfiles,
  fetchPendingRosterApprovalsCount,
} from '@shared/dashboard-data'
import { pickLocationColor } from '@shared/location-colors'
import { MANAGER_ROLES } from '@/lib/schemas'
import {
  KpiCard, KpiRow, SectionHeader, ListCard, PendingRow,
} from '@/components/dashboard/Cards'

export const dynamic = 'force-dynamic'
export const revalidate = 0

function shiftTime(shift) {
  const start = (shift.start_time_override || shift.shift_templates?.start_time || '').slice(0, 5)
  const end = (shift.end_time_override || shift.shift_templates?.end_time || '').slice(0, 5)
  return `${start} – ${end}`
}

function shiftHours(shift) {
  const start = shift.start_time_override || shift.shift_templates?.start_time
  const end = shift.end_time_override || shift.shift_templates?.end_time
  if (!start || !end) return 0
  const [sh, sm] = start.split(':').map(Number)
  const [eh, em] = end.split(':').map(Number)
  let mins = eh * 60 + em - (sh * 60 + sm)
  if (mins < 0) mins += 24 * 60
  return Math.round((mins / 60) * 10) / 10
}

function isoDate(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function buildWeek(weekStartIso, shifts) {
  const start = new Date(weekStartIso + 'T00:00:00')
  const todayIso = isoDate(new Date())
  const days = []
  for (let i = 0; i < 7; i++) {
    const d = new Date(start)
    d.setDate(start.getDate() + i)
    const iso = isoDate(d)
    const daysShifts = shifts.filter(s => s.shift_date === iso)
    days.push({
      iso,
      label: d.toLocaleDateString(undefined, { weekday: 'short' }).toUpperCase(),
      dayNum: d.getDate(),
      isToday: iso === todayIso,
      isPast: iso < todayIso,
      shifts: daysShifts,
    })
  }
  return days
}

function rangeLabelFor(startIso, endIso) {
  const s = new Date(startIso + 'T00:00:00')
  const e = new Date(endIso + 'T00:00:00')
  const fmt = d => d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
  return `${fmt(s)} – ${fmt(e)}`
}

// Reusable week panel — same JSX for "This week" and "Next week".
// `showLocation` controls whether each shift row renders a small
// location chip; we only show it for users with 2+ assigned
// locations to avoid redundant chrome for single-location staff.
function WeekPanel({ title, startIso, endIso, shifts, showLocation }) {
  const days = buildWeek(startIso, shifts || [])
  return (
    <div className="bg-un1t-dark border border-un1t-gray rounded-2xl overflow-hidden">
      <div className="px-4 pt-3 pb-2 flex items-baseline justify-between">
        <span className="text-xs font-semibold uppercase tracking-wider text-un1t-light">{title}</span>
        <span className="text-xs text-un1t-mid">{rangeLabelFor(startIso, endIso)}</span>
      </div>
      {days.map((day, idx) => {
        const isLast = idx === days.length - 1
        return (
          <div
            key={day.iso}
            className={`flex px-4 py-2.5 ${!isLast ? 'border-b border-un1t-gray' : ''} ${
              day.isToday ? 'bg-un1t-gray/30' : ''
            }`}
          >
            <div className="w-14 shrink-0">
              <div className={`text-[10px] font-semibold uppercase tracking-wider ${
                day.isToday ? 'text-un1t-white'
                : day.isPast ? 'text-un1t-mid'
                : 'text-un1t-light'
              }`}>
                {day.label}
              </div>
              <div className={`text-base font-semibold ${
                day.isPast ? 'text-un1t-mid' : 'text-un1t-white'
              }`}>
                {day.dayNum}
              </div>
            </div>
            <div className="flex-1 min-w-0">
              {day.shifts.length === 0 ? (
                <div className={`text-sm pt-1 ${day.isPast ? 'text-un1t-mid' : 'text-un1t-light'}`}>
                  Off
                </div>
              ) : (
                day.shifts.map((s, i) => (
                  <div key={s.id} className={i > 0 ? 'mt-1' : ''}>
                    <div className="flex items-center justify-between gap-2">
                      <div className={`text-sm font-medium truncate ${day.isPast ? 'text-un1t-light' : 'text-un1t-white'}`}>
                        {s.shift_templates?.name || 'Shift'}
                      </div>
                      {s.published === false && (
                        <span className="px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-700 text-[10px] uppercase font-semibold whitespace-nowrap">
                          Draft
                        </span>
                      )}
                      {s.status === 'swapped' && (
                        <span className="px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-700 text-[10px] uppercase font-semibold whitespace-nowrap">
                          Swapped
                        </span>
                      )}
                    </div>
                    <div className={`text-xs flex items-center gap-1.5 flex-wrap ${day.isPast ? 'text-un1t-mid' : 'text-un1t-light'}`}>
                      <span>{shiftTime(s)} · {shiftHours(s)}h</span>
                      {showLocation && s.locations?.name && (() => {
                        // Per-location accent colour so chips for
                        // different gyms don't blur into one another.
                        // Past-day chips use the same palette but
                        // softer to keep the past row visually muted.
                        const c = pickLocationColor(s.locations.id || s.location_id)
                        return (
                          <span className={`px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wider whitespace-nowrap ${c.bg} ${c.text} ${day.isPast ? 'opacity-60' : ''}`}>
                            {s.locations.name}
                          </span>
                        )
                      })()}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

export default async function PersonalDashboardPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  // Permission gate — toggle is honoured for every role including owner.
  if (!hasPermission(user, 'dashboard_personal')) redirect('/dashboard')

  const db = createServerClient()
  const res = await fetchPersonalDashboardData(db, user.id, user.activeLocation?.id)
  if (!res.success) {
    return (
      <p className="text-sm text-red-500">Failed to load dashboard: {res.error}</p>
    )
  }

  const {
    weekShifts, weekStartIso, weekEndIso,
    nextWeekShifts, nextWeekStartIso, nextWeekEndIso,
    shiftsThisWeek, hoursThisWeek,
    pendingSwapsForMe, myPendingTimeOff, unreadInbox,
  } = res.data

  // Roster v2 phases 2 + 3 + 5 — manager / owner alerts.
  // Master sees these chips across all assigned locations.
  const isManager = user.role === 'master' || MANAGER_ROLES.includes(user.role)
  // Owner-only chip: pending roster approvals. Master counts as owner
  // for approval purposes; otherwise the user is "owner-somewhere"
  // if any of their per-location assignments has role='owner'.
  const ownerLocationIds = user.role === 'master'
    ? (user.locations || []).map(l => l.id)
    : Object.entries(user.rolesByLocation || {})
        .filter(([, role]) => role === 'owner')
        .map(([id]) => id)
  const isOwnerSomewhere = ownerLocationIds.length > 0

  let unstaffedCount = 0
  let incompletePay = { count: 0, sample: [] }
  let pendingApprovals = 0
  if (isManager || isOwnerSomewhere) {
    const locIds = user.role === 'master'
      ? (user.locations || []).map(l => l.id)
      : getUserLocationIds(user)
    const [unstaffedRes, payRes, approvalsRes] = await Promise.all([
      fetchUnstaffedBlocksThisWeek(db, locIds),
      fetchIncompletePayProfiles(db, locIds),
      isOwnerSomewhere ? fetchPendingRosterApprovalsCount(db, ownerLocationIds) : Promise.resolve({ success: true, data: { count: 0 } }),
    ])
    if (unstaffedRes.success) unstaffedCount = unstaffedRes.data.count
    if (payRes.success) incompletePay = payRes.data
    if (approvalsRes.success) pendingApprovals = approvalsRes.data.count
  }

  // Show the per-shift location chip only when the user is assigned
  // to 2+ locations — otherwise it's redundant clutter for staff
  // who only ever work at one gym.
  const showLocation = (user.locations || []).length > 1

  return (
    <>
      {/* Roster — current + next week, side-by-side on md+ screens,
          stacked below md so the rows stay readable on narrow web. */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4 max-w-5xl">
        <WeekPanel
          title="This week"
          startIso={weekStartIso}
          endIso={weekEndIso}
          shifts={weekShifts}
          showLocation={showLocation}
        />
        <WeekPanel
          title="Next week"
          startIso={nextWeekStartIso}
          endIso={nextWeekEndIso}
          shifts={nextWeekShifts}
          showLocation={showLocation}
        />
      </div>

      <KpiRow>
        <KpiCard label="This week" value={`${hoursThisWeek}h`} sublabel={`${shiftsThisWeek} shift${shiftsThisWeek === 1 ? '' : 's'}`} />
        <KpiCard
          label="Inbox"
          value={unreadInbox}
          sublabel={unreadInbox === 1 ? 'unread message' : 'unread messages'}
          accent={unreadInbox > 0 ? 'text-un1t-white' : 'text-un1t-mid'}
          href={unreadInbox > 0 ? '/whatsapp' : undefined}
        />
      </KpiRow>

      {/* Roster v2 phase 5 — pending roster approvals for owners.
          Most operationally urgent of the three roster chips
          (it's actively blocking staff from seeing their schedule),
          so it goes first in the alert stack. */}
      {isOwnerSomewhere && pendingApprovals > 0 && (
        <Link
          href="/schedule/approvals"
          className="block mt-3 p-3 rounded-lg border border-blue-500/40 bg-blue-500/10 hover:bg-blue-500/15 transition-colors"
        >
          <div className="flex items-start gap-3">
            <ClipboardCheck size={16} className="text-blue-600 mt-0.5 flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-blue-800">
                {pendingApprovals} roster{pendingApprovals === 1 ? '' : 's'} waiting for approval
              </div>
              <div className="text-xs text-blue-700/90 mt-0.5">
                Manager-submitted draft{pendingApprovals === 1 ? '' : 's'} over budget. Staff can&apos;t see their shifts until you approve.
              </div>
            </div>
          </div>
        </Link>
      )}

      {/* Roster v2 phase 2 — unstaffed-block alert for managers/owners.
          Empty future shift_blocks across the user's locations;
          customers will be in the studio either way, so loud surfacing
          here matches the "demand window" model. */}
      {isManager && unstaffedCount > 0 && (
        <Link
          href="/schedule"
          className="block mt-3 p-3 rounded-lg border border-red-500/40 bg-red-500/10 hover:bg-red-500/15 transition-colors"
        >
          <div className="flex items-start gap-3">
            <AlertCircle size={16} className="text-red-600 mt-0.5 flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-red-700">
                {unstaffedCount} unstaffed block{unstaffedCount === 1 ? '' : 's'} this week
              </div>
              <div className="text-xs text-red-700/80 mt-0.5">
                Demand windows with no coach assigned. Click to open the schedule.
              </div>
            </div>
          </div>
        </Link>
      )}

      {/* Roster v2 phase 3 — pay-data completeness for managers.
          Phase 4's cost panel zero-costs anyone whose employment
          fields are missing, which silently understates labour
          spend. Surfacing here gives the operator a chance to fix
          before the budget panel goes live in mig 071. */}
      {isManager && incompletePay.count > 0 && (
        <Link
          href="/settings/staff"
          className="block mt-3 p-3 rounded-lg border border-amber-500/40 bg-amber-500/10 hover:bg-amber-500/15 transition-colors"
        >
          <div className="flex items-start gap-3">
            <AlertTriangle size={16} className="text-amber-600 mt-0.5 flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-amber-800">
                {incompletePay.count} staff member{incompletePay.count === 1 ? '' : 's'} missing pay data
              </div>
              <div className="text-xs text-amber-700/90 mt-0.5">
                {incompletePay.sample.slice(0, 3).map(p => p.name).join(', ')}
                {incompletePay.count > 3 && ` and ${incompletePay.count - 3} more`}
                {' — '}
                without a rate or contracted hours, their shifts cost €0 in the budget panel.
              </div>
            </div>
          </div>
        </Link>
      )}

      <SectionHeader title="Swap requests for you" count={pendingSwapsForMe.length} />
      <ListCard empty={pendingSwapsForMe.length === 0} emptyText="No swap requests waiting on you.">
        {pendingSwapsForMe.map((s, i) => (
          <PendingRow
            key={s.id}
            icon={<ArrowLeftRight size={16} />}
            title={`${s.requester?.full_name || 'Someone'} wants you to take a shift`}
            subtitle={s.requester_shift?.shift_templates?.name
              ? `${s.requester_shift.shift_templates.name} on ${s.requester_shift.shift_date}`
              : `Posted ${new Date(s.created_at).toLocaleDateString()}`}
            href="/schedule"
            isLast={i === pendingSwapsForMe.length - 1}
          />
        ))}
      </ListCard>

      <SectionHeader title="Your time-off requests" count={myPendingTimeOff.length} />
      <ListCard empty={myPendingTimeOff.length === 0} emptyText="No pending time-off requests.">
        {myPendingTimeOff.map((t, i) => (
          <PendingRow
            key={t.id}
            icon={<Calendar size={16} />}
            title={`${t.type} · awaiting decision`}
            subtitle={t.start_date === t.end_date ? t.start_date : `${t.start_date} – ${t.end_date}`}
            href="/schedule"
            isLast={i === myPendingTimeOff.length - 1}
          />
        ))}
      </ListCard>
    </>
  )
}
