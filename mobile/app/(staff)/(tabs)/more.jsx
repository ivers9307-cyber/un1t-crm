// More tab — tiled app-launcher grid (MOBILE-MORE-TILES). Each enabled
// surface is a tile (icon + label) in a flat 3-across grid, so everything
// fits on one screen with little/no scrolling. Replaces the older scrolling
// sectioned list. The account + active location sit in a compact header on
// top; Sign out is a clear row at the bottom.
//
// Which tiles appear is driven by the SAME gates as before: the resolved
// layout's `more` set (so a feature promoted into the bottom bar drops out
// of here automatically) + `allowed` for the Customise-bar tile + the master
// gate for View-as-user. ScrollView is kept as a safety net for the rare
// many-tiles case; for typical users the grid fits without scrolling.

import { useState, useCallback } from 'react'
import { View, Text, ScrollView, Pressable, Alert, Switch } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useRouter, useFocusEffect } from 'expo-router'
import { useAuth } from '../../../lib/auth-context'
import { resolveLayoutForUser } from '../../../lib/mobile-layout'
import { getOutstandingPolicyCount } from '../../../lib/policies-api'
import { canMobile } from '../../../lib/permissions'
import { getPendingApprovals } from '../../../lib/approvals-api'
import { approvalsBadgeCount } from '../../../lib/approvals'
import { listInboxIssues } from '../../../lib/issues-api'
import { listInvoices } from '../../../lib/invoices-api'
import { accountingLanding, ACCOUNTING_ROUTES } from '../../../lib/accounting'
import { buildSummary } from '../../../lib/build-info'
import { useBiometricLock } from '../../../lib/biometric-lock'
import { useStudioPin } from '../../../lib/studio-pin'

function Tile({ icon, label, badge, onPress }) {
  return (
    <View style={{ width: '33.333%' }} className="p-1.5">
      <Pressable
        onPress={onPress}
        style={{ minHeight: 92 }}
        className="bg-un1t-surface border border-un1t-border rounded-2xl py-4 px-2 items-center justify-center active:bg-un1t-border/40"
      >
        <View>
          <Ionicons name={icon} size={26} color="#111827" />
          {badge ? (
            <View className="absolute -top-2 -right-3.5 bg-green-500 rounded-full min-w-[18px] h-[18px] px-1 items-center justify-center">
              <Text className="text-[10px] text-white font-bold">{badge}</Text>
            </View>
          ) : null}
        </View>
        <Text numberOfLines={2} className="text-xs text-un1t-text text-center mt-2 leading-tight">
          {label}
        </Text>
      </Pressable>
    </View>
  )
}

