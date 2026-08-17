// PHASE2 (one-app merge, stage B) — the member (Graft) tree's layout.
// Deliberately NOT champ's root _layout ported as-is: providers and every
// auth-consuming gate are stage-C work. This layout only pins the member
// look — iron canvas (Afterglow tokens), portrait, light status bar — and
// registers the screens that need non-default presentation, verbatim from
// champ's root Stack (minus champ's (auth) group, which is not ported:
// stage C merges the auth flows and the resolver is the only way in).
//
// TODO(stage C) — wire here (or in the root layout) when the identity spine
// lands; all of it read champ's auth context so none of it can mount yet:
//   - the member AuthProvider (lib/member/contact-context.jsx)
//   - NotificationRouter for member push types — the pure route mapping is
//     already ported at lib/member/notification-nav.js
//   - Notifications.setNotificationHandler foreground-banner handler (champ
//     registered it at module scope; doing so here would globally change
//     how STAFF foreground pushes present today)
//   - AppleHealthBackgroundSync (iOS), ProfileSetupGate, MonthWrappedGate
// Fonts (Archivo Expanded / Figtree / IBM Plex Mono) load in the merged
// ROOT app/_layout.jsx — nothing to load here.

import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'

// Iron canvas — mobile/tailwind.config.js 'iron-bg'. Pinned as the stack's
// contentStyle so every member screen sits on the Graft graphite ground
// (never the staff white) even before its own styled view renders.
const IRON_BG = '#0F1216'

export default function MemberLayout() {
  return (
    <>
      {/* Member chrome is light-on-dark; mounts only while a member route is
          active, so the staff tree keeps its dark-on-light status bar. */}
      <StatusBar style="light" />
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
    </>
  )
}
