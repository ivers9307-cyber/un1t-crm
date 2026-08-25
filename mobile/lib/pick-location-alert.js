// mobile/lib/pick-location-alert.js
//
// HOME-LOC.8b — the ONE "Control which studio?" Alert. LocationPill and
// Home's remote "Studio controls" row both open it, so the copy, the ✓
// current-selection marker and the Android caveat below live in a single
// place rather than drifting between two hand-rolled copies (they already
// had: only the pill's version marked the current studio).
//
// Deliberately NOT in control-location.js — that module is documented
// native-import-free so vitest can run it in Node, and `Alert` is a
// react-native import. No test file here for the same reason; the decision
// of WHETHER there is anything worth picking is canPickLocation()'s, and
// that is covered in control-location.test.js.
//
// Android's Alert.alert silently caps at 3 buttons total, and a `cancel`
// button is appended last — so a third pickable studio would push Cancel
// off and the picker would just lose it, no error. Fine at today's
// 2-location fleet; swap this Alert for an ActionSheet before a third
// studio goes live.

import { Alert } from 'react-native'

/**
 * @param {object[]} pickable   locations to offer ({ id, name }).
 * @param {string} [currentId]  the location currently in force — gets a ✓.
 *   Omit where nothing is "current" yet (Home's remote launcher).
 * @param {(locationId: string) => void} onPick
 */
export function promptLocationPick({ pickable, currentId, onPick }) {
  const options = Array.isArray(pickable) ? pickable : []
  if (options.length === 0 || typeof onPick !== 'function') return
  Alert.alert('Control which studio?', 'Commands go to the studio you pick.', [
    ...options.map((l) => ({
      text: l.name + (currentId && l.id === currentId ? '  ✓' : ''),
      onPress: () => onPick(l.id),
    })),
    { text: 'Cancel', style: 'cancel' },
  ])
}
