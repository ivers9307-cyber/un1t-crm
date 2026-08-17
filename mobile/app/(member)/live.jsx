// Live in-class view — the member watches their OWN heart rate / zone / UN1T
// Points in real time during a class.
//
// Data: the member's OWN open heart_rate_sessions row, read via the RLS-scoped
// Supabase client (policy heart_rate_sessions_read: contact_id =
// private.auth_contact_id()). The bridge maintains a running aggregate ON that
// row at ingest (un1t-crm mig 354 / bridge-samples.js) — zones_seconds,
// effort_points, peak/avg, live_last_bpm — so the whole live state is on ONE
// row. No hr_samples read, no new API route, no cross-repo change.
//
// Poll cadence: every 2s (matches the bridge's live-board poll and the ~1Hz
// ingest). Polling pauses while the tab/screen is unfocused.
//
// Motion: a gentle BPM pulse behind the big number + a points count-up. Both
// honour OS Reduce Motion (snap to final, no tween).

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { View, Text, Pressable, ActivityIndicator, Animated, ScrollView } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter, useFocusEffect } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { supabase } from '../../lib/member/supabase'
import { useAuth } from '../../lib/member/contact-context'
import { useReduceMotion, useCountUp } from '../../lib/member/motion'
import ZoneBar from '../../components/member/ui/ZoneBar'
import {
  liveViewModel,
  minutesToBurn,
  burnMinutes,
  formatElapsed,
} from 'shared/live-view'
import { zoneBreakdown } from 'shared/heart-rate'
import { zoneColorDark } from 'shared/zone-colors'
import { hardestZone, PEARL, VOLT } from '../../lib/member/brand'

const POLL_MS = 2000

// The Burn accent = the Zone 4 colour (Furnace on the dark canvas), tying
// the badge to the zone it rewards.
const BURN_COLOR = zoneColorDark(4)

// Columns needed by liveViewModel — the member's own row (RLS-scoped).
const LIVE_COLS =
  'id, started_at, ended_at, last_sample_at, live_last_at, live_last_bpm, ' +
  'max_hr_used, zones_seconds, effort_points, peak_hr_bpm, avg_hr_bpm, class_name'

export default function LiveScreen() {
  const { contact } = useAuth()
  const router = useRouter()
  const reduceMotion = useReduceMotion()

  const [session, setSession] = useState(null)
  const [loading, setLoading] = useState(true)
  const [now, setNow] = useState(() => Date.now())
  // Once we've seen an open session, remember its id so that when it flips to
  // `ended` (or disappears) we can still link to the finished report.
  const lastSessionIdRef = useRef(null)
  // True only while the screen is focused. fetchLive checks it after every
  // await so a request that resolves post-blur/unmount can't setState.
  const activeRef = useRef(false)

  // Fetch the member's current OPEN session (most-recent, ended_at null). If none
  // is open, fall back to the most-recent session overall so the "class complete"
  // state can link to the just-finished report.
  const fetchLive = useCallback(async () => {
    if (!contact?.id) { if (activeRef.current) { setSession(null); setLoading(false) } return }
    // Open session first.
    const { data: open } = await supabase
      .from('heart_rate_sessions')
      .select(LIVE_COLS)
      .is('ended_at', null)
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (!activeRef.current) return // blurred/unmounted while awaiting

    if (open) {
      lastSessionIdRef.current = open.id
      setSession(open)
      setLoading(false)
      return
    }

    // No open session. Only resolve the session we were actually watching this
    // mount (so a class that ends while you watch shows its "just finished"
    // state + report link). Never fall back to a random most-recent finished
    // session — that would render a stale "report on the way" for a days-old
    // class. With no watched id, show the neutral "no live session" state.
    if (!lastSessionIdRef.current) { setSession(null); setLoading(false); return }
    const { data: recent } = await supabase
      .from('heart_rate_sessions')
      .select(LIVE_COLS)
      .eq('id', lastSessionIdRef.current)
      .maybeSingle()
    if (!activeRef.current) return
    setSession(recent || null)
    setLoading(false)
  }, [contact?.id])

  // Poll every POLL_MS while focused. Also tick `now` each interval so the
  // elapsed clock + stale flag advance even if the row itself is unchanged.
  useFocusEffect(
    useCallback(() => {
      activeRef.current = true
      const tick = async () => {
        if (!activeRef.current) return
        setNow(Date.now())
        await fetchLive()
      }
      tick()
      const id = setInterval(tick, POLL_MS)
      return () => { activeRef.current = false; clearInterval(id) }
    }, [fetchLive]),
  )

  const model = useMemo(() => liveViewModel(session, now), [session, now])

  if (loading) {
    return (
      <SafeAreaView className="flex-1 bg-iron-bg items-center justify-center">
        <ActivityIndicator color="#F1EEE7" size="large" />
      </SafeAreaView>
    )
  }

  // No session ever, or a finished one → "class complete" state.
  if (!model.active || model.ended) {
    return <CompleteState model={model} sessionId={session?.id || lastSessionIdRef.current} onClose={() => router.back()} />
  }

  return <LiveActive model={model} reduceMotion={reduceMotion} onClose={() => router.back()} />
}

