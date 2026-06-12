// "Today" — personal dashboard rendered on the Home tab for everyone
// (gated by permissions.dashboard_personal, default: all roles).
//
// Hero is a week view of YOUR shifts grouped by day — every day Mon
// through Sun is shown so you can scan your week at a glance. Days
// with no shifts say "Off". Today is highlighted. Past days are
// dimmed.

import { View, Text, ActivityIndicator, Pressable } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useState, useEffect, useCallback } from 'react'
import { useRouter, useFocusEffect } from 'expo-router'
import { useAuth } from '../../lib/auth-context'
import { fetchPersonalDashboard } from '../../lib/dashboard-api'
import { pickLocationColor } from '../../../shared/location-colors'
import {
  KpiCard, KpiRow, SectionHeader, PendingRow, ListCard,
} from './cards'
// CHECKLIST.2 — top-of-Today card showing the coach's checklist
// when they're on shift today. Self-contained: renders nothing
// when there's no instance to surface.
import TodayChecklistCard from './TodayChecklistCard'
// MOBILE-TODAY-FEED — the "Needs attention" triage card (mirror of
// the web Today feed). Self-contained: renders nothing when the
// viewer has no queue permissions or nothing is pending.
import NeedsAttentionCard from './NeedsAttentionCard'

function shiftTime(shift) {
  const start = (shift.start_time_override || shift.shift_templates?.start_time || '').slice(0, 5)
  const end = (shift.end_time_override || shift.shift_templates?.end_time || '').slice(0, 5)
  return `${start} – ${end}`
}

function shiftHours(shift) {
  const start = shift.start_time_override || shift.shift_templates?.start_time
  const end = shift.end_time_override || shift.shift_templates?.end_time
  if (!start || !end) return 0
  const [sh, sm] = start.split(':').map(Number)
  const [eh, em] = end.split(':').map(Number)
  let mins = eh * 60 + em - (sh * 60 + sm)
  if (mins < 0) mins += 24 * 60
  return Math.round((mins / 60) * 10) / 10
}

