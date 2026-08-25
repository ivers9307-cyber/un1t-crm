// Coaching hub — the member's coach feedback + goals + body-composition home.
//
// Reached from the Account tab ("Coaching" row). Up to three cards:
//   1. Coach feedback   — latest note a coach shared + "All feedback ›"
//                         (omitted entirely when there's none)
//   2. Goals            — coach-set coaching_goals (read-only) + a link to
//                         the member's own self-serve targets (account/goals)
//   3. Body composition — latest InBody scan headline + "View trends ›"
//
// Goals + scans read through the member's RLS-scoped supabase client:
//   coaching_goals  → coaching_goals_self  (read-only for members)
//   inbody_scans    → inbody_scans_self     (member's own scans)
// Coach feedback reads the CRM-API route GET /api/consultations/me (crmApi
// attaches the member's Bearer JWT) — it returns ONLY feedback-bearing
// consultations, never the coach's private notes. That fetch fails
// independently: a CRM-API hiccup must not blank the goals/scan cards.
//
// Mirrors the fetch / loading / empty-state idioms in (tabs)/progress.jsx
// and account/goals.jsx.

import { useState, useCallback } from 'react'
import { View, Text, Pressable, ScrollView, ActivityIndicator, Image } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useFocusEffect, useRouter } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { supabase } from '../../../lib/member/supabase'
import { crmApi } from '../../../lib/member/api'
import Card from '../../../components/member/ui/Card'
import ErrorRetry from '../../../components/member/ErrorRetry'
import { PEARL } from '../../../lib/member/brand'

// ── Number / date formatting ─────────────────────────────────────────────────

const fmt1 = (v) => (Number.isFinite(Number(v)) ? Number(v).toFixed(1) : '—')
const fmtScore = (v) => (Number.isFinite(Number(v)) ? String(Math.round(Number(v))) : '—')

const fmtDate = (iso) => {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return ''
  return new Intl.DateTimeFormat('en-IE', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  }).format(new Date(t))
}

// First initial of the coach's name → avatar glyph; '' when there's no name.
const initial = (name) => {
  const c = String(name || '').trim().charAt(0)
  return c ? c.toUpperCase() : ''
}

// Coach-goal status → chip styling. Case-insensitive: the column default is
// 'open' (lowercase). Open = pearl accent; Achieved = muted + check; Dropped =
// muted. Anything unexpected falls through to the muted style.
function statusChip(status) {
  const s = String(status || '').toLowerCase()
  if (s === 'achieved') {
    return { label: 'Achieved', icon: 'checkmark-outline', muted: true }
  }
  if (s === 'dropped') {
    return { label: 'Dropped', icon: null, muted: true }
  }
  // 'open' and any fallback
  return { label: 'Open', icon: null, muted: false }
}

