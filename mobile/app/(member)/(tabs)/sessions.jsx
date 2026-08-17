// Sessions list — mirrors src/app/sessions/page.jsx.
//
// Query: id, started_at, ended_at, source, avg_hr_bpm, peak_hr_bpm,
//        zones_seconds, effort_points — ordered desc, limit 100.
// RLS scopes reads to the signed-in member automatically.

import { useState, useCallback, useMemo } from 'react'
import { View, Text, Pressable, SectionList, ActivityIndicator, RefreshControl } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useFocusEffect, useRouter } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { supabase } from '../../../lib/member/supabase'
import Card from '../../../components/member/ui/Card'
import ErrorRetry from '../../../components/member/ErrorRetry'
import ZoneBar from '../../../components/member/ui/ZoneBar'
import { zoneBreakdown, isBurn } from 'shared/heart-rate'
import { zoneColorDark } from 'shared/zone-colors'
import { sourceLabel, durationMinutes, sessionDate } from 'shared/format'
import { workoutLabel, formatDistance, formatDuration } from 'shared/workout-detail'
import { buildSessionsList } from 'shared/sessions-list'
import { groupSessionsByMonth } from 'shared/session-history'

// Named export so the Activity tab (History segment) can embed this screen
// without going through the router. The default export stays the route handler
// for /sessions (kept reachable so home's "See all" + any deep-link resolve).
export function SessionsScreen() {
  const router = useRouter()
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [sessions, setSessions] = useState([])
  const [stravaActivities, setStravaActivities] = useState([])
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const { data, error: err } = await supabase
        .from('heart_rate_sessions')
        .select('id, started_at, ended_at, source, avg_hr_bpm, peak_hr_bpm, zones_seconds, effort_points')
        .order('started_at', { ascending: false })
        .limit(100)
      if (err) throw err
      setSessions(data || [])

      // strava_activities — personal-only (mig 308). RLS scopes to the member;
      // never read by any community/leaderboard query. Display-only in the list.
      // Soft-degrades (no throw) so a Strava read blip won't blank the sessions.
      const { data: strava } = await supabase
        .from('strava_activities')
        .select('strava_activity_id, activity_type, name, started_at, distance_meters, duration_seconds, avg_hr_bpm, max_hr_bpm')
        .order('started_at', { ascending: false })
        .limit(100)
      setStravaActivities(strava || [])
    } catch (e) {
      setError(e?.message || 'Failed to load sessions')
    } finally {
      setLoading(false)
    }
  }, [])

  const onRefresh = useCallback(async () => {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }, [load])

  useFocusEffect(
    useCallback(() => {
      load()
    }, [load])
  )

  // One date-sorted list of HR sessions + personal-only Strava activities,
  // then grouped into Europe/Dublin calendar-month sections with a per-month
  // stat line (sessions + UN1T points) for the sticky headers.
  const sections = useMemo(
    () => groupSessionsByMonth(buildSessionsList({ sessions, stravaActivities })),
    [sessions, stravaActivities],
  )

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
        <View className="p-5">
          <Text className="text-2xl font-display-bold text-chalk">Sessions</Text>
          <View className="mt-4">
            {/* Reuse the same Retry affordance as home/progress — the passive
                "Try refreshing" card had no way to actually retry. */}
            <ErrorRetry
              message="We couldn't load your sessions. If it keeps happening, drop us a line."
              onPress={load}
            />
          </View>
        </View>
      </SafeAreaView>
    )
  }

  return (
    <SafeAreaView className="flex-1 bg-iron-bg" edges={['left', 'right']}>
      <SectionList
        contentContainerClassName="p-5 pb-24"
        sections={sections}
        keyExtractor={(item) => item.key}
        stickySectionHeadersEnabled
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor="#F1EEE7"
          />
        }
        ListHeaderComponent={
          <View className="mb-6">
            <Text className="text-2xl font-display-bold text-chalk">Your sessions</Text>
            <Text className="mt-1 text-sm font-body text-chalk-2">
              Every session you've trained, plus activities you've imported.
            </Text>
          </View>
        }
        ListEmptyComponent={
          <Card className="items-center py-8">
            <Ionicons name="heart-outline" size={32} color="#727170" />
            <Text className="mt-3 text-base font-body-semibold text-chalk">No sessions yet</Text>
            <Text className="mt-1 text-sm text-chalk-2 text-center">
              Connect a device, or pair a chest strap at the studio. Every
              session you train will appear here with zone breakdowns and UN1T Points.
            </Text>
          </Card>
        }
        renderSectionHeader={({ section }) => <MonthHeader section={section} />}
        renderItem={({ item }) => (
          <View className="mb-3">
            {item.kind === 'strava' ? (
              <StravaRow activity={item.activity} />
            ) : (
              <SessionRow
                session={item.session}
                onPress={item.session.ended_at ? () => router.push('/sessions/' + item.session.id) : null}
              />
            )}
          </View>
        )}
      />
    </SafeAreaView>
  )
}

