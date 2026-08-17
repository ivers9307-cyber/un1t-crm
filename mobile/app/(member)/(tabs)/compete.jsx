// Compete tab — the former Challenges screen + the friends Boards, behind a
// Challenges / Boards segmented control (Wave 4 IA restructure).
//
// REUSE, not rewrite:
//   Challenges → <ChallengesScreen showBack={false} /> (the old /challenges
//                screen: consistency board, collective + individual challenges
//                with the Everyone/Friends toggle, and the monthly gym board).
//   Boards     → <BoardsPanel /> (the friends monthly-points leaderboard already
//                used by the Social screen's Boards segment).
// The old /challenges route stays reachable (the `challenge` push deep-links
// there) via app/challenges.jsx's default export.

import { useState } from 'react'
import { View, Text, Pressable, ScrollView } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { ChallengesScreen } from '../challenges'
import BoardsPanel from '../../../components/member/BoardsPanel'
import { PEARL } from '../../../lib/member/brand'

const SEGMENTS = ['Challenges', 'Boards']

export default function Compete() {
  const [seg, setSeg] = useState('Challenges')

  const segmentedControl = (
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
              <Text className="font-body-semibold" style={{ fontSize: 14, color: active ? '#131316' : '#B3B2AC' }}>
                {s}
              </Text>
            </Pressable>
          )
        })}
      </View>
    </View>
  )

  // Challenges brings its own SafeAreaView + ScrollView + states, so render it
  // directly under the control. Boards is a plain panel → wrap it in a scroll
  // view with the same page padding the other tabs use.
  return (
    <SafeAreaView className="flex-1 bg-iron-bg" edges={['left', 'right']}>
      {segmentedControl}
      <View className="flex-1">
        {seg === 'Challenges' ? (
          <ChallengesScreen showBack={false} />
        ) : (
          <ScrollView contentContainerClassName="p-5 pb-24">
            <BoardsPanel />
          </ScrollView>
        )}
      </View>
    </SafeAreaView>
  )
}
