// Home dashboard — the "how am I doing / what's next" screen (Wave 4 rework).
//
// Layout, top→bottom:
//   1. Tier hero band  — big tier name, animated progress ring, tier-colour glow
//   2. Streak          — ALWAYS visible, weeks-based, even at zero
//   3. What's next      — one best-effort prompt (challenge ending / pts to target / usual day)
//   4. Latest session   — zone bar + Burn badge
//   5. Recent + Achievements + Goals (secondary)
//   6. Nudges (profile / Apple-Health / connect-device) — DEMOTED below training,
//      dismissible, and connect-device only shows to members with no sessions.
//
// Data loading is unchanged from the previous dashboard (tier-status, challenge,
// social teasers, recent sessions, 120d streak source, achievements, goals).
// RLS scopes all Supabase reads to the signed-in member.

import { useState, useCallback, useRef, useMemo, useEffect } from 'react'
import { View, Text, Pressable, ActivityIndicator, ScrollView, Animated } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useFocusEffect, useRouter } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useAuth } from '../../../lib/member/contact-context'
import { supabase } from '../../../lib/member/supabase'
import { api } from '../../../lib/member/api'
import { crmApi } from '../../../lib/member/api'
import Card from '../../../components/member/ui/Card'
import ErrorRetry from '../../../components/member/ErrorRetry'
import JourneyCard from '../../../components/member/JourneyCard'
import ZoneBar from '../../../components/member/ui/ZoneBar'
import { GOAL_DEFS, computeProgress } from 'shared/goals'
import { shapeJourneyCard } from 'shared/onboarding-journey'
import { sourceLabel, durationMinutes, sessionDate } from 'shared/format'
import { weeklyStreak } from 'shared/hr-analytics'
import { isBurn } from 'shared/heart-rate'
import { dublinDateKey, dublinWeekStartMs, DUBLIN_DAY_MS } from 'shared/dublin-time'
import ProfileCompletionPrompt from '../../../components/member/ProfileCompletionPrompt'
import AppleHealthResyncCard from '../../../components/member/AppleHealthResyncCard'
import { accentFromSessions, hardestZone, PEARL } from '../../../lib/member/brand'
import { zoneColorDark } from 'shared/zone-colors'
import PosterHeader from '../../../components/member/ui/PosterHeader'
import Pips from '../../../components/member/ui/Pips'
import WeekRing from '../../../components/member/ui/WeekRing'
import { EarnedNumber } from '../../../components/member/ui/Type'
import { useReduceMotion, useCountUp } from '../../../lib/member/motion'
import { toKudosView, kudosRelativeTime, isUnseen } from 'shared/coach-kudos'
import { weekDigestModel } from 'shared/week-digest'
import { hasSeenWeekDigest, markWeekDigestSeen } from '../../../lib/member/week-digest-seen'


