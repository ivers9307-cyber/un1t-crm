// WAVE-5 — "Monthly Wrapped" month-end recap story (fullScreenModal).
//
// At the start of a new month we celebrate the month that JUST ENDED with a
// full-screen story of the member's OWN stats — mirroring the post-class
// wrapped ceremony (mobile/app/sessions/[id]/wrapped.jsx):
//   • points count-up (0 → the month's total UN1T Points) as the hero
//   • a pearl wash-in behind the hero
//   • sessions + minutes + avg peak HR stat tiles
//   • a "Fittest month yet 🏆" beat when it's the member's biggest month
//   • a PR highlight if a personal record landed that month (best-effort)
//   • Share as the closing CTA (Share.share of a text summary — no backend)
//
// Data comes from the SAME analytics the Progress screen uses (monthlyRecap +
// personalRecords), flattened by the pure shared/month-wrapped.js helper. This
// screen keeps to the member's OWN stats — NO social/classmates data (kept
// self-contained + low-risk; a social month-recap is a future add).
//
// Motion is RN's built-in Animated + AccessibilityInfo reduce-motion; NO new
// deps. Reduce Motion snaps everything to its final state and skips confetti.

import { useEffect, useMemo, useRef, useState } from 'react'
import { Ionicons } from '@expo/vector-icons'
import {
  View, Text, ScrollView, ActivityIndicator, Pressable,
  Animated, Easing, AccessibilityInfo, Share, useWindowDimensions,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { supabase } from '../../../lib/member/supabase'
import { markMonthRecapSeen } from '../../../lib/member/recap-seen'
import { monthlyRecap, personalRecords } from 'shared/progress-analytics'
import { monthWrappedModel } from 'shared/month-wrapped'
import { PEARL, VOLT } from '../../../lib/member/brand'

// Keep the pearl flood dark enough that chalk type always passes contrast.
const SCRIM = 'rgba(19,19,22,0.62)'

// ── animated points count-up ──────────────────────────────────────
function PointsCountUp({ target, reduceMotion }) {
  const [display, setDisplay] = useState(reduceMotion ? target : 0)
  const val = useRef(new Animated.Value(0)).current

  useEffect(() => {
    if (reduceMotion || !target) { setDisplay(target); return }
    const id = val.addListener(({ value }) => setDisplay(Math.round(value)))
    Animated.timing(val, {
      toValue: target,
      duration: Math.min(1800, 600 + target * 4),
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false, // we read the value on the JS thread
    }).start()
    return () => val.removeListener(id)
  }, [target, reduceMotion, val])

  return (
    <Text
      className="text-chalk font-display-black"
      style={{ fontSize: 76, lineHeight: 84, letterSpacing: -2 }}
      accessibilityLabel={`${target} UN1T Points`}
    >
      {display.toLocaleString()}
    </Text>
  )
}

// ── cheap confetti (reduce-motion gated) ──────────────────────────
function Confetti({ colors, width }) {
  const pieces = useMemo(() => (
    Array.from({ length: 14 }, (_, i) => ({
      key: i,
      x: Math.round(((i + 0.5) / 14) * width) + (i % 2 ? 8 : -8),
      color: colors[i % colors.length],
      delay: (i % 7) * 90,
      size: 6 + (i % 3) * 3,
      drift: (i % 2 ? 1 : -1) * (12 + (i % 4) * 6),
    }))
  ), [colors, width])

  return (
    <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}>
      {pieces.map((p) => <ConfettiPiece key={p.key} {...p} />)}
    </View>
  )
}

function ConfettiPiece({ x, color, delay, size, drift }) {
  const t = useRef(new Animated.Value(0)).current
  useEffect(() => {
    Animated.timing(t, {
      toValue: 1,
      duration: 2200,
      delay,
      easing: Easing.in(Easing.quad),
      useNativeDriver: true,
    }).start()
  }, [t, delay])
  const translateY = t.interpolate({ inputRange: [0, 1], outputRange: [-40, 640] })
  const translateX = t.interpolate({ inputRange: [0, 1], outputRange: [0, drift] })
  const opacity = t.interpolate({ inputRange: [0, 0.1, 0.85, 1], outputRange: [0, 1, 1, 0] })
  const rotate = t.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '220deg'] })
  return (
    <Animated.View
      style={{
        position: 'absolute', left: x, top: 0,
        width: size, height: size * 1.6, borderRadius: 2,
        backgroundColor: color,
        opacity,
        transform: [{ translateY }, { translateX }, { rotate }],
      }}
    />
  )
}

// ── stat tile ─────────────────────────────────────────────────────
function Stat({ label, value, unit }) {
  return (
    <View className="flex-1 rounded-[20px] p-4" style={{ backgroundColor: 'rgba(241,238,231,0.06)', borderWidth: 1, borderColor: 'rgba(241,238,231,0.12)' }}>
      <Text className="font-mono text-[10px] uppercase" style={{ color: 'rgba(241,238,231,0.6)', letterSpacing: 2 }}>{label}</Text>
      <View className="mt-1 flex-row items-baseline flex-wrap">
        <Text className="font-mono text-xl text-chalk">{value}</Text>
        {unit ? <Text className="ml-1 font-mono text-[10px] uppercase" style={{ color: 'rgba(241,238,231,0.7)', letterSpacing: 1 }}>{unit}</Text> : null}
      </View>
    </View>
  )
}

