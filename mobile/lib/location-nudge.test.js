import { describe, it, expect } from 'vitest'
import { shouldShowLocationNudge, hasOnSiteFeatures } from './location-nudge'

const BASE = {
  physStatus: 'offsite',
  foregroundPermission: 'ask',
  dismissed: false,
  onSiteFeatures: true,
  isKiosk: false,
  hasRegions: true,
}

describe('shouldShowLocationNudge', () => {
  it('shows for offsite/unknown when permission is askable or settings-bound', () => {
    expect(shouldShowLocationNudge(BASE)).toBe(true)
    expect(shouldShowLocationNudge({ ...BASE, physStatus: 'unknown' })).toBe(true)
    expect(shouldShowLocationNudge({ ...BASE, foregroundPermission: 'settings' })).toBe(true)
  })
  it('never shows while detection is running or when already on-site', () => {
    expect(shouldShowLocationNudge({ ...BASE, physStatus: 'loading' })).toBe(false)
    expect(shouldShowLocationNudge({ ...BASE, physStatus: 'at_studio' })).toBe(false)
  })
  it('never shows when permission is granted (being offsite is not a fault)', () => {
    expect(shouldShowLocationNudge({ ...BASE, foregroundPermission: 'granted' })).toBe(false)
  })
  it("never shows on an unreadable permission ('unknown' — API fault, not a user choice)", () => {
    expect(shouldShowLocationNudge({ ...BASE, foregroundPermission: 'unknown' })).toBe(false)
  })
  it('respects the sticky dismissal', () => {
    expect(shouldShowLocationNudge({ ...BASE, dismissed: true })).toBe(false)
  })
  it('hidden when no studio has a configured geofence — granting could not deliver the on-site Home', () => {
    expect(shouldShowLocationNudge({ ...BASE, hasRegions: false })).toBe(false)
    expect(shouldShowLocationNudge({ ...BASE, hasRegions: undefined })).toBe(false)
  })
  it('hidden on kiosks and for users with nothing to unlock', () => {
    expect(shouldShowLocationNudge({ ...BASE, isKiosk: true })).toBe(false)
    expect(shouldShowLocationNudge({ ...BASE, onSiteFeatures: false })).toBe(false)
  })
})

describe('hasOnSiteFeatures', () => {
  // master short-circuits every tile gate; staff holds only class_timer by
  // default — both still count as "something to unlock". A profile with no
  // tiles anywhere does not.
  const STILL = { id: 'loc-still', name: 'Stillorgan' }
  it('true when ANY assigned location yields at least one tile', () => {
    const master = { role: 'master', permissions: {} }
    expect(hasOnSiteFeatures(master, [STILL])).toBe(true)
    const staff = { role: 'staff', permissions: {} } // class_timer defaults on
    expect(hasOnSiteFeatures(staff, [STILL])).toBe(true)
  })
  it('false when no location yields a tile', () => {
    const staff = { role: 'staff', permissions: {} }
    const gated = [{ id: 'x', features: { class_timer: false }, permissions: {}, roleTemplate: {} }]
    expect(hasOnSiteFeatures(staff, gated)).toBe(false)
    expect(hasOnSiteFeatures(null, [STILL])).toBe(false)
    expect(hasOnSiteFeatures(staff, [])).toBe(false)
    expect(hasOnSiteFeatures(staff, undefined)).toBe(false)
  })
})