export default function Home() {
  const { contact } = useAuth()
  const router = useRouter()
  const firstName = contact?.name?.split(' ')[0] || 'there'
  const reduceMotion = useReduceMotion()

  const [loading, setLoading] = useState(true)
  const [sessions, setSessions] = useState([])
  const [accentSessions, setAccentSessions] = useState([]) // trailing-7d zones window
  const [activeGoals, setActiveGoals] = useState([])
  const [goalSessions, setGoalSessions] = useState([])
  const [latestAch, setLatestAch] = useState([])
  const [totalUnlocked, setTotalUnlocked] = useState(0)
  const [totalRules, setTotalRules] = useState(0)
  const [streak, setStreak] = useState({ current: 0, best: 0, thisWeekCount: 0, minPerWeek: 1 })
  const [tierStatus, setTierStatus] = useState(null)
  const [teaserChallenge, setTeaserChallenge] = useState(null)
  // Set but never rendered in champ either (dead teaser remnant) — kept as
  // state so the loader logic is untouched; _-prefixed for the stricter CRM lint.
  const [_socialTeaser, setSocialTeaser] = useState(null)
  const [connectDismissed, setConnectDismissed] = useState(false)
  const [liveSession, setLiveSession] = useState(null)
  const [latestKudos, setLatestKudos] = useState(null)
  const [weekDigest, setWeekDigest] = useState(null) // last-week recap model, or null
  const [journey, setJourney] = useState(null)
  const [error, setError] = useState(null)
  const initialisedRef = useRef(false)
  const loadingRef = useRef(false)

  const load = useCallback(async () => {
    if (!contact?.id) { setLoading(false); return }
    if (loadingRef.current) return
    loadingRef.current = true
    // Spinner only on the FIRST load — focus refetches are silent so returning
    // to the tab never re-blanks an already-rendered screen (matches progress.jsx).
    if (!initialisedRef.current) setLoading(true)
    setError(null)

    // Kick the secondary teaser calls off NOW so they run concurrently with the
    // core batch below. Each is best-effort (resolves to null on failure → that
    // tile just stays hidden).
    const tierP = api('/api/tier-status').catch(() => null)
    const challengeP = api('/api/challenges').catch(() => null)
    // First-6-weeks journey — computed by un1t-crm (crmApi, not api). Strictly
    // fail-invisible: any error / non-success / out-of-window response resolves
    // to null and the card simply doesn't render.
    const journeyP = crmApi('/api/me/journey')
      .then((r) => (r?.success ? r.data?.journey ?? null : null))
      .catch(() => null)
    const socialP = api('/api/social/requests')
      .catch(() => null)
      .then(async (sr) => {
        if (!sr || sr.disabled || !sr.ok) return null
        const incomingCount = (sr.incoming || []).length
        let latestItem = null
        if (!incomingCount) {
          const sf = await api('/api/social/feed?limit=1').catch(() => null)
          const item = sf?.items?.[0]
          if (item) latestItem = { who: item.who, className: item.className || null, achievementName: item.name || null }
        }
        return { incomingCount, latestItem }
      })
      .catch(() => null)

    // Weekly digest — the "Your week" recap card for the week that just ended.
    // Best-effort + concurrent: last-week own sessions (RLS-scoped) plus last
    // week's friends-league finish (hidden gracefully with no friends / on
    // error). Resolves to a model only when there's content AND it hasn't been
    // seen this ISO week; otherwise null → the card simply doesn't render.
    const digestP = (async () => {
      const nowMs = Date.now()
      // Last completed Dublin week window (half-open UTC ms). Re-derive last
      // week's Monday through dublinWeekStartMs so a DST week stays exact.
      const thisWeekStartMs = dublinWeekStartMs(nowMs)
      const lastWeekStartIso = new Date(dublinWeekStartMs(thisWeekStartMs - DUBLIN_DAY_MS)).toISOString()
      const thisWeekStartIso = new Date(thisWeekStartMs).toISOString()

      const [{ data: rows }, board] = await Promise.all([
        supabase
          .from('heart_rate_sessions')
          .select('started_at, ended_at, effort_points, zones_seconds')
          .not('ended_at', 'is', null)
          .gte('started_at', lastWeekStartIso)
          .lt('started_at', thisWeekStartIso)
          .order('started_at', { ascending: false }),
        // Friends-league finish. Hidden when disabled / no friends / on error.
        api('/api/social/leaderboard?window=lastweek')
          .then((r) => (r && r.ok && !r.disabled ? r.board : null))
          .catch(() => null),
      ])

      const leagueFinish = board?.me && board.rows && board.rows.length > 1
        ? { rank: board.me.rank, of: board.rows.length }
        : null

      const model = weekDigestModel(rows || [], nowMs, { leagueFinish })
      if (!model.hasContent) return null // never show an empty recap
      if (await hasSeenWeekDigest(model.weekKey)) return null // once per ISO week
      return model
    })().catch(() => null)

    try {
      const goalsSinceIso = new Date(Date.now() - 35 * 24 * 3600 * 1000).toISOString()

      const results = await Promise.all([
        // 1. Recent 3 sessions (same columns as web dashboard)
        supabase
          .from('heart_rate_sessions')
          .select('id, started_at, ended_at, source, peak_hr_bpm, zones_seconds, effort_points')
          .order('started_at', { ascending: false })
          .limit(3),

        // 2a. Active goals
        supabase
          .from('contact_goals')
          .select('id, kind, target_value')
          .eq('contact_id', contact.id)
          .eq('is_active', true)
          .is('archived_at', null),

        // 2b. 35d sessions for goal progress
        supabase
          .from('heart_rate_sessions')
          .select('started_at, effort_points')
          .not('ended_at', 'is', null)
          .gte('started_at', goalsSinceIso),

        // 3a. Latest 3 achievement unlocks
        supabase
          .from('contact_achievements')
          .select('id, earned_at, rule:achievement_rules(name, icon)')
          .eq('contact_id', contact.id)
          .order('earned_at', { ascending: false })
          .limit(3),

        // 3b. Count of unlocked achievements
        supabase
          .from('contact_achievements')
          .select('id', { count: 'exact', head: true })
          .eq('contact_id', contact.id),

        // 3c. Count of active achievement rules
        supabase
          .from('achievement_rules')
          .select('id', { count: 'exact', head: true })
          .eq('is_active', true),

        // 4. Streak source — distinct training days over last 120 days
        supabase
          .from('heart_rate_sessions')
          .select('started_at')
          .not('ended_at', 'is', null)
          .gte('started_at', new Date(Date.now() - 120 * 24 * 3600 * 1000).toISOString())
          .order('started_at', { ascending: false }),

        // 5. Most-recent Coach Kudos (shout-out from a coach). RLS scopes to
        //    self; explicit eq mirrors the achievements reads above.
        supabase
          .from('coach_kudos')
          .select('id, message, emoji, sender_name, created_at, seen_at')
          .eq('contact_id', contact.id)
          .order('created_at', { ascending: false })
          .limit(1),

        // 6. Afterglow accent window — the FULL trailing 7 days of zones
        //    (time-bounded, not row-capped: an auto-synced member can push 10+
        //    rows in two days, which would truncate a row-limited window).
        //    Feeds accentFromSessions + the streak week-pips only.
        supabase
          .from('heart_rate_sessions')
          .select('started_at, zones_seconds')
          .gte('started_at', new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString())
          .order('started_at', { ascending: false }),
      ])

      // supabase-js NEVER throws — every result (network failure included) is
      // { data: null, error }. Without this check one flaky request rendered a
      // convincing but EMPTY dashboard ("No sessions yet", 0/0 achievements)
      // with no retry path, because the catch below was unreachable (re-audit
      // A2). Every sibling screen throws on error; Home now matches. On a
      // focus refetch this sets `error` but the already-rendered screen keeps
      // its data (the error view only shows when sessions is empty).
      const firstErr = results.find((r) => r?.error)?.error
      if (firstErr) throw firstErr

      const [
        { data: recent },
        { data: goals },
        { data: gSessions },
        { data: latest },
        { count: unlocked },
        { count: total },
        { data: streakRows },
        { data: kudosRows },
        { data: accentRows },
      ] = results

      setSessions(recent || [])
      setAccentSessions(accentRows || [])
      setActiveGoals(goals || [])
      setGoalSessions(gSessions || [])
      setLatestAch(latest || [])
      const safeTotal = total || 0
      setTotalUnlocked(Math.min(unlocked || 0, safeTotal))
      setTotalRules(safeTotal)
      // Weeks-based streak (consecutive weeks with >=1 session) — this is the
      // habit metric the hero leads with, and it stays visible even at zero.
      setStreak(weeklyStreak(streakRows || []))
      setLatestKudos((kudosRows && kudosRows[0]) || null)

      // Await the teasers (kicked off above, concurrent with this batch) and set
      // them in the SAME render pass — the whole dashboard appears at once.
      const [t, c, social, digest, j] = await Promise.all([tierP, challengeP, socialP, digestP, journeyP])
      setTierStatus(t?.status || null)
      setTeaserChallenge((c?.challenges || []).find((ch) => ch.phase === 'active') || null)
      setSocialTeaser(social)
      setWeekDigest(digest)
      setJourney(j)

      // Mark initialised on SUCCESS only.
      initialisedRef.current = true
    } catch (e) {
      setError(e?.message || 'Failed to load')
    } finally {
      loadingRef.current = false
      setLoading(false)
    }
  }, [contact?.id])

  useFocusEffect(
    useCallback(() => {
      load()
    }, [load])
  )

  // Live-session banner poll — a light, dedicated check for the member's OWN
  // OPEN session so the "You're training" banner appears/disappears in near-real
  // time while they're in class. RLS scopes this to the signed-in member. Polls
  // every 15s WHILE the Home tab is focused; the /live screen owns the fast 2s
  // poll once they tap through. Best-effort — a blip just leaves the banner as-is.
  useFocusEffect(
    useCallback(() => {
      if (!contact?.id) return
      let cancelled = false
      const check = async () => {
        const { data, error } = await supabase
          .from('heart_rate_sessions')
          .select('id, class_name, started_at')
          .is('ended_at', null)
          .order('started_at', { ascending: false })
          .limit(1)
          .maybeSingle()
        // Honour the best-effort contract above: an errored poll (network blip
        // mid-class) must NOT clear the banner — data is null on error too, so
        // without this guard the "You're training" banner unmounts for up to
        // 15s on every blip. Only a successful "no open session" clears it.
        if (!cancelled && !error) setLiveSession(data || null)
      }
      check()
      const id = setInterval(check, 15000)
      return () => { cancelled = true; clearInterval(id) }
    }, [contact?.id]),
  )

  // "What's next" — one best-effort prompt, picked from richest to weakest.
  const whatsNext = useMemo(
    () => pickWhatsNext({ tierStatus, teaserChallenge, sessions, streak }),
    [tierStatus, teaserChallenge, sessions, streak],
  )

  // First-6-weeks journey card props — null means "render nothing" (not a new
  // member / out of window / celebration over / anything malformed).
  const journeyCard = useMemo(() => shapeJourneyCard(journey), [journey])

  const latestSession = sessions[0] || null
  const showConnectDevice = !connectDismissed && sessions.length === 0

  // The chrome accent is EARNED from the trailing week's training (shared
  // rule via lib/member/brand — hardest zone sustained >=3 min, clamped
  // Z3-Z5). P4b: lit = volt, quiet weeks rest on Pearl. Drives the glow,
  // eyebrow state, ring and chips.
  const earned = useMemo(() => accentFromSessions(accentSessions, Date.now()), [accentSessions])

  // This week's sessions as pips, each in that session's hardest-zone colour.
  const weekPips = useMemo(() => {
    const weekStart = dublinWeekStartMs(Date.now())
    return (accentSessions || [])
      .filter((s) => Date.parse(s.started_at) >= weekStart)
      .map((s) => zoneColorDark(hardestZone(s.zones_seconds)) || PEARL)
  }, [accentSessions])

  // Dismiss the weekly digest: mark the ISO week seen (so it never re-appears
  // this week) and hide it now. Best-effort persist; the local hide is immediate.
  const dismissWeekDigest = useCallback(() => {
    const key = weekDigest?.weekKey
    setWeekDigest(null)
    if (key) markWeekDigestSeen(key)
  }, [weekDigest?.weekKey])

  // Only surface the digest when the member ISN'T mid-class — the live "You're
  // training" banner owns that moment; a recap of last week would be noise. It's
  // not a takeover either, so it coexists calmly with the rest of Home.
  const showWeekDigest = !!weekDigest && !liveSession

  if (loading) {
    return (
      <SafeAreaView className="flex-1 bg-iron-bg items-center justify-center" edges={['left', 'right']}>
        <ActivityIndicator color="#F1EEE7" size="large" />
      </SafeAreaView>
    )
  }

  if (error) {
    return (
      <SafeAreaView className="flex-1 bg-iron-bg" edges={['left', 'right']}>
        <ScrollView contentContainerClassName="p-5 pb-24">
          <ErrorRetry onPress={load} />
        </ScrollView>
      </SafeAreaView>
    )
  }

  return (
    <SafeAreaView className="flex-1 bg-iron-bg" edges={['left', 'right']}>
      <ScrollView contentContainerClassName="p-5 pb-24">
        {/* Poster header — mono eyebrow + display greeting, THE one glow in the
            earned accent. "RUNNING HOT" only when the accent is lit. */}
        <PosterHeader
          eyebrow={`${new Date().toLocaleDateString('en-IE', { weekday: 'short', day: '2-digit', month: 'short' }).toUpperCase()}${earned.lit ? ' · RUNNING HOT' : ''}`}
          title={`Hi, ${firstName}.`}
          accent={earned.color}
        />

        {/* Live banner — only while the member has an OPEN session. Non-intrusive:
            a tappable card that routes to the full live view. */}
        {liveSession && (
          <View className="mt-6">
            <LiveNowBanner session={liveSession} reduceMotion={reduceMotion} accent={earned.color} onPress={() => router.push('/live')} />
          </View>
        )}

        {/* First-6-weeks journey — top of the stack for in-window new members
            (spec: pulse-hub-first-90-days). Fail-invisible: journeyCard is null
            on any error / out-of-window and nothing renders. Purely
            motivational — no booking language (pulse-scope-no-booking). */}
        {journeyCard && (
          <View className="mt-6">
            <JourneyCard card={journeyCard} reduceMotion={reduceMotion} />
          </View>
        )}

        {/* Weekly digest — dismissible "Your week" recap of the week that just
            ended, at the start of a new Dublin week. NOT a takeover (weekly
            cadence is too frequent); hidden mid-class so it never competes with
            the live banner. Sits above the tier hero as the "close the loop"
            moment when the member opens the app on a fresh week. */}
        {showWeekDigest && (
          <View className="mt-6">
            <WeekDigestCard digest={weekDigest} accent={earned.color} onDismiss={dismissWeekDigest} />
          </View>
        )}

        {/* 1. Tier hero — earned-accent wash + segmented ring (Afterglow) */}
        <View className="mt-6">
          <TierHero status={tierStatus} accent={earned.color} reduceMotion={reduceMotion} />
        </View>

        {/* 2. Streak — ALWAYS visible */}
        <View className="mt-4">
          <StreakCard streak={streak} weekPips={weekPips} reduceMotion={reduceMotion} />
        </View>

        {/* 3. What's next — single prompt */}
        {whatsNext && (
          <View className="mt-4">
            <WhatsNextCard prompt={whatsNext} accent={earned.color} onPress={whatsNext.onPress ? () => whatsNext.onPress(router) : undefined} />
          </View>
        )}

        {/* Coach kudos — most recent shout-out, tappable to the full list.
            Below the primary hero/streak/what's-next, above the session cards. */}
        {latestKudos && (
          <View className="mt-4">
            <CoachKudosCard kudos={latestKudos} accent={earned.color} onPress={() => router.push('/kudos')} />
          </View>
        )}

        {/* 4. Latest session */}
        {latestSession && (
          <View className="mt-4">
            <LatestSessionCard
              session={latestSession}
              onPress={() => router.push('/sessions/' + latestSession.id)}
            />
          </View>
        )}

        {/* 5. Recent sessions + Achievements + Goals (secondary) */}
        <View className="mt-8">
          <RecentSessionsCard
            sessions={sessions}
            onSessionPress={(id) => router.push('/sessions/' + id)}
            onSeeAll={() => router.push('/activity')}
          />
        </View>

        <View className="mt-4 gap-4">
          <AchievementsCard
            latest={latestAch}
            unlocked={totalUnlocked}
            total={totalRules}
          />
          <GoalsCard goals={activeGoals} sessions={goalSessions} />
        </View>

        {/* 6. Nudges — DEMOTED below the training content, dismissible/gated.
            Each item self-decides whether to show; the block never leads. */}
        <View className="mt-8 gap-3">
          <ProfileCompletionPrompt />
          {/* Apple Health re-sync — self-gates to null (not iOS / not connected /
              already current), so this renders nothing for most members. */}
          <AppleHealthResyncCard />
          {/* Connect-a-device — only for members with no sessions, and dismissible
              (no longer shown forever to already-paired members). */}
          {showConnectDevice && (
            <ConnectDeviceCard onDismiss={() => setConnectDismissed(true)} />
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  )
}

// ── "What's next" picker (pure) ──────────────────────────────────
//
// Returns one prompt object { icon, title, subtitle, onPress? } or null.
// Order: soonest-ending active challenge → points-to-monthly-target →
// "you usually train <weekday>" → generic. Exported for unit reuse if needed.
export function pickWhatsNext({ tierStatus, teaserChallenge, sessions, streak }, nowMs = Date.now()) {
  // a) A challenge ending soon (within 10 days).
  if (teaserChallenge?.endsOn) {
    const daysLeft = daysUntil(teaserChallenge.endsOn, nowMs)
    if (daysLeft != null && daysLeft >= 0 && daysLeft <= 10) {
      return {
        icon: 'trophy-outline',
        title: daysLeft === 0 ? `“${teaserChallenge.name}” ends today` : `“${teaserChallenge.name}” ends in ${daysLeft} ${daysLeft === 1 ? 'day' : 'days'}`,
        subtitle: 'Bank a session before it closes',
        onPress: (router) => router.push('/compete'),
      }
    }
  }

  // b) Points remaining to this month's tier target.
  if (tierStatus && tierStatus.remaining > 0 && tierStatus.target > 0) {
    return {
      icon: 'flag-outline',
      title: `${tierStatus.remaining.toLocaleString()} pts to your ${tierStatus.periodLabel} target`,
      subtitle: tierStatus.tier ? `Keep your ${tierStatus.tier.name} tier moving` : 'Hit it to earn your first tier',
      onPress: (router) => router.push('/activity'),
    }
  }

  // c) "You usually train <weekday>" — the member's most-frequent training day.
  const usualDay = mostFrequentWeekday(sessions)
  if (usualDay) {
    return {
      icon: 'calendar-outline',
      title: `You usually train on ${usualDay}s`,
      subtitle: 'Keep the rhythm going this week',
    }
  }

  // d) Generic fallback — nudges toward starting/continuing the weekly streak.
  if (streak && streak.thisWeekCount === 0) {
    return {
      icon: 'flame-outline',
      title: streak.current > 0 ? 'Train this week to keep your streak' : 'Train this week to start a streak',
      subtitle: 'One session keeps the week alive',
    }
  }
  return null
}

function daysUntil(isoDate, nowMs) {
  if (!isoDate) return null
  // isoDate is a plain 'YYYY-MM-DD'; compare at UTC midnight to avoid tz drift.
  const t = Date.parse(`${isoDate}T00:00:00Z`)
  if (!Number.isFinite(t)) return null
  const today = Date.parse(`${new Date(nowMs).toISOString().slice(0, 10)}T00:00:00Z`)
  return Math.round((t - today) / (24 * 3600 * 1000))
}

function mostFrequentWeekday(sessions) {
  const counts = new Array(7).fill(0)
  let any = false
  for (const s of sessions || []) {
    const iso = s.started_at || s.ended_at
    if (!iso) continue
    // Dublin calendar day → weekday name.
    const [y, m, d] = dublinDateKey(iso).split('-').map(Number)
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay()
    counts[dow]++
    any = true
  }
  if (!any) return null
  let bestIdx = 0
  for (let i = 1; i < 7; i++) if (counts[i] > counts[bestIdx]) bestIdx = i
  if (counts[bestIdx] < 2) return null // need a real pattern
  return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][bestIdx]
}

// ── Live-now banner ──────────────────────────────────────────────
//
// Shows only while the member has an OPEN heart_rate_sessions row. Tapping it
// opens the full live view (/live). A gently pulsing red dot signals "live"
// (snaps solid under Reduce Motion).
function LiveNowBanner({ session, reduceMotion, accent = PEARL, onPress }) {
  const dot = useRef(new Animated.Value(1)).current
  useEffect(() => {
    if (reduceMotion) { dot.setValue(1); return }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(dot, { toValue: 0.3, duration: 700, useNativeDriver: true }),
        Animated.timing(dot, { toValue: 1, duration: 700, useNativeDriver: true }),
      ]),
    )
    loop.start()
    return () => loop.stop()
  }, [reduceMotion, dot])

  return (
    <Pressable onPress={onPress} className="active:opacity-80">
      <View
        className="rounded-[20px] p-4 flex-row items-center gap-3 overflow-hidden"
        style={{ backgroundColor: hexWithAlpha(accent, 0.12), borderWidth: 1, borderColor: hexWithAlpha(accent, 0.4) }}
      >
        <Animated.View style={{ opacity: dot }}>
          <View className="h-3 w-3 rounded-full" style={{ backgroundColor: '#FF4E42' }} />
        </Animated.View>
        <View className="flex-1 min-w-0">
          <Text className="font-mono text-[10px] uppercase" style={{ color: accent, letterSpacing: 2 }}>You're training</Text>
          <Text className="text-base font-body-semibold text-chalk" numberOfLines={1}>
            {session.class_name || 'Session in progress'} — watch live
          </Text>
        </View>
        <Ionicons name="chevron-forward" size={16} color={accent} />
      </View>
    </Pressable>
  )
}

