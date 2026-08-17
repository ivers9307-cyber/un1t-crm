// PHASE2 (one-app merge) — the member (Graft) tree's layout. Pins the
// member look — iron canvas (Afterglow tokens), portrait, light status
// bar — and registers the screens that need non-default presentation,
// verbatim from champ's root Stack (minus champ's (auth) group: the
// resolver is the only way in; the staff login is the merged app's single
// auth entry).
//
// Stage C wiring (design point 8): the member AuthProvider
// (lib/member/contact-context — contact loading + the policy-gated
// link-contact fallback) mounts HERE, so it only ever runs while a member
// route is active; the gates (ProfileSetupGate, MonthWrappedGate) and the
// Apple-Health background sync mount inside it. AppleHealthBackgroundSync
// is additionally gated on !paired — a shared studio kiosk must never
// sync anyone's HealthKit data. Member push presentation/tap-routing is
// NOT here: the merged root handler owns both (app/_layout.jsx).

import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { Platform } from 'react-native'
import { AuthProvider as MemberContactProvider } from '../../lib/member/contact-context'
import { AppleHealthBackgroundSync } from '../../lib/member/apple-health-background'
import { useIdentity } from '../../lib/identity-context'
import ProfileSetupGate from '../../components/member/ProfileSetupGate'
import MonthWrappedGate from '../../components/member/MonthWrappedGate'

// Iron canvas — mobile/tailwind.config.js 'iron-bg'. Pinned as the stack's
// contentStyle so every member screen sits on the Graft graphite ground
// (never the staff white) even before its own styled view renders.
const IRON_BG = '#131316'

export default function MemberLayout() {
  const { paired } = useIdentity()
  return (
    <MemberContactProvider>
      {/* Member chrome is light-on-dark; mounts only while a member route is
          active, so the staff tree keeps its dark-on-light status bar. */}
      <StatusBar style="light" />
      <ProfileSetupGate />
      <MonthWrappedGate />
      {Platform.OS === 'ios' && !paired && <AppleHealthBackgroundSync />}
      <Stack
        screenOptions={{
          headerShown: false,
          orientation: 'portrait',
          contentStyle: { backgroundColor: IRON_BG },
        }}
      >
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="sessions/[id]" options={{ headerShown: false }} />
        <Stack.Screen
          name="sessions/[id]/wrapped"
          options={{ presentation: 'fullScreenModal', headerShown: false, gestureEnabled: false, animation: 'fade' }}
        />
        <Stack.Screen
          name="wrapped/month"
          options={{ presentation: 'fullScreenModal', headerShown: false, gestureEnabled: false, animation: 'fade' }}
        />
        <Stack.Screen
          name="wrapped/challenge/[id]"
          options={{ presentation: 'fullScreenModal', headerShown: false, gestureEnabled: false, animation: 'fade' }}
        />
        <Stack.Screen name="coaching" options={{ headerShown: false }} />
        <Stack.Screen name="kudos" options={{ headerShown: false }} />
        <Stack.Screen
          name="live"
          options={{ presentation: 'fullScreenModal', headerShown: false, animation: 'fade' }}
        />
        <Stack.Screen
          name="profile-setup"
          options={{ presentation: 'fullScreenModal', headerShown: false, gestureEnabled: false }}
        />
      </Stack>
    </MemberContactProvider>
  )
}
