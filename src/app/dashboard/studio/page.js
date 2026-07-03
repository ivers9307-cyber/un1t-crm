// /dashboard/studio — Studio dashboard. Operations view for managers
// and head coaches. Same data as the mobile StudioDashboard.

import { redirect } from 'next/navigation'
import { Calendar, ArrowLeftRight } from 'lucide-react'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { fetchStudioDashboardData } from '@shared/dashboard-data'
import {
  KpiCard, KpiRow, SectionHeader, ListCard, PendingRow,
} from '@/components/dashboard/Cards'

export const dynamic = 'force-dynamic'

const STATUS_LABEL = {
  new_lead: 'New leads',
  first_class: '1st class',
  second_class: '2nd class',
  trial_done: 'Trial done',
  converted: 'Converted',
  member: 'Members',
  classpass: 'ClassPass',
  dormant: 'Dormant',
  unknown: 'Other',
}

function pretty(key) {
  return STATUS_LABEL[key] ||
    key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

export default async function StudioDashboardPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!hasPermission(user, 'dashboard_studio')) redirect('/dashboard')

  const db = createServerClient()
  const res = await fetchStudioDashboardData(db, user.activeLocation?.id)
  if (!res.success) {
    return <p className="text-sm text-red-500">Failed to load dashboard: {res.error}</p>
  }
  const {
    pendingTimeOff, pendingSwaps,
    newLeadsThisWeek, funnel, totalContacts,
    totalUnreadWhatsapp,
  } = res.data

  // Funnel is keyed by pipeline_stage_slug (FUNNEL.1 taxonomy): the four
  // tiles an operator glances at — top of funnel, first engagement, the
  // decision point, wins. The old keys (active_trial / active_member /
  // lapsed) stop existing after the cutover reclassify.
  const headlineStatuses = ['new_lead', 'first_class', 'trial_done', 'converted']
  const headline = headlineStatuses.map(k => ({ key: k, count: funnel[k] || 0 }))

  return (
    <>
      <KpiRow>
        <KpiCard
          label="New leads this week"
          value={newLeadsThisWeek}
          sublabel={newLeadsThisWeek === 1 ? 'contact added' : 'contacts added'}
          href="/dashboard/lead-radar"
        />
        <KpiCard
          label="WhatsApp unread"
          value={totalUnreadWhatsapp}
          sublabel="across the inbox"
          accent={totalUnreadWhatsapp > 0 ? 'text-un1t-text' : 'text-un1t-muted'}
          href={totalUnreadWhatsapp > 0 ? '/whatsapp' : undefined}
        />
      </KpiRow>

      <SectionHeader title="Funnel" />
      <KpiRow>
        <KpiCard label={pretty(headline[0].key)} value={headline[0].count} href={`/contacts?status=${headline[0].key}`} />
        <KpiCard label={pretty(headline[1].key)} value={headline[1].count} href={`/contacts?status=${headline[1].key}`} />
      </KpiRow>
      <KpiRow>
        <KpiCard label={pretty(headline[2].key)} value={headline[2].count} href={`/contacts?status=${headline[2].key}`} />
        <KpiCard label={pretty(headline[3].key)} value={headline[3].count} href={`/contacts?status=${headline[3].key}`} />
      </KpiRow>
      <p className="text-xs text-un1t-muted mt-1 px-1">
        {totalContacts} total contacts at {user.activeLocation?.name || 'this location'}
      </p>

      <SectionHeader title="Time-off awaiting your call" count={pendingTimeOff.length} />
      <ListCard empty={pendingTimeOff.length === 0} emptyText="Nothing waiting on you.">
        {pendingTimeOff.slice(0, 8).map((t, i, arr) => (
          <PendingRow
            key={t.id}
            icon={<Calendar size={16} />}
            title={`${t.profiles?.full_name || 'Someone'} · ${t.type}`}
            subtitle={t.start_date === t.end_date ? t.start_date : `${t.start_date} – ${t.end_date} (${t.total_days}d)`}
            href="/schedule"
            isLast={i === Math.min(arr.length, 8) - 1}
          />
        ))}
      </ListCard>

      <SectionHeader title="Swap requests pending" count={pendingSwaps.length} />
      <ListCard empty={pendingSwaps.length === 0} emptyText="No swaps to review.">
        {pendingSwaps.slice(0, 8).map((s, i, arr) => (
          <PendingRow
            key={s.id}
            icon={<ArrowLeftRight size={16} />}
            title={`${s.requester?.full_name || 'Someone'} requested a swap`}
            subtitle={`Posted ${new Date(s.created_at).toLocaleDateString()}`}
            href="/schedule"
            isLast={i === Math.min(arr.length, 8) - 1}
          />
        ))}
      </ListCard>
    </>
  )
}
