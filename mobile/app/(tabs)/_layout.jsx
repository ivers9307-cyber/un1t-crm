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
import { useEffect, useRef } from 'react'
import { useAuth } from '../../lib/auth-context'
import { canMobile } from '../../lib/permissions'
import { registerForPushNotifications } from '../../lib/push-register'

export default function TabsLayout() {
  const { session, profile, activeLocation, loading } = useAuth()
  const pushRegistered = useRef(false)

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

  if (loading) return null
  if (!session) return <Redirect href="/(auth)/login" />

  // Sensible defaults for users whose admin hasn't enabled anything yet:
  // Home + More remain visible so they can see their info and sign out.
  // Location gate (mig 032) honoured via canMobile's third arg.
  const showSchedule = canMobile(profile, 'schedule', activeLocation)
  const showPipeline = canMobile(profile, 'pipeline', activeLocation)
  const showWhatsapp = canMobile(profile, 'whatsapp', activeLocation)
  // Invoices tab: contractor employment_type only. Owners/masters
  // approve from the web; on mobile the tab would just be noise for
  // them. (mig 101)
  const showInvoices = profile?.employment_type === 'contractor'

  return (
    <Tabs
      screenOptions={{
        headerShown: true,
        headerTitleStyle: { fontWeight: '600' },
        tabBarActiveTintColor: '#111827',
        tabBarInactiveTintColor: '#94A3B8',
        tabBarStyle: {
          borderTopColor: '#E2E5E9',
          backgroundColor: '#FFFFFF',
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="home-outline" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="schedule"
        options={{
          title: 'Schedule',
          // expo-router's `href: null` removes the tab from the tab bar
          // and disables direct navigation to the route. We use this
          // instead of conditional <Tabs.Screen> rendering because the
          // expo-router file-based tree must always declare every route.
          href: showSchedule ? '/(tabs)/schedule' : null,
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="calendar-outline" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="pipeline"
        options={{
          title: 'Pipeline',
          href: showPipeline ? '/(tabs)/pipeline' : null,
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="trending-up-outline" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="whatsapp"
        options={{
          title: 'WhatsApp',
          href: showWhatsapp ? '/(tabs)/whatsapp' : null,
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="chatbubble-outline" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="invoices"
        options={{
          title: 'Invoices',
          href: showInvoices ? '/(tabs)/invoices' : null,
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="receipt-outline" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="more"
        options={{
          title: 'More',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="ellipsis-horizontal" size={size} color={color} />
          ),
        }}
      />
    </Tabs>
  )
}
