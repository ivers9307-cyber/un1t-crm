// PHASE2 stage C — the "confirmed neither" landing. A signed-in session
// with NO staff profile and NO linked contact reaches this (real users
// can get here via a contact merge/delete after their auth user was
// created). Friendly dead-end: explain, offer sign-out. Deliberately no
// self-service linking — staff linking is admin-only, and the member
// link-contact fallback only fires from the member probe path.

import { Text, TouchableOpacity, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { StatusBar } from 'expo-status-bar'
import { Ionicons } from '@expo/vector-icons'
import { useRouter } from 'expo-router'
import { useAuth } from '../lib/auth-context'

export default function AccountNotSetUp() {
  const { signOut } = useAuth()
  const router = useRouter()

  async function handleSignOut() {
    try { await signOut() } catch { /* the auth flip below still happens */ }
    router.replace('/(staff)/(auth)/login')
  }

  return (
    <SafeAreaView className="flex-1 bg-iron-bg">
      <StatusBar style="light" />
      <View className="flex-1 items-center justify-center px-8">
        <View className="w-16 h-16 rounded-full bg-iron-surface border border-iron-hairline items-center justify-center mb-6">
          <Ionicons name="person-outline" size={28} color="#B3B2AC" />
        </View>
        <Text className="text-chalk text-xl font-display-bold text-center mb-3">
          Your account isn’t set up yet
        </Text>
        <Text className="text-chalk-2 text-base font-body text-center mb-10 leading-6">
          You’re signed in, but this account isn’t connected to a profile
          yet. Contact the studio and they’ll get you sorted.
        </Text>
        <TouchableOpacity
          accessibilityRole="button"
          onPress={handleSignOut}
          className="bg-iron-surface border border-iron-hairline rounded-xl px-8 py-3"
        >
          <Text className="text-chalk text-base font-body-semibold">Sign out</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  )
}
