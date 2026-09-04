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

import { Tabs, Redirect, useFocusEffect } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { View, AppState } from 'react-native'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '../../../lib/auth-context'
import { canMobile, canDashboard, CROSS_PLATFORM_DASHBOARD_KEYS } from '../../../lib/permissions'
import { registerForPushNotifications } from '../../../lib/push-register'
import { resolveLayoutForUser } from '../../../lib/mobile-layout'
import { getNeedsActionCount } from '../../../lib/whatsapp-api'
import { getMailCount } from '../../../lib/email-api'
import { listTodaysRaces } from '../../../lib/races-api'
import ImpersonateBanner from '../../../components/ImpersonateBanner'
import PendingContractsBanner from '../../../components/PendingContractsBanner'
import IdentitySwitcher from '../../../components/IdentitySwitcher'

// RACE-TAB.1 — safety net only, deliberately NOT the 60s cadence of the two
// badge polls below it. Those count work that changes minute to minute; this
// asks whether the studio has a race on today, which changes once a day. The
// three moments that actually matter are mount, screen focus and app
// foreground — all three are wired up — so the interval exists purely to
// catch a phone left open on the bar across the midnight boundary, or a race
// an operator publishes on the web while a coach's app sits idle.
const RACES_TODAY_POLL_MS = 10 * 60 * 1000

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
  // RACE-TAB.1 — today's races at the active studio. Drives whether a
  // contextual Race tab appears; [] means "no race today, or we have not
  // been able to ask".
  const [racesToday, setRacesToday] = useState([])
  const refreshRacesRef = useRef(null)

  // Only ask when the person could act on the answer. `races` is the same
  // key the control board and the race-* action routes check, so the gate
  // that places the tab is the gate that lets its calls through. Collapsed
  // to a single id so the effect below re-runs on a studio switch and on
  // nothing else.
  const racesLocationId = canMobile(profile, 'races', activeLocation)
    ? (activeLocation?.id || null)
    : null

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
      const res = await getMailCount(activeLocation.id)
      if (!cancelled && res?.success) setEmailNeedsReplyCount(res.data?.count || 0)
    }
    poll()
    const t = setInterval(poll, 60000)
    return () => { cancelled = true; clearInterval(t) }
  }, [profile, activeLocation])

  useEffect(() => {
    if (!racesLocationId) { setRacesToday([]); return }
    let cancelled = false
    async function poll() {
      const res = await listTodaysRaces({ locationId: racesLocationId })
      // `cancelled` also covers the studio switch: a reply for the studio
      // we just left must never repaint the bar for the one we are in.
      if (cancelled) return
      // Keep the last known answer on a failure, exactly like the two badge
      // polls above — but the stakes are higher here than a stale count. A
      // dropped packet in a warehouse with bad signal must not make the Race
      // tab vanish out from under an operator mid-event.
      if (!res?.success) return
      setRacesToday(Array.isArray(res.data) ? res.data : [])
    }
    refreshRacesRef.current = poll
    poll()
    const t = setInterval(poll, RACES_TODAY_POLL_MS)
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') poll()
    })
    return () => {
      cancelled = true
      clearInterval(t)
      sub.remove()
      refreshRacesRef.current = null
    }
  }, [racesLocationId])

  // Re-ask when the tabs come back into focus (returning from a pushed
  // screen, or from the member side of the merged app). Going through the
  // ref keeps this callback stable while always calling the CURRENT
  // effect's poll — the one that owns the live `cancelled` flag — so a
  // focus landing just after a studio switch cannot run a stale closure.
  useFocusEffect(useCallback(() => { refreshRacesRef.current?.() }, []))

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
    // Messages, matching web (the "Mail" tab). Gated on
    // `email_inbox` via shared/mobile-nav → resolveLayoutForUser.
    email:    { title: 'Mail',     icon: 'mail-outline' },
    studio:   { title: 'Studio',   icon: 'business-outline' },
    pipeline: { title: 'Pipeline', icon: 'trending-up-outline' },
    bookings: { title: 'Bookings', icon: 'calendar-clear-outline' },
    invoices: { title: 'Invoices', icon: 'receipt-outline' },
    expenses: { title: 'Expenses', icon: 'wallet-outline' },
    // RACE-TAB.1 — trackside race-day control. The flag is unused by any
    // other tab (schedule/bookings own the two calendar glyphs).
    race:     { title: 'Race',     icon: 'flag-outline' },
  }
  // `race` is deliberately NOT in this list: its placement is special (see
  // raceTabMode below) and it is rendered by exactly one of the three
  // branches, never by the generic hidden sweep. Two <Tabs.Screen name="race">
  // in one navigator is an expo-router error, and letting it fall into
  // hiddenKeys while a contextual copy renders is the only way to produce it.
  const FEATURE_KEYS = ['schedule', 'whatsapp', 'email', 'studio', 'pipeline', 'bookings', 'invoices', 'expenses']
  const hiddenKeys = FEATURE_KEYS.filter(k => !barSet.has(k))

  // RACE-TAB.1 — exactly one of three, in strict priority order:
  //   'bar'        the user (or their admin) PINNED Race. It is already in
  //                `bar`, so bar.map below renders it and we must not add a
  //                second copy — pinning always wins over the contextual
  //                placement, which would otherwise duplicate the screen.
  //   'contextual' there is a race on today. Slot it in directly after Home,
  //                OUTSIDE the three resolved bar slots, so race day costs
  //                nobody the surface they arranged for themselves.
  //   'hidden'     neither. The route still exists so a deep link or a
  //                router.push lands (same posture as the hidden feature
  //                tabs below), it just holds no bar slot.
  const raceTabMode = barSet.has('race')
    ? 'bar'
    : (racesToday.length > 0 ? 'contextual' : 'hidden')

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
        {/* RACE-TAB.1 — the contextual Race tab, directly after Home on a day
            this studio has a race. Rendered ONLY in 'contextual' mode; in
            'bar' mode the pinned copy comes out of bar.map below and in
            'hidden' mode the hidden copy comes out of the block at the end,
            so the navigator always holds exactly one screen named "race". */}
        {raceTabMode === 'contextual' ? (
          <Tabs.Screen
            name="race"
            options={{
              title: TAB_META.race.title,
              href: '/(tabs)/race',
              tabBarIcon: ({ color, size }) => (<Ionicons name={TAB_META.race.icon} size={size} color={color} />),
            }}
          />
        ) : null}
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
        {/* RACE-TAB.1 — no race today and not pinned: keep the route
            registered but off the bar, so /races and any deep link into
            /(tabs)/race still resolve. featureHref returns null unless the
            person is actually granted the surface, so this is a UI hide on
            top of the same enablement gate every other tab uses. */}
        {raceTabMode === 'hidden' ? (
          <Tabs.Screen
            name="race"
            options={{
              title: TAB_META.race.title,
              href: featureHref('race'),
              tabBarItemStyle: { display: 'none' },
              tabBarIcon: ({ color, size }) => (<Ionicons name={TAB_META.race.icon} size={size} color={color} />),
            }}
          />
        ) : null}
      </Tabs>
    </View>
  )
}
