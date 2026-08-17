// Progress — native twin of the web Progress screen (src/app/progress/ProgressView.jsx).
//
// Same five cards, same computations (from the Task-1 progress-analytics lib),
// same per-card behaviour — only the rendering differs (RN + NativeWind +
// react-native-svg instead of web CSS/inline-svg). This screen is presentational:
// every total/aggregate comes from a lib field, never re-derived by hand (except
// the trivial lifetime sums in the headline, which the lib doesn't expose).
//
//   1. Headline strip   — streak, lifetime sessions + points, trend chip
//   2. Trend chart       — react-native-svg bar chart, 12 weeks, series toggle
//   3. Monthly recap     — horizontal scroll of month cards + fittest badge
//   4. Personal records  — 5 tiles (linked to the source session where known)
//   5. Activity calendar — 7×N <Rect> heatmap, accent-intensity by count
//
// RLS on the mobile Supabase client scopes reads to the signed-in member.

import { useState, useCallback, useMemo } from 'react'
import { View, Text, Pressable, ActivityIndicator, ScrollView, useWindowDimensions } from 'react-native'
import { lifetimeMilestones } from 'shared/session-history'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useFocusEffect, useRouter } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import Svg, { Rect, Polyline } from 'react-native-svg'
import { supabase } from '../../../lib/member/supabase'
import Card from '../../../components/member/ui/Card'
import ErrorRetry from '../../../components/member/ErrorRetry'
import {
  weeklyBuckets,
  monthlyRecap,
  personalRecords,
  activityCalendar,
} from 'shared/progress-analytics'
import { currentStreak, trendDelta } from 'shared/hr-analytics'
import { workoutLabel, sessionDetailChips, formatDistance, formatDuration } from 'shared/workout-detail'
import { buildTrendViews, TREND_METRICS } from 'shared/wearable-trends-view'
import { accentFromSessions, PEARL } from '../../../lib/member/brand'

// No fixed accent: the chart, heatmap and chips take the EARNED Afterglow
// accent (shared rule via lib/member/brand, spec §2.2; P4b lit = volt)
// threaded down from ProgressScreen, so
// the whole surface reads in the member's own hardest-zone colour — Pearl
// when the trailing week is quiet. HR-zone colours stay reserved for zone
// bars (they're data, never chrome).
const SURFACE_2 = '#24242A' // iron-raised equivalent for SVG fills
const TEXT_2 = '#B3B2AC'    // chalk-2 for muted trend arrows

const TREND_SERIES = [
  { key: 'points', label: 'Points', pick: (b) => b.points },
  { key: 'peak', label: 'Peak HR', pick: (b) => b.avgPeakHr },
  { key: 'count', label: 'Classes', pick: (b) => b.count },
]

const fmtDate = (ms) =>
  new Intl.DateTimeFormat('en-IE', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  }).format(new Date(ms))


