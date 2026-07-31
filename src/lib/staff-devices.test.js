// src/lib/staff-devices.test.js
import { describe, it, expect } from 'vitest'
import {
  compareVersions, parseVersion, currentDevice, isStale, deriveTargetVersion,
  deviceVerdict, STALE_AFTER_DAYS,
} from './staff-devices.js'

const T0 = Date.parse('2026-07-31T12:00:00Z')
const daysAgo = (n) => new Date(T0 - n * 86400_000).toISOString()
const dev = (over = {}) => ({
  id: 'd1', user_id: 'u1', platform: 'ios', device_name: 'iPhone',
  app_version: '2.1.0', last_seen_at: daysAgo(0), ...over,
})

describe('parseVersion / compareVersions', () => {
  it('orders normal semver', () => {
    expect(compareVersions('2.2.0', '2.1.0')).toBeGreaterThan(0)
    expect(compareVersions('2.1.0', '2.2.0')).toBeLessThan(0)
    expect(compareVersions('2.2.0', '2.2.0')).toBe(0)
  })
  it('compares numerically, not lexically (10 > 9)', () => {
    expect(compareVersions('2.10.0', '2.9.0')).toBeGreaterThan(0)
  })
  it('treats missing minor/patch as zero', () => {
    expect(compareVersions('2', '2.0.0')).toBe(0)
    expect(compareVersions('2.1', '2.1.0')).toBe(0)
  })
  it('sorts junk lowest and never equal to a real version', () => {
    for (const junk of [null, undefined, '', '   ', 'abc', 'v-x']) {
      expect(compareVersions(junk, '0.0.1')).toBeLessThan(0)
    }
    expect(parseVersion('nonsense')).toBeNull()
  })
  it('tolerates a leading v and build suffixes', () => {
    expect(compareVersions('v2.2.0', '2.2.0')).toBe(0)
    expect(compareVersions('2.2.0-beta.1', '2.2.0')).toBe(0) // prerelease ignored, by design
  })
})

describe('currentDevice', () => {
  it('picks the most recently seen row', () => {
    const older = dev({ id: 'old', last_seen_at: daysAgo(40), app_version: '1.4.0' })
    const newer = dev({ id: 'new', last_seen_at: daysAgo(1), app_version: '2.1.0' })
    expect(currentDevice([older, newer]).id).toBe('new')
  })
  it('returns null for no devices', () => {
    expect(currentDevice([])).toBeNull()
    expect(currentDevice(null)).toBeNull()
  })
  it('ignores rows with no last_seen_at rather than crashing', () => {
    expect(currentDevice([dev({ id: 'x', last_seen_at: null })]).id).toBe('x')
  })
})

describe('isStale', () => {
  it(`flags devices unseen for more than ${STALE_AFTER_DAYS} days`, () => {
    expect(isStale(dev({ last_seen_at: daysAgo(STALE_AFTER_DAYS + 1) }), T0)).toBe(true)
    expect(isStale(dev({ last_seen_at: daysAgo(1) }), T0)).toBe(false)
  })
})

describe('deriveTargetVersion', () => {
  it('is the highest version among non-stale devices', () => {
    expect(deriveTargetVersion([
      dev({ app_version: '2.2.0' }), dev({ app_version: '2.1.0' }),
    ], T0)).toBe('2.2.0')
  })
  it('ignores stale devices, so an abandoned beta cannot set the bar', () => {
    expect(deriveTargetVersion([
      dev({ app_version: '9.9.9', last_seen_at: daysAgo(STALE_AFTER_DAYS + 5) }),
      dev({ app_version: '2.1.0' }),
    ], T0)).toBe('2.1.0')
  })
  it('returns null when there is nothing to go on', () => {
    expect(deriveTargetVersion([], T0)).toBeNull()
    expect(deriveTargetVersion([dev({ app_version: 'junk' })], T0)).toBeNull()
  })
})

describe('deviceVerdict', () => {
  const target = '2.2.0'
  it('no_device when the staff member has no rows', () => {
    expect(deviceVerdict([], target, T0).kind).toBe('no_device')
  })
  it('outdated when the current device is below target', () => {
    const v = deviceVerdict([dev({ app_version: '2.1.0' })], target, T0)
    expect(v.kind).toBe('outdated')
    expect(v.version).toBe('2.1.0')
  })
  it('current when the current device matches target', () => {
    expect(deviceVerdict([dev({ app_version: '2.2.0' })], target, T0).kind).toBe('current')
  })
  it('keys off the newest device, not the best version', () => {
    // Old iPad on a newer build must NOT mask a downgraded daily phone.
    const v = deviceVerdict([
      dev({ id: 'ipad', app_version: '2.2.0', last_seen_at: daysAgo(40) }),
      dev({ id: 'phone', app_version: '2.1.0', last_seen_at: daysAgo(0) }),
    ], target, T0)
    expect(v.kind).toBe('outdated')
    expect(v.deviceId).toBe('phone')
  })
  it('unknown_version when the current device reported no version', () => {
    expect(deviceVerdict([dev({ app_version: null })], target, T0).kind).toBe('unknown_version')
  })
  it('never reports outdated when there is no target to compare against', () => {
    expect(deviceVerdict([dev({ app_version: '2.1.0' })], null, T0).kind).toBe('current')
  })
})
