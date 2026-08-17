// WAVE-4 — post-class "wrapped" ceremony (approved mockup B).
//
// A full-screen fullScreenModal that loads the SAME session report the detail
// screen (`sessions/[id].jsx`) loads, then plays a restrained celebration:
//   • points count-up (0 → UN1T Points) as the hero
//   • the screen floods with the session's dominant-zone colour
//   • a full-width celebratory line for a PB / highlight
//   • the Burn (mono chip, Furnace colour), prominent, when earned
//   • key stats + the HR trace (shared tracePolyline/traceSvg)
//   • Share as the closing CTA (reuses POST /api/sessions/[id]/share)
//
// Motion is RN's built-in Animated + AccessibilityInfo reduce-motion; NO new
// deps. Reduce Motion snaps everything to its final state and skips confetti.
// The push deep-link (/sessions/[id]) is UNCHANGED — this screen is only ever
// reached by the detail screen's auto-present gate or its manual affordance.

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  View, Text, ScrollView, ActivityIndicator, Pressable,
  Animated, Easing, AccessibilityInfo, Share, useWindowDimensions,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useLocalSearchParams, useRouter } from 'expo-router'
import Svg, { Polyline } from 'react-native-svg'
import { supabase } from '../../../../lib/member/supabase'
import { api } from '../../../../lib/member/api'
import { markRecapSeen } from '../../../../lib/member/recap-seen'
import { recapModel } from 'shared/wrapped'
import { tracePolyline } from 'shared/share-card'
import { PEARL, VOLT } from '../../../../lib/member/brand'
import { zoneColorDark } from 'shared/zone-colors'

// The Burn accent = the Zone 4 colour (Furnace on the dark canvas), tying
// the badge to the zone it rewards.
const BURN_COLOR = zoneColorDark(4)

// ── helpers ───────────────────────────────────────────────────────
// Downsample for the trace (mirrors the detail screen's cap).
function downsample(samples, max) {
  if (samples.length <= max) return samples
  const stride = Math.ceil(samples.length / max)
  const out = []
  for (let i = 0; i < samples.length; i += stride) out.push(samples[i])
  if (out[out.length - 1] !== samples[samples.length - 1]) out.push(samples[samples.length - 1])
  return out
}

// Readable text/veil over a flooded zone colour. We keep the flood dark by
// overlaying a translucent iron scrim so chalk type always passes contrast.
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
      duration: Math.min(1600, 500 + target * 18),
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false, // we read the value on the JS thread
    }).start()
    return () => val.removeListener(id)
  }, [target, reduceMotion, val])

  return (
    <Text
      className="text-chalk font-display-black"
      style={{ fontSize: 88, lineHeight: 96, letterSpacing: -2 }}
      accessibilityLabel={`${target} UN1T Points`}
    >
      {display}
    </Text>
  )
}

