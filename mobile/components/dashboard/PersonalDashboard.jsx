// "Today" — personal dashboard rendered on the Home tab for everyone
// (gated by permissions.mobile.dashboard_personal, default: all roles).
//
// Surfaces what only this user cares about: their next shift, their
// week's hours, swap requests aimed at them, their pending time-off
// requests, and any WhatsApp conversations assigned to them with
// unread messages.

import { View, Text, ActivityIndicator } from 'react-native'
import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'expo-router'
import { useAuth } from '../../lib/auth-context'
import { fetchPersonalDashboard } from '../../lib/dashboard-api'
import {
  KpiCard, KpiRow, SectionHeader, PendingRow, ListCard,
} from './cards'

function formatShiftWhen(shift) {
  if (!shift) return null
  const d = new Date(shift.shift_date + 'T00:00:00')
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1)
  const start = (shift.start_time_override || shift.shift_templates?.start_time || '').slice(0, 5)
  const end = (shift.end_time_override || shift.shift_templates?.end_time || '').slice(0, 5)
  let dayLabel = d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
  if (d.getTime() === today.getTime()) dayLabel = 'Today'
  if (d.getTime() === tomorrow.getTime()) dayLabel = 'Tomorrow'
  return `${dayLabel} · ${start} – ${end}`
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

  const { nextShift, shiftsThisWeek, hoursThisWeek, pendingSwapsForMe, myPendingTimeOff, unreadInbox } = data

  return (
    <View>
      {/* Hero — next shift */}
      {nextShift ? (
        <View className="bg-un1t-white rounded-2xl p-4 mb-3">
          <Text className="text-xs uppercase tracking-wider text-un1t-mid">Your next shift</Text>
          <Text className="text-lg font-bold text-un1t-black mt-1">
            {nextShift.shift_templates?.name || 'Shift'}
          </Text>
          <Text className="text-sm text-un1t-light mt-0.5">{formatShiftWhen(nextShift)}</Text>
        </View>
      ) : (
        <View className="bg-un1t-dark border border-un1t-gray rounded-2xl p-4 mb-3">
          <Text className="text-xs uppercase tracking-wider text-un1t-light">Your next shift</Text>
          <Text className="text-base text-un1t-white mt-1">No upcoming shifts this week.</Text>
        </View>
      )}

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
