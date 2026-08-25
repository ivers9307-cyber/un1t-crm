// FLAGSHIP.B3 — challenge "Wrapped" finisher story (fullScreenModal).
//
// When a FLAGSHIP transformation challenge has ended and the member took part,
// the Compete → Challenges screen offers "See your Challenge Wrapped ›", which
// opens this full-screen recap of the member's OWN performance in the window —
// mirroring the monthly wrapped (mobile/app/wrapped/month.jsx):
//   • a hero count-up (classes attended, or the challenge's metric total)
//   • a pearl wash-in behind the hero + reduce-motion-gated confetti
//   • a "Finisher" beat (they showed up and completed the challenge)
//   • classes / points / rank stat tiles (rank only when the Compete screen
//     passed one — it's the standings' already-masked figure, never recomputed)
//   • an InBody transformation line when a bookend exists (reuses inbodyBookend)
//
// Privacy: every read is the member's OWN data via the RLS-scoped `supabase`
// client (heart_rate_sessions + inbody_scans + the challenge def) — never the
// service client, never anyone else's rows. Own-stats-only; the only
// cross-member figure (rank) arrives already masked from the standings the
// Compete screen loaded. NO booking/reserve/pause/cancel copy.
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
import { useLocalSearchParams, useRouter } from 'expo-router'
import { supabase } from '../../../../lib/member/supabase'
import { PEARL, VOLT } from '../../../../lib/member/brand'
import { challengeWrappedModel, challengeWindowMs } from 'shared/challenge-wrapped'
import { inbodyBookend } from 'shared/inbody'

// Keep the pearl flood dark enough that chalk type always passes contrast.
const SCRIM = 'rgba(19,19,22,0.62)'