// ── 1. Tier hero ─────────────────────────────────────────────────

function TierHero({ status, accent, reduceMotion }) {
  // Feature-off / not-loaded: a lightweight "earn your first tier" band so the
  // hero slot is never empty. Afterglow: the wash/ring/eyebrow live in the
  // EARNED accent (passed in), never a fixed brand colour; the tier name is
  // always chalk — the tier's own colour is data the boards render, not chrome.
  const pct = status ? status.pct : 0
  const points = useCountUp(status?.monthPoints ?? 0, { reduceMotion, duration: 900 })
  const target = status?.target ?? 0
  const tierName = status?.tier ? status.tier.name : 'No tier yet'
  const pctLabel = Math.round((Number.isFinite(pct) ? pct : 0) * 100)
  // Segmented sweep: 12 slots, filled in the earned accent (pips-not-bars).
  const RING_SLOTS = 12
  const filledSegs = Array.from(
    { length: Math.max(0, Math.min(RING_SLOTS, Math.round(pct * RING_SLOTS))) },
    () => accent,
  )

  return (
    <View
      className="rounded-[24px] p-5 overflow-hidden"
      style={{
        // The ONE zone-wash card on this screen (spec §2.5): a subtle tinted
        // fill + matching border in the earned accent.
        backgroundColor: hexWithAlpha(accent, 0.08),
        borderWidth: 1,
        borderColor: hexWithAlpha(accent, 0.3),
      }}
    >
      <View className="flex-row items-center" style={{ gap: 18 }}>
        <WeekRing slots={RING_SLOTS} filled={filledSegs} size={88} stroke={8}>
          <Text className="font-display-bold text-chalk" style={{ fontSize: 18 }}>{pctLabel}%</Text>
        </WeekRing>
        <View className="flex-1 min-w-0">
          <Text className="font-mono text-[10px] uppercase" style={{ color: accent, letterSpacing: 2 }}>
            Your tier
          </Text>
          <Text className="text-2xl font-display-bold text-chalk" numberOfLines={1}>
            {tierName}
          </Text>
          <Text className="mt-0.5 text-xs font-body text-chalk-2" numberOfLines={1}>
            {status
              ? `${status.monthsHit} ${status.monthsHit === 1 ? 'month' : 'months'} hit${status.next ? ` · ${status.monthsToNext} to ${status.next.name}` : ' · top tier'}`
              : 'Hit this month’s target to start climbing'}
          </Text>
        </View>
      </View>

      {/* Monthly progress under the hero row */}
      {status && (
        <View className="mt-4">
          <View className="flex-row justify-between mb-1">
            <Text className="text-xs font-body text-chalk-2">{status.periodLabel} target</Text>
            <Text className="text-xs font-mono text-chalk">
              {points.toLocaleString()} / {target.toLocaleString()}
            </Text>
          </View>
          <View className="h-2 rounded-full overflow-hidden" style={{ backgroundColor: hexWithAlpha(accent, 0.18) }}>
            <View className="h-full rounded-full" style={{ width: `${Math.round(pct * 100)}%`, backgroundColor: accent }} />
          </View>
          {status.remaining > 0 && (
            <Text className="text-xs font-body text-chalk-2 mt-2">
              {status.remaining.toLocaleString()} pts to bank {status.periodLabel}
            </Text>
          )}
        </View>
      )}
    </View>
  )
}

