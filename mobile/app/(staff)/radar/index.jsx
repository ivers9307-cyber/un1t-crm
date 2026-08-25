// MOBILE-RADAR — read-only radar glance.
//
// A headline-numbers view of the churn + lead radars, reached from the
// More tab. Read-only by design: the scored member/contact lists and
// every triage action (win-back, quarantine, cleanup) stay on the web
// radar. This screen shows the summary counts, the week-over-week
// trend (once the weekly snapshot crons have run), and the outreach /
// follow-up effectiveness lines.
//
// Each section renders only if the signed-in user has the matching
// mobile permission (.mobile.churn_radar / .mobile.lead_radar). The
// More-tab row that routes here is gated on the same pair, so at least
// one section is always present when this screen opens.

import { useState, useEffect, useCallback } from 'react'
import {
  View, Text, ScrollView, RefreshControl, ActivityIndicator,
} from 'react-native'
import { Stack } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useAuth } from '../../../lib/auth-context'
import { canMobile } from '../../../lib/permissions'
import { fetchRadarGlance } from '../../../lib/radar-api'
import BackHeaderLeft from '../../../components/BackHeaderLeft'

// Whole euros — the glance never needs cent precision.
function fmtMoney(cents) {
  return `€${Math.round((Number(cents) || 0) / 100).toLocaleString('en-IE')}`
}

function fmtCount(n) {
  return String(Number(n) || 0)
}

// One metric row spec: how to read + colour each line.
//   goodDir: 'up' | 'down' | null — which delta direction is "good"
//   money:   format the value + delta as euros
const CHURN_ROWS = [
  { label: 'Active base',     key: 'activeBase',         goodDir: 'up'   },
  { label: 'At risk',        key: 'atRisk',             goodDir: 'down' },
  { label: 'High risk',      key: 'highRisk',           goodDir: 'down' },
  { label: 'Overdue',        key: 'overdue',            goodDir: 'down' },
  { label: 'Paused',         key: 'paused',             goodDir: null   },
  { label: 'Quarantine',     key: 'quarantine',         goodDir: 'down' },
  { label: 'Revenue at risk', key: 'revenueAtRiskCents', goodDir: 'down', money: true },
  { label: 'Overdue value',  key: 'overdueValueCents',  goodDir: 'down', money: true },
]

const LEAD_ROWS = [
  { label: 'Funnel total',  key: 'funnelTotal',  goodDir: null },
  { label: 'Attending',    key: 'attending',    goodDir: 'up' },
  { label: 'Fresh leads',  key: 'fresh',        goodDir: 'up' },
  { label: 'Cleanup queue', key: 'cleanupTotal', goodDir: 'down' },
]

// ▲ / ▼ delta vs last week. Green when the move is in the good
// direction, red when bad, grey when the metric has no good direction
// or hasn't moved. Null trend (no snapshot yet) renders nothing.
function TrendDelta({ delta, goodDir, money }) {
  if (delta == null || !Number.isFinite(delta)) return null
  if (delta === 0) {
    return <Text className="text-[11px] text-un1t-muted mt-0.5">— no change</Text>
  }
  const up = delta > 0
  const good = goodDir && ((up && goodDir === 'up') || (!up && goodDir === 'down'))
  const bad = goodDir && !good
  const color = good ? 'text-emerald-600' : bad ? 'text-red-500' : 'text-un1t-muted'
  const mag = money ? fmtMoney(Math.abs(delta)) : Math.abs(delta)
  return (
    <Text className={`text-[11px] mt-0.5 ${color}`}>
      {up ? '▲' : '▼'} {mag} vs last wk
    </Text>
  )
}

function StatRow({ label, value, delta, goodDir, money, isLast }) {
  return (
    <View
      className={`flex-row items-center justify-between px-4 py-3 ${
        !isLast ? 'border-b border-un1t-border' : ''
      }`}
    >
      <Text className="text-sm text-un1t-subtle flex-1">{label}</Text>
      <View className="items-end">
        <Text className="text-base font-semibold text-un1t-text">{value}</Text>
        <TrendDelta delta={delta} goodDir={goodDir} money={money} />
      </View>
    </View>
  )
}

function RadarCard({ icon, title, subtitle, children }) {
  return (
    <View className="mb-6">
      <View className="flex-row items-center px-1 mb-2">
        <Ionicons name={icon} size={16} color="#94A3B8" style={{ marginRight: 6 }} />
        <Text className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle">
          {title}
        </Text>
      </View>
      {subtitle && (
        <Text className="text-xs text-un1t-muted px-1 mb-2">{subtitle}</Text>
      )}
      <View className="bg-un1t-surface border border-un1t-border rounded-2xl overflow-hidden">
        {children}
      </View>
    </View>
  )
}

