// Bottom-tab layout. Tabs are conditionally rendered based on
// permissions.mobile.<feature>. Home and More are always present; the
// rest follow the user's flag matrix from /api/mobile/me.
//
// Auth gate: if there's no session we kick back to (auth)/login. The
// AuthProvider's onAuthStateChange handles the inverse (login → tabs).
//
// We register for push notifications on first mount once the profile
// has loaded — this is the moment iOS shows the system permission
// prompt. The token is sent to /api/mobile/device-tokens and stored in
// the device_tokens table.

import { Tabs, Redirect } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { View } from 'react-native'
import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../../lib/auth-context'
import { canMobile } from '../../lib/permissions'
import { registerForPushNotifications } from '../../lib/push-register'
import { resolveLayoutForUser } from '../../lib/mobile-layout'
import { getNeedsActionCount } from '../../lib/whatsapp-api'
import ImpersonateBanner from '../../components/ImpersonateBanner'
import PendingContractsBanner from '../../components/PendingContractsBanner'

export default function TabsLayout() {
  const { session, profile, activeLocation, loading } = useAuth()
  const pushRegistered = useRef(false)
  // INBOX-EMAIL-M.1 — Messages tab badge. Same endpoint as the web
  // sidebar badge (SIDEBAR-BADGES.2): conversations needing a human
  // (needs-reply or agent handoff) across WhatsApp + Instagram + Email
  // at the active location. 60s poll, mirroring the web's cadence;
  // failures leave the last-known count rather than flashing it away.
  const [needsActionCount, setNeedsActionCount] = useState(0)

  useEffect(() => {
    if (
      profile &&
      canMobile(profile, 'push_notifications', activeLocation) &&
      !pushRegistered.current
    ) {
      pushRegistered.current = true
      registerForPushNotifications().catch(() => {
        // Best-effort — never block the UI on push registration.
      })
    }
  }, [profile, activeLocation])

  useEffect(() => {
    if (!profile || !activeLocation) return
    // Only poll when the Messages surface is reachable for this user.
    const { bar: barKeys, more: moreKeys } = resolveLayoutForUser(profile, activeLocation)
    if (!barKeys.includes('whatsapp') && !moreKeys.includes('whatsapp')) {
      setNeedsActionCount(0)
      return
    }
    let cancelled = false
    async function poll() {
      const res = await getNeedsActionCount(activeLocation.id)
      if (!cancelled && res?.success) setNeedsActionCount(res.data?.count || 0)
    }
    poll()
    const t = setInterval(poll, 60000)
    return () => { cancelled = true; clearInterval(t) }
  }, [profile, activeLocation])

  if (loading) return null
  if (!session) return <Redirect href="/(auth)/login" />

  // Sensible defaults for users whose admin hasn't enabled anything yet:
  // Home + More remain visible so they can see their info and sign out.
  // Location gate (mig 032) honoured via resolveLayoutForUser → canMobile.
  const { bar, more } = resolveLayoutForUser(profile, activeLocation)
  const barSet = new Set(bar)
  const moreEligible = new Set(more)

  // Render config for every bar-capable (tabs) route.
  const TAB_META = {
    schedule: { title: 'Schedule', icon: 'calendar-outline' },
    // Route stays /whatsapp (and gates on the whatsapp permission key)
    // but the screen is the unified WhatsApp + Instagram inbox (M2/M3).
    whatsapp: { title: 'Messages', icon: 'chatbubbles-outline' },
    studio:   { title: 'Studio',   icon: 'business-outline' },
    pipeline: { title: 'Pipeline', icon: 'trending-up-outline' },
    bookings: { title: 'Bookings', icon: 'calendar-clear-outline' },
    invoices: { title: 'Invoices', icon: 'receipt-outline' },
    expenses: { title: 'Expenses', icon: 'wallet-outline' },
  }
  const FEATURE_KEYS = ['schedule', 'whatsapp', 'studio', 'pipeline', 'bookings', 'invoices', 'expenses']
  const hiddenKeys = FEATURE_KEYS.filter(k => !barSet.has(k))

  function featureHref(key) {
    if (barSet.has(key) || moreEligible.has(key)) return `/(tabs)/${key}`
    return null // not enabled → not navigable
  }

  return (
    // Wrap the navigator so the impersonation banner can pin above
    // the system header on every tab. ImpersonateBanner returns null
    // when not active, so this wrapper is a no-op for the common case.
    <View style={{ flex: 1 }}>
      <ImpersonateBanner />
      {/* Contracts banner: stacks below the impersonation banner
          when both are active. Auto-renders only when there's a
          pending contract for the signed-in user. */}
      <PendingContractsBanner />
      <Tabs
        screenOptions={{
          headerShown: true,
          headerTitleStyle: { fontWeight: '600' },
          tabBarActiveTintColor: '#111827',
          tabBarInactiveTintColor: '#94A3B8',
          tabBarStyle: { borderTopColor: '#E2E5E9', backgroundColor: '#FFFFFF' },
        }}
      >
        <Tabs.Screen
          name="index"
          options={{
            title: 'Home',
            tabBarIcon: ({ color, size }) => (<Ionicons name="home-outline" size={size} color={color} />),
          }}
        />
        {bar.map(key => (
          <Tabs.Screen
            key={key}
            name={key}
            options={{
              title: TAB_META[key].title,
              href: `/(tabs)/${key}`,
              // Needs-action count (SIDEBAR-BADGES.2 semantics) on the
              // Messages tab; display caps at 99+ like the web badge.
              ...(key === 'whatsapp' && needsActionCount > 0
                ? {
                    tabBarBadge: needsActionCount > 99 ? '99+' : needsActionCount,
                    tabBarBadgeStyle: { backgroundColor: '#16A34A', color: '#FFFFFF', fontSize: 11 },
                  }
                : {}),
              tabBarIcon: ({ color, size }) => (<Ionicons name={TAB_META[key].icon} size={size} color={color} />),
            }}
          />
        ))}
        <Tabs.Screen
          name="more"
          options={{
            title: 'More',
            tabBarIcon: ({ color, size }) => (<Ionicons name="ellipsis-horizontal" size={size} color={color} />),
          }}
        />
        {hiddenKeys.map(key => (
          <Tabs.Screen
            key={key}
            name={key}
            options={{
              title: TAB_META[key].title,
              href: featureHref(key),
              tabBarItemStyle: { display: 'none' },
              tabBarIcon: ({ color, size }) => (<Ionicons name={TAB_META[key].icon} size={size} color={color} />),
            }}
          />
        ))}
      </Tabs>
    </View>
  )
}
