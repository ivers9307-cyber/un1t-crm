// Achievements screen — mirrors src/app/account/achievements/{page,AchievementsGrid}.jsx.
//
// Queries:
//   achievement_rules  (active, ordered by sort_order)
//   contact_achievements  (own rows via RLS, ordered by earned_at desc)
//
// Renders unlocked / locked tabs, grouped by category, matching the web grid.
// Icons: rule.icon is a Lucide name — we map to the nearest Ionicons name.

import { useState, useCallback, useRef } from 'react'
import { View, Text, Pressable, ScrollView, ActivityIndicator, RefreshControl } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useFocusEffect, useRouter } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { supabase } from '../../../lib/member/supabase'
import { useAuth } from '../../../lib/member/contact-context'
import Card from '../../../components/member/ui/Card'
import { memberAchievementStats, ruleProgress } from 'shared/achievement-progress'
import { PEARL } from '../../../lib/member/brand'

// ── Category metadata (mirrors web's CATEGORY_ORDER / CATEGORY_LABELS) ──────

const CATEGORY_ORDER = [
  'milestone', 'streak', 'session_quality', 'volume', 'class_type', 'exploration',
]
const CATEGORY_LABELS = {
  milestone:       'Milestones',
  streak:          'Streaks',
  session_quality: 'Session quality',
  volume:          'Volume',
  class_type:      'Class types',
  exploration:     'Exploration',
}

// ── Lucide → Ionicons fallback map ───────────────────────────────────────────
// rule.icon holds a Lucide icon name (e.g. "Flame", "Star", "Zap").
// We map common ones to their Ionicons equivalent; anything unmapped falls
// back to 'trophy-outline'.

const ICON_MAP = {
  // common Lucide names (PascalCase from the DB) → Ionicons (kebab with -outline)
  Flame:          'flame-outline',
  Star:           'star-outline',
  Zap:            'flash-outline',
  Trophy:         'trophy-outline',
  Award:          'ribbon-outline',
  Medal:          'medal-outline',
  Target:         'flag-outline',
  Heart:          'heart-outline',
  Activity:       'pulse-outline',
  Clock:          'time-outline',
  Calendar:       'calendar-outline',
  CheckCircle:    'checkmark-circle-outline',
  TrendingUp:     'trending-up-outline',
  BarChart:       'bar-chart-outline',
  Layers:         'layers-outline',
  Repeat:         'repeat-outline',
  Compass:        'compass-outline',
  Map:            'map-outline',
  Sunrise:        'sunny-outline',
  Moon:           'moon-outline',
  Dumbbell:       'barbell-outline',
  Users:          'people-outline',
  User:           'person-outline',
  Lock:           'lock-closed-outline',
  Unlock:         'lock-open-outline',
  Gift:           'gift-outline',
  Crown:          'podium-outline',
  Diamond:        'diamond-outline',
  Sparkles:       'sparkles-outline',
  Lightning:      'thunderstorm-outline',
  Run:            'walk-outline',
  Bike:           'bicycle-outline',
  // lowercase variants (in case the DB stores lowercase)
  flame:          'flame-outline',
  star:           'star-outline',
  trophy:         'trophy-outline',
  award:          'ribbon-outline',
  target:         'flag-outline',
}

function toIonicon(lucideName) {
  if (!lucideName) return 'trophy-outline'
  return ICON_MAP[lucideName] || 'trophy-outline'
}

// ── Helpers ─────────────────────────────────────────────────────────────────

