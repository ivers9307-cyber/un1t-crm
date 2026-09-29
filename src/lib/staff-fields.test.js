// STAFFPROFILEPICK.1 — what of a COLLEAGUE's profile may cross to a browser
// or a phone. The staff API (web + the phone's staff directory) and the staff
// editor page used to hand over profiles.* — pin_hash (a short PIN's hash:
// offline-guessable), unifi_user_id, signatures, tombstone and auth
// bookkeeping — and each embedded studio's whole locations row (settings,
// test phone numbers). Fictional values only (public repo).
import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { collectSchema } from '../../scripts/check-select-columns.mjs'
import { CLIENT_LOCATION_COLUMNS } from './location-secrets.js'
import { isSecretKeyName } from './secret-keys.js'
import {
  STAFF_HR_FIELDS, STAFF_MANAGED_FIELDS, STAFF_MANAGED_LINK_FIELDS, STAFF_MANAGED_SELECT,
  STAFF_EDITOR_FIELDS, STAFF_EDITOR_SELECT, pickManagedStaffRow, pickStaffEditorProfile,
} from './staff-fields.js'

const SCHEMA = collectSchema(path.resolve(import.meta.dirname, '../../supabase/migrations')).schema
const NEVER = /^(pin_|unifi_user_id$|unifi_synced_at$|protect_face_id$|deleted_|auth_|two_factor|home_screen_path$|email_signature)/

const LOC = {
  id: 'loc-1', name: 'Studio A', slug: 'a', features: { pipeline: true }, organization_id: 'o0000000-0000-4000-8000-000000000001',
  sensibo_api_key: 'SYNTH-S', thinq_pat: 'SYNTH-T', bca_config: { k: 'SYNTH-BCA' },
  settings: { customer_agent: { test_phones: ['+353000000000'] }, glofox: { branch_id: 'b1', api_key: 'SYNTH-G' } },
}
const FULL_ROW = {
  id: 'p1', email: 'ada@example.test', full_name: 'Ada', role: 'staff', avatar_url: null, active: true,
  permissions: { landing_preference: 'x' }, two_factor_enabled: false, created_at: 'T', updated_at: 'T',
  employment_type: 'fte', annual_salary: 40000, hourly_rate: null, contracted_hours_per_week: 39,
  annual_leave_entitlement: 20, overtime_rate: null,
  unifi_door_access: true, unifi_user_id: 'SYNTH-UU', pin_hash: 'SYNTH-PIN-HASH', pin_set_at: 'T',
  pin_failed_count: 0, pin_locked_until: null, home_screen_path: '/x',
  email_signature: 'SYNTH-SIG', email_signature_rich: '<p>SYNTH-SIG</p>',
  deleted_at: null, deleted_by: null, deleted_role: null, auth_disposition: null, auth_completed_at: null,
  profile_locations: [{
    id: 'pl1', profile_id: 'p1', location_id: 'loc-1', is_default: true, created_at: 'T',
    unifi_door_access: true, unifi_user_id: 'SYNTH-UU-L', unifi_synced_at: 'T', role: 'staff',
    permissions: { mobile: { staff_management: true } }, protect_face_id: 'SYNTH-FACE',
    unifi_door_ids: ['d1'], ac_device_ids: null, geofence_exempt: false,
    locations: LOC,
  }],
}

