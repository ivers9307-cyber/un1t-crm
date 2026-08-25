// Benefit-framed prompt nudging members to fill the profile metrics that unlock
// calorie tracking + accurate HR zones (dob, gender, weight).
//
// FULLY SELF-CONTAINED so it can drop into any slot (Home, Account, …) with a
// bare <ProfileCompletionPrompt />:
//   • reads the member from useAuth() itself
//   • loads its own 7-day snooze from SecureStore
//   • renders NOTHING (returns null) until it knows what to show — no flash
//   • routes to the EXISTING /profile-setup wizard (About-you step) — no new form
//   • dismiss is a SNOOZE, not permanent: re-appears after 7 days while fields
//     stay empty, and self-hides the instant the fields are filled.
//
// Design: chalk-on-iron Afterglow; the resting Pearl accent is a nudge, not an
// alarm (thin ring + small flame chip, not a full accent fill / red banner).

import { useState, useCallback } from 'react'
import { View, Text, Pressable } from 'react-native'
import { useFocusEffect, useRouter } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useAuth } from '../../lib/member/contact-context'
import { PEARL } from '../../lib/member/brand'
import {
  shouldShowCompletionPrompt,
  missingCalorieFields,
  calorieFieldLabel,
} from 'shared/profile-setup'
import {
  getCompletionSnoozedAtMs,
  setCompletionSnoozedNow,
} from '../../lib/member/profile-setup-dismissal'

export default function ProfileCompletionPrompt({ className = '' }) {
  const { contact } = useAuth()
  const router = useRouter()

  // null = undecided (render nothing), true/false = resolved.
  const [visible, setVisible] = useState(null)

  const resolve = useCallback(async () => {
    const snoozedAtMs = await getCompletionSnoozedAtMs()
    setVisible(shouldShowCompletionPrompt(contact, { snoozedAtMs }))
  }, [contact])

  // Re-check on focus so it self-hides right after the member completes the
  // wizard and returns to this screen.
  useFocusEffect(
    useCallback(() => {
      resolve()
    }, [resolve]),
  )

  if (!visible) return null

  const missing = missingCalorieFields(contact)
  if (missing.length === 0) return null

  const missingLabels = missing.map(calorieFieldLabel).join(' · ')

  async function snooze() {
    setVisible(false)
    await setCompletionSnoozedNow()
  }

  return (
    <View
      className={`rounded-2xl border border-iron-hairline bg-iron-surface p-4 ${className}`}
      style={{ borderColor: 'rgba(214,210,201,0.35)' }}
    >
      <View className="flex-row items-start gap-3">
        <View
          className="h-9 w-9 rounded-full items-center justify-center shrink-0"
          style={{ backgroundColor: 'rgba(214,210,201,0.14)' }}
        >
          <Ionicons name="flame" size={18} color={PEARL} />
        </View>

        <View className="flex-1 min-w-0">
          <Text className="text-base font-display text-chalk">
            Unlock calorie tracking & accurate zones
          </Text>
          <Text className="mt-1 text-sm font-body leading-5 text-chalk-2">
            Add a few details so we can show your calories after every class and
            place you in the right heart-rate zones — keeping your points fair.
          </Text>

          <Text className="mt-3 font-mono text-[10px] uppercase text-chalk-3" style={{ letterSpacing: 2 }}>
            Still needed
          </Text>
          <Text className="mt-1 text-sm font-body-medium" style={{ color: PEARL }}>
            {missingLabels}
          </Text>

          <View className="mt-4 flex-row items-center gap-3">
            <Pressable
              onPress={() => router.push('/profile-setup')}
              className="flex-row items-center gap-2 rounded-xl bg-chalk px-4 py-2.5 active:opacity-80"
            >
              <Text className="text-sm font-body-semibold text-iron-bg">Add my details</Text>
              <Ionicons name="arrow-forward" size={14} color="#131316" />
            </Pressable>
            <Pressable onPress={snooze} hitSlop={8} className="px-2 py-2 active:opacity-60">
              <Text className="text-sm font-body-medium text-chalk-3">Not now</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </View>
  )
}
