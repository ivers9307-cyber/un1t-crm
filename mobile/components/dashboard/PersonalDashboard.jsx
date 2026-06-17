// "Today" — personal dashboard rendered on the Home tab for everyone
// (gated by permissions.dashboard_personal, default: all roles).
//
// Hero is a roster view of YOUR shifts:
//   Month mode (default) — agenda grouped by week, days-off hidden,
//     today highlighted, with a Week|Month segmented toggle at the top.
//   Week mode — the original two-week (This week / Next week) panels.

import {
  View, Text, ActivityIndicator, Pressable,
  Alert, Modal, TextInput, KeyboardAvoidingView, Platform,
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useState, useEffect, useCallback } from 'react'
import { useRouter, useFocusEffect } from 'expo-router'
import { useAuth } from '../../lib/auth-context'
import { fetchPersonalDashboard } from '../../lib/dashboard-api'
import { pickLocationColor } from '../../../shared/location-colors'
import { buildMonthMatrix, shiftDurationHours } from '../../../shared/roster-month'
import {
  KpiCard, KpiRow, SectionHeader, ListCard,
} from './cards'
import {
  createSwapRequest, adjustShiftAssignment,
  cancelSwapRequest, cancelTimeOffRequest,
} from '../../lib/schedule-api'
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
function WeekPanel({ title, startIso, endIso, shifts, showLocation, onShiftPress }) {
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
                  <Pressable
                    key={s.id}
                    onPress={onShiftPress ? () => onShiftPress(s, day) : undefined}
                    className={`${i > 0 ? 'mt-1' : ''} active:opacity-60`}
                  >
                    <View className="flex-row items-center justify-between">
                      <Text className={`text-sm font-medium ${day.isPast ? 'text-un1t-subtle' : 'text-un1t-text'}`} numberOfLines={1}>
                        {s.shift_templates?.name || 'Shift'}
                      </Text>
                      <View className="flex-row items-center">
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
                        {onShiftPress && !day.isPast && s.status !== 'swapped' && (
                          <Ionicons name="ellipsis-horizontal" size={14} color="#94A3B8" style={{ marginLeft: 4 }} />
                        )}
                      </View>
                    </View>
                    <View className="flex-row items-center flex-wrap">
                      <Text className={`text-xs ${day.isPast ? 'text-un1t-muted' : 'text-un1t-subtle'}`}>
                        {shiftTime(s)} · {shiftDurationHours(s)}h
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
                  </Pressable>
                ))
              )}
            </View>
          </View>
        )
      })}
    </View>
  )
}

// Short weekday labels for the agenda (Mon-start)
const WEEKDAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

// Week header range label: "22–28 Jun"
function weekRangeLabel(days) {
  // days[0] is Mon, days[6] is Sun — all inMonth days or padded
  // We find the first and last inMonth day in the row to label the range.
  const inMonth = days.filter(d => d.inMonth)
  if (inMonth.length === 0) return null
  const first = inMonth[0]
  const last = inMonth[inMonth.length - 1]
  const fmtDay = iso => {
    const d = new Date(iso + 'T00:00:00Z')
    return d.getUTCDate()
  }
  const fmtMon = iso => {
    const d = new Date(iso + 'T00:00:00Z')
    return d.toLocaleDateString('en-IE', { month: 'short', timeZone: 'UTC' })
  }
  const startDay = fmtDay(first.iso)
  const endDay = fmtDay(last.iso)
  const endMon = fmtMon(last.iso)
  return `${startDay}–${endDay} ${endMon}`
}

// Is this week the one containing today?
function weekContainsToday(days) {
  return days.some(d => d.isToday)
}