// Named export so the Activity tab (Trends / Records segments) can embed this
// screen. The default export stays the route handler for /progress (kept
// reachable so home's Progress row + any deep-link resolve).
//
// `focus` reorders the same cards for the Activity segments — no internal
// rewrite: 'trends' (default) is the full screen as-is; 'records' floats the
// Personal-records card to the top and drops the "Progress" page header (the
// Activity tab supplies its own). All data + card components are unchanged.
export function ProgressScreen({ focus = 'trends', showHeader = true } = {}) {
  const router = useRouter()
  const [loading, setLoading] = useState(true)
  const [sessions, setSessions] = useState([])
  const [healthMetrics, setHealthMetrics] = useState([])
  const [stravaActivities, setStravaActivities] = useState([])
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      // ALL-TIME, newest first, paginated in 1000-row pages (HARD_LIMIT-bounded).
      // The lifetime milestones + points headline must count every session ever
      // — a 365-day window silently under-reported long-tenured members and hid
      // their biggest milestones. The year heatmap / weekly / monthly views all
      // window internally, so the wider set is safe for them; newest-first order
      // keeps those recent windows complete even if the hard cap ever trims.
      const all = []
      const PAGE = 1000, HARD_LIMIT = 20000
      for (let from = 0; from < HARD_LIMIT; from += PAGE) {
        const { data, error: err } = await supabase
          .from('heart_rate_sessions')
          .select('id, started_at, ended_at, effort_points, avg_hr_bpm, peak_hr_bpm, zones_seconds, source, workout_type, calories_kcal, distance_meters, avg_pace_sec_per_km')
          .order('started_at', { ascending: false })
          .range(from, from + PAGE - 1)
        if (err) throw err
        const rows = data || []
        all.push(...rows)
        if (rows.length < PAGE) break
      }
      setSessions(all)

      // member_health_metrics — last 180 days, RLS scopes to the member. Filter to
      // the displayed metrics and fetch newest-first + capped: an ascending,
      // unfiltered read hit the row cap and returned the OLDEST rows, so "latest"
      // went stale. buildTrendViews re-sorts ascending internally.
      const healthSince = new Date(Date.now() - 180 * 24 * 3600 * 1000).toISOString()
      const { data: hm } = await supabase
        .from('member_health_metrics')
        .select('metric, recorded_at, value, unit')
        .in('metric', TREND_METRICS)
        .gte('recorded_at', healthSince)
        .order('recorded_at', { ascending: false })
        .limit(1000)
      setHealthMetrics(hm || [])

      // strava_activities — personal-only (mig 308). RLS scopes to the member;
      // never read by any community/leaderboard query. Newest first, capped.
      const { data: strava } = await supabase
        .from('strava_activities')
        .select('strava_activity_id, activity_type, name, started_at, distance_meters, duration_seconds, avg_hr_bpm, max_hr_bpm')
        .order('started_at', { ascending: false })
        .limit(30)
      setStravaActivities(strava || [])
    } catch (e) {
      setError(e?.message || 'Failed to load progress')
    } finally {
      // Silent refetch-on-focus: never blank the screen once loaded.
      setLoading(false)
    }
  }, [])

  useFocusEffect(
    useCallback(() => {
      load()
    }, [load])
  )

  const trendViews = useMemo(() => buildTrendViews(healthMetrics), [healthMetrics])

  // Afterglow: the accent is EARNED from the trailing week's training (same
  // wiring as home). Sessions arrive all-time newest-first with zones_seconds,
  // so the set already contains the 7-day window accentFromSessions reads.
  const earned = useMemo(() => accentFromSessions(sessions, Date.now()), [sessions])

  const data = useMemo(() => {
    const now = Date.now()
    return {
      weeks: weeklyBuckets(sessions, now, 12),
      recap: monthlyRecap(sessions, now, 6),
      records: personalRecords(sessions),
      // Two windows for the activity calendar: 12 weeks (default, reads cleanly
      // on phone) and a full year (52 weeks) behind a toggle — the "look how
      // far I've come" view. Same accent-intensity encoding; year mode scrolls.
      calendar: activityCalendar(sessions, now, 84),
      calendarYear: activityCalendar(sessions, now, 364),
      milestones: lifetimeMilestones(sessions, now),
      streak: currentStreak(sessions, now),
      pointsTrend: trendDelta(sessions, 'effort_points', now),
      lifetimePoints: (sessions || []).reduce(
        (acc, s) => acc + (Number.isFinite(s.effort_points) ? s.effort_points : 0), 0,
      ),
    }
  }, [sessions])

  if (loading) {
    return (
      <SafeAreaView className="flex-1 bg-iron-bg items-center justify-center" edges={['left', 'right']}>
        <ActivityIndicator color="#F1EEE7" size="large" />
      </SafeAreaView>
    )
  }

  // Only show the error screen on a failed INITIAL load. A transient
  // focus-refetch failure must not blank an already-loaded screen (honours
  // the silent-refetch intent above).
  if (error && sessions.length === 0) {
    return (
      <SafeAreaView className="flex-1 bg-iron-bg" edges={['left', 'right']}>
        <ScrollView contentContainerClassName="p-5 pb-24">
          <ErrorRetry onPress={load} />
        </ScrollView>
      </SafeAreaView>
    )
  }

  // Same low-data fallback as web: zero sessions → a single empty state.
  if (!sessions || sessions.length === 0) {
    return (
      <SafeAreaView className="flex-1 bg-iron-bg" edges={['left', 'right']}>
        <ScrollView contentContainerClassName="p-5 pb-24">
          {showHeader && <Header />}
          <Card className={`${showHeader ? 'mt-8' : ''} items-center py-8`}>
            <Ionicons name="trending-up-outline" size={32} color="#727170" />
            <Text className="mt-3 text-base font-body-semibold text-chalk">No progress yet</Text>
            <Text className="mt-1 text-sm text-chalk-2 text-center">
              Train your first class to start tracking your progress — your
              trends, records and activity will build up here as you go.
            </Text>
          </Card>
        </ScrollView>
      </SafeAreaView>
    )
  }

  const recordsFirst = focus === 'records'
  const recordsCard = (
    <RecordsCard records={data.records} onOpenSession={(id) => router.push('/sessions/' + id)} />
  )

  return (
    <SafeAreaView className="flex-1 bg-iron-bg" edges={['left', 'right']}>
      <ScrollView contentContainerClassName="p-5 pb-24" showsVerticalScrollIndicator={false}>
        {showHeader && <Header />}
        {recordsFirst && (
          <View className={showHeader ? 'mt-8' : ''}>{recordsCard}</View>
        )}
        <View className={showHeader && !recordsFirst ? 'mt-8' : 'mt-4'}>
          <HeadlineStrip
            streak={data.streak}
            sessionCount={sessions.length}
            lifetimePoints={data.lifetimePoints}
            trend={data.pointsTrend}
            accent={earned.color}
          />
        </View>
        <MilestonesStrip milestones={data.milestones} accent={earned.color} />
        <View className="mt-4">
          <TrendCard weeks={data.weeks} accent={earned.color} />
        </View>
        <View className="mt-4">
          <MonthlyRecapCard recap={data.recap} accent={earned.color} />
        </View>
        {!recordsFirst && (
          <View className="mt-4">{recordsCard}</View>
        )}
        <View className="mt-4">
          <ActivityCalendarCard calendar={data.calendar} calendarYear={data.calendarYear} accent={earned.color} />
        </View>
        <AppleWorkoutsCard sessions={sessions} />
        <StravaActivitiesCard activities={stravaActivities} />
        <RecoveryFitnessCard trendViews={trendViews} accent={earned.color} />
      </ScrollView>
    </SafeAreaView>
  )
}

