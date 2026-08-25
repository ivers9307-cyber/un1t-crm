// InBody detail — body-composition trends for the signed-in member.
//
// Pushed from the Coaching hub's "View trends ›". Everything reads from
// inbody_scans via the member's RLS-scoped client (inbody_scans_self):
//
//   • Hero ring   — InBody score on a track (react-native-svg arc), delta
//                   vs the previous scan, scanned date.
//   • 2×2 tiles   — Weight / Skeletal muscle / Body fat / BMI, each with a
//                   delta vs the previous scan (pearl accent when it's an
//                   improvement: weight↓, body-fat↓, muscle↑).
//   • Trend chart — react-native-svg line over the member's scans for a
//                   selected metric (Weight default), state-only toggles.
//   • Recent scans — the last few scans (date + score + a couple of stats).
//
// All series + deltas are computed client-side. The SVG line/sparkline
// pattern is borrowed from (tabs)/progress.jsx.

import { useState, useCallback, useMemo } from 'react'
import { View, Text, Pressable, ScrollView, ActivityIndicator, useWindowDimensions } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useFocusEffect, useRouter } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import Svg, { Circle, Polyline, Line } from 'react-native-svg'
import { supabase } from '../../../lib/member/supabase'
import Card from '../../../components/member/ui/Card'
import ErrorRetry from '../../../components/member/ErrorRetry'
import { PEARL, VOLT } from '../../../lib/member/brand'
import { METRICS } from 'shared/inbody'

const TRACK = '#24242A'       // ring/axis track (iron-raised)
const TEXT_2 = '#B3B2AC'      // muted

// ── Formatting ───────────────────────────────────────────────────────────────

const fmt1 = (v) => (Number.isFinite(Number(v)) ? Number(v).toFixed(1) : '—')
const fmtScore = (v) => (Number.isFinite(Number(v)) ? String(Math.round(Number(v))) : '—')
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null)

const fmtDate = (iso) => {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return ''
  return new Intl.DateTimeFormat('en-IE', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  }).format(new Date(t))
}

const fmtMonth = (iso) => {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return ''
  return new Intl.DateTimeFormat('en-IE', {
    month: 'short', timeZone: 'UTC',
  }).format(new Date(t))
}

// Trend-chart + bookend metric definitions live in shared/inbody.js (single
// source; `betterWhenLower` flips the improvement direction). Imported above.

export default function InBodyDetail() {
  const router = useRouter()
  const [loading, setLoading] = useState(true)
  const [scans, setScans] = useState([])
  const [error, setError] = useState(null)
  const [metricKey, setMetricKey] = useState('weight_kg')

  const load = useCallback(async () => {
    setError(null)
    try {
      const { data, error: err } = await supabase
        .from('inbody_scans')
        .select('scanned_at, weight_kg, pbf_percent, smm_kg, bmi, bmr, body_fat_mass_kg, inbody_score')
        .order('scanned_at', { ascending: false })
      if (err) throw err
      setScans(data || [])
    } catch (e) {
      setError(e?.message || 'Failed to load scans')
    } finally {
      setLoading(false)
    }
  }, [])

  useFocusEffect(
    useCallback(() => { load() }, [load])
  )

  // scans come back newest-first. latest = [0], previous = [1].
  const latest = scans[0] || null
  const previous = scans[1] || null

  if (loading) {
    return (
      <SafeAreaView className="flex-1 bg-iron-bg items-center justify-center" edges={['left', 'right']}>
        <ActivityIndicator color="#F1EEE7" size="large" />
      </SafeAreaView>
    )
  }

  if (error && scans.length === 0) {
    return (
      <SafeAreaView className="flex-1 bg-iron-bg" edges={['left', 'right']}>
        <ScrollView contentContainerClassName="p-5 pb-24">
          <Header onBack={() => router.back()} />
          <View className="mt-6">
            <ErrorRetry onPress={load} />
          </View>
        </ScrollView>
      </SafeAreaView>
    )
  }

  if (!latest) {
    return (
      <SafeAreaView className="flex-1 bg-iron-bg" edges={['left', 'right']}>
        <ScrollView contentContainerClassName="p-5 pb-24">
          <Header onBack={() => router.back()} />
          <Card className="mt-6 items-center py-8">
            <Ionicons name="body-outline" size={32} color="#727170" />
            <Text className="mt-3 text-base font-display text-chalk">No scans yet</Text>
            <Text className="mt-1 text-sm text-chalk-2 text-center">
              Ask a coach to scan you on the InBody — your trends and metrics
              will build up here as you go.
            </Text>
          </Card>
        </ScrollView>
      </SafeAreaView>
    )
  }

  return (
    <SafeAreaView className="flex-1 bg-iron-bg" edges={['left', 'right']}>
      <ScrollView contentContainerClassName="p-5 pb-24" showsVerticalScrollIndicator={false}>
        <Header onBack={() => router.back()} />

        <View className="mt-6">
          <ScoreHero latest={latest} previous={previous} />
        </View>

        <View className="mt-4">
          <MetricTiles latest={latest} previous={previous} />
        </View>

        <View className="mt-4">
          <TrendCard scans={scans} metricKey={metricKey} onChangeMetric={setMetricKey} />
        </View>

        <View className="mt-4">
          <RecentScansCard scans={scans} />
        </View>
      </ScrollView>
    </SafeAreaView>
  )
}