// Convert '#rrggbb' + alpha (0..1) → 8-digit hex the RN colour parser accepts.
function hexWithAlpha(hex, alpha) {
  const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255)
  const aa = a.toString(16).padStart(2, '0')
  // Guard against short/invalid hex — fall back to pearl (unlit accent).
  if (typeof hex !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(hex)) return `#D6D2C9${aa}`
  return `${hex}${aa}`
}

// ── 2. Streak (weeks-based, always visible) ──────────────────────

function StreakCard({ streak, weekPips = [], reduceMotion }) {
  const current = streak?.current || 0
  const count = useCountUp(current, { reduceMotion, duration: 700 })
  const active = current > 0
  const trainedThisWeek = (streak?.thisWeekCount || 0) > 0
  // Pips, not bars (spec §2.4.5): one slot per weekly-target session, each
  // earned pip in that session's hardest-zone colour.
  const slots = Math.max(streak?.minPerWeek || 1, 3)

  return (
    <Card>
      <Text className="font-mono text-[10px] uppercase text-chalk-3 mb-2" style={{ letterSpacing: 2 }}>Streak</Text>
      <View className="flex-row items-baseline gap-2.5">
        {active ? (
          <>
            <EarnedNumber size={34}>{count}</EarnedNumber>
            <Text className="text-[13px] font-body text-chalk-2">
              {count === 1 ? 'week' : 'weeks'} · {trainedThisWeek
                ? `this week's in the bank · best ${streak.best}`
                : `train this week to keep it · best ${streak.best}`}
            </Text>
          </>
        ) : (
          <View className="min-w-0">
            <Text className="text-xl font-display-bold text-chalk">Start a streak</Text>
            <Text className="mt-0.5 text-xs font-body text-chalk-2">Train this week to get it going</Text>
          </View>
        )}
      </View>
      <Pips className="mt-3" slots={slots} filled={weekPips} />
    </Card>
  )
}