export default function More() {
  const router = useRouter()
  const {
    profile,
    locations,
    activeLocation,
    setActiveLocationId,
    signOut,
    impersonatingFrom,
  } = useAuth()
  // Master gate — when impersonating, the visible profile.role is the
  // target's, so also check impersonatingFrom (the underlying caller
  // is then implicitly a master).
  const canImpersonate = profile?.role === 'master' || profile?.isMaster || !!impersonatingFrom

  // FACE-ID — biometric app-lock toggle (shown only when biometrics are
  // available + enrolled). Enabling/disabling both re-auth first.
  const biometric = useBiometricLock()
  const { paired, lock: studioLock, unpair } = useStudioPin()
  function confirmUnpair() {
    Alert.alert(
      'Forget this studio device?',
      'This iPad will go back to normal email + password sign-in. Staff PINs will no longer work here until it is paired again.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Forget device', style: 'destructive', onPress: unpair },
      ],
    )
  }
  async function onToggleBiometric(next) {
    const res = await biometric.setEnabled(next)
    if (!res.success) {
      Alert.alert('Couldn’t confirm', `${biometric.typeLabel} wasn’t confirmed, so the setting wasn’t changed.`)
    }
  }
  const { more, allowed } = resolveLayoutForUser(profile, activeLocation)
  const inMore = new Set(more)

  // POLICIES-VIEWS.1 — outstanding policies the user hasn't opened yet.
  // Re-fetched on each focus so opening a policy reflects here on the
  // back-bounce. Negative sentinel (network error) hides the badge.
  const [outstandingPolicies, setOutstandingPolicies] = useState(0)
  useFocusEffect(useCallback(() => {
    let alive = true
    getOutstandingPolicyCount().then((n) => { if (alive && n >= 0) setOutstandingPolicies(n) })
    return () => { alive = false }
  }, []))

  // MOBILE-APPROVALS — pending-approvals badge for the Approvals tile. Gated on
  // the `approvals` permission so non-managers never fetch. Counts only the four
  // mobile categories so the badge matches the inbox.
  const [outstandingApprovals, setOutstandingApprovals] = useState(0)
  useFocusEffect(useCallback(() => {
    if (!profile || !activeLocation?.id || !canMobile(profile, 'approvals', activeLocation)) return
    let alive = true
    getPendingApprovals({ locationId: activeLocation.id }).then((res) => {
      if (alive && res.success) setOutstandingApprovals(approvalsBadgeCount(res.data?.providers || []))
    })
    return () => { alive = false }
  }, [profile, activeLocation]))

  // REPORTS-HUB.1 — open-issue count for the Reports tile badge. Gated on
  // issue_triage so only handlers fetch (a staff member's Reports tile
  // never carries a triage count). Best-effort; network error hides it.
  const [outstandingIssues, setOutstandingIssues] = useState(0)
  useFocusEffect(useCallback(() => {
    if (!profile || !canMobile(profile, 'issue_triage', activeLocation)) return
    let alive = true
    listInboxIssues().then((res) => {
      if (alive && res.success !== false && Array.isArray(res.data)) setOutstandingIssues(res.data.length)
    }).catch(() => {})
    return () => { alive = false }
  }, [profile, activeLocation]))

  // ACCOUNTING-HUB.1 — awaiting-approval count for the Accounting tile
  // badge. Gated on invoices_inbox so only approvers fetch; 'submitted'
  // is the count waiting on them. Best-effort; network error hides it.
  const [outstandingInvoices, setOutstandingInvoices] = useState(0)
  useFocusEffect(useCallback(() => {
    if (!profile || !canMobile(profile, 'invoices_inbox', activeLocation)) return
    let alive = true
    listInvoices().then((res) => {
      if (alive && res.success !== false && Array.isArray(res.data)) {
        setOutstandingInvoices(res.data.filter((i) => i.status === 'submitted').length)
      }
    }).catch(() => {})
    return () => { alive = false }
  }, [profile, activeLocation]))

  function pickLocation() {
    if (!locations.length) return
    if (locations.length === 1) {
      Alert.alert('Locations', `You only have access to ${locations[0].name}.`)
      return
    }
    Alert.alert('Switch location', 'Which location?', [
      ...locations.map(l => ({
        text: l.name + (l.id === activeLocation?.id ? '  ✓' : ''),
        onPress: () => setActiveLocationId(l.id),
      })),
      { text: 'Cancel', style: 'cancel' },
    ])
  }

  function confirmSignOut() {
    Alert.alert('Sign out?', 'You can sign back in any time with your email and password.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', style: 'destructive', onPress: signOut },
    ])
  }

  if (!profile) return null

  // Tile list — built from the same per-user gates as the old sectioned list.
  const tiles = []
  if (inMore.has('schedule'))  tiles.push({ key: 'schedule', icon: 'calendar-outline', label: 'Schedule', onPress: () => router.push('/schedule') })
  if (inMore.has('whatsapp'))  tiles.push({ key: 'whatsapp', icon: 'chatbubble-outline', label: 'WhatsApp', onPress: () => router.push('/whatsapp') })
  // INBOX-SPLIT.M1 — the studio email queue is its own surface now, so it
  // gets its own tile rather than hiding inside Messages. /email resolves to
  // the (tabs) screen; /email/[ticketId] is the thread stack.
  if (inMore.has('email'))     tiles.push({ key: 'email', icon: 'mail-outline', label: 'Email', onPress: () => router.push('/email') })
  if (inMore.has('studio'))    tiles.push({ key: 'studio', icon: 'business-outline', label: 'Studio', onPress: () => router.push('/studio') })
  if (inMore.has('tasks'))     tiles.push({ key: 'tasks', icon: 'checkbox-outline', label: 'Tasks', onPress: () => router.push('/tasks') })
  if (inMore.has('bookings'))  tiles.push({ key: 'bookings', icon: 'calendar-clear-outline', label: 'Bookings', onPress: () => router.push('/bookings') })
  if (inMore.has('pipeline'))  tiles.push({ key: 'pipeline', icon: 'trending-up-outline', label: 'Pipeline', onPress: () => router.push('/pipeline') })
  // W1 — searchable contact directory (read). Gated directly by canMobile
  // (contacts isn't a bar-eligible layout feature yet); defaults on for
  // every role, like the web contacts list.
  if (canMobile(profile, 'contacts', activeLocation)) tiles.push({ key: 'contacts', icon: 'people-circle-outline', label: 'Contacts', onPress: () => router.push('/contacts') })
  // MOBILE-ASSISTANT.1 — in-app AI assistant chat (P2-8). Gated by the
  // existing `assistant` mobile permission (defaults on for master /
  // owner / manager; explicit opt-in for head_coach + staff).
  if (canMobile(profile, 'assistant', activeLocation)) tiles.push({ key: 'assistant', icon: 'sparkles-outline', label: 'Assistant', onPress: () => router.push('/assistant') })
  // ACCOUNTING-HUB.1 — one "Accounting" tile for the money surfaces
  // (Expenses, own Invoices, Invoices approver inbox, SPEND.P3
  // company-card receipts, and the EVENTS-HUB.2 Orders revenue ledger).
  // The hub routes by access level: a single-surface user is sent
  // straight to their one surface; 2+ surfaces get a chooser. Replaces
  // the old Invoices / Expenses / Invoices inbox / Orders tiles. The
  // badge shows invoices awaiting approval (approvers only).
  const accLanding = accountingLanding({
    canExpenses: inMore.has('expenses'),
    canInvoices: inMore.has('invoices'),
    canInbox: canMobile(profile, 'invoices_inbox', activeLocation),
    // SPEND.P3 — include card_receipts so a card-only holder still gets
    // the Accounting tile (and is routed straight to /card-receipts).
    canCardReceipts: canMobile(profile, 'card_receipts', activeLocation),
    // EVENTS-HUB.2 — Orders (revenue ledger) lives under Accounting now
    // (it's money, not an event surface), so it folds into this hub.
    canOrders: canMobile(profile, 'orders', activeLocation),
    // INV-M.1 — bookkeeper queue (cross-platform `bookkeeper` key).
    canQueue: canMobile(profile, 'bookkeeper', activeLocation),
  })
  if (accLanding) {
    tiles.push({ key: 'accounting', icon: 'calculator-outline', label: 'Accounting', badge: outstandingInvoices > 0 ? String(outstandingInvoices) : null, onPress: () => router.push(ACCOUNTING_ROUTES[accLanding]) })
  }
  if (inMore.has('radar'))     tiles.push({ key: 'radar', icon: 'pulse-outline', label: 'Radar', onPress: () => router.push('/radar') })
  // REPORTS-HUB.1 — one "Reports" tile for the whole issue feature. The
  // hub routes by access level: a regular staffer lands straight on My
  // reports (submit + own history); a handler (issue_triage) gets a
  // chooser between My reports and the triage Issue inbox. Replaces the
  // old Report / My reports / Issue inbox trio of tiles.
  if (inMore.has('issues') || canMobile(profile, 'issue_triage', activeLocation)) {
    tiles.push({ key: 'reports', icon: 'document-text-outline', label: 'Reports', badge: outstandingIssues > 0 ? String(outstandingIssues) : null, onPress: () => router.push('/issues/hub') })
  }
  if (inMore.has('contracts')) tiles.push({ key: 'contracts', icon: 'document-text-outline', label: 'Contracts', onPress: () => router.push('/contracts') })
  if (inMore.has('policies'))  tiles.push({ key: 'policies', icon: 'book-outline', label: 'Policies', badge: outstandingPolicies > 0 ? String(outstandingPolicies) : null, onPress: () => router.push('/policies') })
  if (canMobile(profile, 'approvals', activeLocation)) tiles.push({ key: 'approvals', icon: 'checkmark-done-outline', label: 'Approvals', badge: outstandingApprovals > 0 ? String(outstandingApprovals) : null, onPress: () => router.push('/approvals') })
  if (canMobile(profile, 'hyrox', activeLocation)) tiles.push({ key: 'hyrox', icon: 'barbell-outline', label: 'Hyrox', onPress: () => router.push('/hyrox') })
  // Staff & access management (STAFF-C1 directory + C2c role/permission
  // editors). Gated by the `staff_management` mobile permission (STAFF-C3
  // parity inversion) — defaults to master/owner/manager so behaviour is
  // unchanged, but a master can now grant or revoke it per user. Edit
  // capability inside the screens stays owner/master; the GET routes
  // enforce scope server-side regardless.
  if (canMobile(profile, 'staff_management', activeLocation)) tiles.push({ key: 'staff', icon: 'people-outline', label: 'Staff', onPress: () => router.push('/staff') })
  // (Issue triage now lives inside the Reports hub above — the handler
  // reaches the inbox via the chooser, gated by issue_triage there.)
  // (Invoices approver inbox now lives inside the Accounting hub above —
  // the approver reaches it via the chooser, gated by invoices_inbox.)
  // EVENT-CHECKIN.E — one "Events" tile opens the unified mobile events
  // list (all kinds). Race rows open the race-day control board; non-race
  // rows open the event detail → check-in. Gated by the `races` permission
  // (kept as the internal key for the whole multi-kind events feature).
  if (canMobile(profile, 'races', activeLocation)) {
    tiles.push({ key: 'events', icon: 'calendar-outline', label: 'Events', onPress: () => router.push('/events') })
  }
  // W2 — CCF Autos car-import tracker (read-only). Off by default; master
  // or per-user opt-in, and only where car_processing is on at the location.
  if (canMobile(profile, 'car_processing', activeLocation)) tiles.push({ key: 'cars', icon: 'car-sport-outline', label: 'Cars', onPress: () => router.push('/cars') })
  // (Race control now lives inside the Events hub above — reached via the
  // chooser, gated by the `races` permission there.)
  // W1 — per-location feature toggles (master only; matches the web
  // canEditLocationFeatures gate). Flip which features this studio shows.
  if (profile?.isMaster || profile?.role === 'master') tiles.push({ key: 'features', icon: 'options-outline', label: 'Location features', onPress: () => router.push('/location-features') })
  if (allowed.length > 0)      tiles.push({ key: 'customise', icon: 'grid-outline', label: 'Customise bar', onPress: () => router.push('/customise-bar') })
  if (canImpersonate)          tiles.push({ key: 'impersonate', icon: 'eye-outline', label: 'View as user', badge: impersonatingFrom ? '•' : null, onPress: () => router.push('/impersonate') })

  return (
    <ScrollView className="flex-1 bg-un1t-bg" contentContainerClassName="p-4 pb-8">
      {/* Account + active location (compact header) */}
      <View className="mb-5">
        <Text className="text-2xl font-bold text-un1t-text">{profile.full_name || 'Account'}</Text>
        {profile.email ? <Text className="text-sm text-un1t-subtle mt-0.5">{profile.email}</Text> : null}
        <Pressable
          onPress={locations.length > 1 ? pickLocation : undefined}
          className="flex-row items-center mt-2 active:opacity-70"
        >
          <Ionicons name="location-outline" size={15} color="#64748B" />
          <Text className="text-sm text-un1t-text ml-1.5">{activeLocation?.name || 'No location'}</Text>
          {locations.length > 1 && <Text className="text-sm text-blue-600 ml-2">Change</Text>}
        </Pressable>
      </View>

      {/* Tile grid */}
      {tiles.length > 0 ? (
        <View className="flex-row flex-wrap -m-1.5">
          {tiles.map(t => <Tile key={t.key} {...t} />)}
        </View>
      ) : (
        <Text className="text-sm text-un1t-subtle">No quick links enabled for you yet.</Text>
      )}

      {biometric.available && (
        <View className="flex-row items-center justify-between mt-6 bg-un1t-surface border border-un1t-border rounded-2xl p-4">
          <View className="flex-1 mr-3">
            <Text className="text-base text-un1t-text">Require {biometric.typeLabel} to unlock</Text>
            <Text className="text-xs text-un1t-subtle mt-0.5">Locks the app on open and after 5 min away.</Text>
          </View>
          <Switch value={biometric.enabled} onValueChange={onToggleBiometric} />
        </View>
      )}

      {paired && (
        <View className="mt-4">
          <Pressable
            onPress={studioLock}
            className="flex-row items-center justify-between bg-un1t-surface rounded-2xl border border-un1t-border px-4 py-3.5 active:opacity-80"
          >
            <Text className="text-base text-un1t-text">Return to PIN</Text>
            <Text className="text-sm text-un1t-subtle">Hand off to the next staffer</Text>
          </Pressable>
          <Pressable
            onPress={confirmUnpair}
            className="flex-row items-center justify-between bg-un1t-surface rounded-2xl border border-un1t-border px-4 py-3.5 mt-2 active:opacity-80"
          >
            <Text className="text-base text-red-500">Forget this studio device</Text>
          </Pressable>
        </View>
      )}

      {/* Sign out */}
      <Pressable
        onPress={confirmSignOut}
        className="mt-6 flex-row items-center justify-center py-3.5 rounded-2xl border border-un1t-border active:bg-un1t-border/40"
      >
        <Ionicons name="log-out-outline" size={18} color="#EF4444" />
        <Text className="text-base text-red-500 ml-2 font-medium">Sign out</Text>
      </Pressable>

      <Text className="text-xs text-un1t-muted text-center mt-4">
        Repset · {buildSummary()}
      </Text>
    </ScrollView>
  )
}