// ── Header ───────────────────────────────────────────────────────────────────

function Header({ onBack }) {
  return (
    <View>
      <Pressable
        onPress={onBack}
        className="flex-row items-center gap-1 mb-4 self-start active:opacity-60"
      >
        <Ionicons name="chevron-back-outline" size={18} color="#B3B2AC" />
        <Text className="text-sm text-chalk-2">Back</Text>
      </Pressable>
      <View className="flex-row items-center" style={{ gap: 10 }}>
        <Text className="text-2xl font-display-bold text-chalk">Body composition</Text>
        <View className="rounded-full border border-iron-hairline bg-iron-raised px-2.5 py-0.5">
          <Text className="font-mono text-[10px] uppercase text-chalk-2" style={{ letterSpacing: 1.2 }}>InBody</Text>
        </View>
      </View>
    </View>
  )
}

// ── Score hero (ring) ────────────────────────────────────────────────────────

function ScoreHero({ latest, previous }) {
  const score = num(latest.inbody_score)
  const prevScore = num(previous?.inbody_score)
  const delta = score !== null && prevScore !== null ? score - prevScore : null

  // Ring geometry. Score is /100; clamp the arc fraction to [0, 1].
  const SIZE = 168
  const STROKE = 14
  const r = (SIZE - STROKE) / 2
  const cx = SIZE / 2
  const cy = SIZE / 2
  const circumference = 2 * Math.PI * r
  const frac = score !== null ? Math.max(0, Math.min(1, score / 100)) : 0
  const dash = circumference * frac

  return (
    <Card className="items-center">
      <View style={{ width: SIZE, height: SIZE }}>
        <Svg width={SIZE} height={SIZE}>
          {/* Track */}
          <Circle cx={cx} cy={cy} r={r} stroke={TRACK} strokeWidth={STROKE} fill="none" />
          {/* Progress arc — start at 12 o'clock, sweep clockwise. */}
          <Circle
            cx={cx}
            cy={cy}
            r={r}
            stroke={PEARL}
            strokeWidth={STROKE}
            fill="none"
            strokeLinecap="round"
            strokeDasharray={`${dash} ${circumference}`}
            transform={`rotate(-90 ${cx} ${cy})`}
          />
        </Svg>
        {/* Centred score + /100 */}
        <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} className="items-center justify-center">
          <Text className="text-4xl font-mono text-chalk">{fmtScore(score)}</Text>
          <Text className="font-mono text-[10px] text-chalk-3" style={{ letterSpacing: 1 }}>/100</Text>
        </View>
      </View>

      <Text className="mt-4 text-sm font-body-semibold text-chalk">InBody score</Text>

      {delta !== null && delta !== 0 ? (
        <View
          className="mt-2 rounded-full px-3 py-1"
          // P4b: a higher InBody score is EARNED — the chip lights volt.
          style={{ backgroundColor: delta > 0 ? VOLT + '1F' : '#24242A' }}
        >
          <Text
            className="font-mono text-xs"
            style={{ color: delta > 0 ? VOLT : TEXT_2 }}
          >
            {delta > 0 ? `+${Math.round(delta)} since last` : `${Math.round(delta)} since last`}
          </Text>
        </View>
      ) : null}

      <Text className="mt-2 font-mono text-[11px] text-chalk-2">Scanned {fmtDate(latest.scanned_at)}</Text>
    </Card>
  )
}

