// Login screen. iOS-style large-title header, soft inputs with rounded
// rows, primary action button. Mirrors the web /login page's logic:
//   - Email + password against Supabase
//   - On success, AuthProvider's onAuthStateChange picks up the session
//     and the root index redirects to (tabs).
//   - Errors are shown inline; we never show raw Supabase error codes
//     since they're not user-friendly.

import { useState } from 'react'
import { useRouter } from 'expo-router'
import {
  View, Text, TextInput, Pressable, KeyboardAvoidingView,
  Platform, ActivityIndicator,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useAuth } from '../../lib/auth-context'

export default function Login() {
  const { signIn } = useAuth()
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  async function handleSignIn() {
    setError(null)
    setSubmitting(true)
    const result = await signIn(email.trim(), password)
    setSubmitting(false)
    if (!result.success) {
      // Translate Supabase-isms to staff-friendly copy.
      const msg = /invalid login credentials/i.test(result.error || '')
        ? 'Email or password is incorrect.'
        : (result.error || 'Sign in failed. Try again.')
      setError(msg)
      return
    }
    router.replace('/(tabs)')
  }

  return (
    <SafeAreaView className="flex-1 bg-un1t-black">
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        className="flex-1"
      >
        <View className="flex-1 px-6 justify-center">
          {/* Large title — iOS-native feeling */}
          <Text className="text-3xl font-bold text-un1t-white mb-1">UN1T CRM</Text>
          <Text className="text-base text-un1t-light mb-10">Sign in to continue</Text>

          {error ? (
            <View className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 mb-4">
              <Text className="text-red-500 text-sm">{error}</Text>
            </View>
          ) : null}

          <View className="bg-un1t-dark rounded-2xl border border-un1t-gray overflow-hidden mb-4">
            <View className="px-4 py-3 border-b border-un1t-gray">
              <Text className="text-xs text-un1t-light mb-1">Email</Text>
              <TextInput
                value={email}
                onChangeText={setEmail}
                placeholder="you@un1t.ie"
                placeholderTextColor="#94A3B8"
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
                textContentType="username"
                className="text-base text-un1t-white"
              />
            </View>
            <View className="px-4 py-3">
              <Text className="text-xs text-un1t-light mb-1">Password</Text>
              <TextInput
                value={password}
                onChangeText={setPassword}
                placeholder="••••••••"
                placeholderTextColor="#94A3B8"
                secureTextEntry
                textContentType="password"
                className="text-base text-un1t-white"
              />
            </View>
          </View>

          <Pressable
            onPress={handleSignIn}
            disabled={submitting || !email || !password}
            className={`rounded-2xl py-4 items-center ${
              submitting || !email || !password ? 'bg-un1t-gray' : 'bg-un1t-white'
            }`}
          >
            {submitting ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text className="text-un1t-black font-semibold text-base">Sign in</Text>
            )}
          </Pressable>

          <Text className="text-xs text-un1t-light text-center mt-6">
            Forgot your password? Use the web app at{'\n'}crm.un1tdublin.com to reset it.
          </Text>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}