export default function Coaching() {
  const router = useRouter()
  const [loading, setLoading] = useState(true)
  const [goals, setGoals] = useState([])
  const [latestScan, setLatestScan] = useState(null)
  const [latestFeedback, setLatestFeedback] = useState(null)
  const [photos, setPhotos] = useState([])
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      // Coach feedback comes from the CRM API (not a direct table read) and
      // must fail independently — a CRM-API hiccup falls back to "no feedback"
      // (card omitted) rather than blanking the goals/scan cards. So it gets
      // its own .catch inside the Promise.all.
      const [{ data: goalRows, error: gErr }, { data: scanRows, error: sErr }, feedbackRes, photosRes] =
        await Promise.all([
          supabase
            .from('coaching_goals')
            .select('title, detail, target_value, target_date, status')
            .order('created_at', { ascending: false }),
          supabase
            .from('inbody_scans')
            .select('scanned_at, weight_kg, pbf_percent, smm_kg, bmi, bmr, body_fat_mass_kg, inbody_score')
            .order('scanned_at', { ascending: false }),
          crmApi('/api/consultations/me').catch((e) => ({ success: false, error: e?.message })),
          crmApi('/api/consultation-photos/me').catch((e) => ({ success: false, error: e?.message })),
        ])
      if (gErr) throw gErr
      if (sErr) throw sErr
      setGoals(goalRows || [])
      setLatestScan((scanRows && scanRows[0]) || null)
      // Newest-first; the hub card shows only the latest entry.
      const feedbackRows = feedbackRes?.success === false ? [] : (feedbackRes?.data || [])
      setLatestFeedback(feedbackRows[0] || null)
      const photoRows = photosRes?.success === false ? [] : (photosRes?.data || [])
      setPhotos(photoRows)
    } catch (e) {
      setError(e?.message || 'Failed to load coaching')
    } finally {
      // Silent refetch-on-focus: never blank the screen once loaded.
      setLoading(false)
    }
  }, [])

  useFocusEffect(
    useCallback(() => { load() }, [load])
  )

  if (loading) {
    return (
      <SafeAreaView className="flex-1 bg-iron-bg items-center justify-center" edges={['left', 'right']}>
        <ActivityIndicator color="#F1EEE7" size="large" />
      </SafeAreaView>
    )
  }

  // Only show the error screen on a failed INITIAL load — a transient
  // focus-refetch failure must not blank an already-rendered hub.
  if (error && !latestScan && !latestFeedback && goals.length === 0) {
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

  return (
    <SafeAreaView className="flex-1 bg-iron-bg" edges={['left', 'right']}>
      <ScrollView contentContainerClassName="p-5 pb-24" showsVerticalScrollIndicator={false}>
        <Header onBack={() => router.back()} />

        {/* Coach feedback — only when there's something to show. */}
        {latestFeedback ? (
          <View className="mt-6">
            <CoachFeedbackCard
              feedback={latestFeedback}
              onOpenAll={() => router.push('/coaching/feedback')}
            />
          </View>
        ) : null}

        <View className={latestFeedback ? 'mt-4' : 'mt-6'}>
          <GoalsCard goals={goals} onOpenTargets={() => router.push('/account/goals')} />
        </View>

        <View className="mt-4">
          <BodyCompositionCard scan={latestScan} onOpenTrends={() => router.push('/coaching/inbody')} />
        </View>

        {/* Progress photos — only when the member has any (no upload yet). */}
        {photos.length > 0 ? (
          <View className="mt-4">
            <ProgressPhotosCard photos={photos} onOpenAll={() => router.push('/coaching/photos')} />
          </View>
        ) : null}
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
      <Text className="text-2xl font-display-bold text-chalk">Coaching</Text>
      <Text className="mt-1 text-sm text-chalk-2">Your goals and body scans.</Text>
    </View>
  )
}

// ── Coach feedback card ──────────────────────────────────────────────────────

// Shows the single latest coach note: initials avatar + coach name + date,
// the feedback text, then a "From your coach" pill and an "All feedback ›"
// affordance into the full history. Rendered only when feedback exists.
function CoachFeedbackCard({ feedback, onOpenAll }) {
  const glyph = initial(feedback.coach_name)
  return (
    <Card>
      <View className="flex-row items-center" style={{ gap: 12 }}>
        <View
          className="h-9 w-9 items-center justify-center rounded-full"
          style={{ backgroundColor: 'rgba(214,210,201,0.16)' }}
        >
          {glyph ? (
            <Text className="text-sm font-display-bold" style={{ color: PEARL }}>{glyph}</Text>
          ) : (
            <Ionicons name="person-outline" size={16} color={PEARL} />
          )}
        </View>
        <View className="flex-1 min-w-0">
          <Text className="text-sm font-body-semibold text-chalk" numberOfLines={1}>
            {feedback.coach_name || 'Your coach'}
            <Text className="text-chalk-3"> · Coach</Text>
          </Text>
        </View>
        <Text className="font-mono text-xs text-chalk-2 shrink-0">{fmtDate(feedback.consulted_at)}</Text>
      </View>

      <Text className="mt-3 text-sm leading-5 text-chalk-2">{feedback.member_feedback}</Text>

      <View className="mt-4 flex-row items-center justify-between" style={{ gap: 12 }}>
        <View className="rounded-full border border-iron-hairline bg-iron-raised px-2.5 py-0.5">
          <Text className="font-mono text-[10px] uppercase text-chalk-2" style={{ letterSpacing: 1.2 }}>From your coach</Text>
        </View>
        <Pressable onPress={onOpenAll} hitSlop={8} className="active:opacity-60">
          <Text className="text-sm font-body-semibold" style={{ color: PEARL }}>All feedback ›</Text>
        </Pressable>
      </View>
    </Card>
  )
}