// ── 2×2 metric tiles ─────────────────────────────────────────────────────────

function MetricTiles({ latest, previous }) {
  const tiles = [
    { key: 'weight_kg',   label: 'Weight',          unit: 'kg', dp: 1, betterWhenLower: true },
    { key: 'smm_kg',      label: 'Skeletal muscle', unit: 'kg', dp: 1, betterWhenLower: false },
    { key: 'pbf_percent', label: 'Body fat',        unit: '%',  dp: 1, betterWhenLower: true },
    { key: 'bmi',         label: 'BMI',             unit: '',   dp: 1, betterWhenLower: null },
  ]
  const { width } = useWindowDimensions()
  // Two columns: subtract screen padding (40) + card padding (40) + gap (12),
  // then halve. flexBasis-style fixed width keeps the 2×2 wrap honest.
  const tileW = (width - 40 - 40 - 12) / 2

  return (
    <Card>
      <View className="flex-row flex-wrap" style={{ gap: 12 }}>
        {tiles.map((t) => (
          <MetricTile
            key={t.key}
            def={t}
            current={num(latest[t.key])}
            prev={num(previous?.[t.key])}
            width={tileW}
          />
        ))}
      </View>
    </Card>
  )
}

function MetricTile({ def, current, prev, width }) {
  const delta = current !== null && prev !== null ? current - prev : null
  const hasDelta = delta !== null && Math.abs(delta) >= 0.05 // sub-0.1 reads as flat

  // Improvement direction. betterWhenLower null (BMI) ⇒ never "improving"
  // (no obvious better direction), so its delta stays muted.
  let improving = null
  if (hasDelta && def.betterWhenLower === true) improving = delta < 0
  else if (hasDelta && def.betterWhenLower === false) improving = delta > 0

  // P4b: an improvement is EARNED — lights volt; muted otherwise.
  const deltaColor = improving === true ? VOLT : TEXT_2
  const arrow = !hasDelta ? '' : delta > 0 ? '▲' : '▼'
  const deltaText = hasDelta
    ? `${arrow} ${Math.abs(delta).toFixed(def.dp)}${def.unit ? ` ${def.unit}` : ''}`
    : '—'

  return (
    <View
      className="rounded-[16px] border border-iron-hairline bg-iron-raised p-3"
      style={{ width }}
    >
      <Text className="font-mono text-[10px] uppercase text-chalk-3" style={{ letterSpacing: 2 }}>{def.label}</Text>
      <View className="mt-1 flex-row items-baseline">
        <Text className="text-xl font-mono text-chalk">
          {current !== null ? current.toFixed(def.dp) : '—'}
        </Text>
        {def.unit ? <Text className="ml-1 font-mono text-[10px] uppercase text-chalk-3" style={{ letterSpacing: 1 }}>{def.unit}</Text> : null}
      </View>
      <Text className="mt-0.5 font-mono text-[11px]" style={{ color: deltaColor }}>
        {deltaText}
      </Text>
    </View>
  )
}

// ── Trend chart ──────────────────────────────────────────────────────────────

function TrendCard({ scans, metricKey, onChangeMetric }) {
  const metric = METRICS.find((m) => m.key === metricKey) || METRICS[0]

  // Oldest → newest for a left-to-right chart. Keep only scans with a numeric
  // value for this metric.
  const series = useMemo(() => {
    return (scans || [])
      .map((s) => ({ at: s.scanned_at, value: num(s[metric.key]) }))
      .filter((p) => p.value !== null && p.at)
      .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())
  }, [scans, metric.key])

  return (
    <Card>
      <View className="flex-row items-center justify-between" style={{ gap: 12 }}>
        <Text className="text-base font-display text-chalk">Trend</Text>
        <MetricToggle value={metricKey} onChange={onChangeMetric} />
      </View>

      {series.length < 2 ? (
        <Text className="mt-6 text-sm text-chalk-2">
          One scan so far — your {metric.short.toLowerCase()} trend fills in
          from your next scan.
        </Text>
      ) : (
        <TrendChart series={series} metric={metric} />
      )}
    </Card>
  )
}

