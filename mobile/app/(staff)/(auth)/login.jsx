// Login screen. iOS-style large-title header, soft inputs, primary action.
// MAGIC-LINK.1 — passwordless-first: request an emailed login code, then verify
// it (mirrors champ-app/mobile; no deep-link / native release). Password
// sign-in is retained as break-glass. Studio-device pairing is unchanged.
//   - The code is EMAIL_OTP_LENGTH digits, from mobile/lib/otp.js — it mirrors
//     the Supabase project's "Email OTP Length" setting, which is NOT the
//     supabase default of 6. Never re-hard-code a digit count here.
//   - On success, AuthProvider's onAuthStateChange picks up the session and the
//     root index redirects to (tabs).
//   - Errors are shown inline; never raw Supabase error codes.

import { useState } from 'react'
import { useRouter } from 'expo-router'
import { savePairing } from '../../../lib/studio-device'
import { useStudioPin } from '../../../lib/studio-pin'
import {
  View, Text, TextInput, Pressable, KeyboardAvoidingView,
  Platform, ActivityIndicator,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useAuth } from '../../../lib/auth-context'
import { EMAIL_OTP_LENGTH, OTP_PLACEHOLDER, normalizeOtpInput, isCompleteOtp } from '../../../lib/otp'

export default function Login() {
  const { signIn, requestCode, verifyCode } = useAuth()
  const router = useRouter()
  const { refreshPairing } = useStudioPin()
  const [mode, setMode] = useState('code') // 'code' | 'password' | 'pair'
  const [codeStep, setCodeStep] = useState('email') // 'email' | 'code'

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [otp, setOtp] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  const [pairToken, setPairToken] = useState('')
  const [pairLabel, setPairLabel] = useState('')
  const [pairError, setPairError] = useState(null)

  function switchMode(next) {
    setMode(next); setError(null); setCodeStep('email')
  }

  async function handleRequestCode() {
    setError(null); setSubmitting(true)
    const result = await requestCode(email.trim())
    setSubmitting(false)
    if (!result.success) {
      const m = result.error || ''
      if (/rate|too many/i.test(m)) setError('Too many requests. Wait a minute and try again.')
      else if (/signups? not allowed|not found|otp_disabled/i.test(m)) setError('No account found for that email.')
      else setError('Could not send the code. Try again, or use a password.')
      return
    }
    setOtp(''); setCodeStep('code')
  }

  async function handleVerifyCode() {
    setError(null); setSubmitting(true)
    const result = await verifyCode(email.trim(), otp)
    setSubmitting(false)
    if (!result.success) {
      setError("That code didn't work — check it and try again.")
      return
    }
    router.replace('/(tabs)')
  }

  async function handleSignIn() {
    setError(null); setSubmitting(true)
    const result = await signIn(email.trim(), password)
    setSubmitting(false)
    if (!result.success) {
      const msg = /invalid login credentials/i.test(result.error || '')
        ? 'Email or password is incorrect.'
        : (result.error || 'Sign in failed. Try again.')
      setError(msg)
      return
    }
    router.replace('/(tabs)')
  }

  async function handlePair() {
    setPairError(null)
    const t = pairToken.trim()
    if (t.length < 16) {
      setPairError("That token doesn't look right — paste the full token from /admin/studio-devices.")
      return
    }
    try {
      await savePairing({ token: t, label: pairLabel.trim() })
      await refreshPairing()
    } catch {
      setPairError('Could not save the pairing token. Try again.')
    }
  }

  const emailRow = (
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
  )

  return (
    <SafeAreaView className="flex-1 bg-un1t-bg">
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} className="flex-1">
        <View className="flex-1 px-6 justify-center">
          <Text className="text-3xl font-bold text-un1t-text mb-1">Repset</Text>
          <Text className="text-base text-un1t-subtle mb-10">Sign in to continue</Text>

          {error ? (
            <View className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 mb-4">
              <Text className="text-red-500 text-sm">{error}</Text>
            </View>
          ) : null}

          {/* ── Magic code (default) ───────────────────────────────── */}
          {mode === 'code' && codeStep === 'email' && (
            <>
              <View className="bg-un1t-surface rounded-2xl border border-un1t-border overflow-hidden mb-4">{emailRow}</View>
              <Pressable
                onPress={handleRequestCode}
                disabled={submitting || !email}
                className={`rounded-2xl py-4 items-center ${submitting || !email ? 'bg-un1t-border' : 'bg-un1t-text'}`}
              >
                {submitting ? <ActivityIndicator color="#FFFFFF" /> : <Text className="text-un1t-bg font-semibold text-base">Email me a login code</Text>}
              </Pressable>
              <Pressable onPress={() => switchMode('password')} className="py-3 items-center mt-2 active:opacity-70">
                <Text className="text-sm text-un1t-subtle underline">Sign in with a password instead</Text>
              </Pressable>
            </>
          )}

          {mode === 'code' && codeStep === 'code' && (
            <>
              <Text className="text-sm text-un1t-subtle mb-4">Enter the {EMAIL_OTP_LENGTH}-digit code we emailed to {email}.</Text>
              <View className="bg-un1t-surface rounded-2xl border border-un1t-border overflow-hidden mb-4">
                <View className="px-4 py-3">
                  <Text className="text-xs text-un1t-subtle mb-1">Login code</Text>
                  <TextInput
                    value={otp}
                    onChangeText={(v) => setOtp(normalizeOtpInput(v))}
                    placeholder={OTP_PLACEHOLDER}
                    placeholderTextColor="#94A3B8"
                    keyboardType="number-pad"
                    autoComplete="one-time-code"
                    textContentType="oneTimeCode"
                    maxLength={EMAIL_OTP_LENGTH}
                    className="text-base text-un1t-text tracking-[8px]"
                  />
                </View>
              </View>
              <Pressable
                onPress={handleVerifyCode}
                disabled={submitting || !isCompleteOtp(otp)}
                className={`rounded-2xl py-4 items-center ${submitting || !isCompleteOtp(otp) ? 'bg-un1t-border' : 'bg-un1t-text'}`}
              >
                {submitting ? <ActivityIndicator color="#FFFFFF" /> : <Text className="text-un1t-bg font-semibold text-base">Verify &amp; sign in</Text>}
              </Pressable>
              <View className="flex-row justify-between mt-3">
                <Pressable onPress={() => { setCodeStep('email'); setError(null) }} className="py-2 active:opacity-70">
                  <Text className="text-sm text-un1t-subtle">Change email</Text>
                </Pressable>
                <Pressable onPress={handleRequestCode} disabled={submitting} className="py-2 active:opacity-70">
                  <Text className="text-sm text-un1t-subtle">Resend code</Text>
                </Pressable>
              </View>
            </>
          )}

          {/* ── Password break-glass ───────────────────────────────── */}
          {mode === 'password' && (
            <>
              <View className="bg-un1t-surface rounded-2xl border border-un1t-border overflow-hidden mb-4">
                {emailRow}
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
                className={`rounded-2xl py-4 items-center ${submitting || !email || !password ? 'bg-un1t-border' : 'bg-un1t-text'}`}
              >
                {submitting ? <ActivityIndicator color="#FFFFFF" /> : <Text className="text-un1t-bg font-semibold text-base">Sign in</Text>}
              </Pressable>
              <Pressable onPress={() => switchMode('code')} className="py-3 items-center mt-2 active:opacity-70">
                <Text className="text-sm text-un1t-subtle underline">Use a login code instead</Text>
              </Pressable>
              <Text className="text-xs text-un1t-subtle text-center mt-3">
                Forgot your password? Use the web app at{'\n'}crm.repset.ie to reset it.
              </Text>
            </>
          )}

          {/* ── Studio-device pairing ──────────────────────────────── */}
          {mode === 'pair' && (
            <View>
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
              <Pressable onPress={() => switchMode('code')} className="py-3 items-center mt-1 active:opacity-70">
                <Text className="text-sm text-un1t-subtle">Back to sign in</Text>
              </Pressable>
            </View>
          )}

          {/* Studio-device entry point (hidden while pairing) */}
          {mode !== 'pair' && (
            <Pressable onPress={() => switchMode('pair')} className="py-3 items-center mt-4 active:opacity-70">
              <Text className="text-sm text-un1t-subtle underline">Set up as studio device</Text>
            </Pressable>
          )}
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}
