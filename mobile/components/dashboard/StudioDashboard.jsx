// "Studio" — operational dashboard for managers + head coaches.
// Gated by permissions.mobile.dashboard_studio.
//
// Focus: leads coming in, members in the funnel, things needing
// approval. Deliberately no financial data — that lives on the
// Business dashboard which is owner-only.

import { View, Text, ActivityIndicator } from 'react-native'
import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'expo-router'
import { useAuth } from '../../lib/auth-context'
import { fetchStudioDashboard } from '../../lib/dashboard-api'
import {
  KpiCard, KpiRow, SectionHeader, PendingRow, ListCard,
} from './cards'

// Friendlier labels for the pipeline_stage_slug values than the raw
// snake_case the DB stores. Anything not in the map falls back to a
// title-cased version of the key.
const STATUS_LABEL = {
  new_lead: 'New leads',
  active_trial: 'On trial',
  hot_conversion: 'Hot conversion',
  active_member: 'Members',
  at_risk_member: 'At risk',
  classpass_active: 'ClassPass',
  lapsed: 'Lapsed',
  dormant: 'Dormant',
  dormant_classpass: 'Dormant CP',
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

  if (loading || !data) {
    return (
      <View className="py-8 items-center">
        <ActivityIndicator />
      </View>
    )
  }

  const {
    pendingTimeOff, pendingSwaps,
    newLeadsThisWeek, funnel, totalContacts,
    totalUnreadWhatsapp,
  } = data

  // Funnel display: pull the headline statuses to a 2x2 grid; everything
  // else is rolled into the contact total.
  const headlineStatuses = ['new_lead', 'active_trial', 'active_member', 'lapsed']
  const headline = headlineStatuses.map(k => ({ key: k, count: funnel[k] || 0 }))

  return (
    <View>
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
          accent={totalUnreadWhatsapp > 0 ? 'text-un1t-white' : 'text-un1t-mid'}
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
      <Text className="text-xs text-un1t-mid mt-1 px-1">
        {totalContacts} total contacts at {activeLocation?.name || 'this location'}
      </Text>

      {/* Approvals queue — time off */}
      <SectionHeader title="Time-off awaiting your call" count={pendingTimeOff.length} />
      <ListCard empty={pendingTimeOff.length === 0} emptyText="Nothing waiting on you.">
        {pendingTimeOff.slice(0, 5).map((t, i, arr) => (
          <PendingRow
            key={t.id}
            icon="calendar-outline"
            title={`${t.profiles?.full_name || 'Someone'} · ${t.type}`}
            subtitle={t.start_date === t.end_date ? t.start_date : `${t.start_date} – ${t.end_date} (${t.total_days}d)`}
            onPress={() => router.push('/(tabs)/schedule')}
            isLast={i === Math.min(arr.length, 5) - 1}
          />
        ))}
      </ListCard>

      {/* Approvals queue — swaps */}
      <SectionHeader title="Swap requests pending" count={pendingSwaps.length} />
      <ListCard empty={pendingSwaps.length === 0} emptyText="No swaps to review.">
        {pendingSwaps.slice(0, 5).map((s, i, arr) => (
          <PendingRow
            key={s.id}
            icon="swap-horizontal"
            title={`${s.requester?.full_name || 'Someone'} requested a swap`}
            subtitle={`Posted ${new Date(s.created_at).toLocaleDateString()}`}
            onPress={() => router.push('/(tabs)/schedule')}
            isLast={i === Math.min(arr.length, 5) - 1}
          />
        ))}
      </ListCard>
    </View>
  )
}
