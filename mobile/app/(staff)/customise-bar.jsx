import { useState } from 'react'
import { View, Text, ScrollView, Pressable, ActivityIndicator, Alert } from 'react-native'
import { Stack, useRouter } from 'expo-router'
import { useAuth } from '../../lib/auth-context'
import { resolveLayoutForUser } from '../../lib/mobile-layout'
import { saveBarLayout } from '../../lib/layout-api'
import { MOBILE_NAV_FEATURES } from 'shared/mobile-nav'
import BackHeaderLeft from '../../components/BackHeaderLeft'

const LABEL = Object.fromEntries(MOBILE_NAV_FEATURES.map(f => [f.key, f.label]))

export default function CustomiseBar() {
  const { profile, activeLocation, refresh } = useAuth()
  const router = useRouter()
  const { bar, allowed } = resolveLayoutForUser(profile, activeLocation)
  const [slots, setSlots] = useState([bar[0] || '', bar[1] || '', bar[2] || ''])
  const [saving, setSaving] = useState(false)

  function setSlot(i, key) {
    setSlots(prev => {
      const next = [...prev]
      next[i] = key
      for (let j = 0; j < next.length; j++) if (j !== i && next[j] === key) next[j] = ''
      return next
    })
  }

  async function save() {
    setSaving(true)
    const cleanBar = slots.filter(Boolean).filter((k, i, a) => a.indexOf(k) === i)
    const r = await saveBarLayout(activeLocation?.id, cleanBar)
    setSaving(false)
    if (r.success) { await refresh(); router.back() }
    else Alert.alert('Couldn’t save', r.error || 'Unknown error')
  }

  return (
    <View className="flex-1 bg-un1t-bg">
      <Stack.Screen options={{ title: 'Customise bar', headerLeft: () => <BackHeaderLeft label="More" fallbackHref="/(tabs)/more" /> }} />
      <ScrollView contentContainerClassName="p-4">
        <Text className="text-sm text-un1t-subtle mb-4">
          Choose up to 3 features for your bottom bar, in order. Home, Dashboard and More always stay.
          {allowed.length === 0 ? '\n\nNothing to arrange here yet.' : ''}
        </Text>
        {[0, 1, 2].map(i => (
          <View key={i} className="mb-4">
            <Text className="text-xs uppercase tracking-wider text-un1t-subtle mb-1.5">Slot {i + 1}</Text>
            <View className="flex-row flex-wrap gap-2">
              <SlotChip label="— empty —" active={!slots[i]} onPress={() => setSlot(i, '')} />
              {allowed.map(key => (
                <SlotChip key={key} label={LABEL[key] || key} active={slots[i] === key} onPress={() => setSlot(i, key)} />
              ))}
            </View>
          </View>
        ))}
      </ScrollView>
      <View className="p-4 border-t border-un1t-border">
        <Pressable onPress={save} disabled={saving || allowed.length === 0}
          className="bg-un1t-text rounded-xl py-3.5 items-center active:opacity-80 disabled:opacity-50">
          {saving ? <ActivityIndicator color="#FFFFFF" /> : <Text className="text-un1t-bg font-semibold">Save layout</Text>}
        </Pressable>
      </View>
    </View>
  )
}

function SlotChip({ label, active, onPress }) {
  return (
    <Pressable onPress={onPress}
      className={`px-3 py-2 rounded-full border ${active ? 'bg-un1t-text border-un1t-text' : 'bg-un1t-surface border-un1t-border'}`}>
      <Text className={`text-sm ${active ? 'text-un1t-bg font-semibold' : 'text-un1t-text'}`}>{label}</Text>
    </Pressable>
  )
}