// ── 3. What's next ───────────────────────────────────────────────

function WhatsNextCard({ prompt, accent = PEARL, onPress }) {
  const inner = (
    <Card>
      <View className="flex-row items-center gap-3">
        <View className="h-9 w-9 items-center justify-center rounded-full" style={{ backgroundColor: hexWithAlpha(accent, 0.14) }}>
          <Ionicons name={prompt.icon} size={18} color={accent} />
        </View>
        <View className="flex-1 min-w-0">
          <Text className="text-[11px] font-body-semibold uppercase tracking-widest" style={{ color: accent }}>What's next</Text>
          <Text className="text-sm font-body-semibold text-chalk" numberOfLines={2}>{prompt.title}</Text>
          {prompt.subtitle ? (
            <Text className="text-xs text-chalk-2" numberOfLines={1}>{prompt.subtitle}</Text>
          ) : null}
        </View>
        {onPress ? <Ionicons name="chevron-forward" size={14} color="#727170" /> : null}
      </View>
    </Card>
  )
  if (!onPress) return inner
  return <Pressable onPress={onPress} className="active:opacity-70">{inner}</Pressable>
}

// ── Coach kudos (most recent shout-out) ──────────────────────────

function CoachKudosCard({ kudos, accent = PEARL, onPress }) {
  const v = toKudosView(kudos)
  const unseen = isUnseen(kudos)
  return (
    <Pressable onPress={onPress} className="active:opacity-70">
      <View
        className="rounded-[20px] border bg-iron-surface p-5"
        style={
          unseen
            ? { borderColor: accent, backgroundColor: hexWithAlpha(accent, 0.06) }
            : { borderColor: '#2A2A31' }
        }
      >
        <View className="flex-row items-center justify-between">
          <View className="flex-row items-center gap-1.5">
            <Ionicons name="chatbubble-ellipses" size={15} color={accent} />
            <Text className="text-[11px] font-body-semibold uppercase tracking-widest" style={{ color: accent }}>
              Coach kudos
            </Text>
          </View>
          <View className="flex-row items-center gap-2">
            {unseen && (
              <View className="h-2 w-2 rounded-full" style={{ backgroundColor: accent }} />
            )}
            <Ionicons name="chevron-forward" size={14} color="#727170" />
          </View>
        </View>
        <View className="mt-3 flex-row gap-3">
          {v.emoji ? (
            <Text className="text-2xl" style={{ lineHeight: 30 }}>{v.emoji}</Text>
          ) : null}
          <View className="flex-1 min-w-0">
            <Text className="text-[15px] leading-5 text-chalk" numberOfLines={3}>
              {v.message}
            </Text>
            <View className="mt-2 flex-row items-center justify-between gap-3">
              <Text className="text-xs font-body-medium text-chalk-2 flex-1" numberOfLines={1}>
                — {v.senderName}
              </Text>
              <Text className="text-xs text-chalk-3">{kudosRelativeTime(v.createdAt)}</Text>
            </View>
          </View>
        </View>
      </View>
    </Pressable>
  )
}

