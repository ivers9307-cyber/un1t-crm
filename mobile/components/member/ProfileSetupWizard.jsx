// First-login profile-setup wizard (native).
//
// Multi-step: Welcome → About you (REQUIRED) → Connect health (optional) → Done.
// The About-you step POSTs to un1t-crm's /api/me/body-metrics; that save is what
// marks profile_setup_completed_at server-side, so once it succeeds the gate
// (built elsewhere) clears. Steps after it (Connect / Done) are non-blocking —
// onDone / onDismiss simply tear down the overlay.
//
// Props: { contact, onDone, onDismiss }
//   onDone     — setup finished (call after About-you saved, or from Connect/Done).
//   onDismiss  — user skipped before completing the required step.
//
// Connect cards NAVIGATE to the existing connect screens (Apple Health / devices /
// integrations) — we never re-implement that logic here.

import { useState } from 'react'
import {
  View, Text, Pressable, ScrollView, TextInput, ActivityIndicator, Platform,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { validateAboutYou, normalizeWeightKg } from 'shared/profile-setup'
import { crmApi } from '../../lib/member/api'
import { PEARL } from '../../lib/member/brand' // Afterglow resting accent (chrome, not zone data)

const GENDERS = [
  { key: 'female', label: 'Female' },
  { key: 'male', label: 'Male' },
  { key: 'other', label: 'Other' },
]
const STEPS = ['welcome', 'about', 'connect', 'done']

// Split a stored 'YYYY-MM-DD' dob into the three composed inputs (best-effort).
function splitDob(dob) {
  if (typeof dob === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dob)) {
    const [y, m, d] = dob.split('-')
    return { dd: d, mm: m, yyyy: y }
  }
  return { dd: '', mm: '', yyyy: '' }
}

// Assemble the three composed inputs back into a 'YYYY-MM-DD' string.
function assembleDob({ dd, mm, yyyy }) {
  const d = String(dd).padStart(2, '0')
  const m = String(mm).padStart(2, '0')
  const y = String(yyyy)
  return `${y}-${m}-${d}`
}

function ProgressDots({ step }) {
  const idx = STEPS.indexOf(step)
  return (
    <View className="flex-row items-center gap-2">
      {STEPS.map((s, i) => (
        <View
          key={s}
          className={`h-1.5 rounded-full ${i === idx ? 'w-6 bg-chalk' : 'w-1.5 bg-iron-raised'}`}
        />
      ))}
    </View>
  )
}