describe('the named lists (STAFFPROFILEPICK.1)', () => {
  it('managed = the 7 public fields + the 5 HR fields; links = the 5 the phone editors read', () => {
    expect([...STAFF_HR_FIELDS]).toEqual(['annual_salary', 'hourly_rate', 'contracted_hours_per_week', 'annual_leave_entitlement', 'overtime_rate'])
    expect([...STAFF_MANAGED_FIELDS]).toEqual(['id', 'full_name', 'email', 'role', 'avatar_url', 'active', 'employment_type', ...STAFF_HR_FIELDS])
    expect([...STAFF_MANAGED_LINK_FIELDS]).toEqual(['location_id', 'role', 'is_default', 'permissions', 'unifi_door_access'])
    expect([...STAFF_EDITOR_FIELDS]).toEqual(['id', 'email', 'full_name', 'active', 'employment_type', ...STAFF_HR_FIELDS])
  })

  it('the selects are the lists (no profile star; the editor keeps profile_locations(*) whole, D4)', () => {
    expect(STAFF_MANAGED_SELECT).toBe(
      `${STAFF_MANAGED_FIELDS.join(', ')}, profile_locations(${STAFF_MANAGED_LINK_FIELDS.join(', ')}, locations(${CLIENT_LOCATION_COLUMNS.join(', ')}))`,
    )
    expect(STAFF_MANAGED_SELECT).not.toContain('*')
    expect(STAFF_EDITOR_SELECT).toBe(`${[...STAFF_EDITOR_FIELDS, 'role', 'deleted_at'].join(', ')}, profile_locations(*)`)
    expect(STAFF_EDITOR_SELECT.replace('profile_locations(*)', '')).not.toContain('*')
  })

  it('every name exists (a typo would 400 the read: the staff API fails, the editor 404s)', () => {
    const profiles = SCHEMA.get('profiles')
    const links = SCHEMA.get('profile_locations')
    for (const c of [...STAFF_MANAGED_FIELDS, ...STAFF_EDITOR_FIELDS, 'role', 'deleted_at']) expect([c, profiles.has(c)]).toEqual([c, true])
    for (const c of STAFF_MANAGED_LINK_FIELDS) expect([c, links.has(c)]).toEqual([c, true])
  })

  it('no list carries a PIN, secret, UniFi-id, tombstone, auth or signature column', () => {
    for (const c of [...STAFF_MANAGED_FIELDS, ...STAFF_MANAGED_LINK_FIELDS, ...STAFF_EDITOR_FIELDS]) {
      expect([c, NEVER.test(c) || isSecretKeyName(c)]).toEqual([c, false])
    }
  })
})

describe('pickManagedStaffRow', () => {
  it('keeps exactly the managed keys, the link keys and the client location columns', () => {
    const out = pickManagedStaffRow(FULL_ROW)
    expect(Object.keys(out).sort()).toEqual([...STAFF_MANAGED_FIELDS, 'profile_locations'].sort())
    const [link] = out.profile_locations
    expect(Object.keys(link).sort()).toEqual([...STAFF_MANAGED_LINK_FIELDS, 'locations'].sort())
    for (const k of Object.keys(link.locations)) expect(CLIENT_LOCATION_COLUMNS).toContain(k)
    expect(link.locations).toMatchObject({ id: 'loc-1', name: 'Studio A', features: { pipeline: true } })
    expect(out.contracted_hours_per_week).toBe(39)
  })

  it('no PIN hash, UniFi id, signature, setting, test phone or credential survives', () => {
    const json = JSON.stringify(pickManagedStaffRow(FULL_ROW))
    expect(json).not.toMatch(/SYNTH-|\+353000000000|test_phones|settings|pin_|unifi_user_id|deleted_|auth_/)
  })

  it('never adds a key the row lacks, and passes non-objects and odd links through', () => {
    expect(pickManagedStaffRow({ id: 'p2' })).toEqual({ id: 'p2' })
    expect(pickManagedStaffRow({ id: 'p3', profile_locations: [{ location_id: 'l', locations: null }] }))
      .toEqual({ id: 'p3', profile_locations: [{ location_id: 'l', locations: null }] })
    expect(pickManagedStaffRow(null)).toBeNull()
    expect(pickManagedStaffRow(undefined)).toBeUndefined()
  })
})

describe('pickStaffEditorProfile', () => {
  it('keeps exactly the editor fields (no role, no deleted_at, no links)', () => {
    const out = pickStaffEditorProfile(FULL_ROW)
    expect(Object.keys(out).sort()).toEqual([...STAFF_EDITOR_FIELDS].sort())
    expect(JSON.stringify(out)).not.toMatch(/SYNTH-/)
  })
  it('passes a non-object through', () => {
    expect(pickStaffEditorProfile(null)).toBeNull()
  })
})
