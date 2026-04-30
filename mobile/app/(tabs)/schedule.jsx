// Schedule tab — week strip + shifts list + floating Request Time Off.
//
// Architecture:
//   - useEffect loads the week's shifts whenever `weekAnchor` (the first
//     day of the visible week) or activeLocation changes.
//   - The week strip lets the user pick which day's shifts to view.
//   - Pull-to-refresh re-fetches.
//   - "Request Time Off" pushes the modal route.
//   - Long-pressing a shift row offers "Request Swap" (a swap modal).
//
// Performance: shifts are cheap (<= ~14 per week per user). No
// virtualisation needed — the FlatList is overkill for this size.

import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  View, Text, ScrollView, Pressable, RefreshControl,
  ActivityIndicator, Alert,
} from 'react-native'
import { useRouter } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useAuth } from '../../lib/auth-context'
import {
  weekStart, addDays, daysOfWeek, isoDate, DAY_LABELS,
  shortDate, timeRange, hoursBetween,
} from '../../lib/dates'
import { getMyShifts, getMyTimeOff, createSwapRequest } from '../../lib/schedule-api'

function WeekStrip({ anchor, selected, onSelect, byDate }) {
  const days = daysOfWeek(anchor)
  return (
    <View className="flex-row justify-between px-1">
      {days.map((d, i) => {
        const iso = isoDate(d)
        const isSel = iso === isoDate(selected)
        const count = (byDate[iso] || []).length
        return (
          <Pressable
            key={iso}
            onPress={() => onSelect(d)}
            className={`flex-1 mx-0.5 items-center py-2 rounded-xl ${isSel ? 'bg-un1t-white' : 'bg-un1t-dark border border-un1t-gray'}`}
          >
            <Text className={`text-[11px] uppercase font-medium ${isSel ? 'text-un1t-black' : 'text-un1t-light'}`}>
              {DAY_LABELS[i]}
            </Text>
            <Text className={`text-lg font-semibold ${isSel ? 'text-un1t-black' : 'text-un1t-white'}`}>
              {d.getDate()}
            </Text>
            {count > 0 && (
              <View className={`mt-0.5 w-1.5 h-1.5 rounded-full ${isSel ? 'bg-un1t-black' : 'bg-un1t-white'}`} />
            )}
          </Pressable>
        )
      })}
    </View>
  )
}

function ShiftRow({ shift, onLongPress }) {
  const tpl = shift.shift_templates
  const hours = hoursBetween(shift.start_time, shift.end_time)
  return (
    <Pressable
      onLongPress={onLongPress}
      delayLongPress={400}
      className="bg-un1t-dark border border-un1t-gray rounded-2xl p-4 mb-2 active:opacity-70"
    >
      <View className="flex-row items-center justify-between mb-1">
        <Text className="text-base font-semibold text-un1t-white">
          {tpl?.name || 'Shift'}
        </Text>
        {shift.published === false && (
          <View className="px-2 py-0.5 rounded-full bg-amber-500/20">
            <Text className="text-[10px] uppercase text-amber-700 font-medium">Draft</Text>
          </View>
        )}
        {shift.status === 'swapped' && (
          <View className="px-2 py-0.5 rounded-full bg-blue-500/20">
            <Text className="text-[10px] uppercase text-blue-700 font-medium">Swapped</Text>
          </View>
        )}
      </View>
      <View className="flex-row items-center">
        <Ionicons name="time-outline" size={14} color="#64748B" />
        <Text className="text-sm text-un1t-light ml-1">
          {timeRange(shift.start_time, shift.end_time)} · {hours}h
        </Text>
      </View>
      {shift.notes && (
        <Text className="text-xs text-un1t-light mt-1.5">{shift.notes}</Text>
      )}
    </Pressable>
  )
}

