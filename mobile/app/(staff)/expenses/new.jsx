// FTE-EXPENSES.2 (mobile) — create a new draft expense claim.
//
// Modal screen presented from the Expenses tab's FAB. Picks a month
// + location, creates the draft via POST /api/expenses, then
// routes straight to /expenses/[id] so the operator can start
// adding line items.
//
// Mirrors mobile/app/invoices/new.jsx but doesn't take an amount /
// PDF here — the claim is just a header; receipts are added inside
// the detail screen.

import { useState, useMemo } from 'react'
import {
  View, Text, TextInput, Pressable, ScrollView,
  ActivityIndicator, KeyboardAvoidingView, Platform,
} from 'react-native'
import { useRouter } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useAuth } from '../../../lib/auth-context'
import {
  createExpenseClaim, recentMonthOptions, defaultMonthKey,
} from '../../../lib/expenses-api'

export default function NewExpenseClaimScreen() {
  const router = useRouter()
  const { activeLocation, profile } = useAuth()

  const months = useMemo(() => recentMonthOptions(new Date(), 6), [])
  const [monthKey, setMonthKey] = useState(defaultMonthKey())
  const [locationId, setLocationId] = useState(
    activeLocation?.id || profile?.locations?.[0]?.id || ''
  )
  const [notes, setNotes] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  const availableLocations = profile?.locations || (activeLocation ? [activeLocation] : [])

  async function submit() {
    if (!locationId) { setError('Pick a location.'); return }
    setSubmitting(true); setError(null)
    const r = await createExpenseClaim({
      monthKey,
      locationId,
      notes: notes.trim() || null,
    })
    setSubmitting(false)
    if (r.success === false) {
      setError(r.error || 'Could not create claim')
      return
    }
    // Replace so back-button from detail goes to the tab, not back
    // to the new-claim modal.
    router.replace(`/expenses/${r.data.id}`)
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} className="flex-1 bg-un1t-bg">
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 48 }}>
        <Text className="text-2xl font-bold text-un1t-text mb-1">New expense claim</Text>
        <Text className="text-sm text-un1t-subtle mb-5">
          One claim per month per location. Add receipts as you capture them, then submit at month-end.
        </Text>

        <View className="bg-un1t-surface border border-un1t-border rounded-2xl p-4 mb-3">
          <Text className="text-[11px] uppercase tracking-wider text-un1t-subtle mb-2">Month</Text>
          <View className="flex-row flex-wrap gap-2">
            {months.map((m) => (
              <Pressable
                key={m.key}
                onPress={() => setMonthKey(m.key)}
                className={`px-3 py-2 rounded-full border ${monthKey === m.key ? 'bg-un1t-text border-un1t-text' : 'bg-un1t-bg border-un1t-border'}`}
              >
                <Text className={`text-xs font-medium ${monthKey === m.key ? 'text-un1t-bg' : 'text-un1t-subtle'}`}>
                  {m.label}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>

        {availableLocations.length > 1 && (
          <View className="bg-un1t-surface border border-un1t-border rounded-2xl p-4 mb-3">
            <Text className="text-[11px] uppercase tracking-wider text-un1t-subtle mb-2">Location</Text>
            <View className="flex-row flex-wrap gap-2">
              {availableLocations.map((l) => (
                <Pressable
                  key={l.id}
                  onPress={() => setLocationId(l.id)}
                  className={`px-3 py-2 rounded-full border ${locationId === l.id ? 'bg-un1t-text border-un1t-text' : 'bg-un1t-bg border-un1t-border'}`}
                >
                  <Text className={`text-xs font-medium ${locationId === l.id ? 'text-un1t-bg' : 'text-un1t-subtle'}`}>
                    {l.name}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>
        )}

        <View className="bg-un1t-surface border border-un1t-border rounded-2xl p-4 mb-3">
          <Text className="text-[11px] uppercase tracking-wider text-un1t-subtle mb-2">Notes (optional)</Text>
          <TextInput
            value={notes}
            onChangeText={setNotes}
            placeholder="e.g. Berlin trip + office supplies for studio reset"
            placeholderTextColor="#94A3B8"
            multiline
            numberOfLines={3}
            maxLength={2000}
            className="text-sm text-un1t-text"
          />
        </View>

        {error && (
          <View className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 mb-3">
            <Text className="text-sm text-red-700">{error}</Text>
          </View>
        )}

        <Pressable
          onPress={submit}
          disabled={submitting || !locationId}
          className={`rounded-full py-3.5 items-center ${submitting || !locationId ? 'bg-un1t-border' : 'bg-blue-600 active:opacity-80'}`}
        >
          {submitting ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <View className="flex-row items-center gap-2">
              <Ionicons name="add-circle" size={18} color="#FFFFFF" />
              <Text className="text-white font-semibold">Create draft</Text>
            </View>
          )}
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}