// Route handler for /progress — kept reachable (hidden from the tab bar via
// href:null in (tabs)/_layout) so home's Progress row and any deep-link resolve.
export default function Progress() {
  return <ProgressScreen />
}

function Header() {
  return (
    <View>
      <Text className="text-2xl font-display-bold text-chalk">Progress</Text>
      <Text className="mt-1 text-sm font-body text-chalk-2">Your fitness over time.</Text>
    </View>
  )
}

// ── 1. headline strip ────────────────────────────────────────────

function HeadlineStrip({ streak, sessionCount, lifetimePoints, trend, accent = PEARL }) {
  return (
    <Card>
      <View className="flex-row" style={{ gap: 12 }}>
        <HeadlineStat label="Streak" value={String(streak.current)} unit={streak.current === 1 ? 'day' : 'days'} />
        <HeadlineStat label="Sessions" value={sessionCount.toLocaleString()} />
        <HeadlineStat label="UN1T Points" value={lifetimePoints.toLocaleString()} />
      </View>
      {trend.hasEnoughData && <TrendChip trend={trend} accent={accent} />}
    </Card>
  )
}

function HeadlineStat({ label, value, unit }) {
  return (
    <View className="flex-1">
      <Text className="font-mono text-[10px] uppercase text-chalk-3" style={{ letterSpacing: 2 }}>{label}</Text>
      <View className="mt-1 flex-row items-baseline">
        <Text className="text-2xl font-display-bold text-chalk">{value}</Text>
        {unit ? <Text className="ml-1 font-mono text-[10px] uppercase text-chalk-3" style={{ letterSpacing: 1 }}>{unit}</Text> : null}
      </View>
    </View>
  )
}

