// CLASS-TIMER PR3 — mobile coach control. Mirror of the web TimerControlClient:
// pick a template (or quick-add a preset), Start, then Pause/Resume/Skip/Stop.
// Uses the SAME pure engine (shared/class-timer) the TV banner + web control
// use — the server stores authoritative run state (started_at + pause/skip
// offsets) and never streams the clock; this computes the live tick locally
// (250ms) and corrects on the 2s /active poll.
//
// Gated by class_timer — a CROSS_PLATFORM_KEY, the same toggle as the web
// Class timer page (CLASS-TIMER-PERM.1: split off studio_management so coaches
// on shift can run the timer without holding door unlock). The server
// independently enforces the same permission on start/control as defence in depth.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { View, Text, Pressable, ScrollView, ActivityIndicator, Alert } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useFocusEffect, useRouter } from 'expo-router'
import { useAuth } from '../../../lib/auth-context'
import { canMobile } from '../../../lib/permissions'
import { supabase } from '../../../lib/supabase'
import {
  buildTimeline,
  computeEffectiveElapsedMs,
  resolveTimerState,
  SEG_COLOR,
} from 'shared/class-timer'
import {
  listTimerTemplates,
  createTimerTemplate,
  getActiveTimer,
  startTimer,
  controlTimer,
} from '../../../lib/timer-api'

const POLL_MS = 2000

// Same seed structures as the web control (TimerControlClient PRESETS) so a
// coach can run a common format before authoring a custom one on the web editor.
const PRESETS = [
  { name: 'Tabata — 8 × (20/10)', structure: [
    { kind: 'segment', label: 'Get ready', type: 'prep', seconds: 10 },
    { kind: 'round', count: 8, segments: [
      { label: 'Work', type: 'work', seconds: 20 },
      { label: 'Rest', type: 'rest', seconds: 10 },
    ] },
  ] },
  { name: 'Intervals — 10 × (45/15)', structure: [
    { kind: 'segment', label: 'Get ready', type: 'prep', seconds: 10 },
    { kind: 'round', count: 10, segments: [
      { label: 'Work', type: 'work', seconds: 45 },
      { label: 'Rest', type: 'rest', seconds: 15 },
    ] },
  ] },
  { name: 'EMOM — 10 min', structure: [
    { kind: 'round', count: 10, segments: [{ label: 'Minute', type: 'work', seconds: 60 }] },
  ] },
  { name: '32 min — 2 × 16 (45/15) + water', structure: [
    { kind: 'round', count: 16, segments: [
      { label: 'Work', type: 'work', seconds: 45 },
      { label: 'Rest', type: 'rest', seconds: 15 },
    ] },
    { kind: 'segment', label: 'Water break', type: 'rest', seconds: 120 },
    { kind: 'round', count: 16, segments: [
      { label: 'Work', type: 'work', seconds: 45 },
      { label: 'Rest', type: 'rest', seconds: 15 },
    ] },
  ] },
]

