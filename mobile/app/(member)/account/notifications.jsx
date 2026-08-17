// Notification preferences — Variant B ("show, don't tell") of the approved
// mockup: each category is its own card carrying an example of the actual push
// it controls, rendered as a lock-screen banner with the CHAMP app icon, so
// members decide from evidence, not labels.
//
// Two independent switches families:
//   - Master "Allow push notifications" — the existing device-level toggle
//     (OS permission + push-opt-out flag + token register/unregister), moved
//     here verbatim from (tabs)/account.jsx. Device-scoped, not a server pref.
//   - Per-category switches — contacts.push_prefs via GET/PUT
//     /api/notification-prefs. Keys are the shared channel ids
//     ('reminders' | 'social' | 'progress'); absent = enabled. Both servers'
//     sendCustomerPush drops recipients whose pref for a payload's category
//     is false, so these hold across devices and platforms.
//
// Toggles are optimistic with revert-on-error, matching app patterns.

import { useEffect, useState } from 'react'
import { View, Text, Pressable, ScrollView, Switch } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { api } from '../../../lib/member/api'
import { getPushPermission, registerForPushNotifications, unregisterCurrentDevicePush } from '../../../lib/member/push-register'
import { isPushOptedOut, setPushOptOut } from '../../../lib/member/push-opt-out'
import Card from '../../../components/member/ui/Card'
import { PEARL } from '../../../lib/member/brand'

// Per-category copy + the example banner each card renders. Categories are
// product labels tied to the shared channel ids — fixed by design, like the
// channel names themselves.
const CATEGORIES = [
  {
    key: 'reminders',
    label: 'Class reminders',
    icon: 'time-outline',
    desc: "Never miss a session you've booked.",
    example: {
      title: 'Class in 2 hours',
      time: '4:30pm',
      body: 'UN1T Strength · 6:30pm tonight at Stillorgan. See you on the floor.',
    },
  },
  {
    key: 'social',
    label: 'Social',
    icon: 'people-outline',
    desc: 'Friend requests and reactions from your gym friends.',
    example: {
      title: 'New friend request',
      time: '1h ago',
      body: 'Sarah K. wants to add you as a gym friend.',
    },
  },
  {
    key: 'progress',
    label: 'Progress',
    icon: 'trending-up-outline',
    desc: 'Session reports, achievements, goals, streaks & challenges.',
    example: {
      title: 'Session report ready',
      time: '8:02pm',
      body: 'You earned 42 effort points tonight — your best Thursday this month.',
    },
  },
]

const SWITCH_COLORS = {
  trackColor: { false: '#24242A', true: '#F1EEE7' },
}
const thumb = (on) => (on ? '#131316' : '#727170')

// Lock-screen-style example banner with the CHAMP app icon.
function PushPreview({ title, time, body }) {
  return (
    <View>
      <Text className="mx-5 mb-1.5 font-mono text-[9px] uppercase tracking-[1.5px] text-chalk-3">
        Example
      </Text>
      <View
        className="mx-5 mb-4 flex-row items-start gap-2.5 rounded-[14px] bg-iron-raised px-3 py-2.5"
        style={{ borderWidth: 1, borderColor: '#2A2A31' }}
      >
        <View className="h-[30px] w-[30px] items-center justify-center rounded-[7px] border border-iron-hairline bg-black">
          <Text className="text-[11px] font-display-black text-chalk">
            U<Text style={{ color: PEARL }}>N</Text>
          </Text>
        </View>
        <View className="flex-1 min-w-0">
          <View className="flex-row items-center justify-between gap-2">
            <Text className="text-xs font-body-semibold text-chalk">{title}</Text>
            <Text className="font-mono text-[10px] text-chalk-3">{time}</Text>
          </View>
          <Text className="mt-0.5 text-[11.5px] leading-4 font-body text-chalk-2">{body}</Text>
        </View>
      </View>
    </View>
  )
}

