// Member challenges — leaderboards and collective goals (native).
//
// Fetches GET /api/challenges via the api() helper (auth token attached
// automatically). Mirrors the web /challenges page UI in NativeWind,
// matching the TierCard / StreakCard design tokens from (tabs)/index.jsx.

import { useState, useCallback } from 'react'
import { View, Text, ScrollView, ActivityIndicator, Pressable } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useFocusEffect, useRouter } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { api } from '../../lib/member/api'
import { supabase } from '../../lib/member/supabase'
import Card from '../../components/member/ui/Card'
import ErrorRetry from '../../components/member/ErrorRetry'
import ChallengeTransformationCard from '../../components/member/ChallengeTransformationCard'
import { PEARL, VOLT } from '../../lib/member/brand'
import { endedRecentlyFlagship, ownWindowStats, challengeWindowMs } from 'shared/challenge-wrapped'

// ── Everyone / Friends toggle for individual challenges ───────────────

function IndividualChallengesSection({ everyoneData, viewerIsNewMember = false }) {
  const [view, setView] = useState('everyone')
  const [friendsData, setFriendsData] = useState(null)
  const [newMembersData, setNewMembersData] = useState(null)
  const [loading, setLoading] = useState(false)
  // Which scope is being lazily fetched (so its toggle button can show '...').
  const [loadingKey, setLoadingKey] = useState(null)

  async function switchToFriends() {
    if (friendsData) { setView('friends'); return }
    setLoading(true); setLoadingKey('friends')
    try {
      const d = await api('/api/social/challenge-boards')
      if (d?.ok) setFriendsData(d.challenges || [])
    } finally {
      setLoading(false); setLoadingKey(null)
      setView('friends')
    }
  }

  // Mirrors switchToFriends — lazy-fetches the new-members cohort board.
  async function switchToNewMembers() {
    if (newMembersData) { setView('new members'); return }
    setLoading(true); setLoadingKey('new members')
    try {
      const d = await api('/api/social/challenge-boards/new-members')
      if (d?.ok) setNewMembersData(d.challenges || [])
    } finally {
      setLoading(false); setLoadingKey(null)
      setView('new members')
    }
  }

  if (everyoneData.length === 0) return null

  // "New members" only appears for members currently in their first 90 days.
  const options = ['Everyone', 'Friends', ...(viewerIsNewMember ? ['New members'] : [])]

  const onPressFor = { everyone: () => setView('everyone'), friends: switchToFriends, 'new members': switchToNewMembers }

  const displayed =
    view === 'friends' ? (friendsData || [])
      : view === 'new members' ? (newMembersData || [])
        : everyoneData

  // On the cohort board, a challenge with too few new members is hidden so we
  // never show a hollow board of 1.
  const cohortCards = view === 'new members' ? displayed.filter((ch) => !ch.tooSmall) : displayed

  return (
    <View>
      {/* Toggle */}
      <View className="flex-row rounded-lg bg-iron-surface mb-4 p-0.5 gap-0.5 self-start" style={{ borderWidth: 1, borderColor: '#2A2A31' }}>
        {options.map((opt) => {
          const key = opt.toLowerCase()
          const isActive = view === key
          return (
            <Pressable
              key={opt}
              onPress={onPressFor[key]}
              disabled={loading}
              style={{
                borderRadius: 6,
                paddingHorizontal: 16,
                paddingVertical: 6,
                backgroundColor: isActive ? PEARL : 'transparent',
                opacity: loading ? 0.5 : 1,
              }}
            >
              <Text className="font-body-semibold" style={{ fontSize: 12, color: isActive ? '#131316' : '#B3B2AC' }}>
                {loadingKey === key ? '...' : opt}
              </Text>
            </Pressable>
          )
        })}
      </View>

      {view === 'new members' && cohortCards.length === 0 ? (
        <View className="mb-4">
          <Text className="text-xs text-chalk-2">
            Not enough new members on the board yet — check back soon
          </Text>
        </View>
      ) : (
        cohortCards.map((ch) => (
          <View key={ch.id} className="mt-0 mb-4">
            <IndividualCard challenge={ch} />
            {/* Flagship transformation challenges get the InBody bookend card
                (own body-comp change over the window). isFlagship is falsy
                until the CRM flag lands, so this stays inert by default. */}
            {ch.isFlagship === true && (
              <View className="mt-3">
                <ChallengeTransformationCard challenge={ch} />
              </View>
            )}
          </View>
        ))
      )}
    </View>
  )
}