export default function TimerScreen() {
  const { profile, activeLocation } = useAuth()
  const router = useRouter()
  const locationId = activeLocation?.id
  const allowed = canMobile(profile, 'class_timer', activeLocation)

  const [templates, setTemplates] = useState([])
  const [run, setRun] = useState(null)
  const [suggestion, setSuggestion] = useState(null) // { className, template } | null
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const pollRef = useRef(null)

  const loadTemplates = useCallback(async () => {
    if (!locationId) return
    const r = await listTimerTemplates(locationId)
    if (r.success) setTemplates(r.templates || [])
  }, [locationId])

  const loadActive = useCallback(async () => {
    if (!locationId) return
    const r = await getActiveTimer(locationId)
    if (r.success) {
      setRun(r.run || null)
      setSuggestion(!r.run && r.suggested_template
        ? { className: r.live_class?.class_name, template: r.suggested_template }
        : null)
    }
  }, [locationId])

  useEffect(() => {
    if (!allowed) return
    setLoading(true)
    Promise.all([loadTemplates(), loadActive()]).finally(() => setLoading(false))
    pollRef.current = setInterval(loadActive, POLL_MS)
    return () => clearInterval(pollRef.current)
  }, [allowed, loadTemplates, loadActive])

  // TIMER-PUSH.1 — realtime nudge: the timer routes broadcast on
  // `timer:<locationId>` after every start/pause/resume/skip/stop, so this
  // screen reflects another device's action immediately instead of waiting
  // out the 2s poll (which stays as the fallback).
  useEffect(() => {
    if (!allowed || !locationId) return undefined
    const chan = supabase.channel(`timer:${locationId}`)
    chan.on('broadcast', { event: 'timer' }, () => loadActive())
    chan.subscribe()
    return () => { supabase.removeChannel(chan) }
  }, [allowed, locationId, loadActive])

  // Refresh on focus (a master could start/stop a run from web or another
  // device while this screen is backgrounded).
  useFocusEffect(useCallback(() => {
    if (allowed) { loadTemplates(); loadActive() }
  }, [allowed, loadTemplates, loadActive]))

  // Permission gate — defence in depth. The Studio tile hides the link without
  // access, but a hand-typed deep link would otherwise reach this screen.
  if (!allowed) {
    return (
      <View className="flex-1 bg-un1t-bg items-center justify-center p-6">
        <Text className="text-sm text-un1t-subtle text-center">
          Studio Management isn&apos;t enabled for your role at this location.
        </Text>
        <Pressable onPress={() => router.back()} className="mt-4">
          <Text className="text-sm text-blue-600">Back</Text>
        </Pressable>
      </View>
    )
  }

  async function quickAddPreset(preset) {
    setBusy(true); setError(null)
    const r = await createTimerTemplate(locationId, preset.name, preset.structure)
    setBusy(false)
    if (!r.success) { setError(r.error || 'Could not create timer'); return }
    loadTemplates()
  }

  async function start(templateId) {
    setBusy(true); setError(null)
    const r = await startTimer(locationId, templateId)
    setBusy(false)
    if (!r.success) { setError(r.error || 'Could not start'); return }
    setRun(r.run)
  }

  async function onControl(action, direction) {
    if (!run) return
    setBusy(true); setError(null)
    const r = await controlTimer(run.id, action, direction, locationId)
    setBusy(false)
    if (!r.success) { setError(r.error || 'Action failed'); return }
    setRun(r.run?.status === 'stopped' ? null : r.run)
  }

  const existingNames = new Set(templates.map((t) => t.name))

  return (
    <ScrollView className="flex-1 bg-un1t-bg" contentContainerClassName="p-4 gap-4">
      {error && (
        <View className="bg-red-500/10 border border-red-500/30 rounded-xl p-3">
          <Text className="text-xs text-red-700">{error}</Text>
        </View>
      )}

      {loading ? (
        <View className="py-10 items-center"><ActivityIndicator color="#94A3B8" /></View>
      ) : run ? (
        <RunControl run={run} busy={busy} onControl={onControl} />
      ) : (
        <>
          {suggestion && (
            <Pressable
              onPress={() => start(suggestion.template.id)} disabled={busy}
              className="border-2 border-emerald-300 bg-emerald-50 rounded-2xl p-4 flex-row items-center justify-between active:opacity-80 disabled:opacity-50"
            >
              <View className="flex-1 min-w-0 pr-3">
                <Text className="text-sm font-semibold text-emerald-800" numberOfLines={1}>
                  {suggestion.className} is on now
                </Text>
                <Text className="text-xs text-emerald-700 mt-0.5" numberOfLines={1}>
                  Load “{suggestion.template?.name}”?
                </Text>
              </View>
              <View className="flex-row items-center bg-emerald-600 rounded-xl px-3 py-2">
                <Ionicons name="play" size={14} color="#FFFFFF" />
                <Text className="text-sm font-semibold text-white ml-1.5">Load</Text>
              </View>
            </Pressable>
          )}
          <View className="bg-un1t-surface border border-un1t-border rounded-2xl p-4">
            <Text className="text-sm font-semibold text-un1t-text mb-1">Start a timer</Text>
            {templates.length === 0 ? (
              <Text className="text-sm text-un1t-subtle">
                No timers yet — quick-add a preset below, or build a custom one on the web app
                under Studio Management → Class timer.
              </Text>
            ) : (
              <View className="gap-1 mt-2">
                {templates.map((t) => (
                  <View key={t.id} className="flex-row items-center justify-between gap-3 py-2">
                    <View className="min-w-0 flex-1">
                      <Text className="text-sm font-medium text-un1t-text" numberOfLines={1}>{t.name}</Text>
                      <Text className="text-xs text-un1t-subtle">{fmtClock((t.total_seconds || 0) * 1000)} total</Text>
                    </View>
                    <Pressable
                      onPress={() => start(t.id)} disabled={busy}
                      className="bg-emerald-600 active:opacity-80 disabled:opacity-50 px-4 py-2 rounded-xl flex-row items-center"
                    >
                      <Ionicons name="play" size={14} color="#FFFFFF" />
                      <Text className="text-sm font-semibold text-white ml-1.5">Start</Text>
                    </Pressable>
                  </View>
                ))}
              </View>
            )}
          </View>

          <View className="bg-un1t-surface border border-un1t-border rounded-2xl p-4">
            <Text className="text-sm font-semibold text-un1t-text">Quick add a preset</Text>
            <Text className="text-xs text-un1t-subtle mt-0.5 mb-2">
              Seed a common format, then tweak it on the web editor.
            </Text>
            <View className="gap-2">
              {PRESETS.map((p) => {
                const exists = existingNames.has(p.name)
                return (
                  <Pressable
                    key={p.name} onPress={() => quickAddPreset(p)} disabled={busy || exists}
                    className="border border-un1t-border rounded-xl px-3 py-2.5 flex-row items-center active:opacity-70 disabled:opacity-40"
                  >
                    <Ionicons name={exists ? 'checkmark-circle' : 'add-circle-outline'} size={16} color="#94A3B8" />
                    <Text className="text-sm font-medium text-un1t-text ml-2">{p.name}{exists ? '  ✓' : ''}</Text>
                  </Pressable>
                )
              })}
            </View>
          </View>
        </>
      )}
    </ScrollView>
  )
}