// ── Active live view ─────────────────────────────────────────────

function LiveActive({ model, reduceMotion, onClose }) {
  // Zone DATA colour on the dark canvas — this zone colour IS the screen's
  // accent while live (Afterglow: the accent is earned, never fixed chrome).
  const zoneColor = zoneColorDark(model.zone?.id) || '#727170'
  const zoneLabel = model.zone?.label || null // "Zone 4"
  const points = useCountUp(model.effortPoints, { reduceMotion, duration: 600 })

  return (
    <SafeAreaView className="flex-1 bg-iron-bg">
      <ScrollView contentContainerClassName="px-5 pb-10" showsVerticalScrollIndicator={false}>
        {/* Header row: class + elapsed + close */}
        <View className="mt-2 flex-row items-center justify-between">
          <View className="flex-row items-center gap-2">
            <View className="h-2 w-2 rounded-full" style={{ backgroundColor: '#FF4E42' }} />
            <Text className="font-mono text-[10px] uppercase text-chalk-2" style={{ letterSpacing: 2 }}>Training live</Text>
          </View>
          <Pressable onPress={onClose} hitSlop={10} className="active:opacity-60">
            <Ionicons name="close" size={24} color="#B3B2AC" />
          </Pressable>
        </View>

        <View className="mt-1 flex-row items-baseline justify-between">
          <Text className="text-lg font-display-bold text-chalk" numberOfLines={1}>
            {model.className || 'Your session'}
          </Text>
          <Text className="font-mono text-sm text-chalk-2">
            {formatElapsed(model.elapsedSeconds)}
          </Text>
        </View>

        {/* Big BPM in the zone colour, with a gentle pulse */}
        <View className="mt-8 items-center">
          <BpmPulse bpm={model.currentBpm} color={zoneColor} reduceMotion={reduceMotion} stale={model.stale} />
          {zoneLabel ? (
            <View className="mt-4 rounded-full px-3 py-1" style={{ backgroundColor: zoneColor + '26', borderWidth: 1, borderColor: zoneColor + '66' }}>
              <Text className="font-mono text-[11px] uppercase" style={{ color: zoneColor, letterSpacing: 1.4 }}>
                {zoneLabel}{model.zone?.name ? ` · ${model.zone.name}` : ''}
              </Text>
            </View>
          ) : (
            <Text className="mt-4 text-sm font-body text-chalk-2">Waiting for your heart rate…</Text>
          )}
          {model.stale && (
            <View className="mt-3 flex-row items-center gap-1.5">
              <Ionicons name="bluetooth-outline" size={13} color="#B3B2AC" />
              <Text className="text-xs font-body text-chalk-2">Strap reconnecting…</Text>
            </View>
          )}
        </View>

        {/* Points — an EARNED number (two-tier numeral rule): display face */}
        <View className="mt-8 flex-row items-end justify-center">
          <Text className="text-5xl font-display-black text-chalk">{points}</Text>
          <Text className="mb-1.5 ml-2 text-base font-body-semibold text-chalk-2">UN1T Points</Text>
        </View>

        {/* Burn progress */}
        <View className="mt-8">
          <BurnBlock model={model} reduceMotion={reduceMotion} />
        </View>

        {/* Zone breakdown bar + legend */}
        <View className="mt-8">
          <View className="flex-row items-center justify-between mb-2">
            <Text className="font-mono text-[10px] uppercase text-chalk-3" style={{ letterSpacing: 2 }}>Time in zones</Text>
            <View className="flex-row gap-4">
              {model.avgBpm != null && (
                <Text className="text-xs font-body text-chalk-2"><Text className="font-mono text-chalk">{model.avgBpm}</Text> avg</Text>
              )}
              {model.peakBpm != null && (
                <Text className="text-xs font-body text-chalk-2"><Text className="font-mono text-chalk">{model.peakBpm}</Text> peak</Text>
              )}
            </View>
          </View>
          <ZoneBar zonesSeconds={model.zonesSeconds} height={12} />
          <ZoneLegend zonesSeconds={model.zonesSeconds} />
        </View>
      </ScrollView>
    </SafeAreaView>
  )
}

