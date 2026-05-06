// More tab. iOS-style settings list:
//   - Account header
//   - Active location with switcher
//   - Sign out
//
// Future: notification preferences (read/write the per-category mobile
// permission flags), dark mode toggle, "open web app", about screen.

import { View, Text, ScrollView, Pressable, Alert } from 'react-native'
import { useRouter } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useAuth } from '../../lib/auth-context'
import { canMobile } from '../../lib/permissions'

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
  } = useAuth()
  const showStudio = canMobile(profile, 'studio_management', activeLocation)

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

      {showStudio && (
        <Section title="On-site">
          <Row
            icon="business-outline"
            label="Studio management"
            value="Doors · AC"
            onPress={() => router.push('/studio')}
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
        UN1T CRM mobile · v0.1.0
      </Text>
    </ScrollView>
  )
}