function MetricToggle({ value, onChange }) {
  return (
    <View className="flex-row rounded-xl border border-iron-hairline bg-iron-raised p-0.5">
      {METRICS.map((m) => {
        const active = m.key === value
        return (
          <Pressable
            key={m.key}
            onPress={() => onChange(m.key)}
            className={`rounded-lg px-2.5 py-1 ${active ? 'bg-chalk' : ''}`}
          >
            <Text className={`text-xs font-body-medium ${active ? 'text-iron-bg' : 'text-chalk-2'}`}>
              {m.short}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

function TrendChart({ series, metric }) {
  // Map values into a fixed viewBox, scaled to the series min/max with a
  // little headroom. Same approach as progress.jsx's sparkline, sized up to
  // a full-width line chart. viewBox scales to the card width.
  const W = 700
  const H = 200
  const PAD_X = 16
  const PAD_TOP = 16
  const PAD_BOTTOM = 16
  const innerW = W - 2 * PAD_X
  const innerH = H - PAD_TOP - PAD_BOTTOM

  const vals = series.map((p) => p.value)
  const minV = Math.min(...vals)
  const maxV = Math.max(...vals)
  const range = maxV - minV || 1

  const xFor = (i) => PAD_X + (series.length === 1 ? innerW / 2 : (i / (series.length - 1)) * innerW)
  const yFor = (v) => PAD_TOP + (1 - (v - minV) / range) * innerH

  const points = series.map((p, i) => `${xFor(i).toFixed(1)},${yFor(p.value).toFixed(1)}`).join(' ')

  // Month labels — show every Nth point so the axis isn't cramped (~5 ticks).
  const tickEvery = Math.max(1, Math.ceil(series.length / 5))

  return (
    <View className="mt-4">
      <Svg viewBox={`0 0 ${W} ${H}`} width="100%" height={196}>
        {/* Baseline */}
        <Line x1={PAD_X} y1={H - PAD_BOTTOM} x2={W - PAD_X} y2={H - PAD_BOTTOM} stroke={TRACK} strokeWidth={1.5} />
        {/* Trend line */}
        <Polyline
          points={points}
          fill="none"
          stroke={PEARL}
          strokeWidth={3}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {/* Dots at each scan */}
        {series.map((p, i) => (
          <Circle key={i} cx={xFor(i)} cy={yFor(p.value)} r={4} fill={PEARL} />
        ))}
      </Svg>

      {/* X-axis month labels */}
      <View className="mt-2 flex-row justify-between">
        {series.map((p, i) => (
          <View key={i} className="flex-1 items-center">
            <Text className="font-mono text-[10px] text-chalk-3">
              {i % tickEvery === 0 ? fmtMonth(p.at) : ''}
            </Text>
          </View>
        ))}
      </View>

      {/* Latest value caption */}
      <Text className="mt-2 text-xs text-chalk-2">
        Latest{' '}
        <Text className="font-mono text-chalk">
          {vals[vals.length - 1].toFixed(metric.dp)}{metric.unit ? ` ${metric.unit}` : ''}
        </Text>
      </Text>
    </View>
  )
}

// ── Recent scans ─────────────────────────────────────────────────────────────

function RecentScansCard({ scans }) {
  const rows = (scans || []).slice(0, 3) // newest-first already

  return (
    <Card>
      <Text className="text-base font-display text-chalk">Recent scans</Text>
      <View className="mt-3" style={{ gap: 0 }}>
        {rows.map((s, i) => (
          <View
            key={s.scanned_at || i}
            className={`flex-row items-center justify-between py-2.5${i === 0 ? '' : ' border-t border-iron-hairline'}`}
            style={{ gap: 16 }}
          >
            <View className="flex-1 min-w-0">
              <Text className="text-sm font-body-medium text-chalk">{fmtDate(s.scanned_at)}</Text>
              <Text className="mt-0.5 font-mono text-xs text-chalk-2">
                {fmt1(s.weight_kg)} kg · {fmt1(s.pbf_percent)}% fat
              </Text>
            </View>
            <View className="items-end shrink-0">
              <Text className="font-mono text-sm" style={{ color: PEARL }}>
                {fmtScore(s.inbody_score)}
              </Text>
              <Text className="font-mono text-[9px] uppercase text-chalk-3" style={{ letterSpacing: 1 }}>score</Text>
            </View>
          </View>
        ))}
      </View>
    </Card>
  )
}
