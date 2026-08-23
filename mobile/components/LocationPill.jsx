// mobile/components/LocationPill.jsx
//
// HOME-LOC.6 — the always-visible answer to "which studio am I commanding?".
// Two visual states: detected (green, from the geofence resolution) and
// manual (amber — activeLocation fallback or an explicit pick). Tapping
// opens an Alert picker over `pickable` (the caller filters by its screen's
// perm key via pickerLocations); picking calls onPick(locationId), which
// screens wire to router.setParams({ loc }) — per-visit by construction.
import { View, Text, Pressable, Alert } from 'react-native'
import { Ionicons } from '@expo/vector-icons'

export default function LocationPill({ location, source, pickable = [], onPick }) {
  const detected = source === 'detected'
  const name = location?.name || 'No location'
  const canPick = typeof onPick === 'function' && pickable.length > 1

  function openPicker() {
    if (!canPick) return
    Alert.alert('Control which studio?', 'Commands go to the studio you pick.', [
      ...pickable.map((l) => ({
        text: l.name + (l.id === location?.id ? '  ✓' : ''),
        onPress: () => onPick(l.id),
      })),
      { text: 'Cancel', style: 'cancel' },
    ])
  }

  const fg = detected ? '#047857' : '#B45309'
  return (
    <Pressable
      onPress={openPicker}
      accessibilityRole="button"
      accessibilityLabel={`Controlling ${name}, ${detected ? 'detected' : 'manual'}`}
      className="self-start mb-4"
    >
      <View
        className={`flex-row items-center rounded-full px-3 py-1.5 border ${
          detected ? 'bg-emerald-500/20 border-emerald-600/30' : 'bg-amber-500/20 border-amber-600/30'
        }`}
      >
        <Ionicons name={detected ? 'navigate' : 'hand-left-outline'} size={12} color={fg} />
        <Text className={`text-xs font-semibold ml-1.5 ${detected ? 'text-emerald-700' : 'text-amber-700'}`}>
          {name} · {detected ? 'detected' : 'manual'}
        </Text>
        {canPick ? <Ionicons name="chevron-down" size={12} color={fg} style={{ marginLeft: 4 }} /> : null}
      </View>
    </Pressable>
  )
}
