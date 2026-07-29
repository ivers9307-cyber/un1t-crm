// "Business" — owner-level command centre. Mobile mirror of the
// rebuilt web /dashboard/business (DASH-REBUILD): briefing line, four
// headline KPIs (Revenue MTD / Members / Churn risk / In arrears),
// "Needs you" rail, acquisition funnel + ads-7d, membership live
// breakdown + 12-month trend, today-ops strip. Block order follows the
// web page's narrow-viewport order (the rail is `order-first` there).
//
// Data comes from ONE authenticated JSON route (/api/dashboard/business
// via fetchBusinessCommandCentre) — no mobile-direct Supabase selects
// on this screen. The route mirrors the page's per-block failure
// isolation: a failed block arrives as null and renders a compact
// error cell instead of blanking the segment.
//
// The old pipeline/labour cards are gone: pipeline detail lives in the
// Pipeline tab, and the labour estimate is carried by the today-ops
// strip — same rationale as the web rebuild.
//
// Gated by permissions.dashboard_business (top-level key, shared with
// the web page; segment filtering happens in (tabs)/index.jsx).

import { View, Text, Pressable, ActivityIndicator } from 'react-native'
import { useState, useEffect, useCallback } from 'react'
import { useRouter, useFocusEffect } from 'expo-router'
import { useAuth } from '../../lib/auth-context'
import { fetchBusinessCommandCentre } from '../../lib/dashboard-api'
import { KpiCard, KpiRow, SectionHeader, formatCurrency } from './cards'

// ---------------------------------------------------------------------------
// Small presentational pieces (mirrors of src/components/dashboard/
// BusinessBlocks.jsx, rendered with plain Views — no chart lib).

function BlockError({ label }) {
  return (
    <View className="bg-un1t-surface border border-un1t-border rounded-2xl px-4 py-3 mb-3">
      <Text className="text-xs text-un1t-muted">{label} couldn&apos;t load — pull to refresh.</Text>
    </View>
  )
}

function BriefingLine({ text }) {
  return (
    <View className="bg-un1t-surface border border-un1t-border rounded-2xl px-4 py-3 mb-3">
      <Text className="text-sm text-un1t-text">{text}</Text>
    </View>
  )
}

// Same labels as the web FunnelMini.
const FUNNEL_LABELS = {
  new_lead: 'New', first_class: '1st', second_class: '2nd', trial_done: 'Trial', converted: 'Won',
}

function FunnelMini({ funnel, onOpenPipeline }) {
  const max = Math.max(1, ...funnel.stages.map(s => s.count))
  return (
    <View>
      <View className="flex-row items-end" style={{ columnGap: 6, height: 80 }}>
        {funnel.stages.map(s => (
          <View key={s.slug} className="flex-1 items-center justify-end" style={{ rowGap: 4 }}>
            <Text className="text-[10px] text-un1t-muted">{s.count}</Text>
            <View
              className="w-full rounded-t bg-purple-500/60"
              style={{ height: Math.max(6, (s.count / max) * 60) }}
            />
            <Text className="text-[10px] text-un1t-subtle">{FUNNEL_LABELS[s.slug] || s.slug}</Text>
          </View>
        ))}
      </View>
      <Text className="text-xs text-un1t-muted mt-2">
        {funnel.entered} entered this month → {funnel.converted} converted
        {funnel.conversionPct != null ? ` · ${funnel.conversionPct}%` : ''}
      </Text>
      <Pressable onPress={onOpenPipeline} className="mt-2 active:opacity-70">
        <Text className="text-xs text-un1t-muted underline">Open pipeline</Text>
      </Pressable>
    </View>
  )
}

function AdsSummaryPanel({ ads }) {
  return (
    <View>
      <Text className="text-lg font-semibold text-un1t-text">
        €{Math.round(ads.spend).toLocaleString('en-IE')} spend · {ads.results} results
      </Text>
      <Text className="text-xs text-un1t-muted mt-1">
        {ads.costPerResult != null ? `€${ads.costPerResult.toFixed(2)} per result` : 'no results yet'}
        {' · '}{ads.attributedContacts} contact{ads.attributedContacts === 1 ? '' : 's'} attributed (7d)
      </Text>
    </View>
  )
}

// 12-month membership trend as stacked per-month columns — plain Views,
// three series over monthly snapshots. (The web panel moved on to a
// weekly sales-vs-cancellations chart in TREND-FLOWS.1; this mini
// keeps the monthly stacked view until mobile gets a flows chart.)
const TREND_SERIES = [
  { key: 'monthly_recurring', label: 'Monthly recurring', color: '#10b981' },
  { key: 'class_packs', label: 'Class packs', color: '#3b82f6' },
  { key: 'payg', label: 'Pay-as-you-go', color: '#a78bfa' },
]