// Big BPM number with a subtle scale pulse (roughly heartbeat-paced). Snaps to a
// static number when Reduce Motion is on or there's no live bpm.
function BpmPulse({ bpm, color, reduceMotion, stale }) {
  const scale = useRef(new Animated.Value(1)).current

  // Pace the pulse to the actual bpm (bounded), so a higher HR visibly beats
  // faster — but quantise the period into 100ms buckets. The effect keys on
  // the BUCKET, not the raw bpm: the 2s poll almost always drifts by ±1-3 bpm,
  // and restarting Animated.loop on every tick snapped the scale mid-beat
  // (visible stutter). Only a meaningful HR change retimes the beat.
  const period = bpm == null
    ? null
    : Math.max(400, Math.min(1200, Math.round(60000 / bpm / 100) * 100))

  useEffect(() => {
    if (reduceMotion || period == null || stale) {
      scale.setValue(1)
      return
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(scale, { toValue: 1.06, duration: Math.round(period * 0.25), useNativeDriver: true }),
        Animated.timing(scale, { toValue: 1.0, duration: Math.round(period * 0.75), useNativeDriver: true }),
      ]),
    )
    loop.start()
    return () => loop.stop()
  }, [period, reduceMotion, stale, scale])

  return (
    <Animated.View style={{ transform: [{ scale }], opacity: stale ? 0.45 : 1 }} className="items-center">
      <View className="flex-row items-start">
        {/* Body-sourced TELEMETRY (two-tier numeral rule): mono, zone-coloured */}
        <Text className="font-mono text-[96px] leading-none" style={{ color: bpm != null ? color : '#727170' }}>
          {bpm != null ? bpm : '––'}
        </Text>
      </View>
      <Text className="mt-1 font-mono text-[10px] uppercase" style={{ letterSpacing: 1.6, color: bpm != null ? color : '#727170' }}>bpm</Text>
    </Animated.View>
  )
}

function BurnBlock({ model, reduceMotion }) {
  if (model.isBurn) {
    const mins = burnMinutes(model.zonesSeconds)
    return (
      <View
        className="rounded-[20px] p-4"
        style={{ backgroundColor: BURN_COLOR + '1F', borderWidth: 1, borderColor: BURN_COLOR + '66' }}
      >
        <View className="flex-row items-center gap-2">
          <Text className="text-base font-display-black" style={{ color: BURN_COLOR, letterSpacing: 1 }}>BURN EARNED</Text>
        </View>
        <Text className="mt-1 text-sm font-body text-chalk-2">
          {mins} min in Zone 4+ — you've banked the Burn for this session.
        </Text>
      </View>
    )
  }

  const toGo = minutesToBurn(model.zonesSeconds)
  return (
    <View className="rounded-[20px] border border-iron-hairline bg-iron-surface p-4">
      <View className="flex-row items-center justify-between">
        <View className="flex-row items-center gap-2">
          <Text className="text-sm font-body-semibold text-chalk">Burn</Text>
        </View>
        <Text className="font-mono text-xs text-chalk-2">
          {toGo} min to go
        </Text>
      </View>
      <BurnBar progress={model.burnProgress} reduceMotion={reduceMotion} />
      <Text className="mt-2 text-xs font-body text-chalk-2">
        Spend 12 minutes in Zone 4 or 5 to earn the Burn.
      </Text>
    </View>
  )
}

