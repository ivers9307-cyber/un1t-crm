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
import { pickLocationColor } from 'shared/location-colors'
import { buildMonthMatrix, shiftDurationHours } from 'shared/roster-month'
import { groupTeamShiftsByCoach, coachSpanLabel } from 'shared/team-today'
import {
  KpiCard, KpiRow, SectionHeader, ListCard,
} from './cards'
import {
  createSwapRequest, adjustShiftAssignment,
  cancelSwapRequest, cancelTimeOffRequest,
  getSwapsForMe, getOpenSwaps, getTeamShifts, respondToSwap,
  getLocationStaff,
} from '../../lib/schedule-api'
// CT-P3b — reuse the schedule Manage-mode colleague picker for targeted swaps.
import CoachPickerSheet from '../schedule/CoachPickerSheet'
// CHECKLIST.2 — top-of-Today card showing the coach's checklist
// when they're on shift today. Self-contained: renders nothing
// when there's no instance to surface.
import TodayChecklistCard from './TodayChecklistCard'
// EQUIP-MAINT.2 — equipment due-for-inspection card. Self-contained,
// same posture as TodayChecklistCard: renders nothing when there's
// nothing due, the viewer lacks equipment_inspect, or the location
// hasn't got inspections switched on.
import DueInspectionsCard from './DueInspectionsCard'
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
        <Text className="text-sm text-un1t-subtle text-center">No shifts in the next 7 weeks</Text>
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

// Week | Upcoming segmented toggle. Internal value stays 'week'/'month'; the
// 'month' label reads "Upcoming" because that view now shows a rolling 7-week
// window (this week + next 6), not a calendar month.
const ROSTER_OPTS = [{ value: 'week', label: 'Week' }, { value: 'month', label: 'Upcoming' }]

