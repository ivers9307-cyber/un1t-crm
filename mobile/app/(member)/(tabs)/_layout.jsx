import { Tabs, Redirect } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useEffect, useRef, useState } from 'react'
import { AppState } from 'react-native'
import { useAuth } from '../../../lib/member/contact-context'
import { api } from '../../../lib/member/api'
import { registerForPushNotifications, getPushPermission } from '../../../lib/member/push-register'
import { isPushOptedOut } from '../../../lib/member/push-opt-out'
import { shouldRegisterPush, isGenuinePushSuccess } from 'shared/push-registration'
import IdentitySwitcher from '../../../components/IdentitySwitcher'

// How often to refresh the Social pending-request badge while the app is
// foregrounded. Cheap aggregate call; 60 s keeps it roughly live without
// hammering the API. Also refreshes on foreground + when the contact links.
const BADGE_REFRESH_MS = 60_000

export default function TabsLayout() {
  const { session, contact, loading } = useAuth()
  const pushRegistered = useRef(false)
  const [pendingRequests, setPendingRequests] = useState(0)

  useEffect(() => {
    // Gate on the linked contact (contact?.id), not raw session.
    // For an app-first member the contact isn't linked until loadContact()
    // POSTs /api/mobile/link-contact. If we fire before that we get a 404
    // ('no-contact') and the token is silently dropped.
    if (!session || !contact?.id || pushRegistered.current) return

    let cancelled = false
    ;(async () => {
      // Respect a persisted opt-out: a member who turned push OFF must NOT be
      // silently re-subscribed on the next launch (OS permission is still
      // granted, so registration would otherwise succeed).
      const [optedOut, permission] = await Promise.all([
        isPushOptedOut().catch(() => false),
        getPushPermission().catch(() => 'undetermined'),
      ])
      if (cancelled) return
      if (!shouldRegisterPush({ optedOut, permission, lastResult: null })) return

      let result
      try { result = await registerForPushNotifications() } catch { return }
      if (cancelled) return
      // Latch ONLY on a genuine success (token obtained + server POST ok) so a
      // permission_denied skip or a failed POST is retried on the next launch.
      if (isGenuinePushSuccess(result)) pushRegistered.current = true
    })()

    return () => { cancelled = true }
  }, [session, contact])

  // Social tab badge — count of incoming friend requests. Best-effort: any
  // failure (or Social disabled at the gym) just leaves the badge hidden.
  useEffect(() => {
    if (!session || !contact?.id) { setPendingRequests(0); return }
    let cancelled = false

    async function refresh() {
      const r = await api('/api/social/requests').catch(() => null)
      if (cancelled) return
      if (r?.ok && !r.disabled) setPendingRequests((r.incoming || []).length)
      else setPendingRequests(0)
    }

    refresh()
    const interval = setInterval(refresh, BADGE_REFRESH_MS)
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active') refresh() })
    return () => { cancelled = true; clearInterval(interval); sub.remove() }
  }, [session, contact])

  if (loading) return null
  // Stage C: the resolver (app/index.jsx) owns entry, so this gate only
  // fires when the session dies WHILE a member route is active (idle
  // sign-out, dead refresh token). The staff login is the merged app's
  // single auth entry — champ's (auth) group is deliberately not ported.
  if (!session) return <Redirect href="/(staff)/(auth)/login" />
  return (
    <Tabs
      screenOptions={{
        // Afterglow chrome (spec §2.5): iron canvas, chalk text, mono tab
        // labels. The accent tick above the active tab needs a custom
        // tabBarButton — deliberately deferred to P3; colour retune only here.
        // Badge = attention (Redline), not the dead ember accent.
        headerStyle: { backgroundColor: '#131316' },
        headerTitleStyle: { color: '#F1EEE7', fontFamily: 'ArchivoExpanded-Bold' },
        headerShadowVisible: false,
        tabBarActiveTintColor: '#F1EEE7',
        tabBarInactiveTintColor: '#727170',
        tabBarStyle: { backgroundColor: '#131316', borderTopColor: '#2A2A31' },
        tabBarLabelStyle: { fontFamily: 'IBMPlexMono_500Medium', fontSize: 9, letterSpacing: 1, textTransform: 'uppercase' },
        tabBarBadgeStyle: { backgroundColor: '#FF4E42', color: '#F1EEE7' },
      }}
    >
      {/* ── The 5 tabs ── */}
      {/* PHASE2: champ's (tabs)/index.jsx is (member)/(tabs)/home.jsx in the
          merged app — the staff (tabs)/index keeps '/'; member home is '/home'.
          Stage C: the member-side identity switcher lives in the home header —
          renders ONLY for dual (staff+member) users, never on kiosk /
          impersonating sessions (guards inside the component). */}
      <Tabs.Screen
        name="home"
        options={{
          title: 'Home',
          tabBarIcon: ({ color, size }) => <Ionicons name="home-outline" size={size} color={color} />,
          headerRight: () => <IdentitySwitcher side="member" />,
        }}
      />
      <Tabs.Screen name="activity" options={{ title: 'Activity', tabBarIcon: ({ color, size }) => <Ionicons name="pulse-outline" size={size} color={color} /> }} />
      <Tabs.Screen name="compete" options={{ title: 'Compete', tabBarIcon: ({ color, size }) => <Ionicons name="trophy-outline" size={size} color={color} /> }} />
      <Tabs.Screen
        name="social"
        options={{
          title: 'Social',
          tabBarIcon: ({ color, size }) => <Ionicons name="people-outline" size={size} color={color} />,
          tabBarBadge: pendingRequests > 0 ? pendingRequests : undefined,
        }}
      />
      <Tabs.Screen name="account" options={{ title: 'You', tabBarIcon: ({ color, size }) => <Ionicons name="person-outline" size={size} color={color} /> }} />

      {/* ── Legacy routes kept registered but HIDDEN from the tab bar (href:null).
          They stay navigable so home's "See all" affordances and any push
          deep-links (session_report → /sessions/[id] is a Stack route; these two
          are the former standalone tabs) keep resolving. ── */}
      <Tabs.Screen name="sessions" options={{ href: null }} />
      <Tabs.Screen name="progress" options={{ href: null }} />
    </Tabs>
  )
}
