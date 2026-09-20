// "Studio" — operational dashboard for managers + head coaches.
// Gated by permissions.mobile.dashboard_studio.
//
// Focus: leads coming in, members in the funnel, things needing
// approval. Deliberately no financial data — that lives on the
// Business dashboard which is owner-only.

import { View, Text, ActivityIndicator } from 'react-native'
import { useState, useEffect, useCallback } from 'react'
import { useRouter, useFocusEffect } from 'expo-router'
import { useAuth } from '../../lib/auth-context'
import { fetchStudioDashboard, swapRowTitle } from '../../lib/dashboard-api'
// COVERLOOP.2 — pending rows open the approval itself (the same place the
// manager pushes go), and a swap row says when the shift is.
import { teamApprovalRoute } from '../../lib/notification-nav'
import { swapShiftWhen } from '../../lib/swap-cards'
import {
  KpiCard, KpiRow, SectionHeader, PendingRow, ListCard,
} from './cards'
import RosterRunwayChip from './RosterRunwayChip'

// Friendlier labels for the pipeline_stage_slug values than the raw
// snake_case the DB stores. Anything not in the map falls back to a
// title-cased version of the key.
const STATUS_LABEL = {
  new_lead: 'New leads',
  first_class: '1st Class Completed',
  second_class: '2nd Class Completed',
  trial_done: 'Trial done',
  converted: 'Converted',
  member: 'Members',
  pack_member: 'Class Pack',
  classpass: 'ClassPass',
  cold_lead: 'Cold',
  dormant: 'Dormant',
  unknown: 'Other',
}

function pretty(key) {
  return STATUS_LABEL[key] ||
    key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

export default function StudioDashboard({ refreshKey }) {
  const { activeLocation } = useAuth()
  const router = useRouter()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!activeLocation) return
    const res = await fetchStudioDashboard(activeLocation.id)
    if (res.success) setData(res.data)
  }, [activeLocation])

  useEffect(() => {
    setLoading(true)
    load().finally(() => setLoading(false))
  }, [load, refreshKey])

  // Re-fetch when the Home tab regains focus so the funnel + pending counts
  // reflect changes made elsewhere (or a "View as user" switch) without a
  // manual pull-to-refresh.
  useFocusEffect(useCallback(() => { load() }, [load]))

  if (loading || !data) {
    return (
      <View className="py-8 items-center">
        <ActivityIndicator />
      </View>
    )
  }

  const {
    newLeadsThisWeek, funnel, totalContacts,
    totalUnreadWhatsapp,
  } = data
  // STUDIODASH.1 — null = the list couldn't be read (see dashboard-api.js).
  // Say so; an empty card would claim nothing is pending.
  const timeOffFailed = data.pendingTimeOff == null
  const swapsFailed = data.pendingSwaps == null
  const pendingTimeOff = data.pendingTimeOff || []
  const pendingSwaps = data.pendingSwaps || []
  const LOAD_FAILED = "Couldn't load this list. Pull down to retry."

  // Funnel display: pull the headline statuses to a 2x2 grid; everything
  // else is rolled into the contact total. FUNNEL.1 taxonomy — the old
  // keys (active_trial / active_member / lapsed) no longer exist.
  const headlineStatuses = ['new_lead', 'first_class', 'trial_done', 'converted']
  const headline = headlineStatuses.map(k => ({ key: k, count: funnel[k] || 0 }))

  return (
    <View>
      {/* RUNWAY.1 — an upcoming week that is not built or not published.
          Draws nothing when data.rosterRunway is null (ready, not a manager
          here, or the read failed). */}
      <RosterRunwayChip runway={data.rosterRunway} />
      <KpiRow>
        <KpiCard
          label="New leads this week"
          value={newLeadsThisWeek}
          sublabel={newLeadsThisWeek === 1 ? 'contact added' : 'contacts added'}
        />
        <KpiCard
          label="WhatsApp unread"
          value={totalUnreadWhatsapp}
          sublabel="across the inbox"
          accent={totalUnreadWhatsapp > 0 ? 'text-un1t-text' : 'text-un1t-muted'}
          onPress={totalUnreadWhatsapp > 0 ? () => router.push('/(tabs)/whatsapp') : undefined}
        />
      </KpiRow>

      {/* Funnel */}
      <SectionHeader title="Funnel" />
      <View style={{ rowGap: 12 }}>
        <KpiRow>
          <KpiCard label={pretty(headline[0].key)} value={headline[0].count} />
          <KpiCard label={pretty(headline[1].key)} value={headline[1].count} />
        </KpiRow>
        <KpiRow>
          <KpiCard label={pretty(headline[2].key)} value={headline[2].count} />
          <KpiCard label={pretty(headline[3].key)} value={headline[3].count} />
        </KpiRow>
      </View>
      <Text className="text-xs text-un1t-muted mt-1 px-1">
        {totalContacts} total contacts at {activeLocation?.name || 'this location'}
      </Text>

      {/* Approvals queue — time off */}
      <SectionHeader title="Time-off awaiting your call" count={pendingTimeOff.length} />
      <ListCard empty={pendingTimeOff.length === 0} emptyText={timeOffFailed ? LOAD_FAILED : 'Nothing waiting on you.'}>
        {pendingTimeOff.slice(0, 5).map((t, i, arr) => (
          <PendingRow
            key={t.id}
            icon="calendar-outline"
            title={`${t.profiles?.full_name || 'Someone'} · ${t.type}`}
            subtitle={t.start_date === t.end_date ? t.start_date : `${t.start_date} – ${t.end_date} (${t.total_days}d)`}
            onPress={() => router.push(teamApprovalRoute(t.id))}
            isLast={i === Math.min(arr.length, 5) - 1}
          />
        ))}
      </ListCard>

      {/* Approvals queue — swaps */}
      <SectionHeader title="Swaps awaiting your call" count={pendingSwaps.length} />
      <ListCard empty={pendingSwaps.length === 0} emptyText={swapsFailed ? LOAD_FAILED : 'No swaps to review.'}>
        {pendingSwaps.slice(0, 5).map((s, i, arr) => (
          <PendingRow
            key={s.id}
            icon="swap-horizontal"
            title={swapRowTitle(s)}
            subtitle={swapShiftWhen(s.requester_shift) || `Posted ${new Date(s.created_at).toLocaleDateString()}`}
            onPress={() => router.push(teamApprovalRoute(s.id))}
            isLast={i === Math.min(arr.length, 5) - 1}
          />
        ))}
      </ListCard>
    </View>
  )
}