function isoDate(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function buildWeek(weekStartIso, shifts) {
  const start = new Date(weekStartIso + 'T00:00:00')
  const todayIso = isoDate(new Date())
  const days = []
  for (let i = 0; i < 7; i++) {
    const d = new Date(start)
    d.setDate(start.getDate() + i)
    const iso = isoDate(d)
    const daysShifts = shifts.filter(s => s.shift_date === iso)
    days.push({
      date: d,
      iso,
      label: d.toLocaleDateString(undefined, { weekday: 'short' }).toUpperCase(),
      dayNum: d.getDate(),
      monthLabel: d.toLocaleDateString(undefined, { month: 'short' }),
      isToday: iso === todayIso,
      isPast: iso < todayIso,
      shifts: daysShifts,
    })
  }
  return days
}

function rangeLabelFor(startIso, endIso) {
  const s = new Date(startIso + 'T00:00:00')
  const e = new Date(endIso + 'T00:00:00')
  const fmt = d => d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
  return `${fmt(s)} – ${fmt(e)}`
}

// Reusable week-panel renderer. Same shape used for "This week" and
// "Next week"; they stack vertically on mobile because the screen is
// too narrow for side-by-side, and visually segment by the title row.
// `showLocation` controls whether each shift row renders a small
// location chip; only shown for staff assigned to 2+ locations so
// single-location users don't see redundant chrome.
function WeekPanel({ title, startIso, endIso, shifts, showLocation }) {
  const days = buildWeek(startIso, shifts || [])
  return (
    <View className="bg-un1t-surface border border-un1t-border rounded-2xl mb-3 overflow-hidden">
      <View className="px-4 pt-3 pb-2 flex-row items-baseline justify-between">
        <Text className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle">
          {title}
        </Text>
        <Text className="text-xs text-un1t-muted">{rangeLabelFor(startIso, endIso)}</Text>
      </View>
      {days.map((day, idx) => {
        const isLast = idx === days.length - 1
        return (
          <View
            key={day.iso}
            className={`flex-row px-4 py-2.5 ${!isLast ? 'border-b border-un1t-border' : ''} ${
              day.isToday ? 'bg-un1t-border/30' : ''
            }`}
          >
            <View className="w-14">
              <Text className={`text-[10px] font-semibold uppercase tracking-wider ${
                day.isToday ? 'text-un1t-text'
                : day.isPast ? 'text-un1t-muted'
                : 'text-un1t-subtle'
              }`}>
                {day.label}
              </Text>
              <Text className={`text-base font-semibold ${
                day.isPast ? 'text-un1t-muted' : 'text-un1t-text'
              }`}>
                {day.dayNum}
              </Text>
            </View>
            <View className="flex-1">
              {day.shifts.length === 0 ? (
                <Text className={`text-sm ${day.isPast ? 'text-un1t-muted' : 'text-un1t-subtle'} pt-1`}>
                  Off
                </Text>
              ) : (
                day.shifts.map((s, i) => (
                  <View key={s.id} className={i > 0 ? 'mt-1' : ''}>
                    <View className="flex-row items-center justify-between">
                      <Text className={`text-sm font-medium ${day.isPast ? 'text-un1t-subtle' : 'text-un1t-text'}`} numberOfLines={1}>
                        {s.shift_templates?.name || 'Shift'}
                      </Text>
                      {s.published === false && (
                        <View className="ml-2 px-1.5 py-0.5 rounded bg-amber-500/20">
                          <Text className="text-[9px] uppercase text-amber-700 font-semibold">Draft</Text>
                        </View>
                      )}
                      {s.status === 'swapped' && (
                        <View className="ml-2 px-1.5 py-0.5 rounded bg-blue-500/20">
                          <Text className="text-[9px] uppercase text-blue-700 font-semibold">Swapped</Text>
                        </View>
                      )}
                    </View>
                    <View className="flex-row items-center flex-wrap">
                      <Text className={`text-xs ${day.isPast ? 'text-un1t-muted' : 'text-un1t-subtle'}`}>
                        {shiftTime(s)} · {shiftHours(s)}h
                      </Text>
                      {showLocation && s.locations?.name && (() => {
                        // Per-location accent — same palette as web
                        // (shared/location-colors.js) so the chip looks
                        // consistent across devices.
                        const c = pickLocationColor(s.locations.id || s.location_id)
                        return (
                          <View className={`ml-1.5 px-1.5 py-0.5 rounded ${c.bg} ${day.isPast ? 'opacity-60' : ''}`}>
                            <Text className={`text-[9px] uppercase tracking-wider ${c.text}`}>
                              {s.locations.name}
                            </Text>
                          </View>
                        )
                      })()}
                    </View>
                  </View>
                ))
              )}
            </View>
          </View>
        )
      })}
    </View>
  )
}

export default function PersonalDashboard({ refreshKey }) {
  const { profile, activeLocation, locations } = useAuth()
  const router = useRouter()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  // Show per-shift location chip only when the user is assigned to
  // 2+ locations — otherwise it's redundant.
  const showLocation = (locations || []).length > 1

  const load = useCallback(async () => {
    if (!profile) return
    setError(null)
    try {
      const res = await fetchPersonalDashboard(profile.id, activeLocation?.id)
      if (res.success) {
        setData(res.data)
      } else {
        setError(res.error || 'Failed to load')
      }
    } catch (e) {
      setError(e?.message || 'Network error')
    }
  }, [profile, activeLocation])

  useEffect(() => {
    setLoading(true)
    load().finally(() => setLoading(false))
  }, [load, refreshKey])

  // Re-fetch when the Home tab regains focus so the roster + KPIs reflect
  // changes made elsewhere (or a "View as user" switch) without a manual
  // pull-to-refresh. Silent — keeps the current data on screen until the
  // new data lands.
  useFocusEffect(useCallback(() => { load() }, [load]))

  if (loading) {
    return (
      <View className="py-8 items-center">
        <ActivityIndicator />
      </View>
    )
  }
  if (error) {
    return (
      <View className="bg-red-500/10 border border-red-500/30 rounded-2xl p-5">
        <View className="flex-row items-start">
          <Ionicons name="alert-circle" size={18} color="#DC2626" />
          <View className="flex-1 ml-2">
            <Text className="text-sm font-semibold text-red-700">Couldn’t load Today</Text>
            <Text className="text-xs text-red-700 mt-1">{error}</Text>
          </View>
        </View>
        <Pressable
          onPress={() => { setLoading(true); load().finally(() => setLoading(false)) }}
          className="mt-3 bg-red-600 active:opacity-80 px-3 py-2 rounded-md self-start"
        >
          <Text className="text-xs font-semibold text-white">Try again</Text>
        </Pressable>
      </View>
    )
  }
  if (!data) {
    // Loaded with no error but no data — defensive empty state.
    return (
      <View className="py-8 items-center">
        <Text className="text-sm text-un1t-subtle">No data</Text>
      </View>
    )
  }

  const {
    weekShifts, weekStartIso, weekEndIso,
    nextWeekShifts, nextWeekStartIso, nextWeekEndIso,
    shiftsThisWeek, hoursThisWeek,
    pendingSwapsForMe, myPendingTimeOff, unreadInbox,
  } = data

  return (
    <View>
      {/* CHECKLIST.2 — coach's checklist for today, when applicable.
          Self-renders null when the coach isn't on shift today or
          has no matching template, so this is invisible for most
          users on most days. Sits at the top so it's the first
          thing on shift — closer / opener items shouldn't have to
          scroll past a roster. */}
      <TodayChecklistCard />

      {/* MOBILE-TODAY-FEED — what needs the viewer across the gym,
          right under their own shift card. Coaches without queue
          permissions never see it. */}
      <NeedsAttentionCard />

      {/* Roster — current week + next week, stacked vertically because
          a phone is too narrow for two side-by-side weeks. The web
          equivalent renders these in a 2-col grid. */}
      <WeekPanel
        title="This week"
        startIso={weekStartIso}
        endIso={weekEndIso}
        shifts={weekShifts}
        showLocation={showLocation}
      />
      <WeekPanel
        title="Next week"
        startIso={nextWeekStartIso}
        endIso={nextWeekEndIso}
        shifts={nextWeekShifts}
        showLocation={showLocation}
      />

      {/* Top KPIs */}
      <KpiRow>
        <KpiCard label="This week" value={`${hoursThisWeek}h`} sublabel={`${shiftsThisWeek} shift${shiftsThisWeek === 1 ? '' : 's'}`} />
        <KpiCard
          label="Inbox"
          value={unreadInbox}
          sublabel={unreadInbox === 1 ? 'unread message' : 'unread messages'}
          accent={unreadInbox > 0 ? 'text-un1t-text' : 'text-un1t-muted'}
          onPress={unreadInbox > 0 ? () => router.push('/(tabs)/whatsapp') : undefined}
        />
      </KpiRow>

      {/* Swaps targeting me */}
      <SectionHeader title="Swap requests for you" count={pendingSwapsForMe.length} />
      <ListCard empty={pendingSwapsForMe.length === 0} emptyText="No swap requests waiting on you.">
        {pendingSwapsForMe.map((s, i) => (
          <PendingRow
            key={s.id}
            icon="swap-horizontal"
            title={`${s.requester?.full_name || 'Someone'} wants you to take a shift`}
            subtitle={s.requester_shift?.shift_templates?.name
              ? `${s.requester_shift.shift_templates.name} on ${s.requester_shift.shift_date}`
              : `Posted ${new Date(s.created_at).toLocaleDateString()}`}
            onPress={() => router.push('/(tabs)/schedule')}
            isLast={i === pendingSwapsForMe.length - 1}
          />
        ))}
      </ListCard>

      {/* My pending time-off */}
      <SectionHeader title="Your time-off requests" count={myPendingTimeOff.length} />
      <ListCard empty={myPendingTimeOff.length === 0} emptyText="No pending time-off requests.">
        {myPendingTimeOff.map((t, i) => (
          <PendingRow
            key={t.id}
            icon="calendar-outline"
            title={`${t.type} · awaiting decision`}
            subtitle={t.start_date === t.end_date ? t.start_date : `${t.start_date} – ${t.end_date}`}
            onPress={() => router.push('/(tabs)/schedule')}
            isLast={i === myPendingTimeOff.length - 1}
          />
        ))}
      </ListCard>
    </View>
  )
}
