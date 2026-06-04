// "Business" — owner-level dashboard. Pipeline, realised value,
// scheduled labour. Sourced entirely from existing CRM data — no
// Glofox / Stripe ingestion required.
//
// Gated by permissions.mobile.dashboard_business (default: owner only).

import { View, Text, ActivityIndicator } from 'react-native'
import { useState, useEffect, useCallback } from 'react'
import { useFocusEffect } from 'expo-router'
import { useAuth } from '../../lib/auth-context'
import { fetchBusinessDashboard } from '../../lib/dashboard-api'
import {
  KpiCard, KpiRow, SectionHeader, formatCurrency, formatPercent,
} from './cards'

export default function BusinessDashboard({ refreshKey }) {
  const { activeLocation } = useAuth()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!activeLocation) return
    const res = await fetchBusinessDashboard(activeLocation.id)
    if (res.success) setData(res.data)
  }, [activeLocation])

  useEffect(() => {
    setLoading(true)
    load().finally(() => setLoading(false))
  }, [load, refreshKey])

  // Re-fetch when the Home tab regains focus so the pipeline + revenue KPIs
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
    openPipelineValue, openDealCount,
    wonValueMTD, wonCountMTD, lostCountMTD, winRatePercent,
    scheduledHoursThisWeek, scheduledLabourThisWeek,
  } = data

  return (
    <View>
      <SectionHeader title="Pipeline" />
      <KpiRow>
        <KpiCard
          label="Open value"
          value={formatCurrency(openPipelineValue)}
          sublabel={`${openDealCount} open deal${openDealCount === 1 ? '' : 's'}`}
        />
        <KpiCard
          label="Won this month"
          value={formatCurrency(wonValueMTD)}
          sublabel={`${wonCountMTD} deal${wonCountMTD === 1 ? '' : 's'}`}
          accent="text-green-600"
        />
      </KpiRow>
      <KpiRow>
        <KpiCard
          label="Lost this month"
          value={lostCountMTD}
          sublabel={lostCountMTD === 1 ? 'deal' : 'deals'}
          accent={lostCountMTD > 0 ? 'text-red-500' : 'text-un1t-muted'}
        />
        <KpiCard
          label="Win rate"
          value={formatPercent(winRatePercent)}
          sublabel={
            winRatePercent == null
              ? 'no decided deals yet'
              : `${wonCountMTD} won / ${lostCountMTD} lost`
          }
        />
      </KpiRow>

      <SectionHeader title="Scheduled labour" />
      <KpiRow>
        <KpiCard
          label="Hours this week"
          value={`${scheduledHoursThisWeek}h`}
          sublabel={`at ${activeLocation?.name || 'this location'}`}
        />
        <KpiCard
          label="Labour cost (est.)"
          value={formatCurrency(scheduledLabourThisWeek)}
          sublabel="excludes overtime premium"
        />
      </KpiRow>
      <Text className="text-xs text-un1t-muted mt-1 px-1">
        Cost is a base estimate from each staffer&apos;s contract / hourly rate.
        The full payroll report (including overtime, NI, etc.) lives in the web app.
      </Text>
    </View>
  )
}
