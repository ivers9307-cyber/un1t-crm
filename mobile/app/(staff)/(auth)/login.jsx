// Login screen. iOS-style large-title header, soft inputs, primary action.
// MAGIC-LINK.1 — passwordless-first: request an emailed login code, then verify
// it (mirrors champ-app/mobile; no deep-link / native release). Password
// sign-in is retained as break-glass. Studio-device pairing is unchanged.
//   - The code is EMAIL_OTP_LENGTH digits, from mobile/lib/otp.js — it mirrors
//     the Supabase project's "Email OTP Length" setting, which is NOT the
//     supabase default of 6. Never re-hard-code a digit count here.
//   - On success we replace to "/" so app/index.jsx — THE identity resolver —
//     decides which shell owns the launch. It used to jump straight to
//     /(tabs); that predates the merge and hard-codes the staff answer, which
//     is wrong for any member-only session (the reviewer's included).
//   - Errors are shown inline; never raw Supabase error codes.
//
// REPSET-PUB.3A — App Store reviewer gate. Typing the demo email
// (lib/review-login.js) swaps the emailed-OTP step for a gate-code step; the
// code is exchanged server-side for a real one-time token. Champ's trigger,
// copied: the email IS the trigger, there is no hidden gesture, and Apple
// receives that email in the App Store Connect demo-account fields. The gate
// code lives ONLY in the server's environment and is 404 while unset.

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
import { normalizeGateCode, isCompleteGateCode } from '../../../lib/review-login'

export default function Login() {
  const { signIn, requestCode, verifyCode } = useAuth()
  const router = useRouter()
  const { refreshPairing } = useStudioPin()
  const [mode, setMode] = useState('code') // 'code' | 'password' | 'pair'
  const [codeStep, setCodeStep] = useState('email') // 'email' | 'code'
  // REPSET-PUB.3A — set by requestCode when the typed email is the reviewer
  // demo account; swaps the OTP field for the gate-code field below.
  const [reviewMode, setReviewMode] = useState(false)

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [otp, setOtp] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  const [pairToken, setPairToken] = useState('')
  const [pairLabel, setPairLabel] = useState('')
  const [pairError, setPairError] = useState(null)

  function switchMode(next) {
    setMode(next); setError(null); setCodeStep('email'); setReviewMode(false)
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
    // `review` is set only for the App Store demo account — no email was sent
    // and the next step takes the gate code instead.
    setReviewMode(Boolean(result.review))
    setOtp(''); setCodeStep('code')
  }

  // Both code paths submit through verifyCode; auth-context branches on the
  // email and exchanges a gate code for a real one-time token when it is the
  // reviewer account. The button gate differs because the two values do:
  // an emailed OTP is exactly EMAIL_OTP_LENGTH digits, a gate code is free
  // text of unknown length.
  const codeReady = reviewMode ? isCompleteGateCode(otp) : isCompleteOtp(otp)

  async function handleVerifyCode() {
    setError(null); setSubmitting(true)
    const result = await verifyCode(email.trim(), otp)
    setSubmitting(false)
    if (!result.success) {
      setError("That code didn't work — check it and try again.")
      return
    }
    // "/" hands the launch to the identity resolver (app/index.jsx), which
    // routes staff to the staff tabs and a member-only session — the App
    // Review demo account is one — to the member home.
    router.replace('/')
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
    router.replace('/')
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
              <Text className="text-sm text-un1t-subtle mb-4">
                {reviewMode
                  ? 'Enter the access code supplied with this review submission.'
                  : `Enter the ${EMAIL_OTP_LENGTH}-digit code we emailed to ${email}.`}
              </Text>
              <View className="bg-un1t-surface rounded-2xl border border-un1t-border overflow-hidden mb-4">
                <View className="px-4 py-3">
                  <Text className="text-xs text-un1t-subtle mb-1">{reviewMode ? 'Access code' : 'Login code'}</Text>
                  {/* REPSET-PUB.3A — the gate code is FREE TEXT, deliberately
                      not the digits-only OTP input. Routing it through
                      normalizeOtpInput (as champ does) would strip every
                      non-digit and leave the submit button dead on an
                      alphanumeric code — at submission time, with a code
                      nobody had typed before. */}
                  {reviewMode ? (
                    <TextInput
                      value={otp}
                      onChangeText={(v) => setOtp(normalizeGateCode(v))}
                      placeholder="Access code"
                      placeholderTextColor="#94A3B8"
                      autoCapitalize="none"
                      autoCorrect={false}
                      autoComplete="off"
                      className="text-base text-un1t-text"
                    />
                  ) : (
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
                  )}
                </View>
              </View>
              <Pressable
                onPress={handleVerifyCode}
                disabled={submitting || !codeReady}
                className={`rounded-2xl py-4 items-center ${submitting || !codeReady ? 'bg-un1t-border' : 'bg-un1t-text'}`}
              >
                {submitting ? <ActivityIndicator color="#FFFFFF" /> : <Text className="text-un1t-bg font-semibold text-base">Verify &amp; sign in</Text>}
              </Pressable>
              <View className="flex-row justify-between mt-3">
                <Pressable onPress={() => { setCodeStep('email'); setReviewMode(false); setError(null) }} className="py-2 active:opacity-70">
                  <Text className="text-sm text-un1t-subtle">Change email</Text>
                </Pressable>
                {/* Nothing was emailed in review mode — a "Resend code" that
                    resends nothing is worse than no button at all. */}
                {!reviewMode && (
                  <Pressable onPress={handleRequestCode} disabled={submitting} className="py-2 active:opacity-70">
                    <Text className="text-sm text-un1t-subtle">Resend code</Text>
                  </Pressable>
                )}
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