// Page through the member's own ended sessions in 1k chunks. A single query
// silently hits PostgREST's 1000-row default cap, which would under-count the
// all-time aggregates (classes/points) for the most loyal members and freeze
// their progress bars below 100%. Best-effort: returns { data, error } and a
// HARD_LIMIT bounds the on-device download.
const SESSIONS_PAGE = 1000, SESSIONS_HARD_LIMIT = 20000
async function fetchOwnEndedSessions(contactId) {
  const all = []
  for (let from = 0; from < SESSIONS_HARD_LIMIT; from += SESSIONS_PAGE) {
    const { data, error } = await supabase
      .from('heart_rate_sessions')
      .select('started_at, ended_at, effort_points, zones_seconds')
      .eq('contact_id', contactId)
      .not('ended_at', 'is', null)
      .order('started_at', { ascending: false })
      .range(from, from + SESSIONS_PAGE - 1)
    if (error) return { data: all, error }
    if (data?.length) all.push(...data)
    if (!data || data.length < SESSIONS_PAGE) break
  }
  return { data: all, error: null }
}

function groupByCategory(rules) {
  const map = new Map()
  for (const r of rules) {
    const cat = r.category || 'other'
    const arr = map.get(cat) || []
    arr.push(r)
    map.set(cat, arr)
  }
  return map
}

function shortDate(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
  })
}

// ── Main screen ──────────────────────────────────────────────────────────────

