// src/app/api/live/[locationId]/register-device/route.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  getUserLocationIds: vi.fn(() => ['loc1']),
}))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

import { POST, DELETE } from './route'
import { getCurrentUser, getUserLocationIds } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

const props = { params: Promise.resolve({ locationId: 'loc1' }) }
const CONTACT_ID = '00000000-0000-0000-0000-000000000001'
function reqWith(body) {
  return new Request('http://localhost/api/live/loc1/register-device', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
}

// Generic thenable query-chain mock: every filter returns the chain, the
// terminal (maybeSingle/single/await) resolves `result`.
function q(result) {
  const p = Promise.resolve(result)
  const c = {
    eq: () => c, is: () => c, order: () => c, limit: () => c,
    maybeSingle: () => p, single: () => p,
    then: (...a) => p.then(...a),
  }
  return c
}

function makeDb({
  contact = { id: 'c1', location_id: 'loc1', max_hr_override: null, dob: null },
  activeRegs = [],
  upsertResult = { data: { id: 'dev1' }, error: null },
  memberOpen = null,
  anon = null,
  adoptError = null,
  captured = {},
} = {}) {
  let hrSelects = 0
  return {
    from: (table) => {
      if (table === 'contacts') return { select: () => q({ data: contact, error: null }) }
      if (table === 'contact_devices') {
        return {
          select: () => q({ data: activeRegs, error: null }), // steal-guard read
          upsert: (row, opts) => { captured.upsert = { row, opts }; return { select: () => ({ single: () => Promise.resolve(upsertResult) }) } },
        }
      }
      if (table === 'heart_rate_sessions') {
        return {
          // The route builds the memberOpen select first, then the anon one.
          select: () => { hrSelects += 1; return q(hrSelects === 1 ? { data: memberOpen, error: null } : { data: anon, error: null }) },
          update: (patch) => { captured.adopt = patch; return q({ error: adoptError }) },
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
}

// SEC-LIVE-API.1 — the gate now also requires `studio_management` at the
// location, so fixtures need the shape hasPermissionForLocation reads.
function userAt(role, { studio = true, locationId = 'loc1' } = {}) {
  return {
    id: 'u1',
    role,
    isMaster: false,
    locations: [{ id: locationId, features: {} }],
    assignmentsByLocation: {
      [locationId]: { role, permissions: studio === null ? {} : { studio_management: studio } },
    },
    roleTemplatesByLocation: {},
  }
}

beforeEach(() => { vi.clearAllMocks(); getUserLocationIds.mockReturnValue(['loc1']) })

describe('POST /api/live/[locationId]/register-device', () => {
  it('403 for a non-coach role', async () => {
    getCurrentUser.mockResolvedValue(userAt('staff'))
    const res = await POST(reqWith({ device_key: 'ant:1', contact_id: CONTACT_ID }), props)
    expect(res.status).toBe(403)
  })

  it('404 when the contact is not at this location (IDOR guard)', async () => {
    getCurrentUser.mockResolvedValue(userAt('head_coach'))
    createServerClient.mockReturnValue(makeDb({ contact: { id: 'c1', location_id: 'other' } }))
    const res = await POST(reqWith({ device_key: 'ant:1', contact_id: CONTACT_ID }), props)
    expect(res.status).toBe(404)
  })

  it('200 upserts a contact_devices row', async () => {
    getCurrentUser.mockResolvedValue(userAt('head_coach'))
    const captured = {}
    createServerClient.mockReturnValue(makeDb({ captured }))
    const res = await POST(reqWith({ device_key: 'ant:45075', contact_id: CONTACT_ID, device_type: 'watch', label: 'Garmin' }), props)
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json).toMatchObject({ ok: true, device_id: 'dev1', adopted_session_id: null })
    expect(captured.upsert.row).toMatchObject({ contact_id: CONTACT_ID, identifier: 'ant:45075', device_type: 'watch', label: 'Garmin', is_active: true, added_by_contact: false, added_by_user_id: 'u1' })
    expect(captured.upsert.opts).toEqual({ onConflict: 'contact_id,device_type,identifier' })
  })

  it('409 with the holder name when another SAME-location contact holds the strap (steal guard)', async () => {
    getCurrentUser.mockResolvedValue(userAt('head_coach'))
    const captured = {}
    createServerClient.mockReturnValue(makeDb({
      activeRegs: [{ contact_id: 'c-other', is_active: true, contacts: { name: 'Bob Walsh', location_id: 'loc1' } }],
      captured,
    }))
    const res = await POST(reqWith({ device_key: 'ant:45075', contact_id: CONTACT_ID }), props)
    const json = await res.json()
    expect(res.status).toBe(409)
    expect(json.error).toContain('Bob Walsh')
    expect(captured.upsert).toBeUndefined()
  })

  it('409 WITHOUT a name when the holder is at another location (no cross-tenant leak)', async () => {
    getCurrentUser.mockResolvedValue(userAt('head_coach'))
    createServerClient.mockReturnValue(makeDb({
      activeRegs: [{ contact_id: 'c-other', is_active: true, contacts: { name: 'Bob Walsh', location_id: 'loc2' } }],
    }))
    const res = await POST(reqWith({ device_key: 'ant:45075', contact_id: CONTACT_ID }), props)
    const json = await res.json()
    expect(res.status).toBe(409)
    expect(json.error).not.toContain('Bob Walsh')
  })

  it('the claiming contact re-registering their own strap is not a conflict', async () => {
    getCurrentUser.mockResolvedValue(userAt('head_coach'))
    createServerClient.mockReturnValue(makeDb({
      activeRegs: [{ contact_id: CONTACT_ID, is_active: true, contacts: { name: 'Alice', location_id: 'loc1' } }],
    }))
    const res = await POST(reqWith({ device_key: 'ant:45075', contact_id: CONTACT_ID }), props)
    expect(res.status).toBe(200)
  })

  it('adopts the open contact-less session: stamps contact_id + max_hr (HR-CLAIM.1)', async () => {
    getCurrentUser.mockResolvedValue(userAt('head_coach'))
    const captured = {}
    createServerClient.mockReturnValue(makeDb({
      contact: { id: 'c1', location_id: 'loc1', max_hr_override: 190, dob: null },
      anon: { id: 's-anon', contact_id: null, ended_at: null },
      captured,
    }))
    const res = await POST(reqWith({ device_key: 'ant:45075', contact_id: CONTACT_ID }), props)
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.adopted_session_id).toBe('s-anon')
    expect(captured.adopt).toEqual({ contact_id: CONTACT_ID, max_hr_used: 190 })
  })

  it('skips adoption when the member already has an open session (mig 343)', async () => {
    getCurrentUser.mockResolvedValue(userAt('head_coach'))
    const captured = {}
    createServerClient.mockReturnValue(makeDb({
      memberOpen: { id: 's-mine' },
      anon: { id: 's-anon', contact_id: null, ended_at: null },
      captured,
    }))
    const res = await POST(reqWith({ device_key: 'ant:45075', contact_id: CONTACT_ID }), props)
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.adopted_session_id).toBe(null)
    expect(captured.adopt).toBeUndefined()
  })

  it('a failed adoption never fails the registration', async () => {
    getCurrentUser.mockResolvedValue(userAt('head_coach'))
    createServerClient.mockReturnValue(makeDb({
      anon: { id: 's-anon', contact_id: null, ended_at: null },
      adoptError: { code: '23505', message: 'duplicate open session' },
    }))
    const res = await POST(reqWith({ device_key: 'ant:45075', contact_id: CONTACT_ID }), props)
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json).toMatchObject({ ok: true, device_id: 'dev1', adopted_session_id: null })
  })
})

describe('DELETE /api/live/[locationId]/register-device (unregister)', () => {
  function delReq(body) {
    return new Request('http://localhost/api/live/loc1/register-device', {
      method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
  }

  it('404 when the contact is not at this location (IDOR guard)', async () => {
    getCurrentUser.mockResolvedValue(userAt('head_coach'))
    createServerClient.mockReturnValue({
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { id: 'c1', location_id: 'other' }, error: null }) }) }) }),
    })
    const res = await DELETE(delReq({ device_key: 'ant:1', contact_id: CONTACT_ID }), props)
    expect(res.status).toBe(404)
  })

  it('200 deactivates the device for a contact at this location', async () => {
    getCurrentUser.mockResolvedValue(userAt('head_coach'))
    let updated = null
    createServerClient.mockReturnValue({
      from: (table) => {
        if (table === 'contacts') {
          return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { id: 'c1', location_id: 'loc1' }, error: null }) }) }) }
        }
        return { update: (patch) => { updated = patch; return { eq: () => ({ eq: () => Promise.resolve({ error: null }) }) } } }
      },
    })
    const res = await DELETE(delReq({ device_key: 'ant:45075', contact_id: CONTACT_ID }), props)
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json).toEqual({ ok: true })
    expect(updated).toEqual({ is_active: false })
  })
})
