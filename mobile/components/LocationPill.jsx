// mobile/components/LocationPill.jsx
//
// HOME-LOC.6 — the always-visible answer to "which studio am I commanding?".
// Two visual states: detected (green, from the geofence resolution) and
// manual (amber — activeLocation fallback or an explicit pick). Tapping
// opens an Alert picker over `pickable` (the caller filters by its screen's
// perm key via pickerLocations); picking calls onPick(locationId), which
// screens wire to router.setParams({ loc }) — per-visit by construction.
//
// Colouring here is by STATE (detected/manual), deliberately NOT the
// per-location identity-chip palette from shared/location-colors — this
// pill answers "how was this decided", not "which studio, visually". One
// consequence worth knowing: re-picking the currently-detected studio from
// the Alert still flips the label to manual — they DID pick it manually,
// even though the outcome matches what geofencing would have said anyway.
//
// The Alert itself is promptLocationPick (HOME-LOC.8b) — shared with Home's
// remote "Studio controls" row, which carries the Android 3-button caveat.
import { View, Text, Pressable } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { canPickLocation } from '../lib/control-location'
import { promptLocationPick } from '../lib/pick-location-alert'

export default function LocationPill({ location, source, pickable = [], onPick, className }) {
  const detected = source === 'detected'
  const canPick = typeof onPick === 'function' && canPickLocation(pickable, location?.id)
  const displayName = location?.name || (canPick ? 'Pick a studio' : 'No location')

  function openPicker() {
    if (!canPick) return
    promptLocationPick({ pickable, currentId: location?.id, onPick })
  }

  const fg = detected ? '#047857' : '#B45309'
  const layoutClassName = className || 'self-start mb-4'
  return (
    <Pressable
      onPress={openPicker}
      disabled={!canPick}
      accessibilityRole="button"
      accessibilityLabel={location ? `Controlling ${displayName}, ${detected ? 'detected' : 'manual'}` : 'No studio selected'}
      className={`${layoutClassName} ${canPick ? 'active:opacity-70' : ''}`}
    >
      <View
        className={`flex-row items-center rounded-full px-3 py-1.5 border ${
          detected ? 'bg-emerald-500/20 border-emerald-600/30' : 'bg-amber-500/20 border-amber-600/30'
        }`}
      >
        <Ionicons name={detected ? 'navigate' : 'hand-left-outline'} size={12} color={fg} />
        <Text className={`text-xs font-semibold ml-1.5 ${detected ? 'text-emerald-700' : 'text-amber-700'}`}>
          {displayName} · {detected ? 'detected' : 'manual'}
        </Text>
        {canPick ? <Ionicons name="chevron-down" size={12} color={fg} style={{ marginLeft: 4 }} /> : null}
      </View>
    </Pressable>
  )
}
