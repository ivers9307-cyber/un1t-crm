import { describe, it, expect } from 'vitest'
import { buildStaffAssignmentsPatch } from './staff-edit.js'

const current = [
  { location_id: 'loc-1', role: 'staff', is_default: true, permissions: { pipeline: true }, unifi_door_access: true, unifi_user_id: 'u1', unifi_door_ids: ['d1'] },
  { location_id: 'loc-2', role: 'manager', is_default: false, permissions: { sms: true }, unifi_door_access: false },
]

describe('buildStaffAssignmentsPatch', () => {
  it('master: includes ALL assignments (full desired state)', () => {
    const out = buildStaffAssignmentsPatch({ isMaster: true, ownedLocationIds: [], currentAssignments: current, roleEdits: {} })
    expect(out.map(a => a.location_id).sort()).toEqual(['loc-1', 'loc-2'])
  })

  it('owner: includes ONLY owned-location assignments (server preserves the rest)', () => {
    const out = buildStaffAssignmentsPatch({ isMaster: false, ownedLocationIds: ['loc-1'], currentAssignments: current, roleEdits: {} })
    expect(out.map(a => a.location_id)).toEqual(['loc-1'])
  })

  it('applies a role edit to the named location, leaving others at their current role', () => {
    const out = buildStaffAssignmentsPatch({ isMaster: true, ownedLocationIds: [], currentAssignments: current, roleEdits: { 'loc-1': 'head_coach' } })
    expect(out.find(a => a.location_id === 'loc-1').role).toBe('head_coach')
    expect(out.find(a => a.location_id === 'loc-2').role).toBe('manager')
  })

  it('PRESERVES permissions + door access + is_default for every emitted assignment (the wipe guard)', () => {
    const out = buildStaffAssignmentsPatch({ isMaster: true, ownedLocationIds: [], currentAssignments: current, roleEdits: { 'loc-1': 'owner' } })
    const a1 = out.find(a => a.location_id === 'loc-1')
    expect(a1.permissions).toEqual({ pipeline: true })
    expect(a1.unifi_door_access).toBe(true)
    expect(a1.is_default).toBe(true)
  })

  it('OMITS unifi_user_id and the door/AC/face allowlist keys (so the server leaves them unchanged)', () => {
    const out = buildStaffAssignmentsPatch({ isMaster: true, ownedLocationIds: [], currentAssignments: current, roleEdits: {} })
    const a1 = out.find(a => a.location_id === 'loc-1')
    expect('unifi_user_id' in a1).toBe(false)
    expect('unifi_door_ids' in a1).toBe(false)
    expect('ac_device_ids' in a1).toBe(false)
    expect('protect_face_id' in a1).toBe(false)
  })

  it('defaults a missing permissions blob to {} (never undefined → never wipes via undefined)', () => {
    const out = buildStaffAssignmentsPatch({ isMaster: true, ownedLocationIds: [], currentAssignments: [{ location_id: 'x', role: 'staff', is_default: true, unifi_door_access: false }], roleEdits: {} })
    expect(out[0].permissions).toEqual({})
  })

  it('returns [] for no current assignments', () => {
    expect(buildStaffAssignmentsPatch({ isMaster: true, ownedLocationIds: [], currentAssignments: [], roleEdits: {} })).toEqual([])
  })
})