// ── Goals card ───────────────────────────────────────────────────────────────

function GoalsCard({ goals, onOpenTargets }) {
  return (
    <Card>
      <Text className="text-base font-display text-chalk">Goals</Text>

      {/* From your coach (read-only) */}
      <Text className="mt-4 font-mono text-[10px] uppercase text-chalk-3" style={{ letterSpacing: 2 }}>
        From your coach
      </Text>
      {goals.length === 0 ? (
        <Text className="mt-2 text-sm text-chalk-2">
          Your coach hasn't set any goals yet.
        </Text>
      ) : (
        <View className="mt-2" style={{ gap: 0 }}>
          {goals.map((g, i) => (
            <CoachGoalRow key={`${g.title}-${i}`} goal={g} first={i === 0} />
          ))}
        </View>
      )}

      {/* Divider */}
      <View className="my-4 h-px bg-iron-hairline" />

      {/* Set by you → self-serve targets editor */}
      <Text className="font-mono text-[10px] uppercase text-chalk-3" style={{ letterSpacing: 2 }}>
        Set by you
      </Text>
      <Pressable
        onPress={onOpenTargets}
        className="mt-2 flex-row items-center gap-3 rounded-xl border border-iron-hairline bg-iron-raised px-4 py-3.5 active:opacity-70"
      >
        <Ionicons name="flag-outline" size={18} color="#B3B2AC" />
        <View className="flex-1">
          <Text className="text-sm font-body-medium text-chalk">Weekly targets</Text>
          <Text className="mt-0.5 text-xs text-chalk-2">
            Set your own goals and watch them tick up every class.
          </Text>
        </View>
        <Ionicons name="chevron-forward-outline" size={18} color="#727170" />
      </Pressable>
    </Card>
  )
}

function CoachGoalRow({ goal, first }) {
  const chip = statusChip(goal.status)
  return (
    <View
      className={`flex-row items-center justify-between py-3${first ? '' : ' border-t border-iron-hairline'}`}
      style={{ gap: 12 }}
    >
      <View className="flex-row items-center flex-1 min-w-0" style={{ gap: 10 }}>
        <Ionicons name="locate-outline" size={18} color={PEARL} />
        <Text className="flex-1 text-sm font-body-medium text-chalk" numberOfLines={2}>
          {goal.title || 'Goal'}
        </Text>
      </View>
      <StatusChip chip={chip} />
    </View>
  )
}

function StatusChip({ chip }) {
  if (chip.muted) {
    return (
      <View className="flex-row items-center rounded-full border border-iron-hairline bg-iron-raised px-2.5 py-0.5" style={{ gap: 4 }}>
        {chip.icon ? <Ionicons name={chip.icon} size={12} color="#B3B2AC" /> : null}
        <Text className="font-mono text-[10px] uppercase text-chalk-2" style={{ letterSpacing: 1.2 }}>{chip.label}</Text>
      </View>
    )
  }
  return (
    <View
      className="flex-row items-center rounded-full px-2.5 py-0.5"
      style={{ gap: 4, borderWidth: 1, borderColor: 'rgba(214,210,201,0.45)' }}
    >
      <Text className="font-mono text-[10px] uppercase" style={{ color: PEARL, letterSpacing: 1.2 }}>{chip.label}</Text>
    </View>
  )
}

