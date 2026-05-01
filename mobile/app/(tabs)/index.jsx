// Home tab — segmented control hosting up to three dashboards:
//   - "Today"     → personal view (everyone w/ dashboard_personal)
//   - "Studio"    → operational view (head_coach+ w/ dashboard_studio)
//   - "Business"  → owner view (owner w/ dashboard_business)
//
// Only segments the user has permission to see are rendered. Default
// landing segment is the most-aggregated one available — owners land
// on Business, managers on Studio, staff on Today. The selection
// persists across renders within a session via useState.
//
// Pull-to-refresh re-fetches whichever dashboard is currently shown.

import { useState, useMemo, useCallback } from 'react'
import {
  View, Text, ScrollView, Pressable, RefreshControl,
} from 'react-native'
import { useAuth } from '../../lib/auth-context'
import { canDashboard, hasAnyMobileFeature } from '../../lib/permissions'
import PersonalDashboard from '../../components/dashboard/PersonalDashboard'
import StudioDashboard from '../../components/dashboard/StudioDashboard'
import BusinessDashboard from '../../components/dashboard/BusinessDashboard'

// Dashboard segments. The `perm` keys live at the TOP LEVEL of
// profile.permissions (not under .mobile) so a single admin toggle
// in StaffForm controls both the web /dashboard/<id> page AND the
// matching mobile segment.
const SEGMENTS = [
  { id: 'personal', label: 'Today',    perm: 'dashboard_personal', Component: PersonalDashboard },
  { id: 'studio',   label: 'Studio',   perm: 'dashboard_studio',   Component: StudioDashboard },
  { id: 'business', label: 'Business', perm: 'dashboard_business', Component: BusinessDashboard },
]

function SegmentedControl({ segments, selected, onSelect }) {
  return (
    <View className="flex-row bg-un1t-dark border border-un1t-gray rounded-xl p-1 mb-4">
      {segments.map(seg => {
        const sel = seg.id === selected
        return (
          <Pressable
            key={seg.id}
            onPress={() => onSelect(seg.id)}
            className={`flex-1 py-2 rounded-lg ${sel ? 'bg-un1t-white' : ''}`}
          >
            <Text className={`text-center text-sm ${sel ? 'text-un1t-black font-semibold' : 'text-un1t-light'}`}>
              {seg.label}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

export default function Home() {
  const { profile, activeLocation } = useAuth()
  const [refreshKey, setRefreshKey] = useState(0)
  const [refreshing, setRefreshing] = useState(false)

  // Filter segments to those the user has permission for at the
  // active location. Location-level feature gate (migration 032)
  // is honoured by canDashboard's third arg.
  const available = useMemo(
    () => SEGMENTS.filter(s => canDashboard(profile, s.perm, activeLocation)),
    [profile, activeLocation]
  )

  // Default to the LAST available segment so owners land on Business
  // (the most-aggregated view), managers on Studio, staff on Today.
  // Memoize so the user's manual selection persists.
  const [selected, setSelected] = useState(null)
  const effectiveSelected = selected || available[available.length - 1]?.id

  const onRefresh = useCallback(async () => {
    setRefreshing(true)
    setRefreshKey(k => k + 1) // bump to force child dashboards to re-fetch
    // Give the child time to fetch before stopping the spinner.
    setTimeout(() => setRefreshing(false), 800)
  }, [])

  if (!profile) return null

  const firstName = profile.full_name?.split(' ')[0] || 'there'

  // No mobile features at all — show the existing onboarding nudge.
  // Honours the location gate so a user whose features are all
  // disabled at this studio sees the same nudge.
  if (!hasAnyMobileFeature(profile, activeLocation)) {
    return (
      <ScrollView className="flex-1 bg-un1t-black" contentContainerClassName="p-6">
        <Text className="text-3xl font-bold text-un1t-white mb-1">Hi {firstName}</Text>
        <Text className="text-base text-un1t-light mb-6">{roleLabel(profile.role)}</Text>
        <View className="bg-un1t-dark border border-un1t-gray rounded-2xl p-5">
          <Text className="text-base font-semibold text-un1t-white mb-1">
            Mobile features off
          </Text>
          <Text className="text-sm text-un1t-light">
            An admin hasn&apos;t enabled any mobile features for your account
            yet. Ask the gym manager to turn on Schedule, Pipeline, or
            WhatsApp from your profile in the web app.
          </Text>
        </View>
      </ScrollView>
    )
  }

  // No dashboard permissions at all — fall through to a tiny stub
  // pointing them at the bottom-tab features they can use.
  if (available.length === 0) {
    return (
      <ScrollView className="flex-1 bg-un1t-black" contentContainerClassName="p-6">
        <Text className="text-3xl font-bold text-un1t-white mb-1">Hi {firstName}</Text>
        <Text className="text-base text-un1t-light">
          {activeLocation
            ? `${activeLocation.name} · ${roleLabel(profile.role)}`
            : roleLabel(profile.role)}
        </Text>
        <Text className="text-sm text-un1t-light mt-6">
          Use the tabs below to navigate.
        </Text>
      </ScrollView>
    )
  }

  const currentSegment = available.find(s => s.id === effectiveSelected) || available[0]
  const Body = currentSegment.Component

  return (
    <ScrollView
      className="flex-1 bg-un1t-black"
      contentContainerClassName="px-4 pt-4 pb-24"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#111827" />}
    >
      {/* Greeting */}
      <Text className="text-3xl font-bold text-un1t-white">Hi {firstName}</Text>
      <Text className="text-sm text-un1t-light mb-4">
        {activeLocation
          ? `${activeLocation.name} · ${roleLabel(profile.role)}`
          : roleLabel(profile.role)}
      </Text>

      {/* Segmented control — only render if user has more than one
          dashboard. With a single segment, the title above is enough. */}
      {available.length > 1 ? (
        <SegmentedControl
          segments={available}
          selected={currentSegment.id}
          onSelect={setSelected}
        />
      ) : null}

      <Body refreshKey={refreshKey} />
    </ScrollView>
  )
}

function roleLabel(role) {
  switch (role) {
    case 'owner':      return 'Owner'
    case 'manager':    return 'Manager'
    case 'head_coach': return 'Head Coach'
    case 'staff':      return 'Staff'
    default:           return ''
  }
}
