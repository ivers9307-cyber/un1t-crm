// mobile/components/StudioRoutineCard.jsx
//
// STUDIOROUTINE.1 — the "Open studio" and "Close studio" buttons at the top
// of the controls screen. One press switches the picked studio's lights,
// music and air con (mobile/lib/studio-routine.js); doors are never part of
// it. Each press asks first, because it acts on the whole studio.
import { useState } from 'react'
import { View, Text, Pressable, ActivityIndicator, Alert } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { listShellyGroups, toggleShellyGroup } from '../lib/api'
import { getSonosHousehold, sendSonosAction } from '../lib/sonos-api'
import { listAcDevices, turnOnAcDevice, turnOffAcDevice } from '../lib/studio-mgmt-api'
import { runStudioRoutine, routineSummary } from '../lib/studio-routine'

const API = {
  listShellyGroups, toggleShellyGroup, getSonosHousehold, sendSonosAction,
  listAcDevices, turnOnAcDevice, turnOffAcDevice,
}

const COPY = {
  open: { title: 'Open studio', confirm: 'Turn on the lights, music and air con', icon: 'sunny-outline', tint: '#16a34a' },
  close: { title: 'Close studio', confirm: 'Turn off the lights, music and air con', icon: 'moon-outline', tint: '#475569' },
}

export default function StudioRoutineCard({ location, can }) {
  const [running, setRunning] = useState(null)
  const [lines, setLines] = useState(null)
  if (!location || !(can?.lights || can?.music || can?.ac)) return null

  async function run(mode) {
    setRunning(mode)
    setLines(null)
    try {
      const results = await runStudioRoutine(mode, { locationId: location.id, can, api: API })
      setLines({ mode, text: routineSummary(results) })
    } catch {
      setLines({ mode, text: ['Something went wrong. Try again.'] })
    } finally {
      setRunning(null)
    }
  }

  function ask(mode) {
    const c = COPY[mode]
    Alert.alert(c.title, `${c.confirm} at ${location.name}? Doors are not touched.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: c.title, onPress: () => run(mode) },
    ])
  }

  return (
    <View className="bg-un1t-surface border border-un1t-border rounded-2xl p-4 mb-3">
      <View className="flex-row gap-3">
        {['open', 'close'].map((mode) => (
          <Pressable
            key={mode}
            onPress={() => ask(mode)}
            disabled={running != null}
            accessibilityRole="button"
            accessibilityLabel={COPY[mode].title}
            className="flex-1 flex-row items-center justify-center rounded-xl py-3 active:opacity-70"
            style={{ backgroundColor: `${COPY[mode].tint}1A`, opacity: running && running !== mode ? 0.5 : 1 }}
          >
            {running === mode
              ? <ActivityIndicator color={COPY[mode].tint} />
              : <Ionicons name={COPY[mode].icon} size={18} color={COPY[mode].tint} />}
            <Text className="ml-2 text-sm font-semibold" style={{ color: COPY[mode].tint }}>{COPY[mode].title}</Text>
          </Pressable>
        ))}
      </View>
      <Text className="text-xs text-un1t-subtle mt-2">Lights, music and air con. Doors are never touched.</Text>
      {lines && (
        <View className="mt-3" accessibilityLiveRegion="polite">
          {lines.text.map((t) => <Text key={t} className="text-xs text-un1t-text">{t}</Text>)}
        </View>
      )}
    </View>
  )
}