// ── Weekly digest ("Your week") ──────────────────────────────────
//
// Dismissible in-app recap of the LAST completed Dublin week: classes, UN1T
// Points, Burn count, and (if the member has friends) their friends-league
// finish, plus a light nudge into the new week. Iron card with an earned-
// accent header and a dismiss (X). Pure presentational — the model + seen-gate
// are computed in the Home loader.
function WeekDigestCard({ digest, accent = PEARL, onDismiss }) {
  const { weekLabel, classes, points, burnCount, earnedBurn, leagueFinish } = digest
  const finishLine = leagueFinish
    ? `#${leagueFinish.rank} of ${leagueFinish.of} friends`
    : null

  return (
    <View
      className="rounded-[24px] p-5 overflow-hidden"
      style={{
        backgroundColor: hexWithAlpha(accent, 0.10),
        borderWidth: 1,
        borderColor: hexWithAlpha(accent, 0.35),
      }}
    >
      <View className="flex-row items-start justify-between">
        <View className="flex-1 min-w-0">
          <Text className="text-[11px] font-body-semibold uppercase tracking-widest" style={{ color: accent }}>
            Your week
          </Text>
          <Text className="text-lg font-display-bold text-chalk" numberOfLines={1}>
            Last week, wrapped
          </Text>
          <Text className="mt-0.5 text-xs text-chalk-2" numberOfLines={1}>{weekLabel}</Text>
        </View>
        <Pressable onPress={onDismiss} hitSlop={10} className="active:opacity-60 -mr-1 -mt-1">
          <Ionicons name="close" size={20} color="#727170" />
        </Pressable>
      </View>

      {/* Stat row — classes · UN1T Points · Burns. Raw member totals only; no
          class-capacity/spaces info ever surfaces here. */}
      <View className="mt-4 flex-row gap-3">
        <WeekStat value={String(classes)} label={classes === 1 ? 'class' : 'classes'} />
        <WeekStat value={points.toLocaleString()} label="UN1T Points" />
        <WeekStat
          value={String(earnedBurn ? burnCount : 0)}
          label={burnCount === 1 ? 'Burn' : 'Burns'}
          dim={!earnedBurn}
        />
      </View>

      {/* Friends-league finish — only when the member has friends. */}
      {finishLine && (
        <View className="mt-4 flex-row items-center gap-2">
          <Ionicons name="trophy-outline" size={15} color={accent} />
          <Text className="text-sm font-body-semibold text-chalk" numberOfLines={1}>
            You finished {finishLine} last week
          </Text>
        </View>
      )}

      {/* Light nudge into the new week. */}
      <Text className="mt-4 text-xs text-chalk-2">
        {earnedBurn
          ? 'Strong week. A fresh one just started — go again.'
          : 'A fresh week just started — make this one count.'}
      </Text>
    </View>
  )
}