function TrendChip({ trend, accent = PEARL }) {
  const pct = Math.round(Math.abs(trend.deltaPct ?? 0) * 100)
  const arrow = trend.direction === 'up' ? '▲' : trend.direction === 'down' ? '▼' : '→'
  // Up = good (more points). Flat is neutral. Down is muted, not alarming —
  // a member's load naturally ebbs.
  const color = trend.direction === 'up' ? accent : TEXT_2
  const text = trend.direction === 'flat'
    ? 'Steady vs last 4 weeks'
    : `${pct}% vs last 4 weeks`
  return (
    <View className="mt-4 flex-row items-center" style={{ gap: 6 }}>
      <Text className="text-xs font-body-medium" style={{ color }}>{arrow}</Text>
      <Text className="text-xs font-body-medium" style={{ color }}>{text}</Text>
    </View>
  )
}

// ── 2. trend chart ───────────────────────────────────────────────

function TrendCard({ weeks, accent = PEARL }) {
  const [seriesKey, setSeriesKey] = useState('points')
  const series = TREND_SERIES.find((s) => s.key === seriesKey) || TREND_SERIES[0]
  const allEmpty = weeks.every((w) => w.count === 0)

  return (
    <Card>
      <View className="flex-row items-center justify-between" style={{ gap: 12 }}>
        <Text className="text-base font-display text-chalk">Fitness over time</Text>
        <SeriesToggle value={seriesKey} onChange={setSeriesKey} />
      </View>
      {allEmpty ? (
        <Text className="mt-6 text-sm text-chalk-2">
          Keep training to see your trend — the last 12 weeks fill in here.
        </Text>
      ) : (
        <TrendChart weeks={weeks} pick={series.pick} accent={accent} />
      )}
    </Card>
  )
}