// ── cheap confetti (reduce-motion gated) ──────────────────────────
// A handful of Animated views falling from the top in zone/pearl colours.
// No new dep; capped at 14 pieces so it stays light on device.
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
export default function SessionWrapped() {
  const { id } = useLocalSearchParams()
  const router = useRouter()
  const { width } = useWindowDimensions()

  const [model, setModel] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [sharing, setSharing] = useState(false)
  const [reduceMotion, setReduceMotion] = useState(false)
  const [motionReady, setMotionReady] = useState(false)

  // Zone-colour wash-in + content reveal drivers.
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

  // Mark the recap seen the moment it opens, so it never re-ambushes the member.
  useEffect(() => { if (id) markRecapSeen(id) }, [id])

  // Load the SAME report + samples the detail screen loads.
  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setLoadError(false)
      try {
        // Page the whole hr_samples trace (chart downsamples to 600 regardless):
        // a single ascending .limit() dropped the END of long sessions.
        async function fetchAllSamples() {
          const out = []
          const SPAGE = 1000, SHARD = 20000
          for (let from = 0; from < SHARD; from += SPAGE) {
            const { data: pg } = await supabase
              .from('hr_samples')
              .select('recorded_at, bpm')
              .eq('session_id', id)
              .order('recorded_at', { ascending: true })
              .range(from, from + SPAGE - 1)
            const chunk = pg || []
            out.push(...chunk)
            if (chunk.length < SPAGE) break
          }
          return out
        }
        const [reportOut, rawSamples] = await Promise.all([
          api('/api/sessions/' + id + '/report'),
          fetchAllSamples(),
        ])
        if (cancelled) return
        if (reportOut?.report) {
          const samples = downsample(rawSamples, 600)
          setModel(recapModel(reportOut.report, samples))
        } else {
          setLoadError(true)
        }
      } catch {
        if (!cancelled) setLoadError(true)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    if (id) load()
    return () => { cancelled = true }
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

  async function handleShare() {
    if (sharing) return
    setSharing(true)
    try {
      const r = await api('/api/sessions/' + id + '/share', { method: 'POST' })
      if (r?.url) {
        await Share.share({ message: r.url, url: r.url, title: 'My UN1T session' })
      }
    } catch { /* fail quietly */ } finally { setSharing(false) }
  }

  function dismiss() {
    if (router.canGoBack()) router.back()
    else router.replace('/sessions/' + id)
  }

  function seeFullSession() {
    // The detail screen won't re-present the recap (flag already set above).
    router.replace('/sessions/' + id)
  }

  if (loading || !motionReady) {
    return (
      <SafeAreaView className="flex-1 bg-iron-bg items-center justify-center">
        <ActivityIndicator color="#F1EEE7" size="large" />
      </SafeAreaView>
    )
  }

  if (loadError || !model) {
    return (
      <SafeAreaView className="flex-1 bg-iron-bg">
        <View className="p-5">
          <Pressable onPress={dismiss} hitSlop={12}>
            <Text className="text-sm font-body-medium text-chalk-2">Close</Text>
          </Pressable>
          <View className="mt-8 rounded-[20px] border border-iron-hairline bg-iron-surface p-5">
            <Text className="text-sm text-chalk-2">
              We couldn't build your recap — it may still be processing. Tap “See full session” to view the details.
            </Text>
            <Pressable className="mt-4" onPress={seeFullSession} hitSlop={8}>
              <Text className="text-sm font-body-semibold" style={{ color: PEARL }}>See full session ›</Text>
            </Pressable>
          </View>
        </View>
      </SafeAreaView>
    )
  }

  // Zone DATA colour on the dark canvas — derived from the dominant zone id
  // already in the model; sessions without a dominant zone rest on Pearl.
  const floodColor = zoneColorDark(model.dominant?.id) || PEARL
  const zoneLabel = model.dominant?.id ? `Zone ${model.dominant.id}` : null
  const tracePoints = model.hasTrace ? tracePolyline(model.traceSamples, { width: 600, height: 140, points: 80 }) : null
  const confettiColors = [floodColor, PEARL, '#F1EEE7']

  // Wash-in: fade the flood colour in from transparent so the screen "takes"
  // the zone's colour. Under reduce-motion this is set to 1 immediately.
  const revealStyle = reduceMotion
    ? {}
    : { opacity: reveal, transform: [{ translateY: reveal.interpolate({ inputRange: [0, 1], outputRange: [16, 0] }) }] }

  return (
    <View className="flex-1 bg-iron-bg">
      {/* Dominant-zone flood + scrim for legibility */}
      <Animated.View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: floodColor, opacity: reduceMotion ? 1 : wash }} />
      <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: SCRIM }} />

      {!reduceMotion && model.points > 0 ? <Confetti colors={confettiColors} width={width} /> : null}

      <SafeAreaView className="flex-1">
        {/* top bar */}
        <View className="flex-row items-center justify-between px-5 pt-2">
          <Pressable onPress={dismiss} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close recap">
            <Text className="text-2xl text-chalk" style={{ lineHeight: 26 }}>×</Text>
          </Pressable>
          <Text className="font-mono text-[10px] uppercase" style={{ color: 'rgba(241,238,231,0.7)', letterSpacing: 2 }}>Session wrapped</Text>
          <View style={{ width: 20 }} />
        </View>

        <ScrollView contentContainerClassName="px-5 pb-10" showsVerticalScrollIndicator={false}>
          {/* Hero: points count-up */}
          <View className="items-center mt-6">
            {model.className ? (
              <Text className="text-sm font-body-medium mb-2" style={{ color: 'rgba(241,238,231,0.85)' }}>{model.className}</Text>
            ) : null}
            <PointsCountUp target={model.points} reduceMotion={reduceMotion} />
            <Text className="text-base font-body-medium mt-1" style={{ color: 'rgba(241,238,231,0.8)' }}>UN1T Points</Text>
            {zoneLabel ? (
              <View className="mt-3 flex-row items-center rounded-full px-3 py-1" style={{ backgroundColor: 'rgba(241,238,231,0.14)' }}>
                <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: floodColor, marginRight: 6 }} />
                <Text className="font-mono text-[10px] uppercase text-chalk" style={{ letterSpacing: 1.2 }}>{zoneLabel} session</Text>
              </View>
            ) : null}
          </View>

          <Animated.View style={revealStyle}>
            {/* PB / highlight — full-width celebratory line */}
            {model.highlight ? (
              <View
                className="mt-7 rounded-[20px] px-4 py-4"
                style={{
                  // P4b: a PB is EARNED — the celebratory fill lights volt.
                  backgroundColor: model.highlight.kind === 'pb' ? VOLT : 'rgba(241,238,231,0.1)',
                  borderWidth: 1,
                  borderColor: model.highlight.kind === 'pb' ? VOLT : 'rgba(241,238,231,0.18)',
                }}
              >
                <Text
                  className="text-base font-display-bold text-center"
                  style={{ color: model.highlight.kind === 'pb' ? '#131316' : '#F1EEE7' }}
                >
                  {model.highlight.kind === 'pb' ? '★  ' : ''}{model.highlight.message}
                </Text>
              </View>
            ) : null}

            {/* The Burn — prominent when earned (and not already the highlight) */}
            {model.burn && model.highlight?.kind !== 'burn' ? (
              <View
                className="mt-4 rounded-[20px] px-4 py-4 flex-row items-center justify-center"
                style={{ gap: 8, backgroundColor: BURN_COLOR + '26', borderWidth: 1, borderColor: BURN_COLOR + '66' }}
              >
                <Text className="font-mono text-[13px]" style={{ color: BURN_COLOR, letterSpacing: 1.4 }}>BURN</Text>
                {model.z4plusMinutes ? (
                  <Text className="text-sm font-body-medium" style={{ color: 'rgba(241,238,231,0.85)' }}>
                    {model.z4plusMinutes} min in Zone 4+
                  </Text>
                ) : null}
              </View>
            ) : null}

            {/* Key stats */}
            <View className="mt-6 flex-row" style={{ gap: 12 }}>
              <Stat label="Avg HR" value={model.avgHr ?? '—'} unit={model.avgHr ? 'bpm' : undefined} />
              <Stat label="Zone 4+" value={model.z4plusMinutes != null ? `${model.z4plusMinutes}` : '—'} unit={model.z4plusMinutes != null ? 'min' : undefined} />
              <Stat label="Calories" value={model.calories != null ? `${model.calories}` : '—'} unit={model.calories != null ? 'kcal' : undefined} />
            </View>

            {/* HR trace */}
            {tracePoints ? (
              <View className="mt-6 rounded-[20px] px-4 py-4" style={{ backgroundColor: 'rgba(241,238,231,0.06)', borderWidth: 1, borderColor: 'rgba(241,238,231,0.12)' }}>
                <Text className="font-mono text-[10px] uppercase mb-3" style={{ color: 'rgba(241,238,231,0.6)', letterSpacing: 2 }}>Your heart rate</Text>
                <Svg viewBox="0 0 600 140" width="100%" height={90} preserveAspectRatio="none">
                  <Polyline points={tracePoints} fill="none" stroke="#F1EEE7" strokeWidth={4} strokeLinejoin="round" strokeLinecap="round" />
                </Svg>
              </View>
            ) : null}
          </Animated.View>
        </ScrollView>

        {/* Closing CTAs — Share is the hero */}
        <View className="px-5 pb-2" style={{ gap: 10 }}>
          <Pressable
            onPress={handleShare}
            disabled={sharing}
            accessibilityRole="button"
            className="rounded-xl py-3.5 px-5 items-center bg-chalk"
          >
            {sharing
              ? <ActivityIndicator color="#131316" />
              : <Text className="font-display text-iron-bg">Share my session</Text>}
          </Pressable>
          <Pressable onPress={seeFullSession} hitSlop={8} className="items-center py-2">
            <Text className="text-sm font-body-medium" style={{ color: 'rgba(241,238,231,0.85)' }}>See full session</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    </View>
  )
}
