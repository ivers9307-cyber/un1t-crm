// W3 — race-day control board screen (trackside), reached from the /races
// picker.
//
// RACEDAY.1 — the board itself now lives in components/RaceControlBoard.jsx,
// shared with the contextual Race tab, so this file is only the screen chrome
// the board deliberately does not own: the title, the back button and the
// "Check in" action. Everything else — polling, the live clock, bucketing,
// start/finish/reset and the offsite read-only gate — is the component's.
import { useState, useCallback } from 'react'
import { Text, Pressable } from 'react-native'
import { useLocalSearchParams, useRouter, Stack } from 'expo-router'
import { useAuth } from '../../../lib/auth-context'
import { canMobile } from '../../../lib/permissions'
import BackHeaderLeft from '../../../components/BackHeaderLeft'
import RaceControlBoard from '../../../components/RaceControlBoard'

export default function RaceControlScreen() {
  const { id } = useLocalSearchParams()
  const { profile, activeLocation } = useAuth()
  const router = useRouter()
  const canView = canMobile(profile, 'races', activeLocation)

  // The race's name arrives inside the board's polled payload, and the header
  // is out here — so the board hands it back rather than this screen polling
  // /control-board a second time just to title itself. Identity-stable: it is
  // one of the board's effect dependencies, and an inline arrow would re-run
  // that effect on every one of its 2s renders.
  const [raceName, setRaceName] = useState(null)
  const handleRaceName = useCallback((name) => setRaceName(name), [])

  return (
    <>
      <Stack.Screen
        options={{
          title: raceName || 'Race control',
          headerLeft: () => <BackHeaderLeft label="Races" fallbackHref="/races" />,
          headerRight: () => (canView ? (
            <Pressable onPress={() => router.push(`/races/checkin/${id}`)} className="px-2 py-1 active:opacity-60">
              <Text className="text-blue-700 text-sm font-medium">Check in</Text>
            </Pressable>
          ) : null),
        }}
      />
      <RaceControlBoard eventId={id} onRaceName={handleRaceName} />
    </>
  )
}