// ── screen ────────────────────────────────────────────────────────
export default function MonthWrapped() {
  const router = useRouter()
  const { width } = useWindowDimensions()

  const [model, setModel] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [reduceMotion, setReduceMotion] = useState(false)
  const [motionReady, setMotionReady] = useState(false)

  const wash = useRef(new Animated.Value(0)).current
  const reveal = useRef(new Animated.Value(0)).current

  // Detect Reduce Motion once (and subscribe for changes while mounted).
  useEffect(() => {
    let mounted = true
    AccessibilityInfo.isReduceMotionEnabled().then((v) => {
      if (mounted) { setReduceMotion(!!v); setMotionReady(true) }
    }).catch(() => { if (mounted) setMotionReady(true) })
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', (v) => setReduceMotion(!!v))
    return () => { mounted = false; sub?.remove?.() }
  }, [])

  // Load ~13 months of sessions (enough for monthlyRecap's 6-month window +
  // fittest across the year), compute the completed-month story. RLS scopes
  // the read to the signed-in member.
  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setLoadError(false)
      try {
        const sinceIso = new Date(Date.now() - 400 * 24 * 3600 * 1000).toISOString()
        const all = []
        const PAGE = 1000
        for (let from = 0; ; from += PAGE) {
          const { data, error } = await supabase
            .from('heart_rate_sessions')
            .select('id, started_at, ended_at, effort_points, avg_hr_bpm, peak_hr_bpm, zones_seconds')
            .gte('started_at', sinceIso)
            .order('started_at', { ascending: false })
            .range(from, from + PAGE - 1)
          if (error) throw error
          const rows = data || []
          all.push(...rows)
          if (rows.length < PAGE) break
        }
        if (cancelled) return
        const now = Date.now()
        const recap = monthlyRecap(all, now, 6)
        const records = personalRecords(all)
        const m = monthWrappedModel(recap, records, now)
        setModel(m)
        // Mark the recapped month seen the moment it opens, so it never
        // re-ambushes the member on a later home visit this month.
        if (m?.monthKey) markMonthRecapSeen(m.monthKey)
      } catch {
        if (!cancelled) setLoadError(true)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [])

  // Kick the wash-in + reveal once data + motion pref are ready.
  useEffect(() => {
    if (loading || loadError || !model || !motionReady) return
    if (reduceMotion) { wash.setValue(1); reveal.setValue(1); return }
    Animated.sequence([
      Animated.timing(wash, { toValue: 1, duration: 700, easing: Easing.out(Easing.quad), useNativeDriver: false }),
      Animated.timing(reveal, { toValue: 1, duration: 500, delay: 250, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
    ]).start()
  }, [loading, loadError, model, motionReady, reduceMotion, wash, reveal])

  function handleShare() {
    if (!model?.hasContent) return
    const bits = [
      `My ${model.label} at UN1T 💪`,
      `${model.points.toLocaleString()} UN1T Points · ${model.sessions} ${model.sessions === 1 ? 'session' : 'sessions'} · ${model.minutes} min`,
    ]
    if (model.isFittest) bits.push('My fittest month yet 🏆')
    if (model.pr) bits.push(`${model.pr.label}: ${model.pr.value.toLocaleString()} ${model.pr.unit}`)
    const message = bits.join('\n')
    Share.share({ message, title: `My ${model.label}` }).catch(() => { /* fail quietly */ })
  }

  function dismiss() {
    if (router.canGoBack()) router.back()
    else router.replace('/home')
  }

  if (loading || !motionReady) {
    // The route is a gesture-locked fullScreenModal, so the loading state MUST
    // carry its own exit — without this Close a hung fetch traps the member
    // with no way out (re-audit A7). Same top-bar close as the loaded screen.
    return (
      <SafeAreaView className="flex-1 bg-iron-bg">
        <View className="flex-row items-center justify-between px-5 pt-2">
          <Pressable onPress={dismiss} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close recap">
            <Text className="text-2xl text-chalk" style={{ lineHeight: 26 }}>×</Text>
          </Pressable>
          <Text className="font-mono text-[10px] uppercase" style={{ color: 'rgba(241,238,231,0.7)', letterSpacing: 2 }}>Monthly wrapped</Text>
          <View style={{ width: 20 }} />
        </View>
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator color="#F1EEE7" size="large" />
        </View>
      </SafeAreaView>
    )
  }

  // No completed-month content (or a load error) → close out gracefully rather
  // than present an empty recap.
  if (loadError || !model || !model.hasContent) {
    return (
      <SafeAreaView className="flex-1 bg-iron-bg">
        <View className="p-5">
          <Pressable onPress={dismiss} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close">
            <Text className="text-sm font-body-medium text-chalk-2">Close</Text>
          </Pressable>
          <View className="mt-8 rounded-[20px] border border-iron-hairline bg-iron-surface p-5">
            <Text className="text-base font-display text-chalk">
              {model && !model.hasContent ? 'No recap for last month' : "We couldn't build your recap"}
            </Text>
            <Text className="mt-2 text-sm text-chalk-2">
              {model && !model.hasContent
                ? `You didn't train in ${model.label}. Train this month and your next recap will be waiting.`
                : 'Something went wrong loading your month. Please try again later.'}
            </Text>
          </View>
        </View>
      </SafeAreaView>
    )
  }

  // P4b: the Z4 hue here was zone-as-accent sparkle, not zone data → volt.
  const confettiColors = [PEARL, '#F1EEE7', VOLT]

  const revealStyle = reduceMotion
    ? {}
    : { opacity: reveal, transform: [{ translateY: reveal.interpolate({ inputRange: [0, 1], outputRange: [16, 0] }) }] }

  return (
    <View className="flex-1 bg-iron-bg">
      {/* Pearl flood + scrim for legibility */}
      <Animated.View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: PEARL, opacity: reduceMotion ? 0.9 : wash }} />
      <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: SCRIM }} />

      {!reduceMotion && model.points > 0 ? <Confetti colors={confettiColors} width={width} /> : null}

      <SafeAreaView className="flex-1">
        {/* top bar */}
        <View className="flex-row items-center justify-between px-5 pt-2">
          <Pressable onPress={dismiss} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close recap">
            <Text className="text-2xl text-chalk" style={{ lineHeight: 26 }}>×</Text>
          </Pressable>
          <Text className="font-mono text-[10px] uppercase" style={{ color: 'rgba(241,238,231,0.7)', letterSpacing: 2 }}>Monthly wrapped</Text>
          <View style={{ width: 20 }} />
        </View>

        <ScrollView contentContainerClassName="px-5 pb-10" showsVerticalScrollIndicator={false}>
          {/* Hero: month label + points count-up */}
          <View className="items-center mt-8">
            <Text className="text-base font-display mb-2" style={{ color: 'rgba(241,238,231,0.9)' }}>{model.label}</Text>
            <PointsCountUp target={model.points} reduceMotion={reduceMotion} />
            <Text className="text-base font-body-medium mt-1" style={{ color: 'rgba(241,238,231,0.85)' }}>UN1T Points</Text>
          </View>

          <Animated.View style={revealStyle}>
            {/* Fittest-month beat — the celebratory line */}
            {model.isFittest ? (
              <View
                className="mt-7 rounded-[20px] px-4 py-4"
                // P4b: fittest month is EARNED — the celebratory fill lights volt.
                style={{ backgroundColor: VOLT, borderWidth: 1, borderColor: VOLT }}
              >
                <View className="flex-row items-center justify-center" style={{ gap: 8 }}>
                  <Ionicons name="trophy" size={16} color="#131316" />
                  <Text className="text-base font-display-bold text-center" style={{ color: '#131316' }}>
                    Fittest month yet
                  </Text>
                </View>
              </View>
            ) : null}

            {/* PR highlight — full-width line when a record landed this month */}
            {model.pr ? (
              <View
                className="mt-4 rounded-[20px] px-4 py-4 flex-row items-center justify-center"
                style={{ gap: 8, backgroundColor: 'rgba(241,238,231,0.1)', borderWidth: 1, borderColor: 'rgba(241,238,231,0.18)' }}
              >
                <Text className="text-sm font-body-semibold" style={{ color: '#F1EEE7' }}>
                  ★  {model.pr.label} — {model.pr.value.toLocaleString()} {model.pr.unit}
                </Text>
              </View>
            ) : null}

            {/* Key stats */}
            <View className="mt-6 flex-row" style={{ gap: 12 }}>
              <Stat label="Sessions" value={model.sessions.toLocaleString()} />
              <Stat label="Minutes" value={model.minutes.toLocaleString()} unit="min" />
              <Stat label="Avg peak" value={model.avgPeakHr != null ? `${model.avgPeakHr}` : '—'} unit={model.avgPeakHr != null ? 'bpm' : undefined} />
            </View>

            <Text className="mt-6 text-center text-sm" style={{ color: 'rgba(241,238,231,0.8)' }}>
              That's a wrap on {model.monthName}. Here's to the next one.
            </Text>
          </Animated.View>
        </ScrollView>

        {/* Closing CTAs — Share is the hero */}
        <View className="px-5 pb-2" style={{ gap: 10 }}>
          <Pressable
            onPress={handleShare}
            accessibilityRole="button"
            className="rounded-xl py-3.5 px-5 items-center bg-chalk"
          >
            <Text className="font-display text-iron-bg">Share my month</Text>
          </Pressable>
          <Pressable onPress={dismiss} hitSlop={8} className="items-center py-2">
            <Text className="text-sm font-body-medium" style={{ color: 'rgba(241,238,231,0.85)' }}>Done</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    </View>
  )
}
