// STAFFPROFILEPICK.1 — StaffForm is a client component. The page read the
// target with select('*, profile_locations(*)') and spread the row into its
// `staff` prop, so the editor's HTML carried the person's pin_hash (a short
// PIN's hash: offline-guessable), pin_* bookkeeping, profile UniFi id,
// signatures and tombstone/auth bookkeeping. The prop is now exactly what
// StaffForm reads, plus the page-computed is_master and assignments.
// Fictional values only.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('next/navigation', () => ({
  redirect: vi.fn((url) => { throw new Error(`NEXT_REDIRECT:${url}`) }),
  notFound: vi.fn(() => { throw new Error('NEXT_NOT_FOUND') }),
}))
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

import EditStaffPage from './page.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { STAFF_EDITOR_FIELDS, STAFF_EDITOR_SELECT } from '@/lib/staff-fields'

const TARGET = 'c0000000-0000-4000-8000-000000000003'
const LOC = 'a0000000-0000-4000-8000-000000000001'

const ROW = {
  id: TARGET, email: 'coach@example.test', full_name: 'A Coach', role: 'staff', active: true,
  employment_type: 'fte', annual_salary: 40000, hourly_rate: null, contracted_hours_per_week: 39,
  annual_leave_entitlement: 20, overtime_rate: null, avatar_url: null, permissions: {},
  pin_hash: 'SYNTH-PIN-HASH', pin_set_at: 'T', pin_failed_count: 0, pin_locked_until: null,
  unifi_user_id: 'SYNTH-UU', home_screen_path: '/x', email_signature: 'SYNTH-SIG', email_signature_rich: '<p>SYNTH-SIG</p>',
  two_factor_enabled: false, deleted_at: null, deleted_by: null, deleted_role: null, auth_disposition: null, auth_completed_at: null,
  profile_locations: [{
    id: 'pl1', profile_id: TARGET, location_id: LOC, role: 'staff', is_default: true, permissions: {},
    unifi_door_access: true, unifi_user_id: 'door-user-1', unifi_door_ids: ['d1'], ac_device_ids: null,
    geofence_exempt: false, protect_face_id: 'SYNTH-FACE', unifi_synced_at: 'T', created_at: 'T',
  }],
}

function makeDb(row) {
  const calls = { profileSelect: null }
  return {
    calls,
    from(table) {
      if (table === 'profiles') {
        return {
          select: (cols) => {
            calls.profileSelect = cols
            return { eq: () => ({ single: () => Promise.resolve({ data: row, error: null }) }) }
          },
        }
      }
      const chain = {}
      for (const op of ['select', 'eq', 'order', 'in']) chain[op] = () => chain
      chain.then = (res) => Promise.resolve({ data: [], error: null }).then(res)
      return chain
    },
  }
}

function findElement(node, name) {
  if (!node || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const n of node) { const f = findElement(n, name); if (f) return f }
    return null
  }
  const t = node.type
  if (t && (t.name === name || t.displayName === name)) return node
  return findElement(node.props?.children, name)
}

const MASTER = { id: 'm1', role: 'master', isMaster: true, rolesByLocation: {}, locations: [], activeLocation: null }
const call = () => EditStaffPage({ params: Promise.resolve({ id: TARGET }) })

beforeEach(() => vi.clearAllMocks())

describe('/settings/staff/[id] — STAFFPROFILEPICK.1: the staff prop is what StaffForm reads', () => {
  it('reads the named editor select (profile_locations(*) stays whole)', async () => {
    const db = makeDb(ROW)
    createServerClient.mockReturnValue(db)
    getCurrentUser.mockResolvedValue(MASTER)
    await call()
    expect(db.calls.profileSelect).toBe(STAFF_EDITOR_SELECT)
  })

  it('hands StaffForm the editor fields + is_master + assignments, and nothing else', async () => {
    createServerClient.mockReturnValue(makeDb(ROW))
    getCurrentUser.mockResolvedValue(MASTER)
    const el = findElement(await call(), 'StaffForm')
    expect(el).toBeTruthy()
    const { staff } = el.props
    expect(Object.keys(staff).sort()).toEqual([...STAFF_EDITOR_FIELDS, 'is_master', 'assignments'].sort())
    expect(staff).toMatchObject({ id: TARGET, full_name: 'A Coach', annual_salary: 40000, contracted_hours_per_week: 39, annual_leave_entitlement: 20, is_master: false })
    expect(JSON.stringify(staff)).not.toMatch(/SYNTH-|pin_|home_screen_path|email_signature|deleted_|auth_|two_factor/)
  })

  it('the per-location UniFi user link still reaches the door picker (via assignments)', async () => {
    createServerClient.mockReturnValue(makeDb(ROW))
    getCurrentUser.mockResolvedValue(MASTER)
    const el = findElement(await call(), 'StaffForm')
    expect(el.props.staff.assignments[0]).toMatchObject({ location_id: LOC, unifi_user_id: 'door-user-1', unifi_door_ids: ['d1'], permissions: {} })
    expect(el.props.staff).not.toHaveProperty('profile_locations')
  })

  it('a master target is still flagged, and a tombstone still 404s (role and deleted_at are read, not passed)', async () => {
    createServerClient.mockReturnValue(makeDb({ ...ROW, role: 'master' }))
    getCurrentUser.mockResolvedValue(MASTER)
    const el = findElement(await call(), 'StaffForm')
    expect(el.props.staff.is_master).toBe(true)

    createServerClient.mockReturnValue(makeDb({ ...ROW, deleted_at: '2026-09-01T00:00:00Z' }))
    await expect(call()).rejects.toThrow('NEXT_NOT_FOUND')
  })
})
