// Full-screen lock overlay. Absolute-fill on top of the app (which stays
// mounted underneath). `checking` shows a neutral cover while the stored pref
// is read (no flash of app content). Sign out is the escape hatch so a failed
// biometric never permanently locks someone out.
import { View, Text, Pressable, ActivityIndicator, StyleSheet } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useAuth } from '../lib/auth-context'

export default function LockScreen({ typeLabel, checking, onUnlock }) {
  const { signOut } = useAuth()
  return (
    <View style={StyleSheet.absoluteFill} className="bg-un1t-bg items-center justify-center px-8">
      <Text className="text-3xl font-bold text-un1t-text mb-2">Repset</Text>
      {checking ? (
        <ActivityIndicator className="mt-6" />
      ) : (
        <>
          <Text className="text-sm text-un1t-subtle mb-8 text-center">
            Locked. Unlock with {typeLabel} to continue.
          </Text>
          <Pressable onPress={onUnlock}
            className="flex-row items-center justify-center bg-un1t-text rounded-2xl px-6 py-3.5 active:opacity-80">
            <Ionicons name="lock-open-outline" size={18} color="#FFFFFF" />
            <Text className="text-base font-semibold text-un1t-bg ml-2">Unlock with {typeLabel}</Text>
          </Pressable>
          <Pressable onPress={signOut} className="mt-4 py-2 active:opacity-70">
            <Text className="text-sm text-un1t-subtle">Sign out</Text>
          </Pressable>
        </>
      )}
    </View>
  )
}