function TrendMini({ trend }) {
  const totals = trend.map(m => TREND_SERIES.reduce((s, ser) => s + (m[ser.key] || 0), 0))
  const max = Math.max(1, ...totals)
  const CHART_H = 96
  return (
    <View>
      <View className="flex-row items-end" style={{ columnGap: 4, height: CHART_H }}>
        {trend.map(m => (
          <View key={m.month} className="flex-1 justify-end rounded-t overflow-hidden">
            {/* stacked top-to-bottom: payg, packs, recurring (recurring sits on the axis) */}
            {[...TREND_SERIES].reverse().map(ser => (
              <View
                key={ser.key}
                style={{
                  height: Math.round(((m[ser.key] || 0) / max) * (CHART_H - 8)),
                  backgroundColor: ser.color,
                }}
              />
            ))}
          </View>
        ))}
      </View>
      <View className="flex-row justify-between mt-1">
        <Text className="text-[10px] text-un1t-subtle">{trend[0].month}</Text>
        {trend.length > 1 ? (
          <Text className="text-[10px] text-un1t-subtle">{trend[trend.length - 1].month}</Text>
        ) : null}
      </View>
      <View className="flex-row flex-wrap mt-2" style={{ columnGap: 12, rowGap: 2 }}>
        {TREND_SERIES.map(ser => (
          <View key={ser.key} className="flex-row items-center" style={{ columnGap: 4 }}>
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: ser.color }} />
            <Text className="text-[10px] text-un1t-subtle">{ser.label}</Text>
          </View>
        ))}
      </View>
    </View>
  )
}

function TodayStrip({ ops, locationName }) {
  const items = [
    [String(ops.bookedToday), `booked · ${ops.classesToday} classes`],
    [String(ops.staffToday), 'staff on'],
    [`€${Math.round(ops.labourWeekCents / 100).toLocaleString('en-IE')}`, `labour this week · ${ops.hoursWeek}h`],
  ]
  return (
    <View className="bg-un1t-surface border border-un1t-border rounded-2xl px-4 py-3">
      <Text className="text-xs text-un1t-muted mb-1">
        Today{locationName ? ` at ${locationName}` : ''}
      </Text>
      <View className="flex-row flex-wrap" style={{ columnGap: 16, rowGap: 4 }}>
        {items.map(([v, label]) => (
          <Text key={label} className="text-sm text-un1t-text">
            <Text className="font-semibold">{v}</Text>
            <Text className="text-un1t-subtle"> {label}</Text>
          </Text>
        ))}
      </View>
    </View>
  )
}

// Rail chips — the light-theme recipe (bg-*-500/10 text-*-700), same
// tones as the web NeedsYouRail.
const RAIL_TONES = {
  purple: { bg: 'bg-purple-500/10', text: 'text-purple-700' },
  red: { bg: 'bg-red-500/10', text: 'text-red-700' },
  amber: { bg: 'bg-amber-500/10', text: 'text-amber-700' },
  teal: { bg: 'bg-teal-500/10', text: 'text-teal-700' },
}

// Rail key → mobile screen (the payload's href values are web paths).
// `failed` is deliberately null: the web target is a specific unified-
// inbox conversation, which has no clean mobile destination — the row
// renders informational, same convention as today-feed-nav.js.
const RAIL_ROUTES = {
  approvals: '/approvals',
  arrears: '/radar',
  churn: '/radar',
  leads: '/radar',
}

function NeedsYouRail({ rows, onNavigate }) {
  return (
    <View className="mb-3">
      <SectionHeader title="Needs you" count={rows.length} />
      <View className="bg-un1t-surface border border-un1t-border rounded-2xl px-3 py-1">
        {rows.length === 0 ? (
          <Text className="text-sm text-un1t-subtle py-2">Nothing waiting on you.</Text>
        ) : null}
        {rows.map((row, i) => {
          const tone = RAIL_TONES[row.tone] || RAIL_TONES.purple
          const route = RAIL_ROUTES[row.key]
          return (
            <Pressable
              key={row.key}
              onPress={route ? () => onNavigate(route) : undefined}
              className={`flex-row items-start py-2.5 ${i > 0 ? 'border-t border-un1t-border/50' : ''} ${route ? 'active:opacity-70' : ''}`}
              style={{ columnGap: 8 }}
            >
              <View className={`px-1.5 py-0.5 rounded-full mt-0.5 ${tone.bg}`}>
                <Text className={`text-[10px] font-semibold ${tone.text}`}>{row.chip}</Text>
              </View>
              <Text className="text-sm text-un1t-text flex-1">{row.text}</Text>
            </Pressable>
          )
        })}
      </View>
    </View>
  )
}

// A titled panel card (funnel / ads containers on web).
function PanelCard({ title, children }) {
  return (
    <View className="bg-un1t-surface border border-un1t-border rounded-2xl px-4 py-3 mb-3">
      <Text className="text-xs text-un1t-muted mb-2">{title}</Text>
      {children}
    </View>
  )
}

// ---------------------------------------------------------------------------