// ── Finished-flagship "Challenge Wrapped" entry ───────────────────────
// A flagship transformation challenge that ENDED within the last 14 days and
// that the member took part in gets a "See your Challenge Wrapped ›" entry
// opening the finisher story (mobile/app/wrapped/challenge/[id].jsx).
//
// The normal /api/challenges load drops ended challenges, so this reads the
// member's location's recently-ended flagship challenges DIRECTLY via the
// RLS-scoped self client (own visibility only), then confirms participation
// from the member's OWN heart_rate_sessions in each window — own-stats-only, no
// service client, no new API. is_flagship is falsy until the CRM flag lands, so
// this section simply renders nothing by default.
function FinishedFlagshipWrapped() {
  const router = useRouter()
  const [entries, setEntries] = useState([])

  const load = useCallback(async () => {
    try {
      // RLS scopes challenges to the member's location (same policy the loader
      // relies on). Flagship-only + a recency floor keeps this a tiny read.
      const floorIso = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 10)
      const { data: defs, error } = await supabase
        .from('challenges')
        .select('id, name, mode, metric, starts_on, ends_on, is_flagship')
        .eq('is_flagship', true)
        .gte('ends_on', floorIso)
        .order('ends_on', { ascending: false })
      if (error) throw error

      const now = Date.now()
      const recent = (defs || []).filter((ch) => endedRecentlyFlagship(ch, now, 14))
      if (recent.length === 0) { setEntries([]); return }

      // Widest window across the candidates → one own-sessions read, then check
      // participation per challenge from that set (own data only).
      let minFrom = Infinity
      for (const ch of recent) {
        const win = challengeWindowMs(ch)
        if (win && win.fromMs < minFrom) minFrom = win.fromMs
      }
      if (!Number.isFinite(minFrom)) { setEntries([]); return }

      const { data: sessions, error: sErr } = await supabase
        .from('heart_rate_sessions')
        .select('id, started_at, ended_at, effort_points, zones_seconds')
        .gte('started_at', new Date(minFrom).toISOString())
        .order('started_at', { ascending: true })
        .limit(1000)
      if (sErr) throw sErr

      const participated = recent.filter((ch) => ownWindowStats(sessions || [], ch, now).classes > 0)
      setEntries(participated.map((ch) => ({ id: ch.id, name: ch.name })))
    } catch {
      setEntries([]) // best-effort — the finisher entry is a bonus, never blocks
    }
  }, [])

  useFocusEffect(useCallback(() => { load() }, [load]))

  if (entries.length === 0) return null

  return (
    <View className="mt-4" style={{ gap: 12 }}>
      {entries.map((e) => (
        <Pressable
          key={e.id}
          onPress={() => router.push(`/wrapped/challenge/${e.id}`)}
          accessibilityRole="button"
          accessibilityLabel={`See your Challenge Wrapped for ${e.name}`}
          className="active:opacity-80"
        >
          <Card>
            <View className="flex-row items-center" style={{ gap: 12 }}>
              <Ionicons name="sparkles" size={20} color={PEARL} />
              <View className="flex-1">
                <Text className="text-base font-body-semibold text-chalk" numberOfLines={1}>
                  Your {e.name} is done
                </Text>
                <Text className="text-xs font-body-semibold" style={{ color: PEARL }}>
                  See your Challenge Wrapped ›
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={16} color={PEARL} />
            </View>
          </Card>
        </Pressable>
      ))}
    </View>
  )
}

