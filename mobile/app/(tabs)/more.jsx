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
import { useAuth } from '../../lib/auth-context'
import { resolveLayoutForUser } from '../../lib/mobile-layout'
import { getOutstandingPolicyCount } from '../../lib/policies-api'
import { canMobile } from '../../lib/permissions'
import { getPendingApprovals } from '../../lib/approvals-api'
import { approvalsBadgeCount } from '../../lib/approvals'
import { buildSummary } from '../../lib/build-info'
import { useBiometricLock } from '../../lib/biometric-lock'

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
  if (inMore.has('studio'))    tiles.push({ key: 'studio', icon: 'business-outline', label: 'Studio', onPress: () => router.push('/studio') })
  if (inMore.has('tasks'))     tiles.push({ key: 'tasks', icon: 'checkbox-outline', label: 'Tasks', onPress: () => router.push('/tasks') })
  if (inMore.has('bookings'))  tiles.push({ key: 'bookings', icon: 'calendar-clear-outline', label: 'Bookings', onPress: () => router.push('/bookings') })
  if (inMore.has('pipeline'))  tiles.push({ key: 'pipeline', icon: 'trending-up-outline', label: 'Pipeline', onPress: () => router.push('/pipeline') })
  // W1 — searchable contact directory (read). Gated directly by canMobile
  // (contacts isn't a bar-eligible layout feature yet); defaults on for
  // every role, like the web contacts list.
  if (canMobile(profile, 'contacts', activeLocation)) tiles.push({ key: 'contacts', icon: 'people-circle-outline', label: 'Contacts', onPress: () => router.push('/contacts') })
  if (inMore.has('invoices'))  tiles.push({ key: 'invoices', icon: 'receipt-outline', label: 'Invoices', onPress: () => router.push('/invoices') })
  if (inMore.has('expenses'))  tiles.push({ key: 'expenses', icon: 'wallet-outline', label: 'Expenses', onPress: () => router.push('/expenses') })
  if (inMore.has('radar'))     tiles.push({ key: 'radar', icon: 'pulse-outline', label: 'Radar', onPress: () => router.push('/radar') })
  if (inMore.has('issues'))    tiles.push({ key: 'report', icon: 'alert-circle-outline', label: 'Report', onPress: () => router.push('/issues/new') })
  if (inMore.has('issues'))    tiles.push({ key: 'myreports', icon: 'list-outline', label: 'My reports', onPress: () => router.push('/issues') })
  if (inMore.has('contracts')) tiles.push({ key: 'contracts', icon: 'document-text-outline', label: 'Contracts', onPress: () => router.push('/contracts') })
  if (inMore.has('policies'))  tiles.push({ key: 'policies', icon: 'book-outline', label: 'Policies', badge: outstandingPolicies > 0 ? String(outstandingPolicies) : null, onPress: () => router.push('/policies') })
  if (canMobile(profile, 'approvals', activeLocation)) tiles.push({ key: 'approvals', icon: 'checkmark-done-outline', label: 'Approvals', badge: outstandingApprovals > 0 ? String(outstandingApprovals) : null, onPress: () => router.push('/approvals') })
  // Staff & access management (STAFF-C1 directory + C2c role/permission
  // editors). Gated by the `staff_management` mobile permission (STAFF-C3
  // parity inversion) — defaults to master/owner/manager so behaviour is
  // unchanged, but a master can now grant or revoke it per user. Edit
  // capability inside the screens stays owner/master; the GET routes
  // enforce scope server-side regardless.
  if (canMobile(profile, 'staff_management', activeLocation)) tiles.push({ key: 'staff', icon: 'people-outline', label: 'Staff', onPress: () => router.push('/staff') })
  // Issue triage handler inbox (W1) — owner/master claim/resolve/close
  // staff-reported issues. Gated by issue_triage (parity inversion of the
  // web issues_inbox); the routes also enforce isHandler server-side.
  if (canMobile(profile, 'issue_triage', activeLocation)) tiles.push({ key: 'issueinbox', icon: 'construct-outline', label: 'Issue inbox', onPress: () => router.push('/issues/inbox') })
  // W2 — invoice approver inbox (owner/master review + approve/decline).
  if (canMobile(profile, 'invoices_inbox', activeLocation)) tiles.push({ key: 'invoicesinbox', icon: 'file-tray-full-outline', label: 'Invoices inbox', onPress: () => router.push('/invoices/inbox') })
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

      {/* Sign out */}
      <Pressable
        onPress={confirmSignOut}
        className="mt-6 flex-row items-center justify-center py-3.5 rounded-2xl border border-un1t-border active:bg-un1t-border/40"
      >
        <Ionicons name="log-out-outline" size={18} color="#EF4444" />
        <Text className="text-base text-red-500 ml-2 font-medium">Sign out</Text>
      </Pressable>

      <Text className="text-xs text-un1t-muted text-center mt-4">
        CF Studio · {buildSummary()}
      </Text>
    </ScrollView>
  )
}
