// "Today" — personal dashboard rendered on the Home tab for everyone
// (gated by permissions.dashboard_personal, default: all roles).
//
// Hero is a week view of YOUR shifts grouped by day — every day Mon
// through Sun is shown so you can scan your week at a glance. Days
// with no shifts say "Off". Today is highlighted. Past days are
// dimmed.

import { View, Text, ActivityIndicator } from 'react-native'
import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'expo-router'
import { useAuth } from '../../lib/auth-context'
import { fetchPersonalDashboard } from '../../lib/dashboard-api'
import {
  KpiCard, KpiRow, SectionHeader, PendingRow, ListCard,
} from './cards'

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
function WeekPanel({ title, startIso, endIso, shifts }) {
  const days = buildWeek(startIso, shifts || [])
  return (
    <View className="bg-un1t-dark border border-un1t-gray rounded-2xl mb-3 overflow-hidden">
      <View className="px-4 pt-3 pb-2 flex-row items-baseline justify-between">
        <Text className="text-xs font-semibold uppercase tracking-wider text-un1t-light">
          {title}
        </Text>
        <Text className="text-xs text-un1t-mid">{rangeLabelFor(startIso, endIso)}</Text>
      </View>
      {days.map((day, idx) => {
        const isLast = idx === days.length - 1
        return (
          <View
            key={day.iso}
            className={`flex-row px-4 py-2.5 ${!isLast ? 'border-b border-un1t-gray' : ''} ${
              day.isToday ? 'bg-un1t-gray/30' : ''
            }`}
          >
            <View className="w-14">
              <Text className={`text-[10px] font-semibold uppercase tracking-wider ${
                day.isToday ? 'text-un1t-white'
                : day.isPast ? 'text-un1t-mid'
                : 'text-un1t-light'
              }`}>
                {day.label}
              </Text>
              <Text className={`text-base font-semibold ${
                day.isPast ? 'text-un1t-mid' : 'text-un1t-white'
              }`}>
                {day.dayNum}
              </Text>
            </View>
            <View className="flex-1">
              {day.shifts.length === 0 ? (
                <Text className={`text-sm ${day.isPast ? 'text-un1t-mid' : 'text-un1t-light'} pt-1`}>
                  Off
                </Text>
              ) : (
                day.shifts.map((s, i) => (
                  <View key={s.id} className={i > 0 ? 'mt-1' : ''}>
                    <View className="flex-row items-center justify-between">
                      <Text className={`text-sm font-medium ${day.isPast ? 'text-un1t-light' : 'text-un1t-white'}`} numberOfLines={1}>
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
                    <Text className={`text-xs ${day.isPast ? 'text-un1t-mid' : 'text-un1t-light'}`}>
                      {shiftTime(s)} · {shiftHours(s)}h
                    </Text>
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
  const { profile, activeLocation } = useAuth()
  const router = useRouter()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!profile) return
    const res = await fetchPersonalDashboard(profile.id, activeLocation?.id)
    if (res.success) setData(res.data)
  }, [profile, activeLocation])

  useEffect(() => {
    setLoading(true)
    load().finally(() => setLoading(false))
  }, [load, refreshKey])

  if (loading || !data) {
    return (
      <View className="py-8 items-center">
        <ActivityIndicator />
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
      {/* Roster — current week + next week, stacked vertically because
          a phone is too narrow for two side-by-side weeks. The web
          equivalent renders these in a 2-col grid. */}
      <WeekPanel
        title="This week"
        startIso={weekStartIso}
        endIso={weekEndIso}
        shifts={weekShifts}
      />
      <WeekPanel
        title="Next week"
        startIso={nextWeekStartIso}
        endIso={nextWeekEndIso}
        shifts={nextWeekShifts}
      />

      {/* Top KPIs */}
      <KpiRow>
        <KpiCard label="This week" value={`${hoursThisWeek}h`} sublabel={`${shiftsThisWeek} shift${shiftsThisWeek === 1 ? '' : 's'}`} />
        <KpiCard
          label="Inbox"
          value={unreadInbox}
          sublabel={unreadInbox === 1 ? 'unread message' : 'unread messages'}
          accent={unreadInbox > 0 ? 'text-un1t-white' : 'text-un1t-mid'}
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
