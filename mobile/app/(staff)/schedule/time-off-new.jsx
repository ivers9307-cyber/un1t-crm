// Modal: Request time off.
//
// iOS-feeling form: large title, grouped settings rows. The type menu is
// gated by employment type (shared/time-off catalogue); dates are picked
// with a pure-JS tappable month calendar (components/MonthCalendar) — no
// native picker dependency, so the whole screen ships over-the-air.
//
// On submit, we hit POST /api/schedule/time-off and the server fans
// out a push notification to managers/owners at the location (see
// src/app/api/schedule/time-off/route.js).

import { useState } from 'react'
import { useRouter, Stack } from 'expo-router'
import {
  View, Text, Pressable, ScrollView, TextInput, ActivityIndicator,
  Alert, KeyboardAvoidingView, Platform,
} from 'react-native'
import { useHeaderHeight } from 'expo-router/react-navigation'
import { useAuth } from '../../../lib/auth-context'
import { createTimeOffRequest } from '../../../lib/schedule-api'
import { isoDate } from '../../../lib/dates'
import { timeOffTypesFor, defaultTimeOffTypeFor } from 'shared/time-off'
import MonthCalendar from '../../../components/MonthCalendar'

export default function TimeOffNew() {
  const { activeLocation, profile } = useAuth()
  const router = useRouter()
  const headerHeight = useHeaderHeight()
  const today = isoDate(new Date())
  // Type menu is gated by employment type — contractors + casual staff
  // only get "Unavailable"; everyone else gets the four leave types.
  const types = timeOffTypesFor(profile?.employment_type)
  const [type, setType] = useState(defaultTimeOffTypeFor(profile?.employment_type))
  const [start, setStart] = useState(today)
  const [end, setEnd] = useState(today)
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function submit() {
    // The calendar leaves `end` null after the first tap of a range (and for a
    // single-day pick); coalesce to start so a one-tap pick still submits and a
    // two-tap pick submits the full From–To range.
    const endDate = end || start
    if (start > endDate) {
      Alert.alert('Invalid dates', 'End date must be on or after start date.')
      return
    }
    setSubmitting(true)
    const res = await createTimeOffRequest({
      type,
      startDate: start,
      endDate,
      reason,
      locationId: activeLocation?.id,
    })
    setSubmitting(false)
    if (!res.success) {
      Alert.alert('Couldn’t submit', res.error || 'Unknown error')
      return
    }
    router.back()
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={Platform.OS === 'ios' ? headerHeight : 0}
      className="flex-1 bg-un1t-bg"
    >
      <Stack.Screen
        options={{
          title: 'Request time off',
          headerLeft: () => (
            <Pressable onPress={() => router.back()} hitSlop={10}>
              <Text className="text-base text-un1t-text">Cancel</Text>
            </Pressable>
          ),
          headerRight: () => (
            <Pressable onPress={submit} disabled={submitting} hitSlop={10}>
              {submitting ? (
                <ActivityIndicator />
              ) : (
                <Text className="text-base font-semibold text-un1t-text">Submit</Text>
              )}
            </Pressable>
          ),
        }}
      />

      <ScrollView contentContainerClassName="p-4">
        {/* Type — segmented control when several are allowed; a single
            static row when employment restricts to one (contractor/casual
            → "Unavailable"), since a one-option control is pointless. */}
        <Text className="text-xs uppercase tracking-wider text-un1t-subtle px-2 mb-2">Type</Text>
        {types.length > 1 ? (
          <View className="flex-row bg-un1t-surface border border-un1t-border rounded-xl p-1 mb-5">
            {types.map(t => (
              <Pressable
                key={t.value}
                onPress={() => setType(t.value)}
                className={`flex-1 py-2 rounded-lg ${type === t.value ? 'bg-un1t-text' : ''}`}
              >
                <Text className={`text-center text-sm ${type === t.value ? 'text-un1t-bg font-semibold' : 'text-un1t-subtle'}`}>
                  {t.label}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : (
          <View className="bg-un1t-surface border border-un1t-border rounded-xl px-4 py-3 mb-5">
            <Text className="text-base text-un1t-text">
              {types[0]?.label}
            </Text>
          </View>
        )}

        {/* Dates — tappable month calendar (range select). Pure JS so it
            ships over-the-air; jump months from the header instead of
            stepping a day at a time. */}
        <Text className="text-xs uppercase tracking-wider text-un1t-subtle px-2 mb-2">Dates</Text>
        <View className="mb-5">
          <MonthCalendar
            startDate={start}
            endDate={end}
            minDate={today}
            onChange={({ start: s, end: e }) => { setStart(s); setEnd(e) }}
          />
        </View>

        <Text className="text-xs uppercase tracking-wider text-un1t-subtle px-2 mb-2">Reason (optional)</Text>
        <View className="bg-un1t-surface border border-un1t-border rounded-xl mb-5">
          <TextInput
            value={reason}
            onChangeText={setReason}
            multiline
            numberOfLines={4}
            placeholder="A short note for your manager…"
            placeholderTextColor="#94A3B8"
            className="px-4 py-3 text-base text-un1t-text min-h-[100px]"
            textAlignVertical="top"
          />
        </View>

        <Text className="text-xs text-un1t-subtle px-2 mt-2">
          Your manager will be notified. You can cancel a pending request from the schedule view.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}