// Route handler for /sessions — kept reachable (hidden from the tab bar via
// href:null in (tabs)/_layout) so home's "See all" and any deep-link resolve.
export default function Sessions() {
  return <SessionsScreen />
}

// ── Month section header ──────────────────────────────────────────

// Sticky header per Europe/Dublin calendar month, carrying a stat line
// ("June 2026 · 14 sessions · 3,240 pts"). Solid bg so pinned rows don't show
// through. Strava rows render in-month but are excluded from the counts (they
// carry no UN1T points) — see groupSessionsByMonth.
function MonthHeader({ section }) {
  // A month with only personal activities (e.g. Strava) has no UN1T sessions —
  // count the activity rows instead of showing a misleading "0 sessions".
  const parts = []
  if (section.sessionCount > 0) {
    parts.push(`${section.sessionCount} ${section.sessionCount === 1 ? 'session' : 'sessions'}`)
  } else {
    const n = section.data.length
    parts.push(`${n} ${n === 1 ? 'activity' : 'activities'}`)
  }
  if (section.points > 0) parts.push(`${section.points.toLocaleString()} pts`)
  return (
    <View className="bg-iron-bg pb-2 pt-1">
      <Text className="text-sm font-display-bold text-chalk">{section.title}</Text>
      <Text className="mt-0.5 text-xs font-body text-chalk-2">{parts.join(' · ')}</Text>
    </View>
  )
}

// ── Session row ───────────────────────────────────────────────────

