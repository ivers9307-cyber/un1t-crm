// src/lib/role-templates.test.js
// WIDGET.1 — extracted from auth.js so getCurrentUser and getWidgetUser
// resolve role templates through ONE implementation.

import { describe, it, expect, vi } from 'vitest'
import { loadRoleTemplatesForLocations } from './role-templates'

const LOC = 'loc-1'

function dbWith(rows, { throws = false } = {}) {
  return {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        in: vi.fn(async () => {
          if (throws) throw new Error('boom')
          return { data: rows, error: null }
        }),
      })),
    })),
  }
}

describe('loadRoleTemplatesForLocations', () => {
  it('returns empty maps for a master (templates cannot change what master sees)', async () => {
    const db = dbWith([])
    const out = await loadRoleTemplatesForLocations(db, {
      isMaster: true, rolesByLocation: { [LOC]: 'owner' }, employmentType: 'fte',
    })
    expect(out).toEqual({ roleTemplatesByLocation: {}, acDeviceTemplatesByLocation: {} })
    expect(db.from).not.toHaveBeenCalled()
  })

  it('returns empty maps when there are no locations', async () => {
    const db = dbWith([])
    const out = await loadRoleTemplatesForLocations(db, {
      isMaster: false, rolesByLocation: {}, employmentType: null,
    })
    expect(out.roleTemplatesByLocation).toEqual({})
    expect(db.from).not.toHaveBeenCalled()
  })

  it('applies the "all" row for the role held at that location', async () => {
    const db = dbWith([
      { location_id: LOC, role: 'staff', employment_type: 'all', permissions: { pipeline: false }, ac_device_ids: null },
      { location_id: LOC, role: 'owner', employment_type: 'all', permissions: { pipeline: true }, ac_device_ids: null },
    ])
    const out = await loadRoleTemplatesForLocations(db, {
      isMaster: false, rolesByLocation: { [LOC]: 'staff' }, employmentType: null,
    })
    expect(out.roleTemplatesByLocation[LOC]).toEqual({ pipeline: false })
  })

  it('layers the employment-type variant on top of "all"', async () => {
    const db = dbWith([
      { location_id: LOC, role: 'staff', employment_type: 'all', permissions: { pipeline: false, tasks: false }, ac_device_ids: null },
      { location_id: LOC, role: 'staff', employment_type: 'fte', permissions: { tasks: true }, ac_device_ids: null },
    ])
    const out = await loadRoleTemplatesForLocations(db, {
      isMaster: false, rolesByLocation: { [LOC]: 'staff' }, employmentType: 'fte',
    })
    expect(out.roleTemplatesByLocation[LOC]).toEqual({ pipeline: false, tasks: true })
  })

  it('takes the variant ac_device_ids when set, else the "all" row', async () => {
    const db = dbWith([
      { location_id: LOC, role: 'staff', employment_type: 'all', permissions: null, ac_device_ids: ['a'] },
      { location_id: LOC, role: 'staff', employment_type: 'fte', permissions: null, ac_device_ids: ['b'] },
    ])
    const out = await loadRoleTemplatesForLocations(db, {
      isMaster: false, rolesByLocation: { [LOC]: 'staff' }, employmentType: 'fte',
    })
    expect(out.acDeviceTemplatesByLocation[LOC]).toEqual(['b'])
  })

  it('DEEP-merges the mobile sub-object rather than clobbering it', async () => {
    // The bug this guards: a flat spread drops whatsapp:false, so a permission
    // the operator explicitly removed silently returns as a code default.
    const db = dbWith([
      { location_id: LOC, role: 'staff', employment_type: 'all', permissions: { pipeline: false, mobile: { whatsapp: false, schedule: true } }, ac_device_ids: null },
      { location_id: LOC, role: 'staff', employment_type: 'fte', permissions: { mobile: { tv_displays: true } }, ac_device_ids: null },
    ])
    const out = await loadRoleTemplatesForLocations(db, {
      isMaster: false, rolesByLocation: { [LOC]: 'staff' }, employmentType: 'fte',
    })
    expect(out.roleTemplatesByLocation[LOC]).toEqual({
      pipeline: false,
      mobile: { whatsapp: false, schedule: true, tv_displays: true },
    })
  })

  it('degrades to empty maps when the fetch throws, rather than failing the request', async () => {
    const db = dbWith(null, { throws: true })
    const out = await loadRoleTemplatesForLocations(db, {
      isMaster: false, rolesByLocation: { [LOC]: 'staff' }, employmentType: null,
    })
    expect(out).toEqual({ roleTemplatesByLocation: {}, acDeviceTemplatesByLocation: {} })
  })
})
