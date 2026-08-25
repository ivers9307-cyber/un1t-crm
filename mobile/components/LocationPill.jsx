// mobile/components/LocationPill.jsx
//
// HOME-LOC.6 — the always-visible answer to "which studio am I commanding?".
// THREE visual states: detected (green, from the geofence resolution),
// manual (amber — activeLocation fallback or an explicit pick), and
// detecting (grey, HOME-LOC.10b). Tapping opens an Alert picker over
// `pickable` (the caller filters by its screen's perm key via
// pickerLocations); picking calls onPick(locationId), which screens wire to
// router.setParams({ loc }) — per-visit by construction.
//
// `detecting` is the honest label for the window where a control screen is
// already usable but the geofence answer has NOT landed: resolution has
// fallen back to activeLocation, and it may flip to a detected studio a beat
// later. Without it that flip is a silent surprise — an amber "manual" pill
// turning green under a thumb already reaching for a button — and the denial
// branch appears to flash for no reason. It labels the flip rather than
// preventing it: screens deliberately do NOT block on detection, and the
// picker stays live throughout, because an override during detection is the
// user telling us the answer we are still looking for. Callers pass
// `detecting={phys.status === 'loading' && !overrideId}` — an explicit ?loc=
// override needs no detection, so it is never "detecting".
//
// Colouring here is by STATE (detected/manual/detecting), deliberately NOT
// the per-location identity-chip palette from shared/location-colors — this
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

export default function LocationPill({ location, source, pickable = [], onPick, className, detecting = false }) {
  // `detecting` outranks `source`: during the loading window the resolver
  // reports 'manual' (the activeLocation fallback), and painting that amber
  // is the very claim this state exists to withhold.
  const detected = !detecting && source === 'detected'
  const canPick = typeof onPick === 'function' && canPickLocation(pickable, location?.id)
  const displayName = location?.name || (canPick ? 'Pick a studio' : 'No location')

  function openPicker() {
    if (!canPick) return
    promptLocationPick({ pickable, currentId: location?.id, onPick })
  }

  // Full literal class strings per branch, never interpolated fragments —
  // NativeWind's compiler only sees classes that appear whole in the source.
  const fg = detecting ? '#334155' : detected ? '#047857' : '#B45309'
  const chipClassName = detecting
    ? 'bg-slate-500/20 border-slate-600/30'
    : detected ? 'bg-emerald-500/20 border-emerald-600/30' : 'bg-amber-500/20 border-amber-600/30'
  const textClassName = detecting ? 'text-slate-700' : detected ? 'text-emerald-700' : 'text-amber-700'
  const iconName = detecting ? 'locate-outline' : detected ? 'navigate' : 'hand-left-outline'
  const stateLabel = detecting ? 'detecting…' : detected ? 'detected' : 'manual'
  const layoutClassName = className || 'self-start mb-4'
  return (
    <Pressable
      onPress={openPicker}
      disabled={!canPick}
      accessibilityRole="button"
      accessibilityLabel={location
        ? `Controlling ${displayName}, ${detecting ? 'detecting' : detected ? 'detected' : 'manual'}`
        : 'No studio selected'}
      className={`${layoutClassName} ${canPick ? 'active:opacity-70' : ''}`}
    >
      <View className={`flex-row items-center rounded-full px-3 py-1.5 border ${chipClassName}`}>
        <Ionicons name={iconName} size={12} color={fg} />
        <Text className={`text-xs font-semibold ml-1.5 ${textClassName}`}>
          {displayName} · {stateLabel}
        </Text>
        {canPick ? <Ionicons name="chevron-down" size={12} color={fg} style={{ marginLeft: 4 }} /> : null}
      </View>
    </Pressable>
  )
}
