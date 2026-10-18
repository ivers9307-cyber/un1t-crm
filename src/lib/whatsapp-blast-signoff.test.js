import { describe, it, expect } from 'vitest'
import {
  SIGNOFF_SETTING_KEY, signoffWindow, signoffMessage, isOrganizationAdminFor,
  routeSignoffGate, broadcastSignoffBlock, BlastSignoffRequiredError, isBlastSignoffRequired,
  readSignoffLocation,
} from './whatsapp-blast-signoff.js'

// Fictional ids only: the repo is public.
const hatch = (until, extra = {}) => ({
  id: 'loc-h', name: 'UN1T Hatch Street', organization_id: 'org1', timezone: 'Europe/Dublin',
  settings: until === undefined ? {} : { [SIGNOFF_SETTING_KEY]: until }, ...extra,
})
const at = (iso) => new Date(iso)

describe('signoffWindow', () => {
  it('is open before and on the date, in the studio zone', () => {
    expect(signoffWindow(hatch('2026-11-16'), at('2026-10-18T12:00:00Z'))).toEqual({ until: '2026-11-16' })
    // 23:30 Dublin on the 16th (GMT in November) is still inside.
    expect(signoffWindow(hatch('2026-11-16'), at('2026-11-16T23:30:00Z'))).toEqual({ until: '2026-11-16' })
  })
  it('window past → no gate', () => {
    expect(signoffWindow(hatch('2026-11-16'), at('2026-11-17T00:00:01Z'))).toBeNull()
  })
  it('uses the studio zone, not UTC, for the day boundary', () => {
    // 00:30 on the 17th in New York is 05:30Z: past for New York, still the 16th's evening there.
    const ny = hatch('2026-11-16', { timezone: 'America/New_York' })
    expect(signoffWindow(ny, at('2026-11-17T04:30:00Z'))).toEqual({ until: '2026-11-16' })
    expect(signoffWindow(ny, at('2026-11-17T05:30:00Z'))).toBeNull()
  })
  it('accepts a full timestamp and closes at that instant', () => {
    expect(signoffWindow(hatch('2026-11-16T09:00:00Z'), at('2026-11-16T08:59:00Z'))).toEqual({ until: '2026-11-16T09:00:00Z' })
    expect(signoffWindow(hatch('2026-11-16T09:00:00Z'), at('2026-11-16T09:00:00Z'))).toBeNull()
  })
  it('absent, blank or unreadable → no gate', () => {
    for (const loc of [null, hatch(undefined), hatch(''), hatch('soon'), hatch(null), { settings: null }]) {
      expect(signoffWindow(loc, at('2026-10-18T12:00:00Z'))).toBeNull()
    }
  })
})

describe('signoffMessage', () => {
  it('gives the spec copy with the date as "16 Nov 2026"', () => {
    expect(signoffMessage('UN1T Hatch Street', '2026-11-16'))
      .toBe('Blasts at UN1T Hatch Street need sign-off from an organisation admin until 16 Nov 2026.')
  })
  it("formats a timestamp's day in the studio zone", () => {
    expect(signoffMessage('UN1T Hatch Street', '2026-11-17T02:00:00Z', 'America/New_York'))
      .toBe('Blasts at UN1T Hatch Street need sign-off from an organisation admin until 16 Nov 2026.')
  })
  it('has no em-dash', () => {
    expect(signoffMessage('X', '2026-11-16')).not.toMatch(/—/)
  })
})

describe('isOrganizationAdminFor', () => {
  it('master passes; an org admin of that organisation passes; anyone else does not', () => {
    expect(isOrganizationAdminFor({ isMaster: true }, 'org1')).toBe(true)
    expect(isOrganizationAdminFor({ orgAdminOrgIds: ['org1'] }, 'org1')).toBe(true)
    expect(isOrganizationAdminFor({ orgAdminOrgIds: ['org2'] }, 'org1')).toBe(false)
    expect(isOrganizationAdminFor({ rolesByLocation: { 'loc-h': 'owner' } }, 'org1')).toBe(false)
    expect(isOrganizationAdminFor({ orgAdminOrgIds: ['org1'] }, null)).toBe(false)
    expect(isOrganizationAdminFor(null, 'org1')).toBe(false)
  })
})