// A thin progress bar toward the Burn threshold. Static width when Reduce Motion
// is on; otherwise eases toward the current fraction on each update.
function BurnBar({ progress, reduceMotion }) {
  const target = Math.max(0, Math.min(1, Number(progress) || 0))
  const anim = useRef(new Animated.Value(reduceMotion ? target : 0)).current
  const [_w, setW] = useState(0)

  useEffect(() => {
    if (reduceMotion) { anim.setValue(target); return }
    const a = Animated.timing(anim, { toValue: target, duration: 500, useNativeDriver: false })
    a.start()
    return () => a.stop()
  }, [target, reduceMotion, anim])

  const width = anim.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] })

  return (
    <View className="mt-3 h-2 rounded-full overflow-hidden" style={{ backgroundColor: BURN_COLOR + '1F' }} onLayout={(e) => setW(e.nativeEvent.layout.width)}>
      <Animated.View style={{ width, height: '100%', backgroundColor: BURN_COLOR }} />
    </View>
  )
}

function ZoneLegend({ zonesSeconds }) {
  const rows = zoneBreakdown(zonesSeconds).filter((z) => z.seconds > 0)
  if (rows.length === 0) return null
  return (
    <View className="mt-3 gap-1.5">
      {rows.map((z) => (
        <View key={z.id} className="flex-row items-center justify-between">
          <View className="flex-row items-center gap-2">
            <View className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: zoneColorDark(z.id) || z.color }} />
            <Text className="text-xs font-body text-chalk-2">{z.label} · {z.name}</Text>
          </View>
          <Text className="font-mono text-xs text-chalk-2">{Math.round(z.seconds / 60)} min</Text>
        </View>
      ))}
    </View>
  )
}

// ── Complete / no-session state ──────────────────────────────────

function CompleteState({ model, sessionId, onClose }) {
  const router = useRouter()
  const finished = model.active && model.ended
  // The accent is EARNED — a zone sustained >=3 min in the session already
  // in scope (no new fetch) lights it volt (P4b: zone-hued accents collapse
  // to volt; the ZoneLegend keeps its zone DATA colours); Pearl resting
  // identity when nothing qualifies.
  const accent = hardestZone(model.zonesSeconds) != null ? VOLT : PEARL
  return (
    <SafeAreaView className="flex-1 bg-iron-bg">
      <View className="px-5 pt-2 flex-row justify-end">
        <Pressable onPress={onClose} hitSlop={10} className="active:opacity-60">
          <Ionicons name="close" size={24} color="#B3B2AC" />
        </Pressable>
      </View>
      <View className="flex-1 items-center justify-center px-8">
        <View className="h-16 w-16 items-center justify-center rounded-full" style={{ backgroundColor: accent + '1F' }}>
          <Ionicons name={finished ? 'checkmark' : 'heart-outline'} size={30} color={accent} />
        </View>
        <Text className="mt-5 text-2xl font-display-bold text-chalk text-center">
          {finished ? 'Class complete' : 'No live session'}
        </Text>
        <Text className="mt-2 text-sm font-body text-chalk-2 text-center leading-5">
          {finished
            ? 'Nice work. Your full report is on the way — zones, UN1T Points and your Burn will land here shortly.'
            : "You're not training right now. When you pair your strap at the studio, your live heart rate and points will show up here."}
        </Text>

        {finished && sessionId ? (
          <Pressable
            onPress={() => router.replace('/sessions/' + sessionId)}
            className="mt-8 rounded-xl bg-chalk py-3 px-6 active:opacity-80"
          >
            <Text className="font-body-semibold text-iron-bg">View your session →</Text>
          </Pressable>
        ) : (
          <Pressable onPress={onClose} className="mt-8 rounded-xl bg-iron-raised py-3 px-6 active:opacity-70">
            <Text className="font-body-semibold text-chalk">Back</Text>
          </Pressable>
        )}
      </View>
    </SafeAreaView>
  )
}

