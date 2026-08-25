// Activity tab — merges the former Sessions + Progress screens behind a
// History / Trends / Records segmented control (Wave 4 IA restructure).
//
// REUSE, not rewrite: each segment renders the existing screen component
// unchanged —
//   History → <SessionsScreen /> (the old /sessions screen)
//   Trends  → <ProgressScreen focus="trends" /> (the old /progress screen)
//   Records → <ProgressScreen focus="records" /> (same screen, records floated up)
// Each embedded screen owns its own data fetch, loading + empty states, so the
// tab stays a thin wrapper. The old /sessions and /progress routes remain
// reachable (hidden from the tab bar via href:null) so every deep-link + the
// home "See all" affordances still resolve.

import { useState } from 'react'
import { View, Text, Pressable } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { SessionsScreen } from './sessions'
import { ProgressScreen } from './progress'
import { PEARL } from '../../../lib/member/brand'

const SEGMENTS = ['History', 'Trends', 'Records']

export default function Activity() {
  const [seg, setSeg] = useState('History')

  return (
    <SafeAreaView className="flex-1 bg-iron-bg" edges={['left', 'right']}>
      {/* Segmented control — Pearl-pill idiom (Afterglow resting accent): the
          active segment fills chalk-on-pearl, inactive stays quiet chrome. */}
      <View className="px-5 pt-4 pb-1">
        <View
          className="flex-row rounded-xl bg-iron-surface p-1 gap-1"
          style={{ borderWidth: 1, borderColor: '#2A2A31' }}
        >
          {SEGMENTS.map((s) => {
            const active = seg === s
            return (
              <Pressable
                key={s}
                onPress={() => setSeg(s)}
                accessibilityRole="tab"
                accessibilityState={{ selected: active }}
                style={{
                  flex: 1,
                  borderRadius: 10,
                  paddingVertical: 8,
                  alignItems: 'center',
                  backgroundColor: active ? PEARL : 'transparent',
                }}
              >
                <Text className="text-sm font-body-semibold" style={{ color: active ? '#131316' : '#B3B2AC' }}>
                  {s}
                </Text>
              </Pressable>
            )
          })}
        </View>
      </View>

      {/* Keep all three mounted? No — each does its own fetch; render only the
          active one so we never run three concurrent loads. The embedded screen
          brings its own SafeAreaView/ScrollView + states. */}
      <View className="flex-1">
        {seg === 'History' && <SessionsScreen />}
        {seg === 'Trends' && <ProgressScreen focus="trends" showHeader={false} />}
        {seg === 'Records' && <ProgressScreen focus="records" showHeader={false} />}
      </View>
    </SafeAreaView>
  )
}