// ── animated count-up hero ────────────────────────────────────────
function CountUp({ target, reduceMotion, label }) {
  const [display, setDisplay] = useState(reduceMotion ? target : 0)
  const val = useRef(new Animated.Value(0)).current

  useEffect(() => {
    if (reduceMotion || !target) { setDisplay(target); return }
    const id = val.addListener(({ value }) => setDisplay(Math.round(value)))
    Animated.timing(val, {
      toValue: target,
      duration: Math.min(1800, 600 + target * 30),
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false, // we read the value on the JS thread
    }).start()
    return () => val.removeListener(id)
  }, [target, reduceMotion, val])

  return (
    <Text
      className="text-chalk font-display-black"
      style={{ fontSize: 76, lineHeight: 84, letterSpacing: -2 }}
      accessibilityLabel={`${target} ${label}`}
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

// Positive-integer route param → number, else null (rank/count are optional).
function numParam(v) {
  const raw = Array.isArray(v) ? v[0] : v
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : null
}

// ── screen ────────────────────────────────────────────────────────
export default function ChallengeWrapped() {
  const params = useLocalSearchParams()
  const id = Array.isArray(params.id) ? params.id[0] : params.id
  const rankParam = numParam(params.rank)
  const countParam = numParam(params.count)

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

  // Load the challenge def + the member's own sessions in the window + InBody
  // scans, all via the RLS-scoped client (own data only), then build the story.
  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setLoadError(false)
      try {
        // 1) Challenge def (RLS lets members read their location's challenges).
        //    Ended challenges are included — the normal /api/challenges load
        //    drops them, so we fetch the row directly here.
        const { data: ch, error: chErr } = await supabase
          .from('challenges')
          .select('id, name, mode, metric, starts_on, ends_on, target, is_flagship')
          .eq('id', id)
          .maybeSingle()
        if (chErr) throw chErr
        const win = challengeWindowMs(ch)
        if (!ch || !win) { if (!cancelled) { setLoadError(true); setLoading(false) } return }

        // 2) Own sessions overlapping the window (RLS-scoped to the member).
        const sinceIso = new Date(win.fromMs).toISOString()
        const untilIso = new Date(win.toMs).toISOString()
        const [sessRes, scanRes] = await Promise.all([
          supabase
            .from('heart_rate_sessions')
            .select('id, started_at, ended_at, effort_points, zones_seconds')
            .gte('started_at', sinceIso)
            .lt('started_at', untilIso)
            .order('started_at', { ascending: true })
            .limit(1000),
          // Same self-client select as ChallengeTransformationCard / coaching/inbody.
          supabase
            .from('inbody_scans')
            .select('scanned_at, weight_kg, pbf_percent, smm_kg, inbody_score')
            .order('scanned_at', { ascending: false }),
        ])
        if (cancelled) return
        if (sessRes.error) throw sessRes.error

        const sessions = sessRes.data || []
        const scans = scanRes.error ? [] : (scanRes.data || [])
        // Bookend against the window (toMs clamped to now for a just-closed one).
        const bookend = inbodyBookend(scans, { fromMs: win.fromMs, toMs: Math.min(Date.now(), win.toMs) })

        const m = challengeWrappedModel({
          challenge: ch,
          sessions,
          rank: rankParam,
          count: countParam,
          bookend,
        })
        setModel(m)
      } catch {
        if (!cancelled) setLoadError(true)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    if (id) load()
    else { setLoadError(true); setLoading(false) }
    return () => { cancelled = true }
    // rank/count come from immutable route params; id drives the load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

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
      `I finished the ${model.name} challenge at UN1T 💪`,
      `${model.classes} ${model.classes === 1 ? 'class' : 'classes'} · ${model.points.toLocaleString()} UN1T Points`,
    ]
    if (model.rank) bits.push(`Finished #${model.rank}${model.count ? ` of ${model.count}` : ''}`)
    if (model.inbody) {
      const v = `${model.inbody.delta > 0 ? '+' : ''}${model.inbody.delta.toFixed(model.inbody.dp)}${model.inbody.unit ? ` ${model.inbody.unit}` : ''}`
      bits.push(`${model.inbody.label}: ${v}`)
    }
    Share.share({ message: bits.join('\n'), title: `My ${model.name}` }).catch(() => { /* fail quietly */ })
  }

  function dismiss() {
    if (router.canGoBack()) router.back()
    else router.replace('/home')
  }

  if (loading || !motionReady) {
    return (
      <SafeAreaView className="flex-1 bg-iron-bg items-center justify-center">
        <ActivityIndicator color="#F1EEE7" size="large" />
      </SafeAreaView>
    )
  }

  // No participation / load error → close out gracefully rather than present an
  // empty finisher.
  if (loadError || !model || !model.hasContent) {
    return (
      <SafeAreaView className="flex-1 bg-iron-bg">
        <View className="p-5">
          <Pressable onPress={dismiss} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close">
            <Text className="text-sm font-body-medium text-chalk-2">Close</Text>
          </Pressable>
          <View className="mt-8 rounded-[20px] border border-iron-hairline bg-iron-surface p-5">
            <Text className="text-base font-display text-chalk">
              {model && !model.hasContent ? 'No recap for this challenge' : "We couldn't build your recap"}
            </Text>
            <Text className="mt-2 text-sm text-chalk-2">
              {model && !model.hasContent
                ? "It looks like you didn't have a class logged during this challenge."
                : 'Something went wrong loading your challenge. Please try again later.'}
            </Text>
          </View>
        </View>
      </SafeAreaView>
    )
  }

  // P4b: the Z4 hue here was zone-as-accent sparkle, not zone data → volt.
  const confettiColors = [PEARL, '#F1EEE7', VOLT]

  // Hero = classes attended (the flagship's consistency metric). Points read on
  // a supporting tile so the count-up stays a single clean figure.
  const heroValue = model.classes
  const heroUnit = model.classes === 1 ? 'class attended' : 'classes attended'

  const revealStyle = reduceMotion
    ? {}
    : { opacity: reveal, transform: [{ translateY: reveal.interpolate({ inputRange: [0, 1], outputRange: [16, 0] }) }] }

  const inbodyText = model.inbody
    ? `${model.inbody.label} ${model.inbody.delta > 0 ? '+' : ''}${model.inbody.delta.toFixed(model.inbody.dp)}${model.inbody.unit ? ` ${model.inbody.unit}` : ''}`
    : null

  return (
    <View className="flex-1 bg-iron-bg">
      {/* Pearl flood + scrim for legibility */}
      <Animated.View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: PEARL, opacity: reduceMotion ? 0.9 : wash }} />
      <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: SCRIM }} />

      {!reduceMotion && heroValue > 0 ? <Confetti colors={confettiColors} width={width} /> : null}

      <SafeAreaView className="flex-1">
        {/* top bar */}
        <View className="flex-row items-center justify-between px-5 pt-2">
          <Pressable onPress={dismiss} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close recap">
            <Text className="text-2xl text-chalk" style={{ lineHeight: 26 }}>×</Text>
          </Pressable>
          <Text className="font-mono text-[10px] uppercase" style={{ color: 'rgba(241,238,231,0.7)', letterSpacing: 2 }}>Challenge wrapped</Text>
          <View style={{ width: 20 }} />
        </View>

        <ScrollView contentContainerClassName="px-5 pb-10" showsVerticalScrollIndicator={false}>
          {/* Hero: challenge name + classes count-up */}
          <View className="items-center mt-8">
            <Text className="text-base font-display mb-2 text-center" style={{ color: 'rgba(241,238,231,0.9)' }} numberOfLines={2}>
              {model.name}
            </Text>
            <CountUp target={heroValue} reduceMotion={reduceMotion} label={heroUnit} />
            <Text className="text-base font-body-medium mt-1" style={{ color: 'rgba(241,238,231,0.85)' }}>{heroUnit}</Text>
          </View>

          <Animated.View style={revealStyle}>
            {/* Finisher beat — the celebratory line */}
            {model.finisher ? (
              <View
                className="mt-7 rounded-[20px] px-4 py-4"
                // P4b: finishing the challenge is EARNED — lights volt.
                style={{ backgroundColor: VOLT, borderWidth: 1, borderColor: VOLT }}
              >
                <View className="flex-row items-center justify-center" style={{ gap: 8 }}>
                  <Ionicons name="medal" size={16} color="#131316" />
                  <Text className="text-base font-display-bold text-center" style={{ color: '#131316' }}>
                    Challenge finisher
                  </Text>
                </View>
              </View>
            ) : null}

            {/* InBody transformation — full-width line when a bookend improved */}
            {inbodyText ? (
              <View
                className="mt-4 rounded-[20px] px-4 py-4 flex-row items-center justify-center"
                style={{ gap: 8, backgroundColor: 'rgba(241,238,231,0.1)', borderWidth: 1, borderColor: 'rgba(241,238,231,0.18)' }}
              >
                <Text className="text-sm font-body-semibold" style={{ color: '#F1EEE7' }}>
                  ★  {inbodyText}
                </Text>
              </View>
            ) : null}

            {/* Key stats */}
            <View className="mt-6 flex-row" style={{ gap: 12 }}>
              <Stat label="Classes" value={model.classes.toLocaleString()} />
              <Stat label="Points" value={model.points.toLocaleString()} unit="pts" />
              <Stat
                label="Your rank"
                value={model.rank != null ? `#${model.rank}` : '—'}
                unit={model.rank != null && model.count != null ? `of ${model.count}` : undefined}
              />
            </View>

            <Text className="mt-6 text-center text-sm" style={{ color: 'rgba(241,238,231,0.8)' }}>
              That&apos;s a wrap on {model.name}. Onto the next one.
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
            <Text className="font-display text-iron-bg">Share my challenge</Text>
          </Pressable>
          <Pressable onPress={dismiss} hitSlop={8} className="items-center py-2">
            <Text className="text-sm font-body-medium" style={{ color: 'rgba(241,238,231,0.85)' }}>Done</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    </View>
  )
}
