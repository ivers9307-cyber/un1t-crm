// More tab. iOS-style settings list:
//   - Account header
//   - Active location with switcher
//   - Sign out
//
// Future: notification preferences (read/write the per-category mobile
// permission flags), dark mode toggle, "open web app", about screen.

import { useState, useCallback } from 'react'
import { View, Text, ScrollView, Pressable, Alert } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useRouter, useFocusEffect } from 'expo-router'
import { useAuth } from '../../lib/auth-context'
import { canMobile } from '../../lib/permissions'
import { getOutstandingPolicyCount } from '../../lib/policies-api'

function Section({ title, children }) {
  return (
    <View className="mb-6">
      {title && (
        <Text className="text-xs font-semibold uppercase tracking-wider text-un1t-light px-2 mb-2">
          {title}
        </Text>
      )}
      <View className="bg-un1t-dark border border-un1t-gray rounded-2xl overflow-hidden">
        {children}
      </View>
    </View>
  )
}

function Row({ icon, label, value, onPress, isLast, destructive }) {
  return (
    <Pressable
      onPress={onPress}
      className={`flex-row items-center px-4 py-3.5 active:bg-un1t-gray/40 ${
        !isLast ? 'border-b border-un1t-gray' : ''
      }`}
    >
      {icon && (
        <Ionicons
          name={icon}
          size={18}
          color={destructive ? '#EF4444' : '#111827'}
          style={{ marginRight: 12 }}
        />
      )}
      <Text
        className={`flex-1 text-base ${
          destructive ? 'text-red-500' : 'text-un1t-white'
        }`}
      >
        {label}
      </Text>
      {value && <Text className="text-sm text-un1t-light mr-1">{value}</Text>}
      {onPress && !destructive && (
        <Ionicons name="chevron-forward" size={16} color="#94A3B8" />
      )}
    </Pressable>
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
  // NOTIF.2 — Tasks lives in More (less time-sensitive than Bookings,
  // which is a bottom tab). Gate on the same key the back-end uses.
  const showTasks = profile && canMobile(profile, 'tasks', activeLocation)
  // MOBILE-RADAR — the read-only radar glance. Visible when the user
  // has either mobile radar permission; the screen renders only the
  // section(s) they're entitled to.
  const showRadar = !!profile && (
    canMobile(profile, 'churn_radar', activeLocation) ||
    canMobile(profile, 'lead_radar', activeLocation)
  )

  // POLICIES-VIEWS.1 — outstanding policies the user hasn't opened
  // yet. Re-fetched on each focus so opening a policy in the viewer
  // reflects here on the back-bounce. Negative sentinel (network
  // error) hides the badge silently rather than showing "?".
  const [outstandingPolicies, setOutstandingPolicies] = useState(0)
  useFocusEffect(useCallback(() => {
    let alive = true
    getOutstandingPolicyCount().then((n) => { if (alive && n >= 0) setOutstandingPolicies(n) })
    return () => { alive = false }
  }, []))

  function pickLocation() {
    if (!locations.length) return
    if (locations.length === 1) {
      Alert.alert('Locations', `You only have access to ${locations[0].name}.`)
      return
    }
    Alert.alert(
      'Switch location',
      'Which location?',
      [
        ...locations.map(l => ({
          text: l.name + (l.id === activeLocation?.id ? '  ✓' : ''),
          onPress: () => setActiveLocationId(l.id),
        })),
        { text: 'Cancel', style: 'cancel' },
      ]
    )
  }

  function confirmSignOut() {
    Alert.alert(
      'Sign out?',
      'You can sign back in any time with your email and password.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Sign out', style: 'destructive', onPress: signOut },
      ]
    )
  }

  if (!profile) return null

  return (
    <ScrollView className="flex-1 bg-un1t-black" contentContainerClassName="p-4">
      <Section title="Account">
        <Row label={profile.full_name} value={profile.email} isLast />
      </Section>

      <Section title="Active location">
        <Row
          icon="location-outline"
          label={activeLocation?.name || 'No location'}
          value={locations.length > 1 ? 'Change' : undefined}
          onPress={locations.length > 1 ? pickLocation : undefined}
          isLast
        />
      </Section>

      {/* NOTIF.2 — Tasks. Surfaces tasks assigned to the signed-in
          user. Hidden when the user's `tasks` mobile permission is
          off (admin can disable per-user from StaffForm). */}
      {showTasks && (
        <Section title="Work">
          <Row
            icon="checkbox-outline"
            label="Your tasks"
            onPress={() => router.push('/tasks')}
            isLast
          />
        </Section>
      )}

      {/* MOBILE-RADAR — read-only churn + lead radar glance. Oversight,
          not personal work, so it gets its own section. */}
      {showRadar && (
        <Section title="Insights">
          <Row
            icon="pulse-outline"
            label="Radar"
            onPress={() => router.push('/radar')}
            isLast
          />
        </Section>
      )}

      {/* Documents — contracts and HR policies. Always shown (every
          staff member is potentially a recipient of either); the
          screens show empty-states if none are applicable.
          POLICIES-VIEWS.1 — Policies row shows a "N new" badge when
          the user has policies they haven't opened yet. */}
      <Section title="Documents">
        <Row
          icon="document-text-outline"
          label="Your contracts"
          onPress={() => router.push('/contracts')}
        />
        <Row
          icon="book-outline"
          label="Policies"
          value={outstandingPolicies > 0 ? `${outstandingPolicies} new` : undefined}
          onPress={() => router.push('/policies')}
          isLast
        />
      </Section>

      {/* Master-only: switch into another user's view (mig 035).
          Mirrors the web Settings → Impersonate entry point. The banner
          above the tabs already shows the active session + Stop button
          when one's running. */}
      {canImpersonate && (
        <Section title="Master tools">
          <Row
            icon="eye-outline"
            label="View as user"
            value={impersonatingFrom ? 'Active' : undefined}
            onPress={() => router.push('/impersonate')}
            isLast
          />
        </Section>
      )}

      <Section>
        <Row
          icon="log-out-outline"
          label="Sign out"
          onPress={confirmSignOut}
          destructive
          isLast
        />
      </Section>

      <Text className="text-xs text-un1t-mid text-center mt-4">
        CF Studio · v1.0.0
      </Text>
    </ScrollView>
  )
}
