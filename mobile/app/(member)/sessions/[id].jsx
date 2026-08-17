// Session detail — client screen.
//
// Fetches the report from the API (envelope: { report }) in parallel
// with hr_samples + contact_achievements from Supabase (RLS-scoped).
// Mirrors the web page at src/app/sessions/[id]/page.jsx.

import { useState, useEffect, useRef } from 'react'
import {
  View, Text, ScrollView, ActivityIndicator,
  Pressable, Share,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import * as Linking from 'expo-linking'
import { supabase } from '../../../lib/member/supabase'
import { api } from '../../../lib/member/api'
import { hasSeenRecap, clearRecapSeen } from '../../../lib/member/recap-seen'
import Card from '../../../components/member/ui/Card'
import Button from '../../../components/member/ui/Button'
import HrChart from '../../../components/member/HrChart'
import TickRule from '../../../components/member/ui/TickRule'
import { Telemetry } from '../../../components/member/ui/Type'
import Glow from '../../../components/member/ui/Glow'
import { hardestZone, PEARL, VOLT } from '../../../lib/member/brand'
import { zoneColorDark } from 'shared/zone-colors'
import { sourceLabel, durationMinutes, sessionDate, workoutTypeLabel, formatPace, formatDistanceKm } from 'shared/format'

// The Burn accent = the Zone 4 colour (Furnace on the dark canvas), tying
// the badge to the zone it rewards.
const BURN_COLOR = zoneColorDark(4)

// ── downsample helper (verbatim from web) ─────────────────────────
function downsample(samples, max) {
  if (samples.length <= max) return samples
  const stride = Math.ceil(samples.length / max)
  const out = []
  for (let i = 0; i < samples.length; i += stride) out.push(samples[i])
  if (out[out.length - 1] !== samples[samples.length - 1]) out.push(samples[samples.length - 1])
  return out
}

// ── Comparison text (verbatim logic from web) ─────────────────────
function VsThisClass({ c }) {
  if (c?.percentile == null || c?.sample_size < 2) return null
  const pct = Math.round(c.percentile * 100)
  const cls = c.event_type_name || 'this class'
  let text
  if (pct >= 100) text = `Personal best — top of your last ${c.sample_size} ${cls} sessions.`
  else if (pct >= 50) text = `Top ${100 - pct}% of your last ${c.sample_size} ${cls} sessions.`
  else text = `Below your usual for ${cls} (avg ${c.mean_points} pts over your last ${c.sample_size}).`
  return <Text className="text-sm text-chalk-2">{text}</Text>
}

function VsCategory({ c }) {
  if (!c || c.percentile == null || c.sample_size < 2) return null
  const pct = Math.round(c.percentile * 100)
  let text
  if (pct >= 100) text = `Personal best — top of your last ${c.sample_size} ${c.category} classes.`
  else if (pct >= 50) text = `Top ${100 - pct}% of your last ${c.sample_size} ${c.category} classes.`
  else text = `Below your usual for ${c.category} classes (avg ${c.mean_points} pts over your last ${c.sample_size}).`
  return <Text className="text-sm text-chalk-2">{text}</Text>
}

function VsRecent({ t }) {
  if (!t) return null
  if (!t.has_enough_data) {
    return (
      <Text className="text-sm text-chalk-3">
        Keep training — comparisons unlock once you have a few more sessions.
      </Text>
    )
  }
  if (!Number.isFinite(t.delta_pct)) return null
  const pct = Math.round(Math.abs(t.delta_pct) * 100)
  let text
  if (t.direction === 'up') text = `UN1T Points up ${pct}% vs your previous 4 weeks.`
  else if (t.direction === 'down') text = `UN1T Points down ${pct}% vs your previous 4 weeks.`
  else text = 'UN1T Points steady vs your previous 4 weeks.'
  return <Text className="text-sm text-chalk-2">{text}</Text>
}

// ── Stat card ─────────────────────────────────────────────────────
function Stat({ label, value, unit, accent = '#727170' }) {
  // Two-tier numeral rule (spec §2.3): these are TELEMETRY numbers (bpm,
  // minutes, kcal — body-sourced), so they render in mono with the
  // accent-coloured unit tag, never the earned display face.
  return (
    <View className="flex-1 rounded-[20px] border border-iron-hairline bg-iron-surface p-4">
      <Text className="font-mono text-[9px] uppercase text-chalk-3" style={{ letterSpacing: 1.4 }}>{label}</Text>
      <Telemetry value={value} unit={unit} accent={accent} size={15} className="mt-1" />
    </View>
  )
}

// ── Zone row ──────────────────────────────────────────────────────
function ZoneRow({ zone }) {
  const min = Math.round(zone.seconds / 60)
  return (
    <View className="flex-row items-center gap-3" style={{ gap: 12 }}>
      {/* swatch + label */}
      <View className="flex-row items-center" style={{ width: 72, gap: 6 }}>
        <View style={{ width: 9, height: 9, borderRadius: 3, backgroundColor: zoneColorDark(zone.id) || zone.color }} />
        <Text className="text-xs font-body-medium text-chalk-2">{`Zone ${zone.id}`}</Text>
      </View>
      {/* bar */}
      <View className="flex-1 h-2 rounded-full bg-iron-raised overflow-hidden">
        <View style={{ flex: zone.percent, maxWidth: '100%', backgroundColor: zoneColorDark(zone.id) || zone.color, height: '100%', borderRadius: 9999 }} />
      </View>
      {/* min · % */}
      <Text className="font-mono text-[11px] text-chalk-2" style={{ width: 76, textAlign: 'right' }}>
        {min} MIN · {Math.round(zone.percent * 100)}%
      </Text>
    </View>
  )
}

// ── Burn badge ────────────────────────────────────────────────────
// "🔥 Burn" — earned when ≥12 min in Zone 4+. Amber-tinted chip
// (Zone 4 colour) with light text for contrast on the dark surface.
function BurnBadge({ minutes }) {
  return (
    <View
      className="self-start flex-row items-center rounded-full px-3 py-1"
      style={{ gap: 6, backgroundColor: BURN_COLOR + '26', borderWidth: 1, borderColor: BURN_COLOR + '66' }}
    >
      <Text className="font-mono text-[11px]" style={{ color: BURN_COLOR, letterSpacing: 1.4 }}>BURN</Text>
      {Number.isFinite(minutes) && minutes > 0 ? (
        <Text className="text-xs font-body-medium text-chalk-2">{minutes} min in Zone 4+</Text>
      ) : null}
    </View>
  )
}

// ── Main screen ───────────────────────────────────────────────────
export default function SessionDetail() {
  const { id } = useLocalSearchParams()
  const router = useRouter()

  const [report, setReport] = useState(null)
  const [session, setSession] = useState(null)   // from report.session
  const [samples, setSamples] = useState([])
  const [achievements, setAchievements] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [sharing, setSharing] = useState(false)
  // Auto-present the "wrapped" recap at most once per screen mount.
  const recapPresentedRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setLoadError(null)
      try {
        // Page the whole hr_samples trace (chart downsamples to 600 regardless):
        // a single ascending .limit() dropped the END of long sessions. Keep it
        // parallel with the report + achievements by resolving as its own promise.
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
        // Fire all three in parallel
        const [reportOut, rawSamples, achRes] = await Promise.all([
          api('/api/sessions/' + id + '/report'),
          fetchAllSamples(),
          supabase
            .from('contact_achievements')
            .select('id, earned_at, rule:achievement_rules(name, icon)')
            .eq('source_session_id', id),
        ])
        if (cancelled) return

        if (reportOut?.report) {
          setReport(reportOut.report)
          setSession(reportOut.report.session ?? null)
        } else {
          setLoadError('Could not load this session.')
        }

        setSamples(downsample(rawSamples, 600))
        setAchievements((achRes.data || []).filter((u) => u.rule))
      } catch (e) {
        if (!cancelled) setLoadError(e?.message || 'Could not load this session.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [id])

  // Auto-present the post-class "wrapped" ceremony the FIRST time a member opens
  // a FINISHED session (ended_at set). Guarded by a per-session SecureStore
  // "seen" flag so it shows once — the push deep-link (/sessions/[id]) stays
  // unchanged; the recap simply appears on top. Mirrors the ProfileSetupGate.
  useEffect(() => {
    if (loading || loadError || !report) return
    if (recapPresentedRef.current) return
    const ended = !!(session?.ended_at)
    if (!ended) return
    recapPresentedRef.current = true
    let cancelled = false
    hasSeenRecap(id).then((seen) => {
      if (!cancelled && !seen) router.push('/sessions/' + id + '/wrapped')
    })
    return () => { cancelled = true }
  }, [loading, loadError, report, session, id, router])

  async function handleViewRecap() {
    // Manual affordance — force a replay by clearing the seen flag first.
    await clearRecapSeen(id)
    router.push('/sessions/' + id + '/wrapped')
  }

  async function handleShare() {
    if (sharing) return
    setSharing(true)
    try {
      const r = await api('/api/sessions/' + id + '/share', { method: 'POST' })
      if (r?.url) {
        // `message` carries the link on Android (Share ignores `url` there);
        // `url` kept for iOS rich-link preview. `title` is used by some Android
        // share targets as the subject/heading.
        await Share.share({
          message: r.url,
          url: r.url,
          title: 'My UN1T session',
        })
      }
    } catch {
      // fail quietly
    } finally {
      setSharing(false)
    }
  }

  // ── Loading ────────────────────────────────────────────────────
  if (loading) {
    return (
      <SafeAreaView className="flex-1 bg-iron-bg items-center justify-center" edges={['top', 'left', 'right']}>
        <ActivityIndicator color="#F1EEE7" size="large" />
      </SafeAreaView>
    )
  }

  // ── Error ──────────────────────────────────────────────────────
  if (loadError || !report) {
    return (
      <SafeAreaView className="flex-1 bg-iron-bg" edges={['top', 'left', 'right']}>
        <View className="p-5">
          <Pressable onPress={() => router.back()} hitSlop={12}>
            <Text className="text-sm font-body-medium text-chalk-2">‹ Back</Text>
          </Pressable>
          <Card className="mt-6">
            <Text className="text-sm text-chalk-2">
              We couldn't load this session. It may still be processing — try again in a moment.
            </Text>
          </Card>
        </View>
      </SafeAreaView>
    )
  }

  // ── Derived values ─────────────────────────────────────────────
  // The /api report envelope splits the session: time/source/class live on
  // report.session; the effort/HR numbers + the pre-built zone breakdown live
  // on report.summary. (The web page reads the raw session row instead, which
  // is flat — that's why it worked while this screen, reading the wrong
  // sub-object, showed blanks.)
  const s = session || {}
  const summary = report.summary || {}
  const effortPoints = Number.isFinite(summary.effort_points) ? summary.effort_points : null
  const startedAt    = s.started_at      || null
  const endedAt      = s.ended_at        || null
  const avgHr        = Number.isFinite(summary.avg_hr_bpm)  ? summary.avg_hr_bpm  : null
  const peakHr       = Number.isFinite(summary.peak_hr_bpm) ? summary.peak_hr_bpm : null
  const maxHrUsed    = summary.max_hr_used || null
  const source       = s.source          || null
  const workoutType  = workoutTypeLabel(s.workout_type)
  const calories     = Number.isFinite(s.calories_kcal) ? Math.round(s.calories_kcal) : null
  const distanceKm   = formatDistanceKm(s.distance_meters)
  const pace         = formatPace(s.avg_pace_sec_per_km)

  const dur = durationMinutes(startedAt, endedAt)
  const date = sessionDate(startedAt)
  const startTime = startedAt
    ? new Intl.DateTimeFormat('en-IE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Dublin' }).format(new Date(startedAt))
    : null
  const breakdown = summary.zones || []   // pre-built [{ id, name, color, seconds, percent }]
  const comparisons = report.comparisons || {}
  const burn = summary.burn === true
  // This screen's accent is SESSION-scoped (the share-card rule) — earned
  // by the hardest zone sustained >=3 min in THIS session, lit volt (P4b:
  // zone-hued accents collapse to volt; the zone breakdown bars below keep
  // their zone DATA colours). summary.zones is the pre-built breakdown
  // [{ id, seconds, ... }]; rebuild the {id: seconds} shape the shared rule
  // expects. Pearl when nothing qualifies.
  const sessionAccent = hardestZone(
    Object.fromEntries((summary.zones || []).map((z) => [z.id, z.seconds])),
  ) != null ? VOLT : PEARL
  const z4plusMinutes = Number.isFinite(summary.z4plus_minutes) ? summary.z4plus_minutes : null

  // Show share + the recap affordance only if the session has ended (ended_at set)
  const showShare = !!endedAt
  const showRecap = !!endedAt

  return (
    <SafeAreaView className="flex-1 bg-iron-bg" edges={['top', 'left', 'right']}>
      <ScrollView contentContainerClassName="p-5 pb-24" showsVerticalScrollIndicator={false}>

        {/* Back */}
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Text className="text-sm font-body-medium text-chalk-2">‹ Back</Text>
        </Pressable>

        {/* Header — mono eyebrow + effort-points hero in the session accent */}
        <View className="mt-4">
          <Glow color={sessionAccent} />
          <Text className="font-mono text-[10px] uppercase text-chalk-2" style={{ letterSpacing: 2.2 }}>
            {[date, startTime, workoutType || (source ? sourceLabel(source) : null)].filter(Boolean).join(' · ')}
          </Text>
          {workoutType && source ? (
            <Text className="mt-0.5 text-xs font-body text-chalk-3">{sourceLabel(source)}</Text>
          ) : null}
          {effortPoints != null ? (
            <View className="mt-1 flex-row items-baseline" style={{ gap: 6 }}>
              <Text className="font-display-black text-chalk" style={{ fontSize: 64, lineHeight: 66 }}>{effortPoints}</Text>
              <Text className="font-mono text-[13px]" style={{ color: sessionAccent, letterSpacing: 1.6 }}>PTS</Text>
            </View>
          ) : (
            <Text className="mt-1 text-4xl font-display-black text-chalk">—</Text>
          )}
          {burn && (
            <View className="mt-3">
              <BurnBadge minutes={z4plusMinutes} />
            </View>
          )}
          {showRecap && (
            <Pressable
              onPress={handleViewRecap}
              hitSlop={8}
              accessibilityRole="button"
              className="mt-4 self-start flex-row items-center rounded-full border border-iron-hairline bg-iron-surface px-3 py-1.5"
              style={{ gap: 6 }}
            >
              <Ionicons name="sparkles" size={14} color="#F1EEE7" />
              <Text className="text-sm font-body-semibold text-chalk">View recap</Text>
            </Pressable>
          )}
        </View>

        <TickRule className="mt-5" />

        {/* Highlight */}
        {report.highlight && (
          <Card className="mt-4">
            <View className="flex-row items-center" style={{ gap: 8 }}>
              <Ionicons name="star" size={16} color="#F1EEE7" />
              <Text className="flex-1 text-sm font-body-medium text-chalk">{report.highlight.message}</Text>
            </View>
          </Card>
        )}

        {/* How this compares */}
        <Card className="mt-6">
          <Text className="font-mono text-[10px] uppercase text-chalk-3" style={{ letterSpacing: 2 }}>How this compares</Text>
          <View className="mt-3" style={{ gap: 8 }}>
            <VsThisClass c={comparisons.vs_this_class} />
            <VsCategory  c={comparisons.vs_category} />
            <VsRecent    t={comparisons.vs_recent} />
          </View>
        </Card>

        {/* Stat row */}
        <View className="mt-6 flex-row" style={{ gap: 12 }}>
          <Stat label="Duration" value={dur != null ? `${dur}` : '—'} unit={dur != null ? 'min' : undefined} accent={sessionAccent} />
          <Stat label="Avg HR"   value={avgHr  ?? '—'} unit={avgHr  ? 'bpm' : undefined} accent={sessionAccent} />
          <Stat label="Peak HR"  value={peakHr ?? '—'} unit={peakHr ? 'bpm' : undefined} accent={sessionAccent} />
          <Stat label="Calories" value={calories != null ? `${calories}` : '—'} unit={calories != null ? 'kcal' : undefined} accent={sessionAccent} />
        </View>

        {/* Distance / pace — only for workouts that record them (runs, rides) */}
        {(distanceKm || pace) ? (
          <View className="mt-3 flex-row" style={{ gap: 12 }}>
            {distanceKm ? <Stat label="Distance" value={distanceKm} unit="km" /> : null}
            {pace ? <Stat label="Pace" value={pace} unit="/km" /> : null}
          </View>
        ) : null}

        {/* Achievements */}
        {achievements.length > 0 && (
          <Card className="mt-6">
            <View className="flex-row items-center mb-2.5" style={{ gap: 6 }}>
              <Ionicons name="sparkles" size={14} color="#F1EEE7" />
              <Text className="text-sm font-body-semibold text-chalk">Unlocked in this session</Text>
            </View>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -4 }}>
              <View className="flex-row" style={{ gap: 8, paddingHorizontal: 4, paddingBottom: 4 }}>
                {achievements.map((u) => (
                  <View
                    key={u.id}
                    className="flex-row items-center rounded-xl border border-iron-hairline bg-iron-raised px-3 py-2"
                    style={{ gap: 8 }}
                  >
                    <View className="w-7 h-7 items-center justify-center rounded-full bg-iron-surface">
                      <Ionicons name="trophy-outline" size={14} color="#F1EEE7" />
                    </View>
                    <Text className="text-sm font-body-semibold text-chalk">{u.rule.name}</Text>
                  </View>
                ))}
              </View>
            </ScrollView>
          </Card>
        )}

        {/* HR over time */}
        <Card className="mt-6">
          <Text className="font-mono text-[10px] uppercase text-chalk-3" style={{ letterSpacing: 2 }}>Heart rate</Text>
          {samples.length > 1 ? (
            <HrChart samples={samples} maxHr={maxHrUsed} stroke={sessionAccent} glow darkBands />
          ) : (
            <Text className="mt-3 text-sm text-chalk-2">
              No per-second data for this session — only summary stats are available.
              Live in-studio sessions and intraday device syncs include the full trace.
            </Text>
          )}
        </Card>

        {/* Zone breakdown */}
        <Card className="mt-6">
          <Text className="font-mono text-[10px] uppercase text-chalk-3" style={{ letterSpacing: 2 }}>Zone breakdown</Text>
          <View className="mt-4" style={{ gap: 10 }}>
            {breakdown.map((z) => <ZoneRow key={z.id} zone={z} />)}
          </View>
          {maxHrUsed ? (
            <Text className="mt-4 text-xs text-chalk-2">
              Zones calculated against your max HR of{' '}
              <Text className="font-body-medium text-chalk">{maxHrUsed}</Text> bpm.
            </Text>
          ) : null}
        </Card>

        {/* Next action CTA */}
        {report.next_action && (
          <View className="mt-6">
            <Button
              title={report.next_action.label}
              onPress={() => Linking.openURL(report.next_action.url)}
            />
          </View>
        )}

        {/* Share — the accent CTA (spec §2.5) */}
        {showShare && (
          <Pressable
            onPress={handleShare}
            disabled={sharing}
            className="mt-4 rounded-2xl py-3.5 items-center"
            style={{ backgroundColor: sessionAccent, opacity: sharing ? 0.6 : 1 }}
          >
            {sharing
              ? <ActivityIndicator color="#131316" />
              : <Text className="font-display text-[15px] text-iron-bg">Share this session</Text>}
          </Pressable>
        )}

      </ScrollView>
    </SafeAreaView>
  )
}
