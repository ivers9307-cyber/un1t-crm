import { describe, it, expect } from 'vitest'
import { un1tWriteSettingsFrom, readUn1tWriteSettings, Un1tSettingsReadError } from './un1t-online-settings.js'

const OFF = {
  writesEnabled: false,
  funnelEnabled: false,
  trialProductId: null,
  hiddenClassKeywords: [],
  sendsWelcome: false,
  welcomeSetsPassword: false,
  sendsBookingConfirmation: false,
}

describe('un1tWriteSettingsFrom', () => {
  it('defaults everything off for empty, null and non-object settings', () => {
    expect(un1tWriteSettingsFrom({})).toEqual(OFF)
    expect(un1tWriteSettingsFrom(null)).toEqual(OFF)
    expect(un1tWriteSettingsFrom(undefined)).toEqual(OFF)
    expect(un1tWriteSettingsFrom('x')).toEqual(OFF)
    expect(un1tWriteSettingsFrom({ un1t_online: 'x' })).toEqual(OFF)
  })

  it('writes off forces funnel off; only literal true counts', () => {
    expect(un1tWriteSettingsFrom({ un1t_online: { funnel_enabled: true } }).funnelEnabled).toBe(false)
    expect(un1tWriteSettingsFrom({ un1t_online: { writes_enabled: false, funnel_enabled: true } }).funnelEnabled).toBe(false)
    expect(un1tWriteSettingsFrom({ un1t_online: { writes_enabled: true, funnel_enabled: true } })).toMatchObject({
      writesEnabled: true,
      funnelEnabled: true,
    })
    expect(un1tWriteSettingsFrom({ un1t_online: { writes_enabled: true } }).funnelEnabled).toBe(false)
    for (const v of ['true', 'yes', 1, 'on', {}, [], null]) {
      const s = un1tWriteSettingsFrom({
        un1t_online: {
          writes_enabled: v,
          funnel_enabled: v,
          un1t_sends_welcome: v,
          un1t_welcome_sets_password: v,
          un1t_sends_booking_confirmation: v,
        },
      })
      expect(s).toEqual(OFF)
    }
    // Writes on, the flags are each literal-true only.
    const on = un1tWriteSettingsFrom({
      un1t_online: {
        writes_enabled: true,
        un1t_sends_welcome: true,
        un1t_welcome_sets_password: 'true',
        un1t_sends_booking_confirmation: true,
      },
    })
    expect(on.sendsWelcome).toBe(true)
    expect(on.welcomeSetsPassword).toBe(false)
    expect(on.sendsBookingConfirmation).toBe(true)
  })

  it('reads the trial product id as a trimmed non-empty string, else null', () => {
    const f = (v) => un1tWriteSettingsFrom({ un1t_online: { trial_product_id: v } }).trialProductId
    expect(f('prod-1')).toBe('prod-1')
    expect(f('  prod-1 ')).toBe('prod-1')
    expect(f('')).toBeNull()
    expect(f('   ')).toBeNull()
    expect(f(null)).toBeNull()
    expect(f(42)).toBeNull()
  })

  it('parses hidden class keywords with the public listing parser (string or list)', () => {
    const f = (v) => un1tWriteSettingsFrom({ un1t_online: { hidden_class_keywords: v } }).hiddenClassKeywords
    expect(f('Elites, members only\nOpen Gym')).toEqual(['elites', 'members only', 'open gym'])
    expect(f(['  Elites ', '', 'HYROX'])).toEqual(['elites', 'hyrox'])
    expect(f(undefined)).toEqual([])
    expect(f(7)).toEqual([])
  })

  it('ignores the glofox block and every other settings key', () => {
    const s = un1tWriteSettingsFrom({ glofox: { hidden_class_keywords: 'x', writes_enabled: true }, writes_enabled: true })
    expect(s).toEqual(OFF)
  })
})

// A fake db: from('locations').select(cols).eq('id', id).maybeSingle()
function fakeDb({ row = null, error = null, throws = null } = {}) {
  const calls = []
  return {
    calls,
    from(table) {
      const call = { table, select: null, eq: [] }
      calls.push(call)
      const api = {
        select(cols) { call.select = cols; return api },
        eq(c, v) { call.eq.push([c, v]); return api },
        maybeSingle() {
          if (throws) throw throws
          return Promise.resolve({ data: row, error })
        },
      }
      return api
    },
  }
}

describe('readUn1tWriteSettings', () => {
  it('returns the location facts and the parsed settings, reading named columns by id', async () => {
    const db = fakeDb({
      row: {
        id: 'loc-1',
        name: 'Hatch Street',
        organization_id: 'org-1',
        membership_source: 'un1t_online',
        settings: { un1t_online: { writes_enabled: true, trial_product_id: 'prod-9' } },
      },
    })
    const out = await readUn1tWriteSettings(db, 'loc-1')
    expect(out).toEqual({
      membershipSource: 'un1t_online',
      studioName: 'Hatch Street',
      organizationId: 'org-1',
      settings: { ...OFF, writesEnabled: true, trialProductId: 'prod-9' },
    })
    expect(db.calls).toHaveLength(1)
    expect(db.calls[0].table).toBe('locations')
    expect(db.calls[0].eq).toEqual([['id', 'loc-1']])
    expect(db.calls[0].select).not.toContain('*')
  })

  it('a location with no settings key reads as everything off', async () => {
    const db = fakeDb({ row: { id: 'loc-1', name: 'X', organization_id: 'org-1', membership_source: 'none', settings: null } })
    const out = await readUn1tWriteSettings(db, 'loc-1')
    expect(out.settings).toEqual(OFF)
    expect(out.membershipSource).toBe('none')
  })

  it('throws Un1tSettingsReadError on a read error, carrying the code and no row text', async () => {
    const db = fakeDb({ error: { code: '57014', message: 'canceling statement', details: 'secret detail' } })
    const err = await readUn1tWriteSettings(db, 'loc-1').catch((e) => e)
    expect(err).toBeInstanceOf(Un1tSettingsReadError)
    expect(err.name).toBe('Un1tSettingsReadError')
    expect(err.code).toBe('57014')
    expect(err.message).not.toContain('secret detail')
  })

  it('throws Un1tSettingsReadError on a missing row, never defaults it to off', async () => {
    const db = fakeDb({ row: null })
    await expect(readUn1tWriteSettings(db, 'loc-1')).rejects.toBeInstanceOf(Un1tSettingsReadError)
  })

  it('throws Un1tSettingsReadError when the client itself throws', async () => {
    const db = fakeDb({ throws: new Error('network down') })
    await expect(readUn1tWriteSettings(db, 'loc-1')).rejects.toBeInstanceOf(Un1tSettingsReadError)
  })

  it('throws Un1tSettingsReadError on a missing location id, before any read', async () => {
    const db = fakeDb({})
    await expect(readUn1tWriteSettings(db, '')).rejects.toBeInstanceOf(Un1tSettingsReadError)
    expect(db.calls).toHaveLength(0)
  })
})
