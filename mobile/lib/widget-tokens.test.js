// mobile/lib/widget-tokens.test.js
// WIDGET.1 (Phase 2, Task 5) — pure decisions behind the widget mint/revoke
// screen (mobile/app/(staff)/settings/widgets.jsx). Written before the
// implementation (TDD) — this file is the spec for widget-tokens.js.

import { describe, it, expect } from 'vitest'
import {
  canManageWidgets,
  widgetEligibleLocations,
  defaultDeviceLabel,
  findStoredCredential,
  reconcileStoredWidgets,
} from './widget-tokens'

// Location fixtures shaped exactly like permissions.test.js's — the
// top-level `permissions.studio_management` / `permissions.device_control`
// cross-platform keys canMobile actually reads (mobile/lib/permissions.js).
const STILL_BOTH = { id: 'loc-still', name: 'Stillorgan', features: {}, permissions: { studio_management: true, device_control: true, mobile: {} } }
const HATCH_DOORS_ONLY = { id: 'loc-hatch', name: 'Hatch Street', features: {}, permissions: { studio_management: true, device_control: false, mobile: {} } }
const CITYWEST_SONOS_ONLY = { id: 'loc-citywest', name: 'Citywest', features: {}, permissions: { studio_management: false, device_control: true, mobile: {} } }
const NOWHERE_NEITHER = { id: 'loc-none', name: 'No Access', features: {}, permissions: { studio_management: false, device_control: false, mobile: {} } }

describe('canManageWidgets', () => {
  it('grants when studio_management alone is on (doors/AC widgets)', () => {
    expect(canManageWidgets({ role: 'head_coach' }, HATCH_DOORS_ONLY)).toBe(true)
  })
  it('grants when device_control alone is on (Sonos/Shelly widgets)', () => {
    expect(canManageWidgets({ role: 'head_coach' }, CITYWEST_SONOS_ONLY)).toBe(true)
  })
  it('grants when both are on', () => {
    expect(canManageWidgets({ role: 'head_coach' }, STILL_BOTH)).toBe(true)
  })
  it('denies when neither is on', () => {
    expect(canManageWidgets({ role: 'head_coach' }, NOWHERE_NEITHER)).toBe(false)
  })
  it('denies a falsy profile', () => {
    expect(canManageWidgets(null, STILL_BOTH)).toBe(false)
  })
  it('denies a falsy location', () => {
    expect(canManageWidgets({ role: 'master' }, null)).toBe(false)
  })
})

describe('widgetEligibleLocations', () => {
  const ALL = [STILL_BOTH, HATCH_DOORS_ONLY, CITYWEST_SONOS_ONLY, NOWHERE_NEITHER]

  it('keeps only locations where canManageWidgets is true, in the given order', () => {
    const result = widgetEligibleLocations({ role: 'head_coach' }, ALL)
    expect(result.map((l) => l.id)).toEqual(['loc-still', 'loc-hatch', 'loc-citywest'])
  })
  it('returns [] for a staffer with no controllable studio', () => {
    expect(widgetEligibleLocations({ role: 'staff' }, [NOWHERE_NEITHER])).toEqual([])
  })
  it('a missing/undefined locations list yields []', () => {
    expect(widgetEligibleLocations({ role: 'master' }, undefined)).toEqual([])
  })
})

describe('defaultDeviceLabel', () => {
  it('trims surrounding whitespace', () => {
    expect(defaultDeviceLabel("  Richard's iPhone  ")).toBe("Richard's iPhone")
  })
  it('a null/undefined device name defaults to an empty string, not "null"/"undefined"', () => {
    expect(defaultDeviceLabel(null)).toBe('')
    expect(defaultDeviceLabel(undefined)).toBe('')
  })
  it('a whitespace-only name collapses to empty, not sent as a blank label', () => {
    expect(defaultDeviceLabel('   ')).toBe('')
  })
  it('truncates to the server schema\'s 60-char max so a long device name never fails validation', () => {
    const long = 'A'.repeat(80)
    const result = defaultDeviceLabel(long)
    expect(result).toHaveLength(60)
    expect(result).toBe('A'.repeat(60))
  })
})

describe('findStoredCredential — mint vs re-mint', () => {
  const stillCred = { locationId: 'loc-still', locationName: 'Stillorgan', tokenId: 'tok-still', token: 'rwt_aaa' }
  const hatchCred = { locationId: 'loc-hatch', locationName: 'Hatch Street', tokenId: 'tok-hatch', token: 'rwt_bbb' }

  it('finds the credential for the resolved studio, ignoring others', () => {
    expect(findStoredCredential([stillCred, hatchCred], 'loc-hatch')).toEqual(hatchCred)
  })
  it('returns null when this studio has no stored credential yet (a plain mint)', () => {
    expect(findStoredCredential([hatchCred], 'loc-still')).toBeNull()
  })
  it('returns null for a missing locationId rather than matching a credential with an undefined locationId', () => {
    expect(findStoredCredential([stillCred], null)).toBeNull()
  })
  it('tolerates a missing stored list', () => {
    expect(findStoredCredential(undefined, 'loc-still')).toBeNull()
  })
})

describe('reconcileStoredWidgets — server vs App Group', () => {
  const stillCred = { locationId: 'loc-still', locationName: 'Stillorgan', tokenId: 'tok-still', token: 'rwt_aaa' }
  const hatchCred = { locationId: 'loc-hatch', locationName: 'Hatch Street', tokenId: 'tok-hatch', token: 'rwt_bbb' }

  it('a stored credential whose tokenId is still live on the server stays live', () => {
    const server = [{ id: 'tok-still', device_label: null, created_at: 't', last_used_at: null }]
    const { live, stale } = reconcileStoredWidgets(server, [stillCred])
    expect(live).toEqual([stillCred])
    expect(stale).toEqual([])
  })

  it('a stored credential revoked server-side (its tokenId is gone from the live list) is STALE', () => {
    // The exact scenario the task calls out: revoked from the CRM staff
    // page kills it server-side, but the App Group still holds the
    // plaintext until something reconciles.
    const server = [] // stillCred's token was revoked; server no longer lists it
    const { live, stale } = reconcileStoredWidgets(server, [stillCred])
    expect(live).toEqual([])
    expect(stale).toEqual([stillCred])
  })

  it('partitions a mix correctly — one live, one stale', () => {
    const server = [{ id: 'tok-still' }] // only Stillorgan's token is still live
    const { live, stale } = reconcileStoredWidgets(server, [stillCred, hatchCred])
    expect(live).toEqual([stillCred])
    expect(stale).toEqual([hatchCred])
  })

  it('a live server token with no local match is simply not reflected (not this function\'s concern)', () => {
    const server = [{ id: 'tok-still' }, { id: 'tok-someone-elses-device' }]
    const { live, stale } = reconcileStoredWidgets(server, [stillCred])
    expect(live).toEqual([stillCred])
    expect(stale).toEqual([])
  })

  it('no stored credentials at all → both empty, regardless of server state', () => {
    expect(reconcileStoredWidgets([{ id: 'tok-x' }], [])).toEqual({ live: [], stale: [] })
  })

  it('tolerates missing/null inputs rather than throwing', () => {
    expect(reconcileStoredWidgets(null, null)).toEqual({ live: [], stale: [] })
    expect(reconcileStoredWidgets(undefined, [stillCred])).toEqual({ live: [], stale: [stillCred] })
  })
})
