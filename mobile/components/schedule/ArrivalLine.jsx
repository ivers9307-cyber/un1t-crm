// mobile/components/schedule/ArrivalLine.jsx
// ARRIVALSHOW.1 — one line under a coach's own shift: what the app recorded
// as their arrival. Words and every decision: lib/shift-arrival.js. Tone
// classes are whole literals HERE because NativeWind does not scan mobile/lib.
// Green for a recorded arrival, grey for none. Never red or amber: late and
// no-show alerts are held (00-INDEX).

import { View, Text } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { arrivalLine } from '../../lib/shift-arrival'

const TONE = {
  arrived: { icon: 'checkmark-circle-outline', color: '#15803D', text: 'text-green-700' },
  on_site: { icon: 'checkmark-circle-outline', color: '#15803D', text: 'text-green-700' },
  not_yet: { icon: 'time-outline', color: '#64748B', text: 'text-un1t-subtle' },
  not_recorded: { icon: 'remove-circle-outline', color: '#64748B', text: 'text-un1t-subtle' },
}

export default function ArrivalLine({ shift, nowMs, compact = false }) {
  const line = arrivalLine(shift, nowMs)
  if (!line) return null
  const tone = TONE[line.kind]
  return (
    <View className="flex-row items-center mt-1" accessible accessibilityLabel={line.text}>
      <Ionicons name={tone.icon} size={compact ? 11 : 13} color={tone.color} />
      <Text
        className={compact ? `text-[10px] ml-1 flex-1 ${tone.text}` : `text-xs ml-1 flex-1 ${tone.text}`}
        numberOfLines={compact ? 2 : 1}
      >
        {line.text}
      </Text>
    </View>
  )
}