function WeekStat({ value, label, dim = false }) {
  return (
    <View className="flex-1 rounded-2xl bg-iron-surface px-3 py-3">
      <Text
        className="text-2xl font-display-black"
        style={{ color: dim ? '#727170' : '#F1EEE7' }}
        numberOfLines={1}
      >
        {value}
      </Text>
      <Text className="mt-0.5 text-[11px] font-body-medium text-chalk-2" numberOfLines={1}>{label}</Text>
    </View>
  )
}

// ── 4. Latest session ────────────────────────────────────────────

function LatestSessionCard({ session, onPress }) {
  const dur = durationMinutes(session.started_at, session.ended_at)
  const label = sourceLabel(session.source)
  const date = sessionDate(session.started_at)
  const inProgress = !session.ended_at
  const burn = !inProgress && isBurn(session.zones_seconds)

  return (
    <Pressable onPress={onPress} className="active:opacity-70">
      <Card>
        <View className="flex-row items-center justify-between">
          <Text className="text-base font-display text-chalk">Latest session</Text>
          <Ionicons name="chevron-forward" size={14} color="#727170" />
        </View>
        <View className="mt-3 flex-row items-start justify-between gap-3">
          <View className="flex-1 min-w-0">
            <Text className="text-sm font-body-medium text-chalk" numberOfLines={1}>
              {date}{dur != null ? ` · ${dur} min` : ''}
            </Text>
            <Text className="mt-0.5 text-xs text-chalk-2" numberOfLines={1}>
              {label}{Number.isFinite(session.peak_hr_bpm) ? ` · peak ${session.peak_hr_bpm}` : ''}
            </Text>
          </View>
          <View className="shrink-0 items-end">
            {Number.isFinite(session.effort_points) && (
              <View className="flex-row items-baseline">
                <Text className="text-xl font-display-bold text-chalk">{session.effort_points}</Text>
                <Text className="ml-1 font-mono text-[10px] text-chalk-3" style={{ letterSpacing: 1 }}>PTS</Text>
              </View>
            )}
            {burn && (
              <View
                className="mt-1.5 self-end rounded-full px-2.5 py-0.5"
                style={{ borderWidth: 1, borderColor: zoneColorDark(4) + '73' }}
              >
                <Text className="font-mono text-[10px]" style={{ color: zoneColorDark(4), letterSpacing: 1.2 }}>BURN</Text>
              </View>
            )}
          </View>
        </View>
        <ZoneBar zonesSeconds={session.zones_seconds} height={6} className="mt-3" />
      </Card>
    </Pressable>
  )
}

// ── Sub-components (secondary) ───────────────────────────────────

function RecentSessionsCard({ sessions, onSessionPress, onSeeAll }) {
  // Skip the newest (it's the Latest-session hero above) so this reads as
  // "earlier sessions" and doesn't duplicate the hero.
  const rest = (sessions || []).slice(1)
  return (
    <Card>
      <View className="flex-row items-center justify-between">
        <Text className="text-base font-display text-chalk">Recent sessions</Text>
        {sessions.length > 0 && (
          <Pressable onPress={onSeeAll} hitSlop={8}>
            <Text className="text-xs font-body-medium text-chalk-2">See all →</Text>
          </Pressable>
        )}
      </View>

      {sessions.length === 0 ? (
        <View className="mt-4 items-center py-6">
          <Ionicons name="heart-outline" size={28} color="#727170" />
          <Text className="mt-2 text-sm font-body-medium text-chalk">No sessions yet</Text>
          <Text className="mt-1 text-xs text-chalk-2 text-center">
            Train with a heart rate monitor and your sessions will appear here.
          </Text>
        </View>
      ) : rest.length === 0 ? (
        <Text className="mt-3 text-xs text-chalk-2">
          Your latest session is up top — earlier ones will stack up here.
        </Text>
      ) : (
        <View className="mt-4 gap-3">
          {rest.map((s) => (
            <SessionItem key={s.id} session={s} onPress={() => onSessionPress(s.id)} />
          ))}
        </View>
      )}
    </Card>
  )
}