function SeriesToggle({ value, onChange }) {
  return (
    <View className="flex-row rounded-xl border border-iron-hairline bg-iron-raised p-0.5">
      {TREND_SERIES.map((s) => {
        const active = s.key === value
        return (
          <Pressable
            key={s.key}
            onPress={() => onChange(s.key)}
            className={`rounded-lg px-2.5 py-1 ${active ? 'bg-chalk' : ''}`}
          >
            <Text className={`text-xs font-body-medium ${active ? 'text-iron-bg' : 'text-chalk-2'}`}>
              {s.label}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

function TrendChart({ weeks, pick, accent = PEARL }) {
  // Same approach as the sessions/[id] HR chart (HrChart.jsx): map values into
  // a fixed viewBox, scaled to the series max. Null/0 weeks render as zero-height
  // bars (an empty slot on the axis). viewBox scales to full card width.
  const W = 700
  const H = 180
  const PAD = 12
  const inner = W - 2 * PAD
  const gap = 6
  const barW = (inner - gap * (weeks.length - 1)) / weeks.length

  const vals = weeks.map((w) => {
    const v = pick(w)
    return Number.isFinite(v) ? v : 0
  })
  const maxVal = Math.max(1, ...vals)

  // Label ~4 evenly spaced x-ticks so the axis isn't cramped.
  const tickEvery = Math.max(1, Math.ceil(weeks.length / 4))

  return (
    <View className="mt-4">
      <Svg viewBox={`0 0 ${W} ${H}`} width="100%" height={176}>
        {weeks.map((w, i) => {
          const v = vals[i]
          const h = (v / maxVal) * (H - 2 * PAD)
          const x = PAD + i * (barW + gap)
          const y = H - PAD - h
          return (
            <Rect
              key={w.weekStartMs}
              x={x}
              y={y}
              width={barW}
              height={Math.max(0, h)}
              rx={2}
              fill={accent}
              fillOpacity={v > 0 ? 0.9 : 0}
            />
          )
        })}
      </Svg>
      <View className="mt-2 flex-row justify-between">
        {weeks.map((w, i) => (
          <View key={w.weekStartMs} className="flex-1 items-center">
            <Text className="font-mono text-[10px] text-chalk-3">
              {i % tickEvery === 0 ? w.label : ''}
            </Text>
          </View>
        ))}
      </View>
    </View>
  )
}

// ── 3. monthly recap ─────────────────────────────────────────────

function MonthlyRecapCard({ recap, accent = PEARL }) {
  const { months, fittest } = recap
  const router = useRouter()
  return (
    <Card>
      <View className="flex-row items-center justify-between">
        <Text className="text-base font-display text-chalk">Monthly recap</Text>
        <Pressable onPress={() => router.push('/wrapped/month')} hitSlop={8} className="active:opacity-70">
          <Text className="text-xs font-body-medium" style={{ color: accent }}>View last month →</Text>
        </Pressable>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        className="mt-4"
        contentContainerStyle={{ gap: 12, paddingRight: 4 }}
      >
        {months.map((m) => {
          const isFittest = fittest && fittest.year === m.year && fittest.month === m.month
          return (
            <View
              key={`${m.year}-${m.month}`}
              className="rounded-[16px] border border-iron-hairline bg-iron-raised p-3"
              style={{ width: 124 }}
            >
              <View className="flex-row items-center justify-between" style={{ gap: 4 }}>
                <Text className="text-xs font-body-semibold text-chalk">{m.label}</Text>
                {isFittest && <Ionicons name="trophy" size={11} color={accent} />}
              </View>
              <View className="mt-2 flex-row items-baseline">
                <Text className="text-lg font-display-bold text-chalk">{m.points.toLocaleString()}</Text>
                <Text className="ml-1 font-mono text-[9px] uppercase text-chalk-3" style={{ letterSpacing: 1 }}>pts</Text>
              </View>
              <Text className="mt-0.5 font-mono text-[10px] text-chalk-2">
                {m.count} {m.count === 1 ? 'session' : 'sessions'} · {m.minutes} min
              </Text>
            </View>
          )
        })}
      </ScrollView>
    </Card>
  )
}

// ── 4. personal records ──────────────────────────────────────────

function RecordsCard({ records, onOpenSession }) {
  const tiles = [
    { label: 'Best session', rec: records.bestSessionPoints, unit: 'pts' },
    { label: 'Highest peak HR', rec: records.highestPeakHr, unit: 'bpm' },
    { label: 'Longest session', rec: records.longestSessionMin, unit: 'min' },
    { label: 'Best week', rec: records.bestWeekPoints, unit: 'pts' },
    { label: 'Best streak', rec: records.bestStreak ? { value: records.bestStreak } : null, unit: records.bestStreak === 1 ? 'day' : 'days' },
  ]
  return (
    <Card>
      <Text className="text-base font-display text-chalk">Personal records</Text>
      <View className="mt-4 flex-row flex-wrap" style={{ gap: 12 }}>
        {tiles.map((t) => (
          <RecordTile key={t.label} label={t.label} rec={t.rec} unit={t.unit} onOpenSession={onOpenSession} />
        ))}
      </View>
    </Card>
  )
}

function RecordTile({ label, rec, unit, onOpenSession }) {
  const hasValue = rec && Number.isFinite(rec.value)
  const sub = hasValue && rec.atMs
    ? fmtDate(rec.atMs)
    : hasValue && rec.weekStartMs
      ? `week of ${fmtDate(rec.weekStartMs)}`
      : null

  const body = (
    <>
      <Text className="font-mono text-[9px] uppercase text-chalk-3" style={{ letterSpacing: 1.4 }}>{label}</Text>
      <View className="mt-1 flex-row items-baseline">
        <Text className="text-xl font-display-bold text-chalk">
          {hasValue ? rec.value.toLocaleString() : '—'}
        </Text>
        {hasValue ? <Text className="ml-1 font-mono text-[10px] uppercase text-chalk-3" style={{ letterSpacing: 1 }}>{unit}</Text> : null}
      </View>
      {sub ? <Text className="mt-0.5 font-mono text-[10px] text-chalk-2" numberOfLines={1}>{sub}</Text> : null}
    </>
  )

  // Two columns: subtract the card padding (40) + the inter-tile gap (12),
  // then halve. flexBasis keeps wrap honest across font scales.
  const { width } = useWindowDimensions()
  const tileW = (width - 40 - 40 - 12) / 2
  const base = 'rounded-[16px] border border-iron-hairline bg-iron-raised p-3'

  if (hasValue && rec.sessionId) {
    return (
      <Pressable
        onPress={() => onOpenSession(rec.sessionId)}
        className={`${base} active:opacity-70`}
        style={{ width: tileW }}
      >
        {body}
      </Pressable>
    )
  }
  return <View className={base} style={{ width: tileW }}>{body}</View>
}

// ── 5a. apple health workouts ────────────────────────────────────

// Renders only when the member has apple_health sessions. Shows the
// workout type label + calories/distance/pace chips for each, newest
// first, capped at 10 so the list stays scannable.
function AppleWorkoutsCard({ sessions }) {
  const appleSessions = (sessions || [])
    .filter((s) => s.source === 'apple_health')
    .slice(0, 10)

  if (appleSessions.length === 0) return null

  return (
    <View className="mt-4">
      <Card>
        <Text className="text-base font-display text-chalk">Apple Health workouts</Text>
        <View className="mt-3" style={{ gap: 0 }}>
          {appleSessions.map((s, i) => {
            const chips = sessionDetailChips(s)
            return (
              <View
                key={s.id}
                className={`flex-row items-center justify-between py-2.5${i === 0 ? '' : ' border-t border-iron-hairline'}`}
                style={{ gap: 16 }}
              >
                <View className="flex-1 min-w-0">
                  <Text className="text-sm font-body-medium text-chalk">
                    {workoutLabel(s.workout_type)}
                  </Text>
                  <Text className="mt-0.5 text-xs text-chalk-2">
                    {new Intl.DateTimeFormat('en-IE', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(s.started_at))}
                  </Text>
                </View>
                {chips.length > 0 && (
                  <View className="flex-row flex-wrap justify-end" style={{ gap: 6, flexShrink: 0 }}>
                    {chips.map((chip) => (
                      <View
                        key={chip.key}
                        className="rounded-full border border-iron-hairline bg-iron-raised px-2 py-0.5"
                      >
                        <Text className="font-mono text-[10px] text-chalk-2">{chip.label}</Text>
                      </View>
                    ))}
                  </View>
                )}
              </View>
            )
          })}
        </View>
      </Card>
    </View>
  )
}

// ── 5a-ii. strava activities (personal-only) ─────────────────────

// Renders only when the member has imported Strava activities (mig 308).
// PERSONAL-ONLY (Strava API Policy §5.4): this card lives ONLY on the member's
// own Progress — never a leaderboard / feed / friend-board.
function StravaActivitiesCard({ activities }) {
  const rows = (activities || []).slice(0, 10)
  if (rows.length === 0) return null

  return (
    <View className="mt-4">
      <Card>
        <View className="flex-row items-center" style={{ gap: 8 }}>
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: '#FC4C02' }} />
          <Text className="text-base font-display text-chalk">Strava activities</Text>
        </View>
        <View className="mt-3" style={{ gap: 0 }}>
          {rows.map((a, i) => {
            const chips = stravaChips(a)
            return (
              <View
                key={a.strava_activity_id}
                className={`flex-row items-center justify-between py-2.5${i === 0 ? '' : ' border-t border-iron-hairline'}`}
                style={{ gap: 16 }}
              >
                <View className="flex-1 min-w-0">
                  <Text className="text-sm font-body-medium text-chalk" numberOfLines={1}>
                    {a.name || workoutLabel(a.activity_type)}
                  </Text>
                  <Text className="mt-0.5 text-xs text-chalk-2">
                    {a.started_at
                      ? new Intl.DateTimeFormat('en-IE', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(a.started_at))
                      : ''}
                  </Text>
                </View>
                {chips.length > 0 && (
                  <View className="flex-row flex-wrap justify-end" style={{ gap: 6, flexShrink: 0 }}>
                    {chips.map((chip) => (
                      <View
                        key={chip.key}
                        className="rounded-full border border-iron-hairline bg-iron-raised px-2 py-0.5"
                      >
                        <Text className="font-mono text-[10px] text-chalk-2">{chip.label}</Text>
                      </View>
                    ))}
                  </View>
                )}
              </View>
            )
          })}
        </View>
      </Card>
    </View>
  )
}

function stravaChips(a) {
  const chips = []
  const dist = formatDistance(a?.distance_meters)
  if (dist) chips.push({ key: 'distance', label: dist })
  const dur = formatDuration(a?.duration_seconds)
  if (dur) chips.push({ key: 'duration', label: dur })
  const hr = a?.avg_hr_bpm
  if (hr !== null && hr !== undefined && Number.isFinite(Number(hr))) {
    chips.push({ key: 'hr', label: `${Math.round(Number(hr))} bpm` })
  }
  return chips
}

// ── 5b. recovery & fitness trends ────────────────────────────────

// Renders only when member_health_metrics has rows (buildTrendViews returns
// at least one view). Per-metric label, latest + unit, direction arrow,
// and a small react-native-svg Polyline sparkline.
function RecoveryFitnessCard({ trendViews, accent = PEARL }) {
  if (!trendViews || trendViews.length === 0) return null

  return (
    <View className="mt-4">
      <Card>
        <Text className="text-base font-display text-chalk">Recovery &amp; fitness</Text>
        <View className="mt-3" style={{ gap: 0 }}>
          {trendViews.map((view, i) => {
            const arrow = view.direction === 'up' ? '▲' : view.direction === 'down' ? '▼' : '→'
            const arrowColor =
              view.improving === true ? accent
              : view.improving === false ? '#727170'
              : TEXT_2

            return (
              <View
                key={view.metric}
                className={`flex-row items-center justify-between py-2.5${i === 0 ? '' : ' border-t border-iron-hairline'}`}
                style={{ gap: 16 }}
              >
                <View className="flex-1 min-w-0">
                  <Text className="text-sm font-body-medium text-chalk">{view.label}</Text>
                  <View className="mt-0.5 flex-row items-center" style={{ gap: 4 }}>
                    <Text className="font-mono text-sm text-chalk">{view.latest}</Text>
                    <Text className="font-mono text-[10px] uppercase text-chalk-3" style={{ letterSpacing: 1 }}>{view.unit}</Text>
                    <Text className="text-xs font-body-medium" style={{ color: arrowColor }}>{arrow}</Text>
                  </View>
                </View>
                {view.points.length > 1 && (
                  <NativeTrendSparkline points={view.points} improving={view.improving} accent={accent} />
                )}
              </View>
            )
          })}
        </View>
      </Card>
    </View>
  )
}

function NativeTrendSparkline({ points, improving, accent = PEARL }) {
  const W = 64
  const H = 28
  const PAD = 3
  const vals = points.map((p) => p.value)
  const minV = Math.min(...vals)
  const maxV = Math.max(...vals)
  const rangeV = maxV - minV || 1
  const innerW = W - 2 * PAD
  const innerH = H - 2 * PAD
  const pts = points.map((p, i) => {
    const x = PAD + (i / (points.length - 1)) * innerW
    // Invert Y: higher value = lower y pixel
    const y = PAD + (1 - (p.value - minV) / rangeV) * innerH
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')
  const stroke =
    improving === true ? accent : improving === false ? '#727170' : TEXT_2
  return (
    <Svg width={W} height={H}>
      <Polyline
        points={pts}
        fill="none"
        stroke={stroke}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  )
}

// ── 6. all-time milestones ───────────────────────────────────────

// A tasteful strip of the member's crossed round-number milestones (total
// sessions, points, hours, best streak). Computed by lifetimeMilestones; we
// render only the notable ones, capped so it never becomes a wall of stats.
// Renders nothing until the member has crossed their first threshold.
function MilestonesStrip({ milestones, accent = PEARL }) {
  const items = (milestones?.milestones || []).slice(0, 4)
  if (items.length === 0) return null

  const ICONS = {
    sessions: 'flame',
    points: 'flash',
    hours: 'time',
    streak: 'calendar',
  }
  const MILESTONE_CAPTIONS = {
    sessions: 'sessions trained at UN1T',
    points: 'UN1T Points earned',
    hours: 'hours of training',
    streak: 'day best streak',
  }

  return (
    <View className="mt-4">
      <Card>
        <Text className="text-base font-display text-chalk">Milestones</Text>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          className="mt-4"
          contentContainerStyle={{ gap: 12, paddingRight: 4 }}
        >
          {items.map((m) => (
            <View
              key={m.id}
              className="rounded-[16px] border border-iron-hairline bg-iron-raised p-3"
              style={{ width: 150 }}
            >
              <View className="flex-row items-center" style={{ gap: 6 }}>
                <Ionicons name={ICONS[m.kind] || 'trophy'} size={14} color={accent} />
                <Text className="text-2xl font-display-bold text-chalk">
                  {m.threshold.toLocaleString()}
                </Text>
              </View>
              <Text className="mt-1 text-[12px] leading-4 text-chalk-2">
                {MILESTONE_CAPTIONS[m.kind] || 'milestone'}
              </Text>
            </View>
          ))}
        </ScrollView>
      </Card>
    </View>
  )
}

// ── 5. activity calendar ─────────────────────────────────────────

function ActivityCalendarCard({ calendar, calendarYear, accent = PEARL }) {
  // "12 weeks" (default) vs "Year" — the year view is the progress artifact.
  // 12-week fits the card width; the year grid (52 cols) can exceed it, so we
  // wrap it in a horizontal ScrollView rather than shrinking cells to nothing.
  const [range, setRange] = useState('12w')
  const isYear = range === 'year'
  const active = isYear && calendarYear ? calendarYear : calendar
  const { days, maxCount } = active

  // Pad the front so the first column starts on the correct day-of-week row
  // (Mon=0 … Sun=6, matching the lib's Monday-anchored weeks). Padding cells
  // are invisible placeholders.
  const firstDow = days.length > 0 ? (new Date(days[0].dayMs).getUTCDay() + 6) % 7 : 0
  const cells = [
    ...Array.from({ length: firstDow }, () => null),
    ...days,
  ]
  const cols = Math.ceil(cells.length / 7)

  // Lay the heatmap out in an SVG grid (column-major, like the web grid-flow-col):
  // 7 rows, `cols` columns.
  const { width } = useWindowDimensions()
  const avail = width - 40 - 40 // screen padding + card padding
  const gap = 3
  // 12-week: fit-to-width (clamped 8–16). Year: fixed ~11px cells and let the
  // grid overflow into a horizontal scroll — keeps every day legible.
  const cell = isYear
    ? 11
    : Math.max(8, Math.min(16, (avail - gap * (cols - 1)) / cols))
  const gridW = cols * cell + (cols - 1) * gap
  const gridH = 7 * cell + 6 * gap

  const grid = (
    <Svg width={gridW} height={gridH}>
      {cells.map((d, i) => {
        if (!d) return null
        const col = Math.floor(i / 7)
        const row = i % 7
        const x = col * (cell + gap)
        const y = row * (cell + gap)
        const lit = d.count > 0
        const intensity = d.count / Math.max(maxCount, 1)
        // Faint base cell at 0; ramp opacity with count. Floor the lit
        // cells at 0.25 so a single session is clearly visible.
        return (
          <Rect
            key={d.dayMs}
            x={x}
            y={y}
            width={cell}
            height={cell}
            rx={3}
            fill={lit ? accent : SURFACE_2}
            fillOpacity={lit ? 0.25 + 0.75 * intensity : 1}
          />
        )
      })}
    </Svg>
  )

  return (
    <Card>
      <View className="flex-row items-center justify-between" style={{ gap: 12 }}>
        <View>
          <Text className="text-base font-display text-chalk">Activity</Text>
          <Text className="mt-1 text-xs text-chalk-2">
            {isYear ? 'Last 52 weeks' : 'Last 12 weeks'}
          </Text>
        </View>
        <RangeToggle value={range} onChange={setRange} hasYear={!!calendarYear} />
      </View>
      <View className="mt-4">
        {isYear ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            {grid}
          </ScrollView>
        ) : (
          grid
        )}
      </View>
    </Card>
  )
}

function RangeToggle({ value, onChange, hasYear }) {
  const OPTS = [
    { key: '12w', label: '12 weeks' },
    { key: 'year', label: 'Year' },
  ]
  return (
    <View className="flex-row rounded-xl border border-iron-hairline bg-iron-raised p-0.5">
      {OPTS.map((o) => {
        const active = o.key === value
        const disabled = o.key === 'year' && !hasYear
        return (
          <Pressable
            key={o.key}
            onPress={() => !disabled && onChange(o.key)}
            disabled={disabled}
            className={`rounded-lg px-2.5 py-1 ${active ? 'bg-chalk' : ''}`}
            style={disabled ? { opacity: 0.4 } : undefined}
          >
            <Text className={`text-xs font-body-medium ${active ? 'text-iron-bg' : 'text-chalk-2'}`}>
              {o.label}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}
