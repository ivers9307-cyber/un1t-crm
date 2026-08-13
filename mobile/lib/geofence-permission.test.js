// mobile/lib/geofence-permission.test.js
import { describe, it, expect } from 'vitest'
import { resolveGeofencePermission } from './geofence-permission'

// The OS shapes expo-location returns. `denied` + canAskAgain:false is the
// "permanently denied, send them to Settings" case.
const granted = { status: 'granted', canAskAgain: false }
const denied = { status: 'denied', canAskAgain: true }
const denyForever = { status: 'denied', canAskAgain: false }
const undetermined = { status: 'undetermined', canAskAgain: true }

describe('resolveGeofencePermission — the happy shapes', () => {
  it('background granted is "always": the gate opens and regions may register', () => {
    const r = resolveGeofencePermission({ bg: granted, fg: granted })
    expect(r).toEqual({ value: 'always', blocks: false, mayRegister: true, sendToSettings: false })
  })
  // STAFF-DEV.7's mapping, preserved deliberately: a BACKGROUND denial is
  // 'denied' even when the foreground is granted. That is the iOS "While Using"
  // shape, and it is a denial for this column's purpose (geofencing cannot
  // fire). Changing it would silently reclassify every iOS device in the CRM.
  it('background denied is "denied" even with foreground granted (iOS While Using)', () => {
    const r = resolveGeofencePermission({ bg: denied, fg: granted })
    expect(r.value).toBe('denied')
    expect(r.blocks).toBe(true)
    expect(r.mayRegister).toBe(false)
  })
  it('"when_in_use" is the Android shape: background undetermined, foreground granted', () => {
    const r = resolveGeofencePermission({ bg: undetermined, fg: granted })
    expect(r.value).toBe('when_in_use')
    expect(r.blocks).toBe(true)
    expect(r.mayRegister).toBe(false)
  })
  it('never asked is "undetermined": gated, and the button should prompt not deep-link', () => {
    const r = resolveGeofencePermission({ bg: undetermined, fg: undetermined })
    expect(r.value).toBe('undetermined')
    expect(r.blocks).toBe(true)
    expect(r.sendToSettings).toBe(false)
  })
  it('permanently denied sends the staffer to Settings', () => {
    const r = resolveGeofencePermission({ bg: denyForever, fg: denyForever })
    expect(r.value).toBe('denied')
    expect(r.blocks).toBe(true)
    expect(r.sendToSettings).toBe(true)
  })
})

// The reason this module exists. When the permission API throws, the app used
// to answer the question two different ways at once: LocationGate treated the
// error as GRANTED (gate hidden, staffer told nothing is wrong) while
// syncGeofences treated it as NOT granted (registration torn down). Net effect:
// attendance silently stops and every surface says it's fine.
describe('resolveGeofencePermission — the error path', () => {
  it('is "unknown", not a guess in either direction', () => {
    expect(resolveGeofencePermission({ error: new Error('ExpoLocation is undefined') }).value)
      .toBe('unknown')
  })
  it('does NOT block the app — an unreadable permission must never lock staff out', () => {
    expect(resolveGeofencePermission({ error: new Error('boom') }).blocks).toBe(false)
  })
  it('does NOT register regions — we cannot claim a permission we could not read', () => {
    expect(resolveGeofencePermission({ error: new Error('boom') }).mayRegister).toBe(false)
  })
  it('treats a missing bg reading as the error case, however it went missing', () => {
    expect(resolveGeofencePermission({}).value).toBe('unknown')
    expect(resolveGeofencePermission({ bg: null, fg: null }).value).toBe('unknown')
  })
  it('is reportable: "unknown" is a real value the CRM stores, not a skipped report', () => {
    // The old code returned early on a missing reading, so the CRM kept the
    // last good value forever and no operator surface could show the fault.
    const r = resolveGeofencePermission({ error: new Error('boom') })
    expect(r.value).not.toBeNull()
    expect(r.value).not.toBeUndefined()
  })
})