describe('routeSignoffGate', () => {
  const now = at('2026-10-18T12:00:00Z')
  const manager = { id: 'u-m', rolesByLocation: { 'loc-h': 'manager' } }
  const admin = { id: 'u-a', orgAdminOrgIds: ['org1'] }
  it('manager gets the copy while the window is open', () => {
    expect(routeSignoffGate({ user: manager, location: hatch('2026-11-16'), row: { signed_off_by: null }, now }))
      .toEqual({ blocked: 'Blasts at UN1T Hatch Street need sign-off from an organisation admin until 16 Nov 2026.' })
  })
  it('a manager may send a broadcast an org admin already signed off', () => {
    expect(routeSignoffGate({ user: manager, location: hatch('2026-11-16'), row: { signed_off_by: 'u-a' }, now })).toEqual({})
  })
  it("an org admin's action stamps the row", () => {
    expect(routeSignoffGate({ user: admin, location: hatch('2026-11-16'), row: { signed_off_by: null }, now }))
      .toEqual({ stamp: { signed_off_by: 'u-a', signed_off_at: now.toISOString() } })
  })
  it('window past → no gate and no stamp', () => {
    expect(routeSignoffGate({ user: manager, location: hatch('2026-10-01'), row: null, now })).toEqual({})
    expect(routeSignoffGate({ user: admin, location: hatch('2026-10-01'), row: null, now })).toEqual({})
  })
})

describe('broadcastSignoffBlock', () => {
  const now = at('2026-10-18T12:00:00Z')
  it('refuses an unsigned broadcast while the window is open', () => {
    expect(broadcastSignoffBlock(hatch('2026-11-16'), { signed_off_by: null }, now)).toMatch(/^Blasts at UN1T Hatch Street need sign-off/)
  })
  it('a signed broadcast, or no window, sends', () => {
    expect(broadcastSignoffBlock(hatch('2026-11-16'), { signed_off_by: 'u-a' }, now)).toBeNull()
    expect(broadcastSignoffBlock(hatch(undefined), { signed_off_by: null }, now)).toBeNull()
  })
})

describe('BlastSignoffRequiredError', () => {
  it('is a typed refusal judged by its code', () => {
    const e = new BlastSignoffRequiredError('msg')
    expect(e.message).toBe('msg')
    expect(isBlastSignoffRequired(e)).toBe(true)
    expect(isBlastSignoffRequired({ code: 'WA_BLAST_SIGNOFF' })).toBe(true)
    expect(isBlastSignoffRequired(new Error('msg'))).toBe(false)
  })
})

describe('readSignoffLocation', () => {
  const dbWith = (result) => {
    const calls = {}
    const b = {
      select: (cols) => { calls.cols = cols; return b },
      eq: (c, v) => { calls.eq = [c, v]; return b },
      maybeSingle: async () => result,
    }
    return { calls, db: { from: (t) => { calls.table = t; return b } } }
  }
  it('reads the studio by id', async () => {
    const { db, calls } = dbWith({ data: hatch('2026-11-16'), error: null })
    expect((await readSignoffLocation(db, 'loc-h')).name).toBe('UN1T Hatch Street')
    expect(calls).toMatchObject({ table: 'locations', eq: ['id', 'loc-h'] })
    expect(calls.cols).toBe('id, name, organization_id, timezone, settings')
  })
  it('throws on a failed read (the gate fails closed)', async () => {
    const { db } = dbWith({ data: null, error: { message: 'boom' } })
    await expect(readSignoffLocation(db, 'loc-h')).rejects.toThrow(/sign-off/)
  })
})
