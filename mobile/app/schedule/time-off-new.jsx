// Modal: Request time off.
//
// iOS-feeling form: large title, grouped settings rows, native date
// pickers via @react-native-community/datetimepicker. We avoid that
// dependency for now and use plain date inputs (text + +/- buttons)
// for parity with what's bundled in expo-router. This stays
// dependency-light and works in Expo Go without prebuild.
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
import { Ionicons } from '@expo/vector-icons'
import { useHeaderHeight } from '@react-navigation/elements'
import { useAuth } from '../../lib/auth-context'
import { createTimeOffRequest } from '../../lib/schedule-api'
import { isoDate, addDays } from '../../lib/dates'

const TYPES = [
  { value: 'holiday', label: 'Holiday' },
  { value: 'sick',    label: 'Sick' },
  { value: 'unpaid',  label: 'Unpaid' },
  { value: 'other',   label: 'Other' },
]

function dateMath(iso, days) {
  return isoDate(addDays(new Date(iso + 'T00:00:00'), days))
}

export default function TimeOffNew() {
  const { activeLocation } = useAuth()
  const router = useRouter()
  const headerHeight = useHeaderHeight()
  const today = isoDate(new Date())
  const [type, setType] = useState('holiday')
  const [start, setStart] = useState(today)
  const [end, setEnd] = useState(today)
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function submit() {
    if (start > end) {
      Alert.alert('Invalid dates', 'End date must be on or after start date.')
      return
    }
    setSubmitting(true)
    const res = await createTimeOffRequest({
      type,
      startDate: start,
      endDate: end,
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
        {/* Type segmented control */}
        <Text className="text-xs uppercase tracking-wider text-un1t-subtle px-2 mb-2">Type</Text>
        <View className="flex-row bg-un1t-surface border border-un1t-border rounded-xl p-1 mb-5">
          {TYPES.map(t => (
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

        {/* Date pickers — text + step buttons. Keeps the modal Expo-Go-
            friendly without pulling in a native picker dependency. */}
        <Text className="text-xs uppercase tracking-wider text-un1t-subtle px-2 mb-2">Dates</Text>
        <View className="bg-un1t-surface border border-un1t-border rounded-xl mb-5">
          <DateRow label="From" value={start} onChange={v => {
            setStart(v)
            if (end < v) setEnd(v)
          }} isLast={false} />
          <DateRow label="To" value={end} onChange={setEnd} min={start} isLast />
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

function DateRow({ label, value, onChange, min, isLast }) {
  function step(days) {
    const next = dateMath(value, days)
    if (min && next < min) return
    onChange(next)
  }
  // Pretty label, e.g. "Mon 5 May 2026"
  const pretty = new Date(value + 'T00:00:00').toLocaleDateString(undefined, {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
  })
  return (
    <View className={`flex-row items-center px-4 py-3 ${!isLast ? 'border-b border-un1t-border' : ''}`}>
      <Text className="text-base text-un1t-text w-12">{label}</Text>
      <Text className="flex-1 text-base text-un1t-subtle">{pretty}</Text>
      <Pressable onPress={() => step(-1)} hitSlop={8} className="px-2">
        <Ionicons name="remove-circle-outline" size={22} color="#111827" />
      </Pressable>
      <Pressable onPress={() => step(1)} hitSlop={8} className="px-2">
        <Ionicons name="add-circle-outline" size={22} color="#111827" />
      </Pressable>
    </View>
  )
}