export default function BusinessDashboard({ refreshKey }) {
  const { activeLocation } = useAuth()
  const router = useRouter()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    if (!activeLocation) return
    const res = await fetchBusinessCommandCentre({ locationId: activeLocation.id })
    if (res.success) {
      setData(res.data)
      setError(null)
    } else if (res.error) {
      setError(res.error)
    }
  }, [activeLocation])

  useEffect(() => {
    setLoading(true)
    load().finally(() => setLoading(false))
  }, [load, refreshKey])

  // Re-fetch when the Home tab regains focus so the KPIs reflect
  // changes made elsewhere (or a "View as user" switch) without a
  // manual pull-to-refresh.
  useFocusEffect(useCallback(() => { load() }, [load]))

  if (loading && !data) {
    return (
      <View className="py-8 items-center">
        <ActivityIndicator />
      </View>
    )
  }

  if (!data) {
    return (
      <View className="bg-un1t-surface border border-un1t-border rounded-2xl p-4">
        <Text className="text-sm text-un1t-subtle">
          Business dashboard couldn&apos;t load{error ? ` (${error})` : ''} — pull to refresh.
        </Text>
      </View>
    )
  }

  const { locationName, kpis, funnel, ads, membership, today, rail } = data

  return (
    <View>
      {/* Briefing + headline KPIs */}
      {kpis ? (
        <>
          <BriefingLine text={kpis.briefing} />
          <KpiRow>
            <KpiCard
              label="Revenue MTD"
              value={formatCurrency(kpis.revenue.totalCents / 100)}
              sublabel={kpis.revenue.deltaPct != null
                ? `${kpis.revenue.deltaPct >= 0 ? '+' : ''}${Math.round(kpis.revenue.deltaPct)}% vs last month`
                : `${kpis.revenue.paidCount} payments`}
            />
            <KpiCard
              label="Members"
              value={kpis.memberCount ?? '—'}
              sublabel={kpis.memberCount != null ? 'active recurring' : 'membership unavailable'}
              onPress={() => router.push('/contacts')}
            />
          </KpiRow>
          <KpiRow>
            <KpiCard
              label="Churn risk"
              value={kpis.churnCount ?? '—'}
              sublabel={kpis.churnCount == null
                ? 'radar unavailable'
                : (kpis.churnDelta > 0 ? `+${kpis.churnDelta} this week` : 'high-risk members')}
              accent={kpis.churnCount ? 'text-amber-700' : undefined}
              onPress={() => router.push('/radar')}
            />
            <KpiCard
              label="In arrears"
              value={kpis.arrearsData ? formatCurrency(kpis.arrearsData.totalCents / 100) : '—'}
              sublabel={kpis.arrearsData
                ? `${kpis.arrearsData.memberCount} member${kpis.arrearsData.memberCount === 1 ? '' : 's'}`
                : 'arrears unavailable'}
              accent={kpis.arrearsData?.memberCount > 0 ? 'text-red-700' : undefined}
              onPress={() => router.push('/radar')}
            />
          </KpiRow>
        </>
      ) : <BlockError label="Headline numbers" />}

      {/* "Needs you" rail — first after the KPIs, like the web page's
          narrow-viewport order. null = block failed; [] = all clear. */}
      {rail ? <NeedsYouRail rows={rail} onNavigate={route => router.push(route)} />
        : <BlockError label="Needs you" />}

      {/* Funnel + ads */}
      <PanelCard title="Acquisition funnel · this month">
        {funnel
          ? <FunnelMini funnel={funnel} onOpenPipeline={() => router.push('/(tabs)/pipeline')} />
          : <Text className="text-xs text-un1t-muted">Funnel couldn&apos;t load — pull to refresh.</Text>}
      </PanelCard>
      <PanelCard title="Ads · last 7 days">
        {ads
          ? <AdsSummaryPanel ads={ads} />
          : <Text className="text-xs text-un1t-muted">Ads couldn&apos;t load — pull to refresh.</Text>}
      </PanelCard>

      {/* Membership — live breakdown + 12-month trend */}
      {membership ? (
        <>
          <SectionHeader title="Membership" />
          <KpiRow>
            <KpiCard
              label="Monthly recurring"
              value={membership.live.monthly_recurring ?? 0}
              sublabel={`${membership.live.active_recurring ?? 0} active subscriptions`}
            />
            <KpiCard
              label="Class packs"
              value={membership.live.class_packs ?? 0}
              sublabel={`${membership.live.dead_packs ?? 0} with no credits left`}
              accent={(membership.live.dead_packs ?? 0) > 0 ? 'text-amber-700' : undefined}
            />
          </KpiRow>
          <KpiRow>
            <KpiCard
              label="Pay-as-you-go"
              value={membership.live.payg ?? 0}
              sublabel="drop-in credit buyers"
            />
            <KpiCard
              label="Total members"
              value={membership.live.total_members ?? 0}
              sublabel="all Glofox member records"
            />
          </KpiRow>
          <PanelCard title="Membership trend (12 months)">
            {Array.isArray(membership.trend) && membership.trend.length > 0 ? (
              <TrendMini trend={membership.trend} />
            ) : (
              <Text className="text-sm text-un1t-muted py-4 text-center">
                Trend starts building from the first monthly snapshot.
              </Text>
            )}
          </PanelCard>
        </>
      ) : <BlockError label="Membership trend" />}

      {/* Today ops strip */}
      {today
        ? <TodayStrip ops={today} locationName={locationName || activeLocation?.name} />
        : <BlockError label="Today's operations" />}
    </View>
  )
}
