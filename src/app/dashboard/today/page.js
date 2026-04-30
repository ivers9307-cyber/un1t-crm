// /dashboard/today — Personal dashboard. Web mirror of the mobile
// PersonalDashboard. Same data fetched from shared/dashboard-data.js.
//
// Permission: dashboard_personal (cross-platform).

import { redirect } from 'next/navigation'
import { Calendar, Inbox, ArrowLeftRight, Clock } from 'lucide-react'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { fetchPersonalDashboardData } from '@shared/dashboard-data'
import {
  KpiCard, KpiRow, SectionHeader, ListCard, PendingRow,
} from '@/components/dashboard/Cards'

export const dynamic = 'force-dynamic'
export const revalidate = 0

function formatShiftWhen(shift) {
  if (!shift) return null
  const d = new Date(shift.shift_date + 'T00:00:00')
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1)
  const start = (shift.start_time_override || shift.shift_templates?.start_time || '').slice(0, 5)
  const end = (shift.end_time_override || shift.shift_templates?.end_time || '').slice(0, 5)
  let dayLabel = d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
  if (d.getTime() === today.getTime()) dayLabel = 'Today'
  if (d.getTime() === tomorrow.getTime()) dayLabel = 'Tomorrow'
  return `${dayLabel} · ${start} – ${end}`
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

  const { nextShift, shiftsThisWeek, hoursThisWeek, pendingSwapsForMe, myPendingTimeOff, unreadInbox } = res.data

  return (
    <>
      {nextShift ? (
        <div className="bg-un1t-white rounded-2xl p-5 mb-4 max-w-2xl">
          <div className="text-xs uppercase tracking-wider text-un1t-mid">Your next shift</div>
          <div className="text-xl font-bold text-un1t-black mt-1">
            {nextShift.shift_templates?.name || 'Shift'}
          </div>
          <div className="text-sm text-un1t-light mt-0.5">{formatShiftWhen(nextShift)}</div>
        </div>
      ) : (
        <div className="bg-un1t-dark border border-un1t-gray rounded-2xl p-5 mb-4 max-w-2xl">
          <div className="text-xs uppercase tracking-wider text-un1t-light">Your next shift</div>
          <div className="text-base text-un1t-white mt-1">No upcoming shifts this week.</div>
        </div>
      )}

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