// ── Body composition card ────────────────────────────────────────────────────

function BodyCompositionCard({ scan, onOpenTrends }) {
  return (
    <Card>
      <View className="flex-row items-center justify-between" style={{ gap: 12 }}>
        <Text className="text-base font-display text-chalk">Body composition</Text>
        {scan ? (
          <Pressable onPress={onOpenTrends} hitSlop={8} className="active:opacity-60">
            <Text className="text-sm font-body-semibold" style={{ color: PEARL }}>View trends ›</Text>
          </Pressable>
        ) : null}
      </View>

      {!scan ? (
        <Text className="mt-3 text-sm text-chalk-2">
          No scans yet — ask a coach to scan you on the InBody.
        </Text>
      ) : (
        <View className="mt-4 flex-row items-stretch">
          <MiniStat label="Weight" value={fmt1(scan.weight_kg)} unit="kg" />
          <Divider />
          <MiniStat label="Body fat" value={fmt1(scan.pbf_percent)} unit="%" />
          <Divider />
          <MiniStat label="InBody" value={fmtScore(scan.inbody_score)} accent />
        </View>
      )}
    </Card>
  )
}

function MiniStat({ label, value, unit, accent }) {
  return (
    <View className="flex-1 items-center">
      <Text className="font-mono text-[10px] uppercase text-chalk-3" style={{ letterSpacing: 2 }}>{label}</Text>
      <View className="mt-1 flex-row items-baseline">
        <Text
          className="text-xl font-mono"
          style={accent ? { color: PEARL } : { color: '#F1EEE7' }}
        >
          {value}
        </Text>
        {unit ? <Text className="ml-1 font-mono text-[10px] uppercase text-chalk-3" style={{ letterSpacing: 1 }}>{unit}</Text> : null}
      </View>
    </View>
  )
}

function Divider() {
  return <View style={{ width: 1, backgroundColor: '#24242A', marginHorizontal: 4 }} />
}

// ── Progress photos card ─────────────────────────────────────────────────────

// A strip of up to 4 thumbnails into the full gallery; the 4th tile shows a
// "+N" overlay when there are more. Empty tiles pad the row so a lone photo
// stays thumbnail-sized. Rendered only when the member has photos.
function ProgressPhotosCard({ photos, onOpenAll }) {
  const shown = photos.slice(0, 4)
  const extra = photos.length - shown.length
  const pad = Math.max(0, 4 - shown.length)
  return (
    <Card>
      <View className="flex-row items-center justify-between" style={{ gap: 12 }}>
        <Text className="text-base font-display text-chalk">Progress photos</Text>
        <Pressable onPress={onOpenAll} hitSlop={8} className="active:opacity-60">
          <Text className="text-sm font-body-semibold" style={{ color: PEARL }}>View all ›</Text>
        </Pressable>
      </View>
      <View className="mt-4 flex-row" style={{ gap: 8 }}>
        {shown.map((p, i) => (
          <Pressable key={p.id || i} onPress={onOpenAll} className="flex-1 active:opacity-80">
            <View className="rounded-[12px] overflow-hidden bg-iron-raised" style={{ aspectRatio: 1 }}>
              {p.url ? (
                <Image source={{ uri: p.url }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
              ) : (
                <View className="flex-1 items-center justify-center">
                  <Ionicons name="image-outline" size={18} color="#727170" />
                </View>
              )}
              {i === shown.length - 1 && extra > 0 ? (
                <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.55)' }}>
                  <Text className="text-base font-body-semibold text-chalk">+{extra}</Text>
                </View>
              ) : null}
            </View>
          </Pressable>
        ))}
        {Array.from({ length: pad }).map((_, i) => (
          <View key={`pad-${i}`} className="flex-1" />
        ))}
      </View>
    </Card>
  )
}
