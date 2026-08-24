// src/lib/staff-devices.test.js
import { describe, it, expect } from 'vitest'
import {
  compareVersions, parseVersion, currentDevice, isStale, deriveTargetVersion,
  deviceVerdict, pushHealthStatus, PUSH_HEALTHY_DAYS, STALE_AFTER_DAYS,
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
  it('rejects absurd segments — a client cannot poison the fleet target', () => {
    // app_version is client-reported; an unbounded number here would make
    // every other staff member "outdated" and, via the nudge, push-spammed.
    expect(parseVersion('9'.repeat(40))).toBeNull()
    expect(parseVersion('1.' + '9'.repeat(40) + '.0')).toBeNull()
    expect(parseVersion('10000.0.0')).toBeNull()
    expect(parseVersion('9999.9999.9999')).toEqual([9999, 9999, 9999])
    expect(compareVersions('9'.repeat(40), '2.1.0')).toBeLessThan(0)
  })
  it('truncates a 4th segment rather than treating it as newer', () => {
    expect(compareVersions('2.2.0.1', '2.2.0')).toBe(0)
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
  it('throws when the clock is not injected, rather than calling everything fresh', () => {
    expect(() => isStale(dev(), undefined)).toThrow(TypeError)
    expect(() => isStale(dev(), Number.NaN)).toThrow(/epoch ms/)
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
  it('cannot be poisoned by an absurd client-reported version', () => {
    expect(deriveTargetVersion([
      dev({ id: 'evil', app_version: '9'.repeat(40) }),
      dev({ id: 'real', app_version: '2.1.0' }),
    ], T0)).toBe('2.1.0')
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

describe('pushHealthStatus — ANDROID-VIS.1b', () => {
  const tok = (over = {}) => dev({ expo_push_token: 'ExponentPushToken[x]', ...over })

  it('is red with no devices at all', () => {
    expect(pushHealthStatus([], T0)).toMatchObject({ kind: 'red', label: 'No app' })
  })

  it('is green for a recently-seen device WITH a push token', () => {
    expect(pushHealthStatus([tok()], T0)).toMatchObject({ kind: 'green', label: 'Healthy' })
  })

  it('is amber/Stale for a token-holding device not seen in a fortnight', () => {
    const s = pushHealthStatus([tok({ last_seen_at: daysAgo(PUSH_HEALTHY_DAYS + 1) })], T0)
    expect(s).toMatchObject({ kind: 'amber', label: 'Stale' })
  })

  it('is "Visible, no push" when the device reports but holds NO token', () => {
    // The confident lie this fixes: a token-less Android row rendered
    // 🟢 Healthy on the ONE page that answers "did push reach this phone",
    // next to a live Send-test-push button that could never work.
    const s = pushHealthStatus([tok({ expo_push_token: null })], T0)
    expect(s.kind).toBe('nopush')
    expect(s.label).toBe('Visible, no push')
    expect(s.canPush).toBe(false)
  })

  it('treats a MISSING expo_push_token key the same as an explicit null', () => {
    // Callers that forgot to select the column must not read as healthy.
    const s = pushHealthStatus([dev()], T0)
    expect(s.kind).toBe('nopush')
  })

  it('is healthy when ANY device has a token, even beside a token-less one', () => {
    const s = pushHealthStatus([tok({ expo_push_token: null }), tok()], T0)
    expect(s).toMatchObject({ kind: 'green', canPush: true })
  })

  it('ranks no-push ABOVE staleness — unreachable is the more useful fact', () => {
    const s = pushHealthStatus(
      [tok({ expo_push_token: null, last_seen_at: daysAgo(PUSH_HEALTHY_DAYS + 5) })], T0)
    expect(s.kind).toBe('nopush')
  })

  it('marks canPush on every reachable state and nowhere else', () => {
    expect(pushHealthStatus([tok()], T0).canPush).toBe(true)
    expect(pushHealthStatus([tok({ last_seen_at: daysAgo(99) })], T0).canPush).toBe(true)
    expect(pushHealthStatus([], T0).canPush).toBe(false)
    expect(pushHealthStatus([tok({ expo_push_token: null })], T0).canPush).toBe(false)
  })

  it('is red when devices exist but none ever reported a last_seen_at', () => {
    expect(pushHealthStatus([tok({ last_seen_at: null })], T0).kind).toBe('red')
  })
})
