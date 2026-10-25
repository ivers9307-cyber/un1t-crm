// RUNWAY.1 — an upcoming week that is not built or not published. Amber inside
// 10 days, red inside 5. Draws lib/roster-runway-chip.js's view-model and
// nothing else: every decision (copy, tone, deep link) is made and tested
// there. WHO sees it is the route's call (GET /api/schedule/runway is
// manager-only at that studio; anyone else gets null and no chip).

import { Pressable, Text } from 'react-native'
import { useRouter } from 'expo-router'
import { rosterRunwayChip } from '../../lib/roster-runway-chip'

// Same recipe as the web chip: bg-<c>-500/10 with text-<c>-700.
const TONE = {
  red: { box: 'bg-red-500/10 border-red-500/30', title: 'text-red-700' },
  amber: { box: 'bg-amber-500/10 border-amber-500/30', title: 'text-amber-700' },
}

export default function RosterRunwayChip({ runway }) {
  const router = useRouter()
  const chip = rosterRunwayChip(runway)
  if (!chip) return null
  const tone = TONE[chip.tone]
  return (
    <Pressable
      onPress={() => router.push(chip.route)}
      accessibilityRole="button"
      className={`border rounded-2xl p-4 mb-3 active:opacity-80 ${tone.box}`}
    >
      <Text className={`text-sm font-semibold ${tone.title}`}>{chip.title}</Text>
      <Text className="text-xs text-un1t-subtle mt-1">{chip.detail}</Text>
    </Pressable>
  )
}
