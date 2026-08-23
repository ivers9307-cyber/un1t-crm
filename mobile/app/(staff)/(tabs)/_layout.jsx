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
import { useAuth } from '../../../lib/auth-context'
import { canMobile, canDashboard, CROSS_PLATFORM_DASHBOARD_KEYS } from '../../../lib/permissions'
import { registerForPushNotifications } from '../../../lib/push-register'
import { resolveLayoutForUser } from '../../../lib/mobile-layout'
import { getNeedsActionCount } from '../../../lib/whatsapp-api'
import { getTicketCount } from '../../../lib/email-api'
import ImpersonateBanner from '../../../components/ImpersonateBanner'
import PendingContractsBanner from '../../../components/PendingContractsBanner'
import IdentitySwitcher from '../../../components/IdentitySwitcher'

export default function TabsLayout() {
  const { session, profile, activeLocation, loading } = useAuth()
  const pushRegistered = useRef(false)
  // Messages tab badge. Same endpoint as the web sidebar badge
  // (SIDEBAR-BADGES.2): conversations needing a human (needs-reply or agent
  // handoff) across WhatsApp + Instagram at the active location. Email left
  // this count server-side when it became a ticket system (INBOX-SPLIT.1) —
  // /api/whatsapp/unread-count reads whatsapp_conversations +
  // instagram_conversations only — so splitting email out of the Messages
  // screen (INBOX-SPLIT.M1) needed no change here: the badge already counted
  // exactly what the tab shows. 60s poll, mirroring the web's cadence;
  // failures leave the last-known count rather than flashing it away.
  //
  // The Email tab badge (EMAIL-BADGE-M.1) rides the cheap count route that
  // EMAIL-TICKET-CLEANUP.3 added for the web sidebar — tickets somebody
  // wrote to us that nobody has answered yet, at the active location,
  // counting only mailboxes this person can open. Same predicate as the
  // queue's needs_reply view, so tapping the badge shows the rows it
  // counted. Same 60s cadence and keep-last-count-on-failure posture as the
  // Messages badge above it.
  const [needsActionCount, setNeedsActionCount] = useState(0)
  const [emailNeedsReplyCount, setEmailNeedsReplyCount] = useState(0)

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

  useEffect(() => {
    if (!profile || !activeLocation) return
    // Only poll when the Email surface is reachable for this user — the
    // route itself answers 0 for an ineligible session, but not polling at
    // all is cheaper than polling to learn nothing.
    const { bar: barKeys, more: moreKeys } = resolveLayoutForUser(profile, activeLocation)
    if (!barKeys.includes('email') && !moreKeys.includes('email')) {
      setEmailNeedsReplyCount(0)
      return
    }
    let cancelled = false
    async function poll() {
      const res = await getTicketCount(activeLocation.id)
      if (!cancelled && res?.success) setEmailNeedsReplyCount(res.data?.count || 0)
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

  // HOME-LOC.7 — the old Home (segmented dashboards) is now its own tab.
  // Same gate that used to decide whether Home rendered any segments.
  const hasDashboard = CROSS_PLATFORM_DASHBOARD_KEYS
    .some((k) => canDashboard(profile, k, activeLocation))

  // Render config for every bar-capable (tabs) route.
  const TAB_META = {
    schedule: { title: 'Schedule', icon: 'calendar-outline' },
    // Route stays /whatsapp (and gates on the whatsapp permission key)
    // but the screen is the unified WhatsApp + Instagram inbox (M2/M3).
    whatsapp: { title: 'Messages', icon: 'chatbubbles-outline' },
    // INBOX-SPLIT.M1 — email is its own surface, not a channel inside
    // Messages, matching web (sidebar entry "Email", Mail icon). Gated on
    // `email_inbox` via shared/mobile-nav → resolveLayoutForUser.
    email:    { title: 'Email',    icon: 'mail-outline' },
    studio:   { title: 'Studio',   icon: 'business-outline' },
    pipeline: { title: 'Pipeline', icon: 'trending-up-outline' },
    bookings: { title: 'Bookings', icon: 'calendar-clear-outline' },
    invoices: { title: 'Invoices', icon: 'receipt-outline' },
    expenses: { title: 'Expenses', icon: 'wallet-outline' },
  }
  const FEATURE_KEYS = ['schedule', 'whatsapp', 'email', 'studio', 'pipeline', 'bookings', 'invoices', 'expenses']
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
          // Stage C — the staff-side identity switcher (volt-dot avatar) on
          // every staff tab header. Renders ONLY for dual (staff+member)
          // users; kiosk-paired and impersonating sessions render nothing
          // (guards inside the component), so pre-merge staff see no change.
          headerRight: () => <IdentitySwitcher side="staff" />,
        }}
      >
        <Tabs.Screen
          name="index"
          options={{
            title: 'Home',
            tabBarIcon: ({ color, size }) => (<Ionicons name="home-outline" size={size} color={color} />),
          }}
        />
        <Tabs.Screen
          name="dashboard"
          options={{
            title: 'Dashboard',
            // href:null hides the bar slot (expo-router auto-applies
            // display:'none') but is a UI toggle, NOT an access gate — a
            // router.push('/(tabs)/dashboard') (e.g. a notification tap)
            // still lands; dashboard.jsx's own canDashboard re-filter is the
            // real boundary and renders a harmless stub with no segments.
            // The hidden feature tabs below add tabBarItemStyle only because
            // their href can be non-null (More-eligible but off the bar).
            href: hasDashboard ? '/(tabs)/dashboard' : null,
            tabBarIcon: ({ color, size }) => (<Ionicons name="stats-chart-outline" size={size} color={color} />),
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
              // Needs-reply tickets on the Email tab (EMAIL-BADGE-M.1) —
              // same actionable-work semantics, same style.
              ...(key === 'email' && emailNeedsReplyCount > 0
                ? {
                    tabBarBadge: emailNeedsReplyCount > 99 ? '99+' : emailNeedsReplyCount,
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
