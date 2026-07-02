// Tests for src/lib/inbody-location-scope.js (security audit W2-H / M1).
//
// The leak these guard: a bridge for location A must never see/ingest location
// B's InBody data. inbody_webhook_events.location_id is NULL until ingest, so
// scoping keys off `account` (locations.settings.inbody.accounts).

import { describe, it, expect } from 'vitest'
import {
  normaliseInbodyAccount,
  inbodyAccountsForLocation,
  bridgeInbodyScope,
  eventAccountMatchesScope,
  isPhoneShaped,
} from './inbody-location-scope.js'

// Minimal locations mock: returns the settings for a given id.
function makeDb(byId = {}) {
  return {
    from(table) {
      if (table !== 'locations') return {}
      return {
        select: () => ({
          eq: (_col, id) => ({
            maybeSingle: () =>
              Promise.resolve(
                id in byId ? { data: { settings: byId[id] }, error: null } : { data: null, error: null },
              ),
          }),
        }),
      }
    },
  }
}

describe('normaliseInbodyAccount', () => {
  it('lower-cases and trims', () => {
    expect(normaliseInbodyAccount('  StillorganUN1T ')).toBe('stillorganun1t')
  })
  it('returns null for empty/nullish', () => {
    expect(normaliseInbodyAccount(null)).toBeNull()
    expect(normaliseInbodyAccount('')).toBeNull()
    expect(normaliseInbodyAccount('   ')).toBeNull()
  })
})

describe('inbodyAccountsForLocation', () => {
  it('reads the plural accounts array (normalised)', async () => {
    const db = makeDb({ 'loc-A': { inbody: { accounts: ['StillorganUN1T', 'other'] } } })
    const set = await inbodyAccountsForLocation(db, 'loc-A')
    expect([...set].sort()).toEqual(['other', 'stillorganun1t'])
  })
  it('reads the legacy singular account', async () => {
    const db = makeDb({ 'loc-A': { inbody: { account: 'stillorganun1t' } } })
    const set = await inbodyAccountsForLocation(db, 'loc-A')
    expect([...set]).toEqual(['stillorganun1t'])
  })
  it('returns an empty set when a location has no inbody config', async () => {
    const db = makeDb({ 'loc-A': { glofox: { branch_id: 'x' } } })
    const set = await inbodyAccountsForLocation(db, 'loc-A')
    expect(set.size).toBe(0)
  })
  it('returns an empty set for an unknown location', async () => {
    const db = makeDb({})
    const set = await inbodyAccountsForLocation(db, 'nope')
    expect(set.size).toBe(0)
  })
})

describe('eventAccountMatchesScope', () => {
  it('matches within scope, case-insensitively', async () => {
    const db = makeDb({ 'loc-A': { inbody: { accounts: ['stillorganun1t'] } } })
    const scope = await bridgeInbodyScope(db, { locationId: 'loc-A' })
    expect(eventAccountMatchesScope('StillorganUN1T', scope)).toBe(true)
  })
  it('rejects an account NOT in scope (the cross-tenant leak)', async () => {
    const db = makeDb({ 'loc-A': { inbody: { accounts: ['stillorganun1t'] } } })
    const scope = await bridgeInbodyScope(db, { locationId: 'loc-A' })
    // location B's account
    expect(eventAccountMatchesScope('hatchstreetun1t', scope)).toBe(false)
  })
  it('rejects a null/blank event account (fail safe)', async () => {
    const db = makeDb({ 'loc-A': { inbody: { accounts: ['stillorganun1t'] } } })
    const scope = await bridgeInbodyScope(db, { locationId: 'loc-A' })
    expect(eventAccountMatchesScope(null, scope)).toBe(false)
    expect(eventAccountMatchesScope('', scope)).toBe(false)
  })
  it('rejects everything when the bridge location has no config (empty scope)', async () => {
    const db = makeDb({ 'loc-A': {} })
    const scope = await bridgeInbodyScope(db, { locationId: 'loc-A' })
    expect(scope.hasConfig).toBe(false)
    expect(eventAccountMatchesScope('stillorganun1t', scope)).toBe(false)
  })
})

describe('isPhoneShaped', () => {
  it('accepts local + E.164 phone formats', () => {
    expect(isPhoneShaped('0851234567')).toBe(true)
    expect(isPhoneShaped('+353851234567')).toBe(true)
    expect(isPhoneShaped('085 123 4567')).toBe(true)
    expect(isPhoneShaped('(085) 123-4567')).toBe(true)
  })
  it('rejects non-phone junk (emails, uuids, free text, too-short)', () => {
    expect(isPhoneShaped('attacker@example.com')).toBe(false)
    expect(isPhoneShaped('a0000000-0000-0000-0000-000000000001')).toBe(false)
    expect(isPhoneShaped('drop table')).toBe(false)
    expect(isPhoneShaped('12345')).toBe(false)
    expect(isPhoneShaped('')).toBe(false)
    expect(isPhoneShaped(null)).toBe(false)
    expect(isPhoneShaped(1234567890)).toBe(false)
  })
})