export default function ProfileSetupWizard({ contact, onDone, onDismiss }) {
  const router = useRouter()

  const [step, setStep] = useState('welcome')

  // Form fields pre-filled from contact. Legacy 'P'/null gender → unselected.
  const initialDob = splitDob(contact?.dob)
  const [dd, setDd] = useState(initialDob.dd)
  const [mm, setMm] = useState(initialDob.mm)
  const [yyyy, setYyyy] = useState(initialDob.yyyy)
  const [gender, setGender] = useState(
    ['female', 'male', 'other'].includes(contact?.gender) ? contact.gender : null,
  )
  const [weightInput, setWeightInput] = useState(
    contact?.weight_kg != null ? String(Math.round(Number(contact.weight_kg) * 10) / 10) : '',
  )

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function saveAboutYou() {
    setError(null)
    const payload = {
      dob: assembleDob({ dd, mm, yyyy }),
      gender,
      weight_kg: normalizeWeightKg(weightInput),
    }
    const v = validateAboutYou(payload)
    if (!v.ok) { setError(v.error); return }
    setBusy(true)
    const res = await crmApi('/api/me/body-metrics', { method: 'POST', body: payload })
    setBusy(false)
    if (!res?.success) { setError(res?.error || 'Could not save your details'); return }
    setStep('connect')
  }

  return (
    <SafeAreaView className="flex-1 bg-iron-bg" edges={['top', 'left', 'right', 'bottom']}>
      <ScrollView
        contentContainerClassName="grow p-6 pb-10"
        keyboardShouldPersistTaps="handled"
      >
        {/* ─────────────────────────── WELCOME ─────────────────────────── */}
        {step === 'welcome' && (
          <View className="grow justify-between">
            <View className="mt-10">
              <View className="h-14 w-14 rounded-2xl items-center justify-center" style={{ backgroundColor: PEARL }}>
                <Ionicons name="flame" size={28} color="#131316" />
              </View>
              <Text className="mt-8 text-3xl font-display-bold leading-9 text-chalk">
                Let's set up{'\n'}your profile
              </Text>
              <Text className="mt-4 text-base font-body leading-6 text-chalk-2">
                A few quick details let us score your effort, place you in the right heart-rate
                zones, and show your calories after every class.
              </Text>
            </View>

            <View className="mt-10">
              <View className="mb-6 items-center">
                <ProgressDots step={step} />
              </View>
              <Pressable
                onPress={() => { setError(null); setStep('about') }}
                className="flex-row items-center justify-center gap-2 rounded-xl bg-chalk px-4 py-4 active:opacity-80"
              >
                <Text className="text-base font-body-semibold text-iron-bg">Get started</Text>
                <Ionicons name="arrow-forward" size={16} color="#131316" />
              </Pressable>
              <Pressable onPress={onDismiss} className="mt-3 items-center py-2 active:opacity-60">
                <Text className="text-sm font-body-medium text-chalk-3">Skip for now</Text>
              </Pressable>
            </View>
          </View>
        )}

        {/* ─────────────────────────── ABOUT YOU ─────────────────────────── */}
        {step === 'about' && (
          <View className="grow">
            <View className="mb-6 items-center">
              <ProgressDots step={step} />
            </View>

            <Text className="text-2xl font-display-bold text-chalk">About you</Text>
            <Text className="mt-1.5 text-sm font-body leading-5 text-chalk-2">
              We use these to calculate your heart-rate zones and calorie burn accurately.
            </Text>

            {/* Date of birth — composed DD / MM / YYYY */}
            <Text className="mt-7 font-mono text-[10px] uppercase text-chalk-3" style={{ letterSpacing: 2 }}>
              Date of birth
            </Text>
            <View className="mt-2 flex-row gap-3">
              <View className="flex-1">
                <TextInput
                  value={dd}
                  onChangeText={(t) => setDd(t.replace(/\D/g, '').slice(0, 2))}
                  placeholder="DD"
                  placeholderTextColor="#727170"
                  keyboardType="number-pad"
                  maxLength={2}
                  className="rounded-xl border border-iron-hairline bg-iron-surface px-3 py-3 text-center text-base font-mono text-chalk"
                />
              </View>
              <View className="flex-1">
                <TextInput
                  value={mm}
                  onChangeText={(t) => setMm(t.replace(/\D/g, '').slice(0, 2))}
                  placeholder="MM"
                  placeholderTextColor="#727170"
                  keyboardType="number-pad"
                  maxLength={2}
                  className="rounded-xl border border-iron-hairline bg-iron-surface px-3 py-3 text-center text-base font-mono text-chalk"
                />
              </View>
              <View className="flex-[1.4]">
                <TextInput
                  value={yyyy}
                  onChangeText={(t) => setYyyy(t.replace(/\D/g, '').slice(0, 4))}
                  placeholder="YYYY"
                  placeholderTextColor="#727170"
                  keyboardType="number-pad"
                  maxLength={4}
                  className="rounded-xl border border-iron-hairline bg-iron-surface px-3 py-3 text-center text-base font-mono text-chalk"
                />
              </View>
            </View>

            {/* Gender pills */}
            <Text className="mt-6 font-mono text-[10px] uppercase text-chalk-3" style={{ letterSpacing: 2 }}>
              Gender
            </Text>
            <View className="mt-2 flex-row gap-3">
              {GENDERS.map((g) => {
                const selected = gender === g.key
                return (
                  <Pressable
                    key={g.key}
                    onPress={() => setGender(g.key)}
                    className={`flex-1 items-center rounded-xl border px-3 py-3 active:opacity-80 ${
                      selected ? 'border-chalk bg-chalk' : 'border-iron-hairline bg-iron-surface'
                    }`}
                  >
                    <Text className={`text-sm font-body-medium ${selected ? 'text-iron-bg' : 'text-chalk-2'}`}>
                      {g.label}
                    </Text>
                  </Pressable>
                )
              })}
            </View>

            {/* Weight */}
            <Text className="mt-6 font-mono text-[10px] uppercase text-chalk-3" style={{ letterSpacing: 2 }}>
              Weight
            </Text>
            <View className="mt-2 flex-row items-center rounded-xl border border-iron-hairline bg-iron-surface px-3">
              <TextInput
                value={weightInput}
                onChangeText={(t) => setWeightInput(t.replace(/[^0-9.]/g, ''))}
                placeholder="70"
                placeholderTextColor="#727170"
                keyboardType="decimal-pad"
                className="flex-1 py-3 text-base font-mono text-chalk"
              />
              <Text className="font-mono text-[10px] uppercase text-chalk-3" style={{ letterSpacing: 1 }}>kg</Text>
            </View>
            <Text className="mt-2 text-xs font-body leading-4 text-chalk-3">
              We'll keep weight updated automatically once you connect a health app.
            </Text>

            {error ? (
              <View className="mt-5 rounded-xl border p-3" style={{ borderColor: '#FF4E424D', backgroundColor: '#FF4E421A' }}>
                <Text className="text-sm font-body" style={{ color: '#FF4E42' }}>{error}</Text>
              </View>
            ) : null}

            <View className="mt-8">
              <Pressable
                onPress={saveAboutYou}
                disabled={busy}
                className="flex-row items-center justify-center gap-2 rounded-xl bg-chalk px-4 py-4 active:opacity-80 disabled:opacity-50"
              >
                {busy ? <ActivityIndicator size="small" color="#131316" /> : null}
                <Text className="text-base font-body-semibold text-iron-bg">
                  {busy ? 'Saving…' : 'Continue'}
                </Text>
                {!busy ? <Ionicons name="arrow-forward" size={16} color="#131316" /> : null}
              </Pressable>
              <Pressable
                onPress={onDismiss}
                disabled={busy}
                className="mt-3 items-center py-2 active:opacity-60 disabled:opacity-50"
              >
                <Text className="text-sm font-body-medium text-chalk-3">Skip for now</Text>
              </Pressable>
            </View>
          </View>
        )}

        {/* ─────────────────────────── CONNECT ─────────────────────────── */}
        {step === 'connect' && (
          <View className="grow">
            <View className="mb-6 items-center">
              <ProgressDots step={step} />
            </View>

            <Text className="text-2xl font-display-bold text-chalk">Connect your health data</Text>
            <Text className="mt-1.5 text-sm font-body leading-5 text-chalk-2">
              Optional — link a wearable so your workouts and heart rate flow into UN1T automatically.
              You can always do this later from your account.
            </Text>

            <View className="mt-6 gap-3">
              {Platform.OS === 'ios' ? (
                <ConnectCard
                  icon="heart"
                  iconColor="#F87171"
                  title="Apple Health"
                  subtitle="Sync Apple Watch workouts & heart rate"
                  onPress={() => router.push('/account/connect-apple-health')}
                />
              ) : null}
              <ConnectCard
                icon="watch-outline"
                iconColor="#60A5FA"
                title="Garmin / heart-rate strap"
                subtitle="Auto-sync your strap or watch at the studio"
                onPress={() => router.push('/account/devices')}
              />
              <ConnectCard
                icon="bicycle-outline"
                iconColor="#FB923C"
                title="Strava"
                subtitle="Bring in your runs and rides"
                onPress={() => router.push('/account/integrations')}
              />
              <ConnectCard
                icon="fitness-outline"
                iconColor="#B3B2AC"
                title="Whoop"
                subtitle="Coming soon"
                disabled
              />
            </View>

            <View className="mt-8">
              <Pressable
                onPress={() => setStep('done')}
                className="flex-row items-center justify-center gap-2 rounded-xl bg-chalk px-4 py-4 active:opacity-80"
              >
                <Text className="text-base font-body-semibold text-iron-bg">Continue</Text>
                <Ionicons name="arrow-forward" size={16} color="#131316" />
              </Pressable>
              <Pressable onPress={onDone} className="mt-3 items-center py-2 active:opacity-60">
                <Text className="text-sm font-body-medium text-chalk-3">Skip for now</Text>
              </Pressable>
            </View>
          </View>
        )}

        {/* ─────────────────────────── DONE ─────────────────────────── */}
        {step === 'done' && (
          <View className="grow justify-between">
            <View className="mt-16 items-center">
              <View className="h-16 w-16 rounded-full items-center justify-center" style={{ backgroundColor: PEARL }}>
                <Ionicons name="checkmark" size={34} color="#131316" />
              </View>
              <Text className="mt-6 text-2xl font-display-bold text-center text-chalk">You're all set</Text>
              <Text className="mt-3 text-base font-body leading-6 text-center text-chalk-2 px-2">
                Your calories will show after every class, and your effort counts towards gym challenges.
              </Text>
            </View>

            <View className="mt-10">
              <Pressable
                onPress={onDone}
                className="flex-row items-center justify-center gap-2 rounded-xl bg-chalk px-4 py-4 active:opacity-80"
              >
                <Text className="text-base font-body-semibold text-iron-bg">Finish</Text>
              </Pressable>
            </View>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  )
}

function ConnectCard({ icon, iconColor, title, subtitle, onPress, disabled }) {
  const body = (
    <View
      className={`flex-row items-center gap-3 rounded-[20px] border border-iron-hairline bg-iron-surface p-4 ${
        disabled ? 'opacity-50' : 'active:bg-iron-raised'
      }`}
    >
      <View className="h-10 w-10 rounded-full bg-iron-raised items-center justify-center shrink-0">
        <Ionicons name={icon} size={20} color={iconColor} />
      </View>
      <View className="flex-1 min-w-0">
        <Text className="text-base font-body-semibold text-chalk">{title}</Text>
        <Text className="mt-0.5 text-xs font-body text-chalk-2" numberOfLines={1}>{subtitle}</Text>
      </View>
      {!disabled ? <Ionicons name="chevron-forward" size={18} color="#727170" /> : null}
    </View>
  )
  if (disabled) return body
  return <Pressable onPress={onPress}>{body}</Pressable>
}