// Podium metals (rank 1/2/3)
const METAL = ['#e8b931', '#c2c8ce', '#c77b3a']

const METRIC_LABEL = {
  points: 'UN1T Points',
  classes: 'classes',
  z4plus_minutes: 'Zone 4+ min',
}

// Named export so the Compete tab can embed this screen without the pushed-
// screen chrome (the "← Home" back row). The default export stays the route
// handler for /challenges — kept reachable so the `challenge` push deep-link
// and any legacy link still resolve.
export function ChallengesScreen({ showBack = true }) {
  const router = useRouter()
  const [loading, setLoading] = useState(true)
  const [challenges, setChallenges] = useState([])
  const [gymBoard, setGymBoard] = useState(null)
  const [consistencyBoard, setConsistencyBoard] = useState(null)
  const [viewerIsNewMember, setViewerIsNewMember] = useState(false)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await api('/api/challenges')
      if (res?.success === false) {
        setError(res.error || 'Failed to load')
      } else {
        setChallenges(res?.challenges || [])
        setGymBoard(res?.gymBoard || null)
        setConsistencyBoard(res?.consistencyBoard || null)
        setViewerIsNewMember(res?.viewerIsNewMember === true)
      }
    } catch (e) {
      setError(e?.message || 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [])

  useFocusEffect(useCallback(() => { load() }, [load]))

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

  const hasContent =
    challenges.length > 0 ||
    (gymBoard && gymBoard.top.length > 0) ||
    (consistencyBoard && consistencyBoard.top.length > 0)

  return (
    <SafeAreaView className="flex-1 bg-iron-bg" edges={['left', 'right']}>
      <ScrollView contentContainerClassName="p-5 pb-24">
        {/* Header */}
        {showBack && (
          <Pressable onPress={() => router.back()} hitSlop={8} className="mb-2">
            <Text className="text-xs font-body-medium text-chalk-2">← Home</Text>
          </Pressable>
        )}
        <Text className="text-2xl font-display-bold text-chalk">Challenges</Text>
        <Text className="mt-1 text-sm text-chalk-2">Active competitions and gym leaderboard</Text>

        {/* Consistency board — pinned. Counts class-linked, device-backed
            sessions only (challenge_standings RPC, mig 347): an in-studio HR
            strap or a wearable workout auto-mapped to a booked class. No-device
            participation credits do NOT count toward this board. */}
        {consistencyBoard && consistencyBoard.top.length > 0 && (
          <View className="mt-4">
            <LeaderboardCard
              title="Classes this month"
              subtitle="Strap-backed classes count"
              iconName="calendar-outline"
              top={consistencyBoard.top}
              me={consistencyBoard.me}
              count={consistencyBoard.count}
              metric="classes"
            />
          </View>
        )}

        {/* Finished flagship → "See your Challenge Wrapped ›" finisher entry.
            Self-loading + inert until a flagship challenge has recently ended
            and the member took part. */}
        <FinishedFlagshipWrapped />

        {!hasContent && (
          <View className="mt-8">
            <Card>
              <View className="items-center py-8 gap-2">
                <Ionicons name="trophy-outline" size={28} color="#727170" />
                <Text className="text-sm font-body-semibold text-chalk">No active challenges</Text>
                <Text className="text-xs text-chalk-2 text-center max-w-xs">
                  Check back soon — your studio will post challenges here.
                </Text>
              </View>
            </Card>
          </View>
        )}

        {/* Collective challenges (gym-wide, no filter) */}
        {challenges.filter((ch) => ch.mode === 'collective').map((ch) => (
          <View key={ch.id} className="mt-4">
            <CollectiveCard challenge={ch} />
          </View>
        ))}

        {/* Individual challenges with Everyone / Friends toggle */}
        <View className="mt-4">
          <IndividualChallengesSection
            everyoneData={challenges.filter((ch) => ch.mode === 'individual')}
            viewerIsNewMember={viewerIsNewMember}
          />
        </View>

        {/* Monthly gym leaderboard */}
        {gymBoard && gymBoard.top.length > 0 && (
          <View className="mt-4">
            <LeaderboardCard
              title="Gym leaderboard"
              subtitle="Monthly UN1T Points"
              iconName="bar-chart-outline"
              top={gymBoard.top}
              me={gymBoard.me}
              count={gymBoard.count}
              metric="points"
            />
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  )
}

// Route handler for /challenges — kept reachable (the `challenge` push
// deep-links here). As a pushed screen it keeps the "← Home" back row.
export default function Challenges() {
  return <ChallengesScreen showBack />
}

// ── Individual challenge ──────────────────────────────────────────────

function IndividualCard({ challenge }) {
  const metricLabel = METRIC_LABEL[challenge.metric] || challenge.metric
  return (
    <LeaderboardCard
      title={challenge.name}
      subtitle={`${metricLabel} · ends ${formatDate(challenge.endsOn)}`}
      iconName="trophy-outline"
      top={challenge.top}
      me={challenge.me}
      count={challenge.count}
      metric={challenge.metric}
      phase={challenge.phase}
      flagship={challenge.isFlagship === true}
    />
  )
}

// ── Collective challenge ──────────────────────────────────────────────

function CollectiveCard({ challenge }) {
  const metricLabel = METRIC_LABEL[challenge.metric] || challenge.metric
  const { total, target, pct } = challenge.collective
  const pctRounded = Math.round(pct * 100)
  const fillPct = Math.min(1, pct) * 100

  return (
    <Card>
      {/* Title row */}
      <View className="flex-row items-start justify-between gap-3">
        <View className="flex-row items-center gap-2 flex-1">
          <Ionicons name="people-outline" size={20} color={PEARL} />
          <View className="flex-1">
            <Text className="text-base font-display text-chalk" numberOfLines={2}>
              {challenge.name}
            </Text>
            <Text className="text-xs text-chalk-2">
              {metricLabel} · ends {formatDate(challenge.endsOn)}
            </Text>
          </View>
        </View>
        <Text className="text-2xl font-display-bold shrink-0" style={{ color: PEARL }}>
          {pctRounded}%
        </Text>
      </View>

      {/* Progress bar */}
      <View className="mt-4">
        <View className="flex-row justify-between mb-1.5">
          <Text className="text-xs text-chalk-2">Gym progress</Text>
          <Text className="text-xs font-mono text-chalk">
            {total.toLocaleString()} / {target.toLocaleString()}
          </Text>
        </View>
        <View className="h-3 rounded-full bg-iron-raised overflow-hidden">
          <View
            className="h-full rounded-full"
            style={{ width: `${fillPct}%`, backgroundColor: PEARL }}
          />
        </View>
        {pct < 1 && (
          <Text className="text-xs text-chalk-2 mt-2">
            {(target - total).toLocaleString()} {metricLabel} to go
          </Text>
        )}
        {pct >= 1 && (
          // P4b: goal reached is EARNED — lights volt.
          <Text className="text-xs font-body-medium mt-2" style={{ color: VOLT }}>
            Goal achieved!
          </Text>
        )}
      </View>
    </Card>
  )
}

// ── Flagship badge ────────────────────────────────────────────────────
// Marks the marquee transformation challenge (is_flagship). Afterglow
// mono-chip: hairline border + mono uppercase text in the attention red —
// readable contrast on THIS dark surface.
function FlagshipBadge() {
  return (
    <View
      className="flex-row items-center rounded-full px-2.5 py-0.5 shrink-0"
      style={{ borderWidth: 1, borderColor: PEARL + '73', gap: 3 }}
    >
      <Ionicons name="flame" size={10} color={PEARL} />
      <Text className="font-mono text-[10px] uppercase" style={{ color: PEARL, letterSpacing: 1.2 }}>
        Flagship
      </Text>
    </View>
  )
}

// ── Shared leaderboard card ───────────────────────────────────────────

function LeaderboardCard({ title, subtitle, iconName, top, me, count, metric, phase, flagship = false }) {
  const metricLabel = METRIC_LABEL[metric] || metric

  return (
    <Card>
      {/* Header */}
      <View className="flex-row items-center justify-between gap-3">
        <View className="flex-row items-center gap-2 flex-1">
          <Ionicons name={iconName} size={20} color="#B3B2AC" />
          <View className="flex-1">
            <View className="flex-row items-center" style={{ gap: 8 }}>
              <Text className="text-base font-display text-chalk shrink" numberOfLines={1}>
                {title}
              </Text>
              {flagship && <FlagshipBadge />}
            </View>
            <Text className="text-xs text-chalk-2" numberOfLines={1}>{subtitle}</Text>
          </View>
        </View>
        {me?.rank && (
          <Text className="text-sm font-display-bold shrink-0" style={{ color: PEARL }}>
            You&apos;re #{me.rank}
          </Text>
        )}
      </View>

      {/* Entries */}
      {top.length === 0 ? (
        <View className="items-center py-6 gap-2 mt-2">
          <Ionicons name="people-outline" size={24} color="#727170" />
          <Text className="text-sm font-body-medium text-chalk">No entries yet</Text>
          <Text className="text-xs text-chalk-2 text-center">
            {phase === 'upcoming' ? "Challenge hasn't started yet." : 'Be the first on the board.'}
          </Text>
        </View>
      ) : (
        <View className="mt-4 gap-1">
          {top.map((row) => (
            <LeaderboardRow
              key={`${row.rank}-${row.name}`}
              row={row}
              metricLabel={metricLabel}
            />
          ))}
          {count > top.length && (
            <Text className="mt-3 text-center text-xs text-chalk-3">
              {count} participants
            </Text>
          )}
        </View>
      )}
    </Card>
  )
}

function LeaderboardRow({ row, metricLabel }) {
  const podiumColor = row.rank <= 3 ? METAL[row.rank - 1] : null
  const isMe = row.isMe
  const rankColor = podiumColor || (isMe ? PEARL : '#727170')

  return (
    <View
      className="flex-row items-center gap-3 rounded-lg px-3 py-2 border border-transparent"
      style={isMe ? { backgroundColor: PEARL + '14', borderColor: PEARL + '4D' } : undefined}
    >
      {/* Rank number */}
      <Text
        className="w-5 text-center font-mono text-sm"
        style={{ color: rankColor }}
      >
        {row.rank}
      </Text>

      {/* Name */}
      <Text
        className="flex-1 text-sm font-body-medium"
        style={{ color: isMe ? PEARL : '#F1EEE7' }}
        numberOfLines={1}
      >
        {row.name}
        {isMe && (
          <Text className="text-xs font-body" style={{ color: PEARL + 'B3' }}> (you)</Text>
        )}
      </Text>

      {/* Value */}
      <Text
        className={metricLabel === 'UN1T Points' ? 'shrink-0 font-display-bold text-sm' : 'shrink-0 font-mono text-sm'}
        style={{ color: isMe ? PEARL : '#B3B2AC' }}
      >
        {formatValue(row.value, metricLabel)}
      </Text>
    </View>
  )
}

// ── Helpers ───────────────────────────────────────────────────────────

function formatDate(isoDate) {
  if (!isoDate) return ''
  const [, m, d] = isoDate.split('-').map(Number)
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  return `${d} ${months[m - 1]}`
}

function formatValue(value, metricLabel) {
  if (metricLabel === 'UN1T Points') return `${Math.round(value).toLocaleString()} pts`
  if (metricLabel === 'Zone 4+ min') return `${Math.round(value)} min`
  return String(Math.round(value))
}
