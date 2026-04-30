// /dashboard/today — Personal dashboard. Web mirror of the mobile
// PersonalDashboard. Same data fetched from shared/dashboard-data.js.
//
// Permission: dashboard_personal (cross-platform).

import { redirect } from 'next/navigation'
import { Calendar, ArrowLeftRight } from 'lucide-react'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { fetchPersonalDashboardData } from '@shared/dashboard-data'
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
function WeekPanel({ title, startIso, endIso, shifts }) {
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
                    <div className={`text-xs ${day.isPast ? 'text-un1t-mid' : 'text-un1t-light'}`}>
                      {shiftTime(s)} · {shiftHours(s)}h
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

  // Permission gate (owner bypass is a no-op since they have it set anyway).
  const perms = user.permissions || {}
  if (user.role !== 'owner' && !perms.dashboard_personal) {
    redirect('/dashboard')
  }

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
        />
        <WeekPanel
          title="Next week"
          startIso={nextWeekStartIso}
          endIso={nextWeekEndIso}
          shifts={nextWeekShifts}
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
