// NOTIF.2 — Booking detail screen. Read-only view of a single
// booking. Push-notification taps land here via the booking_id in
// the data payload (wired in mobile/app/_layout.jsx).
//
// Mobile is intentionally read-only — operators reschedule /
// cancel from the web Calendly hub (mig 074), where they can also
// see Calendly's underlying state.

import { useEffect, useState, useCallback } from 'react'
import {
  View, Text, ScrollView, Pressable, ActivityIndicator, Linking,
  RefreshControl,
} from 'react-native'
import { useLocalSearchParams, useRouter, Stack } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { getBooking, formatBookingTime } from '../../../lib/bookings-api'
import BackHeaderLeft from '../../../components/BackHeaderLeft'

export default function BookingDetail() {
  const { id } = useLocalSearchParams()
  const router = useRouter()
  const [booking, setBooking] = useState(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    if (!id) return
    setError(null)
    const res = await getBooking(String(id))
    if (!res.success) setError(res.error || 'Failed to load booking')
    setBooking(res.success ? res.data : null)
  }, [id])

  useEffect(() => {
    setLoading(true)
    load().finally(() => setLoading(false))
  }, [load])

  async function onRefresh() {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }

  // Booking detail is the only screen in its sub-stack, so iOS won't
  // auto-render a back chevron — we have to opt in via headerLeft.
  // The fallback handles cold-start deep-links from a notification
  // tap (no previous screen on the stack → router.back() is a noop).
  const headerOptions = {
    headerLeft: () => <BackHeaderLeft label="Bookings" fallbackHref="/(tabs)/bookings" />,
  }

  if (loading) {
    return (
      <View className="flex-1 bg-un1t-bg items-center justify-center">
        <Stack.Screen options={{ ...headerOptions, title: 'Booking' }} />
        <ActivityIndicator />
      </View>
    )
  }

  if (error || !booking) {
    return (
      <View className="flex-1 bg-un1t-bg items-center justify-center px-6">
        <Stack.Screen options={{ ...headerOptions, title: 'Booking' }} />
        <Ionicons name="alert-circle-outline" size={28} color="#DC2626" />
        <Text className="text-base text-un1t-text mt-2">{error || 'Booking not found'}</Text>
        <Pressable
          onPress={() => router.back()}
          className="mt-4 px-4 py-2 rounded-full bg-un1t-surface border border-un1t-border"
        >
          <Text className="text-sm text-un1t-text">Go back</Text>
        </Pressable>
      </View>
    )
  }

  const evt = booking.event_type
  const customer = booking.customer_name
    || (booking.contact ? `${booking.contact.first_name || ''} ${booking.contact.last_name || ''}`.trim() : '')
    || 'Guest'

  return (
    <ScrollView
      className="flex-1 bg-un1t-bg"
      contentContainerClassName="px-4 pt-4 pb-10"
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#111827" />
      }
    >
      <Stack.Screen options={{ ...headerOptions, title: evt?.name || 'Booking' }} />
      <View className="flex-row items-center mb-2">
        <View
          className="w-2.5 h-2.5 rounded-full mr-2"
          style={{ backgroundColor: evt?.color || '#94A3B8' }}
        />
        <Text className="text-sm font-medium text-un1t-subtle">
          {evt?.name || 'Booking'}
        </Text>
      </View>
      <Text className="text-2xl font-bold text-un1t-text">{customer}</Text>

      <View className="bg-un1t-surface border border-un1t-border rounded-2xl p-4 mt-4">
        <View className="flex-row items-center mb-2">
          <Ionicons name="calendar-outline" size={16} color="#94A3B8" />
          <Text className="text-sm text-un1t-text ml-2">{booking.booking_date}</Text>
        </View>
        <View className="flex-row items-center mb-2">
          <Ionicons name="time-outline" size={16} color="#94A3B8" />
          <Text className="text-sm text-un1t-text ml-2">
            {formatBookingTime(booking.start_time)} – {formatBookingTime(booking.end_time)}
          </Text>
        </View>
        <View className="flex-row items-center">
          <Ionicons name="information-circle-outline" size={16} color="#94A3B8" />
          <Text className="text-sm text-un1t-text ml-2 capitalize">{booking.status}</Text>
        </View>
      </View>

      {(booking.customer_phone || booking.customer_email) && (
        <View className="bg-un1t-surface border border-un1t-border rounded-2xl p-4 mt-3">
          <Text className="text-xs uppercase tracking-wider text-un1t-subtle mb-2">Contact</Text>
          {booking.customer_phone && (
            <Pressable
              onPress={() => Linking.openURL(`tel:${booking.customer_phone}`)}
              className="flex-row items-center py-1.5"
            >
              <Ionicons name="call-outline" size={16} color="#3B82F6" />
              <Text className="text-base text-blue-400 ml-2">{booking.customer_phone}</Text>
            </Pressable>
          )}
          {booking.customer_email && (
            <Pressable
              onPress={() => Linking.openURL(`mailto:${booking.customer_email}`)}
              className="flex-row items-center py-1.5"
            >
              <Ionicons name="mail-outline" size={16} color="#3B82F6" />
              <Text className="text-base text-blue-400 ml-2">{booking.customer_email}</Text>
            </Pressable>
          )}
        </View>
      )}

      {booking.notes && (
        <View className="bg-un1t-surface border border-un1t-border rounded-2xl p-4 mt-3">
          <Text className="text-xs uppercase tracking-wider text-un1t-subtle mb-1.5">Notes</Text>
          <Text className="text-sm text-un1t-text leading-5">{booking.notes}</Text>
        </View>
      )}

      <Text className="text-[11px] text-un1t-muted text-center mt-6">
        To reschedule or cancel, open this booking on the web.
      </Text>
    </ScrollView>
  )
}
