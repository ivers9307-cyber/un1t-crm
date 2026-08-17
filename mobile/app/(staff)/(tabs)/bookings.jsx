// NOTIF.2 — Bookings tab. Operator view of today + tomorrow's
// confirmed bookings at the active location.
//
// Surface design: two day-buckets (Today, Tomorrow), each a list of
// time-sorted rows with the customer, event type, and a tap-to-call
// affordance. Pull-to-refresh.
//
// New bookings still get created on the web Calendly hub — there's
// no "create" CTA here. The push-reminder cron deep-links a tap
// straight into a booking detail screen (mobile/app/bookings/[id].jsx).

import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  View, Text, ScrollView, Pressable, RefreshControl,
  ActivityIndicator, Linking,
} from 'react-native'
import { useRouter, useFocusEffect } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useAuth } from '../../../lib/auth-context'
import {
  listUpcomingBookings, groupByDate, formatBookingTime,
} from '../../../lib/bookings-api'
import TabletConstrained from '../../../components/TabletConstrained'

function todayIso() {
  // Device-local day. Acceptable proxy for "location's day" because
  // the operator opening this view is physically at the studio.
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  dt.setDate(dt.getDate() + n)
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
}

function BookingRow({ booking, onPress }) {
  const evt = booking.event_type
  const customer = booking.customer_name
    || (booking.contact ? `${booking.contact.first_name || ''} ${booking.contact.last_name || ''}`.trim() : '')
    || 'Guest'
  const dot = evt?.color || '#94A3B8'
  return (
    <Pressable
      onPress={onPress}
      className="bg-un1t-surface border border-un1t-border rounded-2xl p-4 mb-2 active:opacity-70"
    >
      <View className="flex-row items-center mb-1.5">
        <View
          className="w-2 h-2 rounded-full mr-2"
          style={{ backgroundColor: dot }}
        />
        <Text className="text-sm font-medium text-un1t-subtle">
          {evt?.name || 'Booking'}
        </Text>
      </View>
      <View className="flex-row items-center justify-between">
        <Text className="text-base font-semibold text-un1t-text flex-1" numberOfLines={1}>
          {customer}
        </Text>
        <Text className="text-base font-mono text-un1t-text ml-2">
          {formatBookingTime(booking.start_time)}
        </Text>
      </View>
      {(booking.customer_phone || booking.customer_email) && (
        <View className="flex-row gap-3 mt-2">
          {booking.customer_phone && (
            <Pressable
              onPress={(e) => {
                e.stopPropagation?.()
                Linking.openURL(`tel:${booking.customer_phone}`)
              }}
              hitSlop={6}
              className="flex-row items-center"
            >
              <Ionicons name="call-outline" size={13} color="#94A3B8" />
              <Text className="text-[11px] text-un1t-subtle ml-1">{booking.customer_phone}</Text>
            </Pressable>
          )}
          {booking.customer_email && (
            <View className="flex-row items-center flex-1">
              <Ionicons name="mail-outline" size={13} color="#94A3B8" />
              <Text className="text-[11px] text-un1t-subtle ml-1" numberOfLines={1}>
                {booking.customer_email}
              </Text>
            </View>
          )}
        </View>
      )}
      {booking.notes && (
        <Text className="text-xs text-un1t-subtle mt-1.5 italic" numberOfLines={2}>
          {booking.notes}
        </Text>
      )}
    </Pressable>
  )
}

function DayHeader({ label, count }) {
  return (
    <View className="flex-row items-center justify-between mt-4 mb-2 px-1">
      <Text className="text-xs uppercase tracking-wider text-un1t-subtle">{label}</Text>
      <Text className="text-xs text-un1t-muted">
        {count} {count === 1 ? 'booking' : 'bookings'}
      </Text>
    </View>
  )
}

export default function Bookings() {
  const { activeLocation } = useAuth()
  const router = useRouter()
  const [bookings, setBookings] = useState([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(null)

  const today = useMemo(() => todayIso(), [])
  const tomorrow = useMemo(() => addDays(today, 1), [today])

  const load = useCallback(async () => {
    if (!activeLocation) return
    setError(null)
    const res = await listUpcomingBookings({
      locationId: activeLocation.id,
      today,
      daysAhead: 1,
    })
    if (!res.success) setError(res.error || 'Failed to load bookings')
    setBookings(res.success ? res.data : [])
  }, [activeLocation, today])

  useEffect(() => {
    setLoading(true)
    load().finally(() => setLoading(false))
  }, [load])

  // Re-fetch on tab focus so today/tomorrow's bookings reflect changes made
  // elsewhere (web calendar, or a "View as user" switch) without a manual
  // pull-to-refresh.
  useFocusEffect(useCallback(() => { load() }, [load]))

  async function onRefresh() {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }

  const byDate = useMemo(() => groupByDate(bookings), [bookings])
  const todays = byDate[today] || []
  const tomorrows = byDate[tomorrow] || []

  return (
    <TabletConstrained className="flex-1 bg-un1t-bg">
      <ScrollView
        contentContainerClassName="px-4 pt-2 pb-10"
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#111827" />
        }
      >
        {error && (
          <View className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 mt-3 mb-2">
            <Text className="text-red-500 text-sm">{error}</Text>
          </View>
        )}

        {loading ? (
          <View className="py-12 items-center">
            <ActivityIndicator />
          </View>
        ) : bookings.length === 0 ? (
          <View className="py-16 items-center px-6">
            <Ionicons name="calendar-clear-outline" size={32} color="#94A3B8" />
            <Text className="text-base font-semibold text-un1t-text mt-3">
              No bookings in the next 24 hours
            </Text>
            <Text className="text-xs text-un1t-subtle text-center mt-1">
              Pull down to refresh.
            </Text>
          </View>
        ) : (
          <>
            <DayHeader label="Today" count={todays.length} />
            {todays.length === 0 ? (
              <Text className="text-xs text-un1t-muted px-1 mb-2">Nothing else today.</Text>
            ) : (
              todays.map(b => (
                <BookingRow
                  key={b.id}
                  booking={b}
                  onPress={() => router.push(`/bookings/${b.id}`)}
                />
              ))
            )}

            <DayHeader label="Tomorrow" count={tomorrows.length} />
            {tomorrows.length === 0 ? (
              <Text className="text-xs text-un1t-muted px-1">Nothing tomorrow.</Text>
            ) : (
              tomorrows.map(b => (
                <BookingRow
                  key={b.id}
                  booking={b}
                  onPress={() => router.push(`/bookings/${b.id}`)}
                />
              ))
            )}
          </>
        )}
      </ScrollView>
    </TabletConstrained>
  )
}