function RosterToggle({ value, onChange }) {
  return (
    <View className="flex-row bg-un1t-surface border border-un1t-border rounded-lg p-0.5 self-start mb-3">
      {ROSTER_OPTS.map(opt => {
        const active = value === opt.value
        return (
          <Pressable
            key={opt.value}
            onPress={() => onChange(opt.value)}
            className={`px-3 py-1 rounded-md ${active ? 'bg-un1t-surface shadow-sm' : ''}`}
          >
            <Text className={`text-xs font-semibold ${active ? 'text-un1t-text' : 'text-un1t-subtle'}`}>
              {opt.label}
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

  // CT-P3b — actionable swap surfaces fed by the service-role route (names
  // ride along). offered = targeted-at/claimed-by me; openPool = claimable
  // pool; onToday = other coaches on shift today. Fetched separately from the
  // shared dashboard data (which can't embed profiles on mobile).
  const [offered, setOffered] = useState([])
  const [openPool, setOpenPool] = useState([])
  const [onToday, setOnToday] = useState([])
  const [swapBusy, setSwapBusy] = useState(null) // `${id}:${verb}` while mutating
  // Targeted-swap colleague picker state (reuses CoachPickerSheet).
  const [swapPickerShift, setSwapPickerShift] = useState(null)
  const [swapStaff, setSwapStaff] = useState(null) // null = not loaded
  const [swapStaffLoading, setSwapStaffLoading] = useState(false)

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

  // Swap lists (offered + open pool). Best-effort — failures leave the lists
  // empty rather than blocking the roster.
  const loadSwaps = useCallback(async () => {
    const locationId = activeLocation?.id
    if (!locationId) { setOffered([]); setOpenPool([]); return }
    try {
      const [forMe, open] = await Promise.all([
        getSwapsForMe({ locationId }),
        getOpenSwaps({ locationId }),
      ])
      setOffered(forMe.success ? (forMe.data || []) : [])
      setOpenPool(open.success ? (open.data || []) : [])
    } catch {
      setOffered([]); setOpenPool([])
    }
  }, [activeLocation])

  // "On with you today" — other coaches working today (exclude self).
  const loadOnToday = useCallback(async () => {
    const locationId = activeLocation?.id
    if (!locationId || !profile) { setOnToday([]); return }
    const today = isoDate(new Date())
    try {
      const res = await getTeamShifts({ locationId, startDate: today, endDate: today })
      const others = (res.success ? (res.data || []) : [])
        .filter((s) => s.profile_id && s.profile_id !== profile.id)
      setOnToday(others)
    } catch {
      setOnToday([])
    }
  }, [activeLocation, profile])

  useEffect(() => {
    setLoading(true)
    load().finally(() => setLoading(false))
  }, [load, refreshKey])

  useEffect(() => { loadSwaps(); loadOnToday() }, [loadSwaps, loadOnToday, refreshKey])

  // Re-fetch when the Home tab regains focus so the roster + KPIs reflect
  // changes made elsewhere (or a "View as user" switch) without a manual
  // pull-to-refresh. Silent — keeps the current data on screen until the
  // new data lands.
  useFocusEffect(useCallback(() => {
    load(); loadSwaps(); loadOnToday()
  }, [load, loadSwaps, loadOnToday]))

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
    myPostedSwaps, myPendingTimeOff, unreadInbox,
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
          load(); loadSwaps()
        } else {
          Alert.alert("Couldn't post", res.error || 'Unknown error')
        }
      },
    })

    // CT-P3b — targeted swap: offer this shift to one chosen colleague.
    options.push({
      text: 'Swap with a specific coach…',
      onPress: () => openSwapPicker(shift),
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

  // CT-P3b — drive an offered/open swap through the lifecycle, then refetch.
  //   accept / claim → 'awaiting_approval'   decline → 'rejected'
  //   withdraw       → 'pending'
  async function mutateSwap(id, status, verb) {
    if (swapBusy) return
    setSwapBusy(`${id}:${verb}`)
    try {
      const res = await respondToSwap(id, status, null, activeLocation?.id)
      if (res.success) {
        await loadSwaps()
        load()
      } else {
        Alert.alert(`Couldn't ${verb}`, res.error || 'Unknown error')
      }
    } finally {
      setSwapBusy(null)
    }
  }

  // Open the colleague picker for a targeted swap. Reuses CoachPickerSheet by
  // synthesising a block-like object: shift_assignments carries the current
  // user so the picker excludes them; shift_templates feeds the sheet title.
  async function openSwapPicker(shift) {
    setSwapPickerShift(shift)
    if (swapStaff === null && !swapStaffLoading) {
      setSwapStaffLoading(true)
      const res = await getLocationStaff({ locationId: activeLocation?.id })
      setSwapStaffLoading(false)
      setSwapStaff(res.success ? (res.data || []) : [])
      if (!res.success) Alert.alert('Could not load staff', res.error || 'Unknown error')
    }
  }

  async function pickSwapCoach(coach) {
    const shift = swapPickerShift
    setSwapPickerShift(null)
    if (!shift) return
    const res = await createSwapRequest({
      requesterShiftId: shift.id,
      targetId: coach.id,
      locationId: activeLocation?.id,
    })
    if (res.success) {
      Alert.alert('Swap offered', `${coach.full_name} has been asked to take this shift.`)
      load(); loadSwaps()
    } else {
      Alert.alert("Couldn't offer swap", res.error || 'Unknown error')
    }
  }

  // Block-like shape for CoachPickerSheet (targeted swap). Excludes self via
  // shift_assignments; title comes from the shift's template.
  const swapPickerBlock = swapPickerShift
    ? {
        shift_templates: swapPickerShift.shift_templates,
        shift_assignments: profile ? [{ profile_id: profile.id }] : [],
      }
    : null

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

  // Group today's team shifts by coach — one row per person (not per shift).
  const onTodayCoaches = groupTeamShiftsByCoach(onToday)

  return (
    <View>
      {/* CHECKLIST.2 — coach's checklist for today, when applicable.
          Self-renders null when the coach isn't on shift today or
          has no matching template, so this is invisible for most
          users on most days. Sits at the top so it's the first
          thing on shift — closer / opener items shouldn't have to
          scroll past a roster. */}
      <TodayChecklistCard />

      {/* EQUIP-MAINT.2 — equipment due for inspection, right under
          the checklist card. Self-renders null when nothing is due,
          the location is dormant, or the viewer lacks
          equipment_inspect. */}
      <DueInspectionsCard />

      {/* MOBILE-TODAY-FEED — what needs the viewer across the gym,
          right under their own shift card. Coaches without queue
          permissions never see it. */}
      <NeedsAttentionCard />

      {/* Request time off — top-of-page shortcut, directly under Needs
          attention, so a coach can request leave without scrolling past the
          roster or hopping to the Schedule tab. */}
      <Pressable
        onPress={() => router.push('/schedule/time-off-new')}
        className="flex-row items-center bg-un1t-surface border border-un1t-border rounded-2xl px-4 py-3.5 mb-3 active:opacity-70"
      >
        <Ionicons name="calendar-outline" size={18} color="#64748B" />
        <Text className="text-sm font-medium text-un1t-text ml-2.5">Request time off</Text>
        <View className="flex-1" />
        <Ionicons name="chevron-forward" size={16} color="#94A3B8" />
      </Pressable>

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

      {/* CT-P3b — Swaps offered to you. Pending → Accept / Decline; once
          claimed (awaiting_approval) → Awaiting-manager chip + Withdraw.
          Name + shift ride along from the service-role route. */}
      {offered.length > 0 && (
        <>
          <SectionHeader title="Swaps offered to you" count={offered.length} />
          <View className="bg-un1t-surface border border-un1t-border rounded-2xl overflow-hidden mb-3">
            {offered.map((s, i) => {
              const isLast = i === offered.length - 1
              const name = s.requester?.full_name || 'A colleague'
              const tpl = s.requester_shift?.shift_templates?.name || 'a shift'
              const date = s.requester_shift?.shift_date
              const awaiting = s.status === 'awaiting_approval'
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
                      {`${name} wants you to take ${tpl}`}
                    </Text>
                    {date ? (
                      <Text className="text-xs text-un1t-subtle" numberOfLines={1}>{date}</Text>
                    ) : null}
                  </View>
                  {awaiting ? (
                    <View className="flex-row items-center">
                      <View className="ml-2 px-2 py-0.5 rounded-full bg-amber-500/20 mr-2">
                        <Text className="text-[10px] font-semibold text-amber-700">Awaiting manager</Text>
                      </View>
                      <Pressable
                        disabled={!!swapBusy}
                        onPress={() => mutateSwap(s.id, 'pending', 'withdraw')}
                        className="px-2.5 py-1 rounded-lg bg-un1t-border/60 active:opacity-70"
                      >
                        <Text className="text-xs font-semibold text-un1t-text">
                          {swapBusy === `${s.id}:withdraw` ? '…' : 'Withdraw'}
                        </Text>
                      </Pressable>
                    </View>
                  ) : (
                    <View className="flex-row items-center">
                      <Pressable
                        disabled={!!swapBusy}
                        onPress={() => mutateSwap(s.id, 'awaiting_approval', 'accept')}
                        className="px-2.5 py-1 rounded-lg bg-un1t-text active:opacity-70 mr-2"
                      >
                        <Text className="text-xs font-semibold text-un1t-bg">
                          {swapBusy === `${s.id}:accept` ? '…' : 'Accept'}
                        </Text>
                      </Pressable>
                      <Pressable
                        disabled={!!swapBusy}
                        onPress={() => mutateSwap(s.id, 'rejected', 'decline')}
                        className="px-2.5 py-1 rounded-lg bg-red-500/10 active:opacity-70"
                      >
                        <Text className="text-xs font-semibold text-red-700">
                          {swapBusy === `${s.id}:decline` ? '…' : 'Decline'}
                        </Text>
                      </Pressable>
                    </View>
                  )}
                </View>
              )
            })}
          </View>
        </>
      )}

      {/* CT-P3b — Open swaps you can take (the unclaimed pool). Claim → the
          swap becomes awaiting_approval, pending manager finalisation. */}
      {openPool.length > 0 && (
        <>
          <SectionHeader title="Open swaps you can take" count={openPool.length} />
          <View className="bg-un1t-surface border border-un1t-border rounded-2xl overflow-hidden mb-3">
            {openPool.map((s, i) => {
              const isLast = i === openPool.length - 1
              const name = s.requester?.full_name || 'A colleague'
              const tpl = s.requester_shift?.shift_templates?.name || 'Shift'
              const date = s.requester_shift?.shift_date
              return (
                <View
                  key={s.id}
                  className={`flex-row items-center px-4 py-3 ${!isLast ? 'border-b border-un1t-border' : ''}`}
                >
                  <View className="w-8 h-8 rounded-full bg-un1t-border/40 items-center justify-center mr-3">
                    <Ionicons name="file-tray-outline" size={16} color="#111827" />
                  </View>
                  <View className="flex-1">
                    <Text className="text-sm font-medium text-un1t-text" numberOfLines={1}>
                      {`${name} · ${tpl}`}
                    </Text>
                    {date ? (
                      <Text className="text-xs text-un1t-subtle" numberOfLines={1}>{date}</Text>
                    ) : null}
                  </View>
                  <Pressable
                    disabled={!!swapBusy}
                    onPress={() => mutateSwap(s.id, 'awaiting_approval', 'claim')}
                    className="px-2.5 py-1 rounded-lg bg-un1t-text active:opacity-70"
                  >
                    <Text className="text-xs font-semibold text-un1t-bg">
                      {swapBusy === `${s.id}:claim` ? '…' : 'Claim'}
                    </Text>
                  </Pressable>
                </View>
              )
            })}
          </View>
        </>
      )}

      {/* ON-TODAY — On with you today (read-only). Grouped by coach: one row
          per person with their earliest–latest span + shift count, so a coach
          with several blocks shows once and the count reflects people on today,
          not shift rows. Names come from the service-role shifts route. */}
      {onTodayCoaches.length > 0 && (
        <>
          <SectionHeader title="On with you today" count={onTodayCoaches.length} />
          <View className="bg-un1t-surface border border-un1t-border rounded-2xl overflow-hidden mb-3">
            {onTodayCoaches.map((c, i) => {
              const isLast = i === onTodayCoaches.length - 1
              const span = coachSpanLabel(c)
              return (
                <View
                  key={c.profileId}
                  className={`flex-row items-center px-4 py-3 ${!isLast ? 'border-b border-un1t-border' : ''}`}
                >
                  <View className="w-8 h-8 rounded-full bg-un1t-border/40 items-center justify-center mr-3">
                    <Ionicons name="people-outline" size={16} color="#111827" />
                  </View>
                  <View className="flex-1">
                    <Text className="text-sm font-medium text-un1t-text" numberOfLines={1}>{c.name}</Text>
                    {span ? (
                      <Text className="text-xs text-un1t-subtle" numberOfLines={1}>{span}</Text>
                    ) : null}
                  </View>
                  <View className="ml-2 px-2 py-0.5 rounded-full bg-un1t-border/60">
                    <Text className="text-[10px] font-semibold text-un1t-subtle">
                      {c.count} shift{c.count === 1 ? '' : 's'}
                    </Text>
                  </View>
                </View>
              )
            })}
          </View>
        </>
      )}

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

      {/* My requests — live section. Two sub-sections:
          1. Swaps I posted (myPostedSwaps) — cancellable; shows real status
             (pending OR awaiting_approval once someone has taken it).
          2. My pending time-off (myPendingTimeOff) — cancellable.
          Swaps offered TO me moved to the "Swaps offered to you" surface above
          (CT-P3b — that list is route-fed so it carries the requester name). */}
      <SectionHeader
        title="My requests"
        count={(myPostedSwaps?.length || 0) + (myPendingTimeOff?.length || 0)}
      />

      {/* Empty state when both request lists are empty */}
      {(myPostedSwaps || []).length === 0 &&
        (myPendingTimeOff || []).length === 0 && (
        <ListCard empty emptyText="No pending requests." />
      )}

      {/* Swaps I posted — each row has a Cancel button */}
      {(myPostedSwaps || []).length > 0 && (
        <View className="bg-un1t-surface border border-un1t-border rounded-2xl overflow-hidden mb-3">
          {(myPostedSwaps || []).map((s, i) => {
            const shiftName = s.requester_shift?.shift_blocks?.shift_templates?.name
            const shiftDate = s.requester_shift?.shift_blocks?.block_date
            const subtitle = shiftName && shiftDate
              ? `${shiftName} on ${shiftDate}`
              : `Posted ${new Date(s.created_at).toLocaleDateString()}`
            const isLast = i === (myPostedSwaps || []).length - 1
            // CT-P3b — reflect the real status. awaiting_approval = a coach has
            // taken it and it's with a manager; pending = still open.
            const awaiting = s.status === 'awaiting_approval'
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
                <View className={`ml-2 px-2 py-0.5 rounded-full mr-2 ${awaiting ? 'bg-amber-500/20' : 'bg-un1t-border/60'}`}>
                  <Text className={`text-[10px] font-semibold ${awaiting ? 'text-amber-700' : 'text-un1t-subtle'}`}>
                    {awaiting ? 'Awaiting manager' : 'Pending'}
                  </Text>
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
                          if (res.success) { load(); loadSwaps() }
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

      {/* CT-P3b — targeted-swap colleague picker (reused from Manage mode).
          The synthesised block excludes the current user and titles the sheet
          with the shift template. */}
      <CoachPickerSheet
        visible={!!swapPickerShift}
        block={swapPickerBlock}
        locationId={activeLocation?.id}
        staff={swapStaff}
        loading={swapStaffLoading}
        onPick={pickSwapCoach}
        onClose={() => setSwapPickerShift(null)}
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
