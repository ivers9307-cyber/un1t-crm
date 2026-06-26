import { describe, it, expect } from 'vitest'
import { resolveUnifiLocation, unifiControllerId } from './unifi-webhook.js'

const A = { id: 'loc-a', settings: { unifi: { host: '10.0.0.1', controller_id: 'ctrl-A' } } }
const B = { id: 'loc-b', settings: { unifi_protect: { host: '10.0.0.2', controller_id: 'ctrl-B' } } }

describe('resolveUnifiLocation', () => {
  it('matches the right location by controller_id when several exist', () => {
    expect(resolveUnifiLocation([A, B], 'ctrl-B')).toBe(B)
    expect(resolveUnifiLocation([A, B], 'ctrl-A')).toBe(A)
  })

  it('matches by host or site_id too', () => {
    expect(resolveUnifiLocation([A, B], '10.0.0.2')).toBe(B)
    const C = { id: 'loc-c', settings: { unifi: { site_id: 'site-9', host: 'x' } } }
    expect(resolveUnifiLocation([A, C], 'site-9')).toBe(C)
  })

  it('falls back to the single configured location (today, unchanged)', () => {
    expect(resolveUnifiLocation([A], null)).toBe(A)
    expect(resolveUnifiLocation([A], 'unknown-controller')).toBe(A)
  })

  it('returns null when ambiguous and no id match (does not pick wrongly)', () => {
    expect(resolveUnifiLocation([A, B], null)).toBeNull()
    expect(resolveUnifiLocation([A, B], 'no-such-controller')).toBeNull()
  })

  it('returns null for no candidates', () => {
    expect(resolveUnifiLocation([], 'ctrl-A')).toBeNull()
    expect(resolveUnifiLocation(undefined, null)).toBeNull()
  })
})

describe('unifiControllerId', () => {
  it('reads payload-level identifiers', () => {
    expect(unifiControllerId({ controller_id: 'c1' })).toBe('c1')
    expect(unifiControllerId({ host: 'h1' })).toBe('h1')
    expect(unifiControllerId({ nvr_mac: 'aa:bb' })).toBe('aa:bb')
  })

  it('falls back to the first event location UUID', () => {
    expect(unifiControllerId({ events: [{ location: 'site-uuid' }] })).toBe('site-uuid')
  })

  it('returns null when nothing identifies the controller', () => {
    expect(unifiControllerId({})).toBeNull()
    expect(unifiControllerId(null)).toBeNull()
  })
})