function RunControl({ run, busy, onControl }) {
  const timeline = useMemo(
    () => (run?.structure_snapshot ? buildTimeline(run.structure_snapshot) : null),
    [run],
  )
  // Local 250ms tick so the countdown moves between 2s polls. The coach device
  // clock is online + fine for control (the TV anchors on server_time instead).
  const [, force] = useState(0)
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 250)
    return () => clearInterval(t)
  }, [])
  if (!timeline) return null
  const st = resolveTimerState(timeline, computeEffectiveElapsedMs(run, Date.now()))
  const paused = run.status === 'paused'
  const tint = st.currentStep ? (SEG_COLOR[st.currentStep.type] || '#64748B') : '#64748B'

  return (
    <View className="gap-4">
      <View
        className="rounded-2xl p-5 border-2"
        style={{ borderColor: `${tint}66`, backgroundColor: `${tint}14` }}
      >
        <View className="flex-row items-center justify-between">
          <Text className="text-sm font-semibold text-un1t-text flex-1" numberOfLines={1}>{run.name || 'Class timer'}</Text>
          {paused && (
            <Text className="text-[11px] font-semibold text-amber-700 bg-amber-500/15 px-2 py-0.5 rounded-full">Paused</Text>
          )}
        </View>

        <Text
          className="text-6xl font-bold text-un1t-text mt-3"
          style={{ fontVariant: ['tabular-nums'], color: st.finished ? '#111827' : tint }}
        >
          {st.finished ? 'Done' : fmtClock(st.segmentRemainingMs)}
        </Text>
        {!st.finished && (
          <Text className="text-lg font-medium text-un1t-text mt-1">{st.currentStep?.label}</Text>
        )}
        <Text className="text-xs text-un1t-subtle mt-1.5">
          {st.roundCount ? `Round ${st.roundIndex}/${st.roundCount}  ·  ` : ''}
          {st.nextStep && !st.finished ? `next: ${st.nextStep.label} ${fmtClock(st.nextStep.seconds * 1000)}  ·  ` : ''}
          {fmtClock(st.totalElapsedMs)} / {fmtClock(st.totalRemainingMs)} total
        </Text>
      </View>

      <View className="flex-row items-center gap-2">
        <Pressable onPress={() => onControl('skip', 'prev')} disabled={busy}
          className="flex-1 border border-un1t-border rounded-xl px-3 py-3 flex-row items-center justify-center active:opacity-70 disabled:opacity-50">
          <Ionicons name="play-skip-back" size={16} color="#64748B" />
          <Text className="text-sm font-semibold text-un1t-text ml-1.5">Prev</Text>
        </Pressable>
        {paused ? (
          <Pressable onPress={() => onControl('resume')} disabled={busy}
            className="flex-1 bg-emerald-600 rounded-xl px-3 py-3 flex-row items-center justify-center active:opacity-80 disabled:opacity-50">
            <Ionicons name="play" size={16} color="#FFFFFF" />
            <Text className="text-sm font-semibold text-white ml-1.5">Resume</Text>
          </Pressable>
        ) : (
          <Pressable onPress={() => onControl('pause')} disabled={busy}
            className="flex-1 bg-un1t-accent rounded-xl px-3 py-3 flex-row items-center justify-center active:opacity-90 disabled:opacity-50">
            <Ionicons name="pause" size={16} color="#FFFFFF" />
            <Text className="text-sm font-semibold text-white ml-1.5">Pause</Text>
          </Pressable>
        )}
        <Pressable onPress={() => onControl('skip', 'next')} disabled={busy}
          className="flex-1 border border-un1t-border rounded-xl px-3 py-3 flex-row items-center justify-center active:opacity-70 disabled:opacity-50">
          <Text className="text-sm font-semibold text-un1t-text mr-1.5">Next</Text>
          <Ionicons name="play-skip-forward" size={16} color="#64748B" />
        </Pressable>
      </View>

      <Pressable onPress={() => confirmStop(onControl)} disabled={busy}
        className="bg-red-500/15 border border-red-500/30 rounded-xl px-3 py-3 flex-row items-center justify-center active:opacity-70 disabled:opacity-50">
        <Ionicons name="stop" size={16} color="#DC2626" />
        <Text className="text-sm font-semibold text-red-700 ml-1.5">Stop timer</Text>
      </Pressable>
    </View>
  )
}

function confirmStop(onControl) {
  Alert.alert('Stop the timer?', 'This ends the live run on the TV.', [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Stop', style: 'destructive', onPress: () => onControl('stop') },
  ])
}

// ms → "m:ss"
function fmtClock(ms) {
  const total = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}
