// Flagship InBody transformation bookend — on a flagship challenge's card in
// the Compete → Challenges screen. Shows the member's OWN body-composition
// change across the challenge window: muscle↑ / body-fat↓ / weight↓ and the
// InBody-score delta, pearl when it's an improvement.
//
// Privacy: reads inbody_scans via the member's RLS-scoped self client (the same
// `supabase` + select used by coaching/inbody.jsx) — never the service client,
// never anyone else's data. Own-stats-only; nothing here is ranked against
// other members.
//
// The bookend itself (baseline vs latest over the window) is derived by the pure
// `inbodyBookend` helper in shared/inbody.js. When fewer than two usable scans
// span the window it returns null and we show a one-line "get scanned" nudge —
// NO booking/reserve language (customers pause/book in the Glofox app, not here).
// "Full trends ›" deep-links to the existing coaching/inbody detail screen.

import { useState, useCallback, useMemo } from 'react'
import { View, Text, Pressable, ActivityIndicator } from 'react-native'
import { useFocusEffect, useRouter } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { supabase } from '../../lib/member/supabase'
import Card from './ui/Card'
import { PEARL, VOLT } from '../../lib/member/brand'
import { inbodyBookend } from 'shared/inbody'
import { windowIso } from 'shared/challenges'

const TEXT_2 = '#B3B2AC' // muted (chalk-2)

// Challenge-window ms bounds from the 'YYYY-MM-DD' starts_on/ends_on, via the
// shared Dublin-day windowIso (same boundaries as the standings RPC). toMs is
// clamped to now so a still-running challenge bookends against today, not a
// future end date. Returns null if either date is missing/unparseable.
function windowMs(startsOn, endsOn, nowMs) {
  if (!startsOn || !endsOn) return null
  const { fromIso, toIso } = windowIso({ starts_on: startsOn, ends_on: endsOn })
  const fromMs = Date.parse(fromIso)
  const endMs = Date.parse(toIso)
  if (!Number.isFinite(fromMs) || !Number.isFinite(endMs)) return null
  return { fromMs, toMs: Math.min(nowMs, endMs) }
}

export default function ChallengeTransformationCard({ challenge }) {
  const router = useRouter()
  const [loading, setLoading] = useState(true)
  const [scans, setScans] = useState([])
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      // Same self-client select as coaching/inbody.jsx (inbody_scans_self RLS).
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

  useFocusEffect(useCallback(() => { load() }, [load]))

  const bookend = useMemo(() => {
    const win = windowMs(challenge?.startsOn, challenge?.endsOn, Date.now())
    if (!win) return null
    return inbodyBookend(scans, win)
  }, [scans, challenge?.startsOn, challenge?.endsOn])

  return (
    <Card>
      {/* Header */}
      <View className="flex-row items-center justify-between" style={{ gap: 12 }}>
        <View className="flex-row items-center flex-1" style={{ gap: 8 }}>
          <Ionicons name="body-outline" size={20} color={PEARL} />
          <View className="flex-1">
            <Text className="text-base font-display text-chalk" numberOfLines={1}>
              Your transformation
            </Text>
            <Text className="text-xs text-chalk-2" numberOfLines={1}>
              InBody change over this challenge
            </Text>
          </View>
        </View>
        <Pressable
          onPress={() => router.push('/coaching/inbody')}
          hitSlop={8}
          className="flex-row items-center active:opacity-60"
          style={{ gap: 2 }}
        >
          <Text className="text-xs font-body-semibold" style={{ color: PEARL }}>Full trends</Text>
          <Ionicons name="chevron-forward" size={13} color={PEARL} />
        </Pressable>
      </View>

      {/* Body */}
      {loading ? (
        <View className="items-center py-6">
          <ActivityIndicator color={PEARL} />
        </View>
      ) : error && scans.length === 0 ? (
        <Text className="mt-4 text-sm text-chalk-2">
          Couldn&apos;t load your InBody scans right now.
        </Text>
      ) : bookend ? (
        <BookendBody bookend={bookend} />
      ) : (
        <Text className="mt-4 text-sm text-chalk-2">
          Get scanned on the InBody to track your transformation
        </Text>
      )}
    </Card>
  )
}

// The metric deltas (muscle / body fat / weight) + the InBody-score delta.
function BookendBody({ bookend }) {
  const scored = bookend.score

  return (
    <View className="mt-4" style={{ gap: 10 }}>
      {/* Score delta line — the headline, pearl when it climbed. */}
      {scored.delta !== null && (
        <View className="flex-row items-center justify-between">
          <Text className="text-sm text-chalk-2">InBody score</Text>
          <View className="flex-row items-baseline" style={{ gap: 6 }}>
            <Text className="font-mono text-sm text-chalk-3">
              {Math.round(scored.from)} → {Math.round(scored.to)}
            </Text>
            <DeltaBadge
              text={`${scored.delta > 0 ? '+' : ''}${Math.round(scored.delta)}`}
              improved={scored.improved}
            />
          </View>
        </View>
      )}

      {/* Per-metric rows */}
      {bookend.metrics.map((m) => (
        <MetricRow key={m.key} metric={m} />
      ))}
    </View>
  )
}

function MetricRow({ metric }) {
  const { label, unit, dp, delta, improved } = metric
  const hasDelta = delta !== null && Math.abs(delta) >= 0.05
  const arrow = !hasDelta ? '' : delta > 0 ? '▲' : '▼'
  const deltaText = hasDelta
    ? `${arrow} ${Math.abs(delta).toFixed(dp)}${unit ? ` ${unit}` : ''}`
    : '—'

  return (
    <View className="flex-row items-center justify-between">
      <Text className="text-sm text-chalk-2">{label}</Text>
      <Text
        className="font-mono text-sm"
        style={{ color: hasDelta && improved === true ? VOLT : TEXT_2 }}
      >
        {deltaText}
      </Text>
    </View>
  )
}

function DeltaBadge({ text, improved }) {
  return (
    <View
      className="rounded-full px-2 py-0.5"
      // P4b: an improved bookend is EARNED — the badge lights volt.
      style={{ backgroundColor: improved === true ? VOLT + '1F' : '#24242A' }}
    >
      <Text
        className="font-mono text-xs"
        style={{ color: improved === true ? VOLT : TEXT_2 }}
      >
        {text}
      </Text>
    </View>
  )
}
