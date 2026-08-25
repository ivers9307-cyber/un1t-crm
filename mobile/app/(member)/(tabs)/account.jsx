// "You" tab (route stays /(tabs)/account — the file name is unchanged so no
// deep-link moves) — mirrors src/app/account/page.jsx.
//
// Coaching is PROMOTED to a prominent hero card at the top (Wave 4) rather than
// buried as a plain list row. The remaining destinations (Devices, Goals,
// Achievements, Integrations, Notifications) stay in the dark link list below,
// then sign-out.

import { View, Text, Pressable, ScrollView } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useAuth } from '../../../lib/member/contact-context'
import Card from '../../../components/member/ui/Card'
import Button from '../../../components/member/ui/Button'
import ProfileCompletionPrompt from '../../../components/member/ProfileCompletionPrompt'
import { PEARL } from '../../../lib/member/brand'

const LINKS = [
  { href: '/account/devices',       label: 'Devices',       icon: 'pulse-outline' },
  { href: '/account/goals',         label: 'Goals',         icon: 'flag-outline' },
  { href: '/account/achievements',  label: 'Achievements',  icon: 'trophy-outline' },
  { href: '/account/integrations',  label: 'Integrations',  icon: 'flash-outline' },
  { href: '/account/notifications', label: 'Notifications', icon: 'notifications-outline' },
]

export default function Account() {
  const { contact, signOut } = useAuth()
  const router = useRouter()

  return (
    <SafeAreaView className="flex-1 bg-iron-bg" edges={['left', 'right']}>
      {/* Scrollable so all content (incl. sign-out) is reachable on every device
          size — a plain View clipped everything below the fold on iPad (Apple
          Guideline 4 rejection). */}
      <ScrollView contentContainerClassName="p-5 pb-24" showsVerticalScrollIndicator={false}>
        <Text className="text-2xl font-display-bold text-chalk">You</Text>
        {contact?.email ? (
          <Text className="mt-1 text-sm font-body text-chalk-2">{contact.email}</Text>
        ) : null}

        {/* Coaching — promoted hero. Pearl-tinted (resting accent), distinct from
            the plain list chrome so the coaching relationship reads as a
            first-class surface. */}
        <Pressable
          onPress={() => router.push('/coaching')}
          className="mt-5 flex-row items-center gap-4 rounded-[20px] border p-5 active:opacity-80"
          style={{ borderColor: PEARL + '59', backgroundColor: PEARL + '1A' }}
        >
          <View
            className="h-12 w-12 items-center justify-center rounded-full"
            style={{ backgroundColor: PEARL + '2E' }}
          >
            <Ionicons name="barbell" size={24} color={PEARL} />
          </View>
          <View className="flex-1 min-w-0">
            <Text className="text-base font-display-bold text-chalk">Coaching</Text>
            <Text className="mt-0.5 text-xs font-body text-chalk-2">
              Your coach's feedback, goals and body scans
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={PEARL} />
        </Pressable>

        {/* Complete-your-profile — self-gates to null once dob/gender/weight are set. */}
        <ProfileCompletionPrompt className="mt-5" />

        {/* Nav links */}
        <Card className="mt-5 p-0 overflow-hidden">
          {LINKS.map(({ href, label, icon }, i) => (
            <Pressable
              key={href}
              onPress={() => router.push(href)}
              className={`flex-row items-center gap-3 px-5 py-4 active:bg-iron-raised${
                i < LINKS.length - 1 ? ' border-b border-iron-hairline' : ''
              }`}
            >
              <Ionicons name={icon} size={18} color="#B3B2AC" />
              <Text className="flex-1 text-sm font-body-medium text-chalk">{label}</Text>
              <Ionicons name="chevron-forward-outline" size={18} color="#727170" />
            </Pressable>
          ))}
        </Card>

        {/* Sign out */}
        <View className="mt-6">
          <Button title="Sign out" variant="ghost" onPress={signOut} />
        </View>
      </ScrollView>
    </SafeAreaView>
  )
}