export default function Achievements() {
  const router = useRouter()
  const { contact, loading: authLoading } = useAuth()
  const [rules, setRules] = useState([])
  const [stats, setStats] = useState(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(null)
  const [tab, setTab] = useState('unlocked')
  const initialisedRef = useRef(false)
  const loadingRef = useRef(false)

  const load = useCallback(async () => {
    // Unlinked contact ("setting up your account" cohort): clear the spinner
    // and let the render fall through to the setup state — bailing with
    // loading=true left them on a permanent spinner (re-audit A9).
    if (!contact?.id) { setLoading(false); return }
    if (loadingRef.current) return
    loadingRef.current = true
    // Spinner only on the FIRST load — focus refetches are silent so returning
    // to the screen never re-blanks an already-rendered grid (matches Home).
    if (!initialisedRef.current) setLoading(true)
    setError(null)
    try {
      const [
        { data: ruleRows, error: rErr },
        { data: earnedRows, error: eErr },
        { data: sessionRows, error: sErr },
      ] = await Promise.all([
        supabase
          .from('achievement_rules')
          // rule_type + rule_config drive the progress-to-unlock bar on locked rows.
          .select('id, slug, name, description, icon, category, family, tier, sort_order, is_active, rule_type, rule_config')
          .eq('is_active', true)
          .order('sort_order', { ascending: true }),
        supabase
          .from('contact_achievements')
          .select('rule_id, earned_at, source_session_id, metadata')
          .eq('contact_id', contact.id)
          .order('earned_at', { ascending: false }),
        // Member's own ENDED heart-rate sessions — RLS scopes to self
        // (contact_id = private.auth_contact_id()). Only the columns
        // sessionMetric()/detectStreak read: started_at, ended_at,
        // effort_points, zones_seconds. Progress is best-effort — a
        // failure here must not blank the whole screen (bars just hide).
        fetchOwnEndedSessions(contact.id),
      ])
      if (rErr) throw rErr
      if (eErr) throw eErr

      const earnedById = new Map((earnedRows || []).map((e) => [e.rule_id, e]))
      const enriched = (ruleRows || []).map((r) => ({
        ...r,
        earned: earnedById.get(r.id) || null,
      }))
      setRules(enriched)
      // If sessions failed to load, fall back to empty stats (bars hide,
      // rest of the screen is unaffected).
      setStats(memberAchievementStats(sErr ? [] : (sessionRows || []), Date.now()))
      // Mark initialised on SUCCESS only — a failed first load keeps the
      // spinner-then-error path, and the next focus retries with a spinner.
      initialisedRef.current = true
    } catch (e) {
      setError(e?.message || 'Failed to load achievements')
    } finally {
      loadingRef.current = false
      setLoading(false)
    }
  }, [contact?.id])

  const onRefresh = useCallback(async () => {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }, [load])

  useFocusEffect(
    useCallback(() => { load() }, [load])
  )

  const unlocked = rules.filter((r) => r.earned)
  const locked   = rules.filter((r) => !r.earned)
  const list     = tab === 'unlocked' ? unlocked : tab === 'locked' ? locked : rules
  const grouped  = groupByCategory(list)

  return (
    <SafeAreaView className="flex-1 bg-iron-bg" edges={['left', 'right']}>
      <ScrollView
        contentContainerClassName="p-5 pb-24"
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#F1EEE7" />
        }
      >

        {/* Back button */}
        <Pressable
          onPress={() => router.back()}
          className="flex-row items-center gap-1 mb-4 self-start active:opacity-60"
        >
          <Ionicons name="chevron-back-outline" size={18} color="#B3B2AC" />
          <Text className="text-sm font-body text-chalk-2">Back</Text>
        </Pressable>

        {/* Header */}
        <View className="flex-row items-end justify-between">
          <View className="flex-1 mr-4">
            <Text className="text-2xl font-display-bold text-chalk">Achievements</Text>
            <Text className="mt-1 text-sm font-body text-chalk-2">
              Badges you've earned and ones still to chase.
            </Text>
          </View>
          <View>
            <Text className="text-2xl font-display-bold text-chalk text-right">
              {unlocked.length}
            </Text>
            <Text className="text-sm font-body text-chalk-2 text-right"> / {rules.length}</Text>
          </View>
        </View>

        {authLoading || loading ? (
          <View className="mt-12 items-center">
            <ActivityIndicator color="#F1EEE7" size="large" />
          </View>
        ) : !contact?.id ? (
          /* Unlinked-account state — contact hasn't been linked yet (mirrors
             account/devices.jsx). Never an endless spinner. */
          <Card className="mt-6">
            <View className="flex-row items-center gap-2 mb-2">
              <ActivityIndicator size="small" color="#B3B2AC" />
              <Text className="text-sm font-body-semibold text-chalk">Finishing setting up your account…</Text>
            </View>
            <Text className="text-sm text-chalk-2">
              This usually takes a moment. Close and reopen the app if this persists.
            </Text>
          </Card>
        ) : error && rules.length === 0 ? (
          /* Error view only when nothing has rendered — a transient focus-
             refetch failure must not blank an already-loaded grid. */
          <Card className="mt-6">
            <Text className="text-sm font-body text-chalk-2">
              Couldn't load achievements. Pull to retry.
            </Text>
          </Card>
        ) : (
          <>
            {/* Tab bar */}
            <View className="mt-6 flex-row rounded-xl border border-iron-hairline bg-iron-surface p-1 self-start">
              {[
                { key: 'unlocked', label: `Unlocked (${unlocked.length})` },
                { key: 'locked',   label: `To earn (${locked.length})` },
                { key: 'all',      label: 'All' },
              ].map(({ key, label }) => (
                <Pressable
                  key={key}
                  onPress={() => setTab(key)}
                  className={`rounded-lg px-3 py-1.5 ${
                    tab === key ? 'bg-chalk' : ''
                  }`}
                >
                  <Text className={`text-xs font-body-medium ${
                    tab === key ? 'text-iron-bg' : 'text-chalk-2'
                  }`}>
                    {label}
                  </Text>
                </Pressable>
              ))}
            </View>

            {/* Empty state */}
            {list.length === 0 && (
              <Card className="mt-4 items-center py-8">
                <Ionicons name="trophy-outline" size={32} color="#727170" />
                <Text className="mt-3 text-sm font-body text-chalk-2 text-center">
                  {tab === 'unlocked'
                    ? 'No achievements yet — get to your first class!'
                    : 'Nothing to show.'}
                </Text>
              </Card>
            )}

            {/* Categories */}
            {CATEGORY_ORDER.map((cat) => {
              const items = grouped.get(cat)
              if (!items || items.length === 0) return null
              return (
                <View key={cat} className="mt-6">
                  <Text className="font-mono text-[10px] uppercase text-chalk-3 mb-2" style={{ letterSpacing: 2 }}>
                    {CATEGORY_LABELS[cat] || cat}
                  </Text>
                  {/* 2-column grid using row pairs */}
                  {chunkPairs(items).map((pair, rowIdx) => (
                    <View key={rowIdx} className="flex-row gap-3 mb-3">
                      {pair.map((rule) => (
                        <AchievementCard key={rule.id} rule={rule} stats={stats} />
                      ))}
                      {/* Fill the second slot if row has only one item */}
                      {pair.length === 1 && <View className="flex-1" />}
                    </View>
                  ))}
                </View>
              )
            })}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  )
}

// ── Achievement card ─────────────────────────────────────────────────────────

function AchievementCard({ rule, stats }) {
  const isUnlocked = Boolean(rule.earned)
  const iconName = toIonicon(rule.icon)

  // Progress-to-unlock: only for LOCKED, quantifiable rules, once stats
  // have loaded. Unlocked rows never show a bar.
  const progress = (!isUnlocked && stats) ? ruleProgress(rule, stats) : null
  const showBar = Boolean(progress?.quantifiable)

  return (
    <View className={`flex-1 rounded-[20px] border border-iron-hairline p-3 ${
      isUnlocked ? 'bg-iron-surface' : 'bg-iron-raised'
    }`}>
      <View className="flex-row items-start gap-2.5">
        {/* Icon bubble */}
        <View className="h-9 w-9 rounded-full bg-iron-raised items-center justify-center shrink-0">
          <Ionicons
            name={iconName}
            size={16}
            color={isUnlocked ? '#F1EEE7' : '#727170'}
          />
        </View>
        <View className="flex-1 min-w-0">
          <Text
            className={`text-sm font-body-semibold ${
              isUnlocked ? 'text-chalk' : 'text-chalk-3'
            }`}
            numberOfLines={1}
          >
            {rule.name}
          </Text>
          {rule.description ? (
            <Text className="mt-0.5 text-[11px] leading-snug font-body text-chalk-2" numberOfLines={2}>
              {rule.description}
            </Text>
          ) : null}
          {isUnlocked && rule.earned?.earned_at ? (
            <Text className="mt-1.5 font-mono text-[10px] uppercase text-chalk-3" style={{ letterSpacing: 1 }}>
              Earned {shortDate(rule.earned.earned_at)}
            </Text>
          ) : null}
        </View>
      </View>

      {/* Progress-to-unlock (locked + quantifiable only) */}
      {showBar ? <ProgressBar progress={progress} /> : null}
    </View>
  )
}

// ── Progress bar ──────────────────────────────────────────────────────────────
// Slim Pearl fill on an iron-surface track + mono "current / target unit" label.

function fmtMetric(n) {
  const r = Math.round((Number(n) || 0) * 10) / 10
  return Number.isInteger(r) ? String(r) : r.toFixed(1)
}

function ProgressBar({ progress }) {
  const { current, target, ratio, unit } = progress
  const pct = `${Math.max(0, Math.min(1, ratio || 0)) * 100}%`
  return (
    <View className="mt-2.5">
      <View className="h-1.5 w-full rounded-full bg-iron-surface overflow-hidden">
        <View
          className="h-full rounded-full"
          style={{ width: pct, backgroundColor: PEARL }}
        />
      </View>
      <Text className="mt-1 font-mono text-[10px] text-chalk-2">
        {fmtMetric(current)} / {fmtMetric(target)}{unit ? ` ${unit}` : ''}
      </Text>
    </View>
  )
}

// ── Utility ──────────────────────────────────────────────────────────────────

function chunkPairs(arr) {
  const pairs = []
  for (let i = 0; i < arr.length; i += 2) {
    pairs.push(arr.slice(i, i + 2))
  }
  return pairs
}