// Agenda-style month view: groups weeks, skips days with no shifts,
// shows a week header and per-day rows for days that have shifts.
function MonthAgenda({ matrix, showLocation, onShiftPress }) {
  const todayIso = (() => {
    const now = new Date()
    const y = now.getFullYear()
    const m = String(now.getMonth() + 1).padStart(2, '0')
    const day = String(now.getDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
  })()

  // Build week groups that have at least one shift day
  const weekGroups = matrix
    .map(days => {
      const shiftDays = days.filter(d => d.inMonth && d.shifts.length > 0)
      return { days, shiftDays }
    })
    .filter(({ shiftDays }) => shiftDays.length > 0)

  if (weekGroups.length === 0) {
    return (
      <View className="bg-un1t-surface border border-un1t-border rounded-2xl mb-3 px-4 py-5">
        <Text className="text-sm text-un1t-subtle text-center">No shifts this month</Text>
      </View>
    )
  }

  return (
    <View className="mb-1">
      {weekGroups.map(({ days, shiftDays }, wIdx) => {
        const isThisWeek = weekContainsToday(days)
        const rangeLabel = weekRangeLabel(days)
        const weekHeader = isThisWeek
          ? 'This week'
          : (rangeLabel || 'This week')
        const shiftCount = shiftDays.reduce((t, d) => t + d.shifts.length, 0)

        return (
          <View key={wIdx} className="bg-un1t-surface border border-un1t-border rounded-2xl mb-3 overflow-hidden">
            {/* Week header */}
            <View className="px-4 pt-3 pb-2 flex-row items-baseline justify-between">
              <Text className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle">
                {weekHeader}
              </Text>
              {!isThisWeek && (
                <Text className="text-xs text-un1t-muted">
                  {shiftCount} shift{shiftCount === 1 ? '' : 's'}
                </Text>
              )}
            </View>

            {/* Day rows — only days that have shifts */}
            {shiftDays.map((day, dIdx) => {
              const isLast = dIdx === shiftDays.length - 1
              const weekdayLabel = WEEKDAY_SHORT[day.weekday].toUpperCase()
              return (
                <View
                  key={day.iso}
                  className={`flex-row px-4 py-2.5 ${!isLast ? 'border-b border-un1t-border' : ''} ${
                    day.isToday ? 'bg-un1t-border/30' : ''
                  }`}
                >
                  {/* Left: weekday short + date number */}
                  <View className="w-14">
                    <Text className={`text-[10px] font-semibold uppercase tracking-wider ${
                      day.isToday ? 'text-un1t-text'
                      : day.isPast ? 'text-un1t-muted'
                      : 'text-un1t-subtle'
                    }`}>
                      {weekdayLabel}
                    </Text>
                    <Text className={`text-base font-semibold ${
                      day.isPast ? 'text-un1t-muted' : 'text-un1t-text'
                    }`}>
                      {day.dayNum}
                    </Text>
                  </View>

                  {/* Right: shifts — each tappable for actions */}
                  <View className="flex-1">
                    {day.shifts.map((s, sIdx) => (
                      <Pressable
                        key={s.id || sIdx}
                        onPress={onShiftPress ? () => onShiftPress(s, day) : undefined}
                        className={`${sIdx > 0 ? 'mt-1' : ''} active:opacity-60`}
                      >
                        <View className="flex-row items-center justify-between">
                          <Text className={`text-sm font-medium ${day.isPast ? 'text-un1t-subtle' : 'text-un1t-text'}`} numberOfLines={1}>
                            {s.shift_templates?.name || 'Shift'}
                          </Text>
                          <View className="flex-row items-center">
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
                            {onShiftPress && !day.isPast && s.status !== 'swapped' && (
                              <Ionicons name="ellipsis-horizontal" size={14} color="#94A3B8" style={{ marginLeft: 4 }} />
                            )}
                          </View>
                        </View>
                        <View className="flex-row items-center flex-wrap">
                          <Text className={`text-xs ${day.isPast ? 'text-un1t-muted' : 'text-un1t-subtle'}`}>
                            {shiftTime(s)} · {shiftDurationHours(s)}h
                          </Text>
                          {showLocation && s.locations?.name && (() => {
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
                      </Pressable>
                    ))}
                  </View>
                </View>
              )
            })}
          </View>
        )
      })}
    </View>
  )
}

// Week|Month segmented toggle
function RosterToggle({ value, onChange }) {
  return (
    <View className="flex-row bg-un1t-dark border border-un1t-border rounded-lg p-0.5 self-start mb-3">
      {['Week', 'Month'].map(opt => {
        const active = value === opt.toLowerCase()
        return (
          <Pressable
            key={opt}
            onPress={() => onChange(opt.toLowerCase())}
            className={`px-3 py-1 rounded-md ${active ? 'bg-un1t-surface shadow-sm' : ''}`}
          >
            <Text className={`text-xs font-semibold ${active ? 'text-un1t-text' : 'text-un1t-subtle'}`}>
              {opt}
            </Text>
          </Pressable>
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
  // 'month' is the default; 'week' shows the classic two-week panels.
  const [rosterView, setRosterView] = useState('month')
  // Show per-shift location chip only when the user is assigned to
  // 2+ locations — otherwise it's redundant.
  const showLocation = (locations || []).length > 1
  // AdjustSheet state — opened by tapping a shift then choosing "Adjust time".
  const [adjustingShift, setAdjustingShift] = useState(null)

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
            <Text className="text-sm font-semibold text-red-700">Couldn't load Today</Text>
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
    monthShifts, monthStartIso, monthEndIso,
    pendingSwapsForMe, myPostedSwaps, myPendingTimeOff, unreadInbox,
  } = data

  // Shift-tap action sheet — fires an Alert with options for the tapped shift.
  // Guards: past shifts and swapped shifts get no actions.
  function handleShiftPress(shift, day) {
    if (day.isPast || shift.status === 'swapped') return
    if (!shift.id) {
      Alert.alert('No actions', 'This shift has no assignment ID and cannot be acted on.')
      return
    }
    const shiftLabel = shift.shift_templates?.name || 'Shift'
    const options = []

    // Post for swap — only when shift isn't already swapped
    options.push({
      text: 'Post for swap',
      onPress: async () => {
        const res = await createSwapRequest({
          requesterShiftId: shift.id,
          locationId: activeLocation?.id,
        })
        if (res.success) {
          Alert.alert('Posted', 'Managers have been notified.')
          load()
        } else {
          Alert.alert("Couldn't post", res.error || 'Unknown error')
        }
      },
    })

    // Adjust time
    options.push({
      text: 'Adjust time',
      onPress: () => setAdjustingShift(shift),
    })

    options.push({ text: 'Cancel', style: 'cancel' })

    Alert.alert(
      shiftLabel,
      `${shiftTime(shift)} · ${shiftDurationHours(shift)}h`,
      options,
    )
  }

  // Build the month matrix once (pure — fast enough to compute on render)
  const todayIso = (() => {
    const now = new Date()
    const y = now.getFullYear()
    const m = String(now.getMonth() + 1).padStart(2, '0')
    const day = String(now.getDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
  })()
  const monthMatrix = (monthShifts && monthStartIso && monthEndIso)
    ? buildMonthMatrix(monthStartIso, monthEndIso, monthShifts, todayIso)
    : []

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

      {/* Roster — Week|Month toggle (Month default).
          Month: agenda grouped by week, days-off hidden, today highlighted.
          Week: the classic This week / Next week panels stacked vertically. */}
      <RosterToggle value={rosterView} onChange={setRosterView} />

      {rosterView === 'month' ? (
        <MonthAgenda matrix={monthMatrix} showLocation={showLocation} onShiftPress={handleShiftPress} />
      ) : (
        <>
          <WeekPanel
            title="This week"
            startIso={weekStartIso}
            endIso={weekEndIso}
            shifts={weekShifts}
            showLocation={showLocation}
            onShiftPress={handleShiftPress}
          />
          <WeekPanel
            title="Next week"
            startIso={nextWeekStartIso}
            endIso={nextWeekEndIso}
            shifts={nextWeekShifts}
            showLocation={showLocation}
            onShiftPress={handleShiftPress}
          />
        </>
      )}

      {/* Request time off — shortcut from the roster surface so a coach
          doesn't need to navigate to the Schedule tab to request leave. */}
      <Pressable
        onPress={() => router.push('/schedule/time-off-new')}
        className="flex-row items-center bg-un1t-surface border border-un1t-border rounded-2xl px-4 py-3.5 mb-3 active:opacity-70"
      >
        <Ionicons name="calendar-outline" size={18} color="#64748B" />
        <Text className="text-sm font-medium text-un1t-text ml-2.5">Request time off</Text>
        <View className="flex-1" />
        <Ionicons name="chevron-forward" size={16} color="#94A3B8" />
      </Pressable>

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

      {/* My requests — live section replacing the two read-only ListCards.
          Three sub-sections:
          1. Swaps I posted (myPostedSwaps) — cancellable.
          2. Swaps offered to me (pendingSwapsForMe) — read-only "Awaiting manager"
             (self-accept is Phase 3, no Accept button here).
          3. My pending time-off (myPendingTimeOff) — cancellable. */}
      <SectionHeader
        title="My requests"
        count={(myPostedSwaps?.length || 0) + (pendingSwapsForMe?.length || 0) + (myPendingTimeOff?.length || 0)}
      />

      {/* Empty state when all three request lists are empty */}
      {(myPostedSwaps || []).length === 0 &&
        (pendingSwapsForMe || []).length === 0 &&
        (myPendingTimeOff || []).length === 0 && (
        <ListCard empty emptyText="No pending requests." />
      )}

      {/* Swaps I posted — each row has a Cancel button */}
      {(myPostedSwaps || []).length > 0 && (
        <View className="bg-un1t-surface border border-un1t-border rounded-2xl overflow-hidden mb-3">
          {(myPostedSwaps || []).map((s, i) => {
            const shiftName = s.requester_shift?.shift_templates?.name
            const shiftDate = s.requester_shift?.shift_blocks?.block_date
            const subtitle = shiftName && shiftDate
              ? `${shiftName} on ${shiftDate}`
              : `Posted ${new Date(s.created_at).toLocaleDateString()}`
            const isLast = i === (myPostedSwaps || []).length - 1
            return (
              <View
                key={s.id}
                className={`flex-row items-center px-4 py-3 ${!isLast ? 'border-b border-un1t-border' : ''}`}
              >
                <View className="w-8 h-8 rounded-full bg-un1t-border/40 items-center justify-center mr-3">
                  <Ionicons name="swap-horizontal" size={16} color="#111827" />
                </View>
                <View className="flex-1">
                  <Text className="text-sm font-medium text-un1t-text" numberOfLines={1}>Swap posted</Text>
                  <Text className="text-xs text-un1t-subtle" numberOfLines={1}>{subtitle}</Text>
                </View>
                <View className="ml-2 px-2 py-0.5 rounded-full bg-un1t-border/60 mr-2">
                  <Text className="text-[10px] font-semibold text-un1t-subtle">Pending</Text>
                </View>
                <Pressable
                  onPress={() => {
                    Alert.alert('Cancel swap?', 'This will remove the swap request.', [
                      { text: 'Back', style: 'cancel' },
                      {
                        text: 'Cancel swap',
                        style: 'destructive',
                        onPress: async () => {
                          const res = await cancelSwapRequest(s.id, activeLocation?.id)
                          if (res.success) load()
                          else Alert.alert("Couldn't cancel", res.error || 'Unknown error')
                        },
                      },
                    ])
                  }}
                  className="px-2.5 py-1 rounded-lg bg-red-500/10 active:opacity-70"
                >
                  <Text className="text-xs font-semibold text-red-700">Cancel</Text>
                </Pressable>
              </View>
            )
          })}
        </View>
      )}

      {/* Swaps offered to me — read-only, no Accept (Phase 3) */}
      {(pendingSwapsForMe || []).length > 0 && (
        <View className="bg-un1t-surface border border-un1t-border rounded-2xl overflow-hidden mb-3">
          {(pendingSwapsForMe || []).map((s, i) => {
            const isLast = i === (pendingSwapsForMe || []).length - 1
            return (
              <View
                key={s.id}
                className={`flex-row items-center px-4 py-3 ${!isLast ? 'border-b border-un1t-border' : ''}`}
              >
                <View className="w-8 h-8 rounded-full bg-un1t-border/40 items-center justify-center mr-3">
                  <Ionicons name="swap-horizontal" size={16} color="#111827" />
                </View>
                <View className="flex-1">
                  <Text className="text-sm font-medium text-un1t-text" numberOfLines={1}>
                    {s.requester?.full_name || 'Someone'} wants you to take a shift
                  </Text>
                  <Text className="text-xs text-un1t-subtle" numberOfLines={1}>
                    {s.requester_shift?.shift_templates?.name
                      ? `${s.requester_shift.shift_templates.name} on ${s.requester_shift.shift_date}`
                      : `Posted ${new Date(s.created_at).toLocaleDateString()}`}
                  </Text>
                </View>
                <View className="ml-2 px-2 py-0.5 rounded-full bg-amber-500/20">
                  <Text className="text-[10px] font-semibold text-amber-700">Awaiting manager</Text>
                </View>
              </View>
            )
          })}
        </View>
      )}

      {/* My pending time-off — each row has a Cancel button */}
      {(myPendingTimeOff || []).length > 0 && (
        <View className="bg-un1t-surface border border-un1t-border rounded-2xl overflow-hidden mb-3">
          {(myPendingTimeOff || []).map((t, i) => {
            const isLast = i === (myPendingTimeOff || []).length - 1
            return (
              <View
                key={t.id}
                className={`flex-row items-center px-4 py-3 ${!isLast ? 'border-b border-un1t-border' : ''}`}
              >
                <View className="w-8 h-8 rounded-full bg-un1t-border/40 items-center justify-center mr-3">
                  <Ionicons name="calendar-outline" size={16} color="#111827" />
                </View>
                <View className="flex-1">
                  <Text className="text-sm font-medium text-un1t-text" numberOfLines={1}>
                    {t.type} · awaiting decision
                  </Text>
                  <Text className="text-xs text-un1t-subtle" numberOfLines={1}>
                    {t.start_date === t.end_date ? t.start_date : `${t.start_date} – ${t.end_date}`}
                  </Text>
                </View>
                <View className="ml-2 px-2 py-0.5 rounded-full bg-un1t-border/60 mr-2">
                  <Text className="text-[10px] font-semibold text-un1t-subtle">Pending</Text>
                </View>
                <Pressable
                  onPress={() => {
                    Alert.alert('Cancel time off?', 'This will withdraw your time-off request.', [
                      { text: 'Back', style: 'cancel' },
                      {
                        text: 'Cancel request',
                        style: 'destructive',
                        onPress: async () => {
                          const res = await cancelTimeOffRequest(t.id, activeLocation?.id)
                          if (res.success) load()
                          else Alert.alert("Couldn't cancel", res.error || 'Unknown error')
                        },
                      },
                    ])
                  }}
                  className="px-2.5 py-1 rounded-lg bg-red-500/10 active:opacity-70"
                >
                  <Text className="text-xs font-semibold text-red-700">Cancel</Text>
                </Pressable>
              </View>
            )
          })}
        </View>
      )}

      {/* Adjust-shift modal — opened from the shift-tap action sheet */}
      <AgendaAdjustSheet
        shift={adjustingShift}
        onClose={() => setAdjustingShift(null)}
        onSaved={() => { setAdjustingShift(null); load() }}
        locationId={activeLocation?.id}
      />
    </View>
  )
}

// AgendaAdjustSheet — a slim port of the AdjustSheet from schedule.jsx,
// adapted for use inside PersonalDashboard. Opens as a slide-up Modal over
// the Today surface; uses adjustShiftAssignment (already imported above).
// Only the shift's id (the shift_assignments row id) is used to PUT the assignments route.
function AgendaAdjustSheet({ shift, onClose, onSaved, locationId }) {
  const blockStart = (shift?.start_time || shift?.shift_templates?.start_time || '').slice(0, 5)
  const blockEnd = (shift?.end_time || shift?.shift_templates?.end_time || '').slice(0, 5)

  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState(null)

  // Reset fields whenever a new shift is opened.
  useEffect(() => {
    if (!shift) return
    setStart((shift.start_time_override || '').slice(0, 5) || blockStart)
    setEnd((shift.end_time_override || '').slice(0, 5) || blockEnd)
    setReason(shift.partial_reason || '')
    setErr(null)
  }, [shift]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!shift) return null
  const hasOverride = !!(shift.start_time_override || shift.end_time_override)

  async function save() {
    setErr(null)
    if (start === end) { setErr('Start and end cannot be identical.'); return }
    if (!/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end)) {
      setErr('Use HH:MM format (24-hour).'); return
    }
    setSaving(true)
    const r = await adjustShiftAssignment(shift.id, {
      startTime: start === blockStart ? null : start,
      endTime: end === blockEnd ? null : end,
      reason: reason.trim() || null,
      locationId,
    })
    setSaving(false)
    if (r.success) onSaved?.()
    else setErr(r.error || 'Save failed')
  }

  async function clearOverride() {
    setErr(null); setSaving(true)
    const r = await adjustShiftAssignment(shift.id, {
      startTime: null, endTime: null, reason: null, locationId,
    })
    setSaving(false)
    if (r.success) onSaved?.()
    else setErr(r.error || 'Clear failed')
  }

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        className="flex-1 justify-end bg-black/50"
      >
        <Pressable className="flex-1" onPress={onClose} />
        <View className="bg-un1t-bg border-t border-un1t-border rounded-t-3xl p-5">
          <View className="flex-row items-center justify-between mb-4">
            <Text className="text-lg font-bold text-un1t-text">Adjust shift times</Text>
            <Pressable onPress={onClose} hitSlop={10}>
              <Ionicons name="close" size={22} color="#94A3B8" />
            </Pressable>
          </View>

          <Text className="text-xs text-un1t-subtle mb-4">
            {shift.shift_templates?.name || 'Shift'} · {shift.shift_date}{'\n'}
            Block default: <Text className="font-mono text-un1t-text">{blockStart}–{blockEnd}</Text>.
            {' '}Leave equal to inherit.
          </Text>

          <View className="flex-row gap-3 mb-4">
            <View className="flex-1">
              <Text className="text-xs uppercase font-semibold text-un1t-subtle mb-1.5">Start (HH:MM)</Text>
              <TextInput
                value={start}
                onChangeText={setStart}
                placeholder={blockStart}
                placeholderTextColor="#64748B"
                keyboardType="numbers-and-punctuation"
                maxLength={5}
                className="bg-un1t-surface border border-un1t-border rounded-xl px-3 py-3 text-base text-un1t-text font-mono"
              />
            </View>
            <View className="flex-1">
              <Text className="text-xs uppercase font-semibold text-un1t-subtle mb-1.5">End (HH:MM)</Text>
              <TextInput
                value={end}
                onChangeText={setEnd}
                placeholder={blockEnd}
                placeholderTextColor="#64748B"
                keyboardType="numbers-and-punctuation"
                maxLength={5}
                className="bg-un1t-surface border border-un1t-border rounded-xl px-3 py-3 text-base text-un1t-text font-mono"
              />
            </View>
          </View>

          <Text className="text-xs uppercase font-semibold text-un1t-subtle mb-1.5">Reason (optional)</Text>
          <TextInput
            value={reason}
            onChangeText={setReason}
            placeholder="e.g. left early — sick, covered until 1pm"
            placeholderTextColor="#64748B"
            maxLength={200}
            className="bg-un1t-surface border border-un1t-border rounded-xl px-3 py-3 text-base text-un1t-text mb-4"
          />

          {err && (
            <View className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 mb-3 flex-row items-start">
              <Ionicons name="alert-circle" size={16} color="#DC2626" />
              <Text className="text-sm text-red-700 ml-2 flex-1">{err}</Text>
            </View>
          )}

          <Pressable
            onPress={save}
            disabled={saving}
            className="bg-amber-600 active:opacity-80 disabled:opacity-50 px-4 py-3.5 rounded-xl items-center flex-row justify-center"
          >
            {saving
              ? <ActivityIndicator color="#FFFFFF" />
              : <Ionicons name="checkmark" size={18} color="#FFFFFF" />}
            <Text className="text-base font-semibold text-white ml-2">
              {saving ? 'Saving…' : 'Save adjustment'}
            </Text>
          </Pressable>

          {hasOverride && (
            <Pressable
              onPress={clearOverride}
              disabled={saving}
              className="mt-2 active:opacity-70 px-4 py-3 rounded-xl items-center"
            >
              <Text className="text-sm font-medium text-un1t-subtle">Clear override (use block default)</Text>
            </Pressable>
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  )
}