function SessionItem({ session, onPress }) {
  const dur = durationMinutes(session.started_at, session.ended_at)
  const label = sourceLabel(session.source)
  const date = sessionDate(session.started_at)

  return (
    <Pressable
      onPress={onPress}
      className="rounded-[16px] border border-iron-hairline bg-iron-surface p-3 active:opacity-70"
    >
      <View className="flex-row items-baseline justify-between gap-3">
        <View className="flex-1 min-w-0">
          <Text className="text-sm font-body-medium text-chalk" numberOfLines={1}>
            {date}{dur != null ? ` · ${dur} min` : ''}
          </Text>
          <Text className="mt-0.5 text-xs text-chalk-2" numberOfLines={1}>
            {label}{Number.isFinite(session.peak_hr_bpm) ? ` · peak ${session.peak_hr_bpm}` : ''}
          </Text>
        </View>
        {Number.isFinite(session.effort_points) && (
          <View className="flex-row items-baseline shrink-0">
            <Text className="text-base font-display-bold text-chalk">
              {session.effort_points}
            </Text>
            <Text className="ml-1 font-mono text-[9px] text-chalk-3" style={{ letterSpacing: 1 }}>PTS</Text>
          </View>
        )}
      </View>
      <ZoneBar zonesSeconds={session.zones_seconds} height={4} className="mt-2" />
    </Pressable>
  )
}

function ConnectDeviceCard({ onDismiss }) {
  const router = useRouter()
  return (
    <Card>
      <View className="flex-row items-start justify-between">
        <Text className="text-base font-display text-chalk">Connect a device</Text>
        <Pressable onPress={onDismiss} hitSlop={8} className="active:opacity-60">
          <Ionicons name="close" size={18} color="#727170" />
        </Pressable>
      </View>
      <Text className="mt-2 text-sm text-chalk-2">
        Sync your watch or strap to track every workout — at the studio and on the road.
      </Text>
      <Pressable
        onPress={() => router.push('/account/devices')}
        className="mt-4 rounded-xl bg-iron-raised py-3 px-5 items-center active:opacity-70"
      >
        <Text className="font-body-semibold text-chalk">Connect →</Text>
      </Pressable>
      <Text className="mt-3 text-xs text-chalk-3">
        Fitbit · Whoop · Apple Watch · Garmin
      </Text>
    </Card>
  )
}

function AchievementsCard({ latest, unlocked, total }) {
  const router = useRouter()
  const withRule = (latest || []).filter((u) => u.rule)
  return (
    <Card>
      <View className="flex-row items-center justify-between">
        <View className="flex-row items-center gap-1.5">
          <Ionicons name="trophy-outline" size={16} color="#F1EEE7" />
          <Text className="text-base font-display text-chalk">Achievements</Text>
        </View>
        <Pressable onPress={() => router.push('/account/achievements')} hitSlop={8}>
          <Text className="text-xs font-body-medium text-chalk-2">See all →</Text>
        </Pressable>
      </View>
      <View className="flex-row items-baseline mt-2 gap-1">
        <Text className="text-2xl font-body-semibold tabular-nums text-chalk">{unlocked}</Text>
        <Text className="text-sm font-body-medium text-chalk-2">/ {total}</Text>
      </View>
      {withRule.length === 0 ? (
        <Text className="mt-1 text-sm text-chalk-2">
          No badges yet. Train at the studio to start unlocking them.
        </Text>
      ) : (
        <View className="mt-3 flex-row flex-wrap gap-2">
          {withRule.map((u) => (
            <AchievementChip key={u.id} rule={u.rule} />
          ))}
        </View>
      )}
    </Card>
  )
}

function AchievementChip({ rule }) {
  const ionIconName = lucideToIonicon(rule.icon)
  return (
    <View className="flex-row items-center gap-1 rounded-full border border-iron-hairline bg-iron-raised px-2.5 py-1">
      {ionIconName && <Ionicons name={ionIconName} size={12} color="#B3B2AC" />}
      <Text className="text-xs text-chalk-2">{rule.name}</Text>
    </View>
  )
}

function lucideToIonicon(iconName) {
  if (!iconName) return 'star-outline'
  const map = {
    Award: 'ribbon-outline',
    Trophy: 'trophy-outline',
    Star: 'star-outline',
    Zap: 'flash-outline',
    Flame: 'flame-outline',
    Heart: 'heart-outline',
    Target: 'radio-button-on-outline',
    Medal: 'medal-outline',
  }
  return map[iconName] || 'ribbon-outline'
}

function GoalsCard({ goals, sessions }) {
  const router = useRouter()
  const hasGoals = (goals || []).length > 0
  return (
    <Card>
      <View className="flex-row items-center justify-between">
        <View className="flex-row items-center gap-1.5">
          <Ionicons name="radio-button-on-outline" size={16} color="#F1EEE7" />
          <Text className="text-base font-display text-chalk">Goals</Text>
        </View>
        <Pressable onPress={() => router.push('/account/goals')} hitSlop={8}>
          <Text className="text-xs font-body-medium text-chalk-2">{hasGoals ? 'Manage →' : 'Set one →'}</Text>
        </Pressable>
      </View>
      {!hasGoals ? (
        <Text className="mt-3 text-sm text-chalk-2">
          Pick a weekly target — points, classes — and track it here.
        </Text>
      ) : (
        <View className="mt-3 gap-3">
          {goals.slice(0, 2).map((g) => {
            const def = GOAL_DEFS[g.kind]
            const p = computeProgress(g, sessions)
            return (
              <GoalRow key={g.id} label={def?.label || g.kind} progress={p} />
            )
          })}
        </View>
      )}
    </Card>
  )
}

function GoalRow({ label, progress }) {
  const { current, target, pct } = progress
  const fillPct = Math.min(1, pct)
  const complete = pct >= 1

  return (
    <View>
      <View className="flex-row items-baseline justify-between">
        <Text className="text-xs font-body-medium text-chalk-2">{label}</Text>
        <Text className="text-xs tabular-nums text-chalk-2">{current} / {target}</Text>
      </View>
      <View className="mt-1 h-1.5 rounded-full bg-iron-raised overflow-hidden">
        <View
          style={{ width: `${fillPct * 100}%` }}
          className={`h-full rounded-full ${complete ? 'bg-chalk' : 'bg-chalk-3'}`}
        />
      </View>
    </View>
  )
}
