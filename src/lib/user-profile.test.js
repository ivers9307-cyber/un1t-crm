// PROFILESPREAD.1 — the profile columns the signed-in user object carries.
// getCurrentUser() used to spread profiles.* into an object that is
// serialised into EVERY page (AppShell is a client component), so each
// person's own pin_hash and pay columns rode in their page HTML (and a
// master's "View as" target's in the master's). Fictional values only.
import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { collectSchema } from '../../scripts/check-select-columns.mjs'
import { USER_PROFILE_COLUMNS, PROFILE_AUTH_SELECT, pickUserProfile, AUTH_USER_FIELDS, pickAuthUser } from './user-profile.js'

const PROFILES = collectSchema(path.resolve(import.meta.dirname, '../../supabase/migrations')).schema.get('profiles')

describe('USER_PROFILE_COLUMNS', () => {
  it('is exactly the ten columns the user object\'s readers use (census in plan C41 §1)', () => {
    expect([...USER_PROFILE_COLUMNS]).toEqual([
      'id', 'email', 'full_name', 'avatar_url', 'role', 'active',
      'permissions', 'employment_type', 'email_signature', 'email_signature_rich',
    ])
  })

  it('never carries a PIN, pay, UniFi-id, tombstone or auth-bookkeeping column', () => {
    const forbidden = /^(pin_|annual_salary$|hourly_rate$|contracted_hours_per_week$|annual_leave_entitlement$|overtime_rate$|unifi_|deleted_|auth_|two_factor)/
    for (const c of USER_PROFILE_COLUMNS) expect([c, forbidden.test(c)]).toEqual([c, false])
    expect(PROFILE_AUTH_SELECT).not.toMatch(/\*|pin_hash|annual_salary|hourly_rate|overtime_rate/)
  })

  it('every name exists on profiles (a typo would 400 the read and sign EVERYONE out)', () => {
    expect(PROFILES, 'the migrations replay knows profiles').toBeTruthy()
    for (const c of [...USER_PROFILE_COLUMNS, 'deleted_at']) expect([c, PROFILES.has(c)]).toEqual([c, true])
  })

  it('the auth select is the list plus deleted_at (read for the tombstone check, never spread)', () => {
    expect(PROFILE_AUTH_SELECT).toBe([...USER_PROFILE_COLUMNS, 'deleted_at'].join(', '))
  })
})

describe('pickUserProfile', () => {
  const ROW = {
    id: 'p1', email: 'a@example.test', full_name: 'A', role: 'staff', active: true,
    pin_hash: 'SYNTH-PIN-HASH', annual_salary: 123, hourly_rate: 45, unifi_user_id: 'u-1',
    deleted_at: null, home_screen_path: '/x',
  }

  it('keeps only the listed keys and never adds one the row lacks', () => {
    expect(pickUserProfile(ROW)).toEqual({ id: 'p1', email: 'a@example.test', full_name: 'A', role: 'staff', active: true })
    expect(Object.keys(pickUserProfile({ id: 'p2' }))).toEqual(['id'])
  })

  it('passes a non-object through', () => {
    expect(pickUserProfile(null)).toBe(null)
    expect(pickUserProfile(undefined)).toBe(undefined)
  })
})

// AUTHUSERPICK.1 — the Supabase auth user as the user object carries it.
describe('pickAuthUser', () => {
  // The shape supabase-js returns from auth.getUser(), with fictional values.
  const FAT = {
    id: 'u1', email: 'a@example.test', phone: '+353000000000', aud: 'authenticated', role: 'authenticated',
    app_metadata: { provider: 'email', providers: ['email', 'google'] },
    user_metadata: { full_name: 'SYNTH-META-NAME' },
    identities: [{ identity_id: 'SYNTH-IDENTITY', provider: 'google', identity_data: { email: 'a@example.test', sub: 'SYNTH-SUB' } }],
    factors: [{ id: 'SYNTH-FACTOR', factor_type: 'totp' }],
    confirmed_at: '2026-01-01T00:00:00Z', last_sign_in_at: '2026-09-01T00:00:00Z',
  }

  it('is exactly id + email', () => {
    expect([...AUTH_USER_FIELDS]).toEqual(['id', 'email'])
  })

  it('keeps id and email and nothing else', () => {
    expect(pickAuthUser(FAT)).toEqual({ id: 'u1', email: 'a@example.test' })
    expect(JSON.stringify(pickAuthUser(FAT))).not.toMatch(/SYNTH-|\+353|identities|app_metadata|user_metadata|factors/)
  })

  it('a missing field is null, never absent (the shape is fixed)', () => {
    expect(pickAuthUser({ id: 'u2' })).toEqual({ id: 'u2', email: null })
  })

  it('the studio-session shape passes through unchanged in value', () => {
    expect(pickAuthUser({ id: 'u3', email: 'c@example.test' })).toEqual({ id: 'u3', email: 'c@example.test' })
  })

  it('a non-object is null', () => {
    expect(pickAuthUser(null)).toBeNull()
    expect(pickAuthUser(undefined)).toBeNull()
    expect(pickAuthUser('u1')).toBeNull()
  })
})