function EffectivenessLine({ text }) {
  return (
    <View className="px-4 py-3 border-t border-un1t-border bg-un1t-border/20">
      <Text className="text-xs text-un1t-subtle">{text}</Text>
    </View>
  )
}

export default function RadarGlance() {
  const { activeLocation, profile } = useAuth()
  const canChurn = !!profile && canMobile(profile, 'churn_radar', activeLocation)
  const canLead = !!profile && canMobile(profile, 'lead_radar', activeLocation)

  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    if (!activeLocation) return
    setError(null)
    const res = await fetchRadarGlance({ locationId: activeLocation.id })
    if (!res.success) {
      setError(res.error || 'Failed to load the radar')
      setData(null)
      return
    }
    setData(res.data || { churn: null, lead: null })
  }, [activeLocation])

  useEffect(() => {
    setLoading(true)
    load().finally(() => setLoading(false))
  }, [load])

  async function onRefresh() {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }

  const churn = data?.churn || null
  const lead = data?.lead || null

  return (
    <View className="flex-1 bg-un1t-bg">
      {/* radar/ is a single-screen sub-stack pushed from /more, so
          iOS won't auto-render a back chevron — opt in. */}
      <Stack.Screen
        options={{
          title: 'Radar',
          headerLeft: () => <BackHeaderLeft label="More" fallbackHref="/(tabs)/more" />,
        }}
      />

      <ScrollView
        contentContainerClassName="px-4 pt-4 pb-10"
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#111827" />
        }
      >
        {error && (
          <View className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 mb-3">
            <Text className="text-red-500 text-sm">{error}</Text>
          </View>
        )}

        {loading ? (
          <View className="py-16 items-center">
            <ActivityIndicator />
          </View>
        ) : (
          <>
            {churn && (
              <RadarCard
                icon="pulse-outline"
                title="Churn radar"
                subtitle="At-risk members across the active base."
              >
                {CHURN_ROWS.map((r, i) => (
                  <StatRow
                    key={r.key}
                    label={r.label}
                    value={r.money ? fmtMoney(churn[r.key]) : fmtCount(churn[r.key])}
                    delta={churn.trend?.deltas?.[r.key]}
                    goodDir={r.goodDir}
                    money={r.money}
                    isLast={i === CHURN_ROWS.length - 1 && !churn.recovery?.contacted}
                  />
                ))}
                {churn.recovery?.contacted > 0 && (
                  <EffectivenessLine
                    text={`Outreach: ${churn.recovery.recovered} of ${churn.recovery.contacted} members contacted in the last 90 days came back training (${Math.round((churn.recovery.recoveryRate || 0) * 100)}%).`}
                  />
                )}
              </RadarCard>
            )}

            {data?.churnError && canChurn && (
              <View className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-3 mb-6">
                <Text className="text-amber-700 text-xs">
                  Churn radar could not be loaded right now. Pull down to retry.
                </Text>
              </View>
            )}

            {lead && (
              <RadarCard
                icon="trending-up-outline"
                title="Lead radar"
                subtitle="Non-member funnel worth a follow-up."
              >
                {LEAD_ROWS.map((r, i) => (
                  <StatRow
                    key={r.key}
                    label={r.label}
                    value={fmtCount(lead[r.key])}
                    delta={lead.trend?.deltas?.[r.key]}
                    goodDir={r.goodDir}
                    isLast={i === LEAD_ROWS.length - 1 && !lead.conversion?.contacted}
                  />
                ))}
                {lead.conversion?.contacted > 0 && (
                  <EffectivenessLine
                    text={`Follow-ups: ${lead.conversion.progressed} of ${lead.conversion.contacted} leads contacted in the last 90 days booked or attended afterwards (${Math.round((lead.conversion.progressionRate || 0) * 100)}%).`}
                  />
                )}
              </RadarCard>
            )}

            {data?.leadError && canLead && (
              <View className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-3 mb-6">
                <Text className="text-amber-700 text-xs">
                  Lead radar could not be loaded right now. Pull down to retry.
                </Text>
              </View>
            )}

            {!churn && !lead && !error && (
              <View className="py-16 items-center px-6">
                <Ionicons name="radio-outline" size={32} color="#94A3B8" />
                <Text className="text-base font-semibold text-un1t-text mt-3">
                  Nothing to show
                </Text>
                <Text className="text-xs text-un1t-subtle text-center mt-1">
                  The radar has no data for this location yet.
                </Text>
              </View>
            )}

            {(churn || lead) && (
              <Text className="text-xs text-un1t-muted text-center mt-1 px-4">
                Read-only glance. Open the radar on the web to contact members,
                run win-backs or triage the cleanup list.
              </Text>
            )}
          </>
        )}
      </ScrollView>
    </View>
  )
}
