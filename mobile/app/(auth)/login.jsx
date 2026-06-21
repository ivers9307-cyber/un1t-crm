// Login screen. iOS-style large-title header, soft inputs with rounded
// rows, primary action button. Mirrors the web /login page's logic:
//   - Email + password against Supabase
//   - On success, AuthProvider's onAuthStateChange picks up the session
//     and the root index redirects to (tabs).
//   - Errors are shown inline; we never show raw Supabase error codes
//     since they're not user-friendly.

import { useState } from 'react'
import { useRouter } from 'expo-router'
import { savePairing } from '../../lib/studio-device'
import { useStudioPin } from '../../lib/studio-pin'
import {
  View, Text, TextInput, Pressable, KeyboardAvoidingView,
  Platform, ActivityIndicator,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useAuth } from '../../lib/auth-context'

export default function Login() {
  const { signIn } = useAuth()
  const router = useRouter()
  const { refreshPairing } = useStudioPin()
  const [mode, setMode] = useState('login') // 'login' | 'pair'
  const [pairToken, setPairToken] = useState('')
  const [pairLabel, setPairLabel] = useState('')
  const [pairError, setPairError] = useState(null)

  async function handlePair() {
    setPairError(null)
    const t = pairToken.trim()
    if (t.length < 16) {
      setPairError("That token doesn't look right — paste the full token from /admin/studio-devices.")
      return
    }
    try {
      await savePairing({ token: t, label: pairLabel.trim() })
      // Becoming paired makes StudioPinProvider show the PIN pad overlay.
      await refreshPairing()
    } catch {
      setPairError('Could not save the pairing token. Try again.')
    }
  }

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
    <SafeAreaView className="flex-1 bg-un1t-bg">
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        className="flex-1"
      >
        <View className="flex-1 px-6 justify-center">
          {/* Large title — iOS-native feeling */}
          <Text className="text-3xl font-bold text-un1t-text mb-1">CF Studio</Text>
          <Text className="text-base text-un1t-subtle mb-10">Sign in to continue</Text>

          {error ? (
            <View className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 mb-4">
              <Text className="text-red-500 text-sm">{error}</Text>
            </View>
          ) : null}

          <View className="bg-un1t-surface rounded-2xl border border-un1t-border overflow-hidden mb-4">
            <View className="px-4 py-3 border-b border-un1t-border">
              <Text className="text-xs text-un1t-subtle mb-1">Email</Text>
              <TextInput
                value={email}
                onChangeText={setEmail}
                placeholder="you@un1t.ie"
                placeholderTextColor="#94A3B8"
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
                textContentType="username"
                className="text-base text-un1t-text"
              />
            </View>
            <View className="px-4 py-3">
              <Text className="text-xs text-un1t-subtle mb-1">Password</Text>
              <TextInput
                value={password}
                onChangeText={setPassword}
                placeholder="••••••••"
                placeholderTextColor="#94A3B8"
                secureTextEntry
                textContentType="password"
                className="text-base text-un1t-text"
              />
            </View>
          </View>

          <Pressable
            onPress={handleSignIn}
            disabled={submitting || !email || !password}
            className={`rounded-2xl py-4 items-center ${
              submitting || !email || !password ? 'bg-un1t-border' : 'bg-un1t-text'
            }`}
          >
            {submitting ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text className="text-un1t-bg font-semibold text-base">Sign in</Text>
            )}
          </Pressable>

          {mode === 'pair' ? (
            <View className="mt-6">
              {pairError ? (
                <View className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 mb-3">
                  <Text className="text-red-500 text-sm">{pairError}</Text>
                </View>
              ) : null}
              <View className="bg-un1t-surface rounded-2xl border border-un1t-border overflow-hidden mb-3">
                <View className="px-4 py-3 border-b border-un1t-border">
                  <Text className="text-xs text-un1t-subtle mb-1">Pairing token</Text>
                  <TextInput
                    value={pairToken}
                    onChangeText={setPairToken}
                    placeholder="Paste the token from /admin/studio-devices"
                    placeholderTextColor="#94A3B8"
                    autoCapitalize="none"
                    autoCorrect={false}
                    className="text-base text-un1t-text"
                  />
                </View>
                <View className="px-4 py-3">
                  <Text className="text-xs text-un1t-subtle mb-1">Device label (optional)</Text>
                  <TextInput
                    value={pairLabel}
                    onChangeText={setPairLabel}
                    placeholder="e.g. Reception iPad"
                    placeholderTextColor="#94A3B8"
                    className="text-base text-un1t-text"
                  />
                </View>
              </View>
              <Pressable
                onPress={handlePair}
                disabled={!pairToken}
                className={`rounded-2xl py-4 items-center ${!pairToken ? 'bg-un1t-border' : 'bg-un1t-text'}`}
              >
                <Text className="text-un1t-bg font-semibold text-base">Pair this device</Text>
              </Pressable>
              <Pressable onPress={() => setMode('login')} className="py-3 items-center mt-1 active:opacity-70">
                <Text className="text-sm text-un1t-subtle">Back to sign in</Text>
              </Pressable>
            </View>
          ) : (
            <>
              <Text className="text-xs text-un1t-subtle text-center mt-6">
                Forgot your password? Use the web app at{'\n'}crm.un1tdublin.com to reset it.
              </Text>
              <Pressable onPress={() => setMode('pair')} className="py-3 items-center mt-4 active:opacity-70">
                <Text className="text-sm text-un1t-subtle underline">Set up as studio device</Text>
              </Pressable>
            </>
          )}
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}