export default function Schedule() {
  const { activeLocation, profile } = useAuth()
  const router = useRouter()
  const [anchor, setAnchor] = useState(() => weekStart(new Date()))
  const [selected, setSelected] = useState(() => new Date())
  const [shifts, setShifts] = useState([])
  const [timeOff, setTimeOff] = useState([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(null)

  const start = useMemo(() => isoDate(anchor), [anchor])
  const end = useMemo(() => isoDate(addDays(anchor, 6)), [anchor])

  const fetchWeek = useCallback(async () => {
    if (!profile || !activeLocation) return
    setError(null)
    const [shiftsRes, timeOffRes] = await Promise.all([
      getMyShifts({
        locationId: activeLocation.id,
        profileId: profile.id,
        startDate: start,
        endDate: end,
      }),
      getMyTimeOff({
        locationId: activeLocation.id,
        profileId: profile.id,
      }),
    ])
    if (!shiftsRes.success) setError(shiftsRes.error || 'Failed to load shifts')
    setShifts(shiftsRes.success ? shiftsRes.data || [] : [])
    setTimeOff(timeOffRes.success ? timeOffRes.data || [] : [])
  }, [profile, activeLocation, start, end])

  useEffect(() => {
    setLoading(true)
    fetchWeek().finally(() => setLoading(false))
  }, [fetchWeek])

  async function onRefresh() {
    setRefreshing(true)
    await fetchWeek()
    setRefreshing(false)
  }

  // Index shifts by ISO date for quick day selection.
  const shiftsByDate = useMemo(() => {
    const idx = {}
    for (const s of shifts) {
      const d = s.shift_date
      if (!idx[d]) idx[d] = []
      idx[d].push(s)
    }
    return idx
  }, [shifts])

  const selectedIso = isoDate(selected)
  const todays = (shiftsByDate[selectedIso] || []).slice().sort((a, b) =>
    (a.start_time || '').localeCompare(b.start_time || '')
  )

  // Time-off rows that touch the selected day. Useful in-context cue
  // for staff: "your week off, no shifts because you requested leave".
  const todaysLeave = timeOff.filter(t =>
    t.start_date <= selectedIso && t.end_date >= selectedIso &&
    (t.status === 'approved' || t.status === 'pending')
  )

  function requestSwapForShift(shift) {
    Alert.alert(
      'Request swap?',
      `Post ${shift.shift_templates?.name || 'this shift'} on ${shift.shift_date} for someone else to take?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Post for swap',
          onPress: async () => {
            const res = await createSwapRequest({
              requesterShiftId: shift.id,
              locationId: activeLocation.id,
            })
            if (res.success) {
              Alert.alert('Posted', 'Managers have been notified.')
              fetchWeek()
            } else {
              Alert.alert('Couldn’t post', res.error || 'Unknown error')
            }
          },
        },
      ]
    )
  }

  return (
    <View className="flex-1 bg-un1t-black">
      <ScrollView
        contentContainerClassName="px-4 pt-4 pb-32"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#111827" />}
      >
        {/* Week header */}
        <View className="flex-row items-center justify-between mb-3">
          <Pressable onPress={() => setAnchor(addDays(anchor, -7))} className="p-2 -ml-2">
            <Ionicons name="chevron-back" size={22} color="#111827" />
          </Pressable>
          <Pressable
            onPress={() => {
              const today = new Date()
              setAnchor(weekStart(today))
              setSelected(today)
            }}
            className="px-3 py-1 rounded-full bg-un1t-dark border border-un1t-gray"
          >
            <Text className="text-sm font-medium text-un1t-white">
              {shortDate(anchor)} – {shortDate(addDays(anchor, 6))}
            </Text>
          </Pressable>
          <Pressable onPress={() => setAnchor(addDays(anchor, 7))} className="p-2 -mr-2">
            <Ionicons name="chevron-forward" size={22} color="#111827" />
          </Pressable>
        </View>

        <WeekStrip anchor={anchor} selected={selected} onSelect={setSelected} byDate={shiftsByDate} />

        <Text className="text-xs uppercase tracking-wider text-un1t-light mt-6 mb-2 px-1">
          {selected.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}
        </Text>

        {error ? (
          <View className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 mb-3">
            <Text className="text-red-500 text-sm">{error}</Text>
          </View>
        ) : null}

        {loading ? (
          <View className="py-12 items-center">
            <ActivityIndicator />
          </View>
        ) : (
          <>
            {todaysLeave.map(t => (
              <View key={t.id} className="bg-amber-500/10 border border-amber-500/40 rounded-2xl p-4 mb-2">
                <Text className="text-sm font-semibold text-amber-700">
                  {t.type === 'holiday' ? 'Holiday' : t.type === 'sick' ? 'Sick leave' : 'Time off'}
                  {t.status === 'pending' ? ' — pending' : ''}
                </Text>
                {t.reason && <Text className="text-xs text-amber-700/80 mt-1">{t.reason}</Text>}
              </View>
            ))}

            {todays.length === 0 && todaysLeave.length === 0 && (
              <View className="py-10 items-center">
                <Ionicons name="cafe-outline" size={28} color="#94A3B8" />
                <Text className="text-sm text-un1t-light mt-2">No shifts today.</Text>
              </View>
            )}

            {todays.map(s => (
              <ShiftRow key={s.id} shift={s} onLongPress={() => requestSwapForShift(s)} />
            ))}
            {todays.length > 0 && (
              <Text className="text-[11px] text-un1t-mid text-center mt-1">
                Long-press a shift to request a swap.
              </Text>
            )}
          </>
        )}
      </ScrollView>

      {/* Floating Request Time Off button */}
      <Pressable
        onPress={() => router.push('/schedule/time-off-new')}
        className="absolute bottom-6 right-6 bg-un1t-white rounded-full px-5 py-3.5 flex-row items-center shadow-lg active:opacity-80"
      >
        <Ionicons name="add" size={20} color="#FFFFFF" />
        <Text className="text-un1t-black font-semibold ml-1.5">Request time off</Text>
      </Pressable>
    </View>
  )
}