export default function Notifications() {
  const router = useRouter()

  // ── Master device toggle (moved from (tabs)/account.jsx, logic unchanged) ──
  const [pushEnabled, setPushEnabled] = useState(false)

  useEffect(() => {
    // Effective state = OS permission granted AND not opted out. A member who
    // turned push OFF keeps OS permission granted, so honour the persisted flag.
    Promise.all([getPushPermission(), isPushOptedOut()])
      .then(([status, optedOut]) => setPushEnabled(status === 'granted' && !optedOut))
      .catch(() => {})
  }, [])

  async function handlePushToggle(value) {
    setPushEnabled(value)
    if (value) {
      // Clear the opt-out so launch registration resumes, then register now.
      await setPushOptOut(false)
      await registerForPushNotifications().catch(() => {})
      // Re-read the real permission in case the user declined the prompt.
      getPushPermission().then(status => setPushEnabled(status === 'granted')).catch(() => {})
    } else {
      // Persist the opt-out so (tabs)/_layout.jsx does NOT re-subscribe on the
      // next launch, then remove the current device's token server-side.
      await setPushOptOut(true)
      await unregisterCurrentDevicePush()
    }
  }

  // ── Per-category server prefs ───────────────────────────────────────────────
  const [prefs, setPrefs] = useState({ reminders: true, social: true, progress: true })
  const [prefsError, setPrefsError] = useState(null)

  useEffect(() => {
    api('/api/notification-prefs')
      .then((res) => { if (res?.ok && res.prefs) setPrefs(res.prefs) })
      .catch(() => {})
  }, [])

  async function togglePref(key, value) {
    setPrefsError(null)
    const previous = prefs
    setPrefs({ ...prefs, [key]: value }) // optimistic
    const res = await api('/api/notification-prefs', { method: 'PUT', body: { [key]: value } })
    if (!res?.ok) {
      setPrefs(previous) // revert
      setPrefsError(res?.error || "Couldn't save that. Try again.")
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <SafeAreaView className="flex-1 bg-iron-bg" edges={['left', 'right']}>
      <ScrollView contentContainerClassName="p-5 pb-24">

        {/* Back */}
        <Pressable
          onPress={() => router.back()}
          className="flex-row items-center gap-1 mb-4 self-start active:opacity-60"
        >
          <Ionicons name="chevron-back-outline" size={18} color="#B3B2AC" />
          <Text className="text-sm font-body text-chalk-2">Account</Text>
        </Pressable>

        {/* Header */}
        <Text className="text-2xl font-display-bold text-chalk">Notifications</Text>
        <Text className="mt-1 text-sm font-body text-chalk-2">
          Here's exactly what each one looks like
        </Text>

        {/* Error banner (optimistic toggle reverted) */}
        {prefsError ? (
          <View className="mt-4 rounded-xl border border-iron-hairline bg-iron-surface p-3">
            <Text className="text-sm font-body" style={{ color: '#FF4E42' }}>{prefsError}</Text>
          </View>
        ) : null}

        {/* Master strip */}
        <Card className="mt-5 p-0 overflow-hidden">
          <View className="flex-row items-center gap-3 px-5 py-3.5">
            <Text className="flex-1 text-sm font-body-medium text-chalk">
              Allow push notifications
            </Text>
            <Switch
              value={pushEnabled}
              onValueChange={handlePushToggle}
              trackColor={SWITCH_COLORS.trackColor}
              thumbColor={thumb(pushEnabled)}
            />
          </View>
        </Card>

        {/* Category cards — head, description, example banner */}
        {CATEGORIES.map(({ key, label, icon, desc, example }) => (
          <Card key={key} className="mt-3.5 p-0 overflow-hidden">
            <View className="flex-row items-center gap-3 px-5 pt-[18px] pb-1.5">
              <Ionicons name={icon} size={18} color="#B3B2AC" />
              <Text className="flex-1 text-sm font-body-semibold text-chalk">{label}</Text>
              <Switch
                value={prefs[key]}
                onValueChange={(v) => togglePref(key, v)}
                trackColor={SWITCH_COLORS.trackColor}
                thumbColor={thumb(prefs[key])}
              />
            </View>
            <Text className="ml-[30px] px-5 pb-3 text-xs leading-[18px] font-body text-chalk-2">
              {desc}
            </Text>
            <PushPreview {...example} />
          </Card>
        ))}
      </ScrollView>
    </SafeAreaView>
  )
}