function SessionRow({ session, onPress }) {
  const inProgress = !session.ended_at
  const dur = durationMinutes(session.started_at, session.ended_at)
  const label = sourceLabel(session.source)
  const date = sessionDate(session.started_at)

  // topZone: highest-seconds zone — mirrors the web sort
  const breakdown = zoneBreakdown(session.zones_seconds)
  const topZone = [...breakdown].sort((a, b) => b.seconds - a.seconds)[0]

  // The Burn — ≥12 min in Zone 4+. Furnace (Zone 4) accent.
  const burn = !inProgress && isBurn(session.zones_seconds)

  const startTime = session.started_at
    ? new Intl.DateTimeFormat('en-IE', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Europe/Dublin',
      }).format(new Date(session.started_at))
    : null

  return (
    <Pressable
      onPress={onPress ?? undefined}
      disabled={inProgress}
      className="rounded-[20px] border border-iron-hairline bg-iron-surface p-4 active:opacity-70"
      style={inProgress ? { opacity: 0.5 } : undefined}
    >
      {/* Top row: date+time left, points+top-zone right */}
      <View className="flex-row items-start justify-between gap-4">
        <View className="flex-1 min-w-0">
          <Text className="text-sm font-body-semibold text-chalk" numberOfLines={1}>{date}</Text>
          <Text className="mt-0.5 text-xs font-body text-chalk-2" numberOfLines={1}>
            {[startTime, dur != null ? `${dur} min` : null, label].filter(Boolean).join(' · ')}
          </Text>
        </View>
        <View className="shrink-0 items-end">
          {inProgress ? (
            <View className="rounded-full border border-iron-hairline bg-iron-raised px-2.5 py-0.5">
              <Text className="font-mono text-[10px] uppercase text-chalk-2" style={{ letterSpacing: 1.2 }}>In progress</Text>
            </View>
          ) : (
            <>
              {Number.isFinite(session.effort_points) && (
                <View className="flex-row items-baseline">
                  <Text className="text-xl font-display-bold text-chalk">
                    {session.effort_points}
                  </Text>
                  <Text className="ml-1 font-mono text-[10px] uppercase text-chalk-3" style={{ letterSpacing: 1 }}>UN1T</Text>
                </View>
              )}
              {topZone && topZone.seconds > 0 && (
                <Text className="mt-0.5 text-xs font-body text-chalk-2">
                  Mostly{' '}
                  <Text style={{ color: zoneColorDark(topZone.id) || topZone.color }} className="font-body-medium">
                    {topZone.label}
                  </Text>
                </Text>
              )}
              {burn && (
                <View
                  className="mt-1.5 self-end rounded-full px-2.5 py-0.5"
                  style={{ borderWidth: 1, borderColor: zoneColorDark(4) + '73' }}
                >
                  <Text className="font-mono text-[10px]" style={{ color: zoneColorDark(4), letterSpacing: 1.2 }}>BURN</Text>
                </View>
              )}
            </>
          )}
        </View>
      </View>

      {/* HR stats row — telemetry numbers: mono, with mono uppercase unit tags */}
      {(Number.isFinite(session.avg_hr_bpm) || Number.isFinite(session.peak_hr_bpm)) && (
        <View className="mt-3 flex-row gap-4">
          {Number.isFinite(session.avg_hr_bpm) && (
            <View className="flex-row items-baseline">
              <Text className="font-mono text-xs text-chalk">{session.avg_hr_bpm}</Text>
              <Text className="ml-1 font-mono text-[9px] uppercase text-chalk-3" style={{ letterSpacing: 1 }}>avg</Text>
            </View>
          )}
          {Number.isFinite(session.peak_hr_bpm) && (
            <View className="flex-row items-baseline">
              <Text className="font-mono text-xs text-chalk">{session.peak_hr_bpm}</Text>
              <Text className="ml-1 font-mono text-[9px] uppercase text-chalk-3" style={{ letterSpacing: 1 }}>peak</Text>
            </View>
          )}
        </View>
      )}

      <ZoneBar zonesSeconds={session.zones_seconds} height={6} className="mt-3" />
    </Pressable>
  )
}

// ── Strava activity row (personal-only) ───────────────────────────

// DISPLAY-ONLY per Strava API Policy §5.4: no UN1T points, no zone bar, and not
// tappable — there's no heart_rate_sessions detail behind it. Badged so it reads
// as distinct from a points-bearing UN1T session.
function StravaRow({ activity }) {
  const date = sessionDate(activity.started_at)
  const title = activity.name || workoutLabel(activity.activity_type)
  const dur = formatDuration(activity.duration_seconds)
  const dist = formatDistance(activity.distance_meters)
  const hr = Number.isFinite(Number(activity.avg_hr_bpm)) ? Math.round(Number(activity.avg_hr_bpm)) : null
  const startTime = activity.started_at
    ? new Intl.DateTimeFormat('en-IE', {
        hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Dublin',
      }).format(new Date(activity.started_at))
    : null
  const meta = [startTime, title, dur, dist].filter(Boolean).join(' · ')

  return (
    <View className="rounded-[20px] border border-iron-hairline bg-iron-surface p-4">
      <View className="flex-row items-start justify-between gap-4">
        <View className="flex-1 min-w-0">
          <Text className="text-sm font-body-semibold text-chalk" numberOfLines={1}>{date}</Text>
          <Text className="mt-0.5 text-xs font-body text-chalk-2" numberOfLines={1}>{meta}</Text>
        </View>
        <View className="shrink-0 flex-row items-center gap-1.5 rounded-full border border-iron-hairline bg-iron-raised px-2.5 py-0.5">
          <View className="h-2 w-2 rounded-full" style={{ backgroundColor: '#FC4C02' }} />
          <Text className="font-mono text-[10px] uppercase text-chalk-2" style={{ letterSpacing: 1.2 }}>Strava</Text>
        </View>
      </View>
      {hr != null && (
        <View className="mt-3 flex-row gap-4">
          <View className="flex-row items-baseline">
            <Text className="font-mono text-xs text-chalk">{hr}</Text>
            <Text className="ml-1 font-mono text-[9px] uppercase text-chalk-3" style={{ letterSpacing: 1 }}>avg bpm</Text>
          </View>
        </View>
      )}
    </View>
  )
}
