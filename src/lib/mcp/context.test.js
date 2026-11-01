import { describe, it, expect } from 'vitest'
import { resolveStudio, roleAt, isManagerAt, isAdminAt } from './context.js'

// owner holds `assistant` by default, staff does not (shared/permissions.js).
const loc = (id, name) => ({ id, name, timezone: 'Europe/London', organization_id: 'org-1' })
function userWith({ active, roles }) {
  const locations = Object.keys(roles).map((id) => loc(id, `Studio ${id}`))
  return {
    isMaster: false,
    locations,
    activeLocation: active ? locations.find((l) => l.id === active) : null,
    rolesByLocation: roles,
    assignmentsByLocation: Object.fromEntries(Object.entries(roles).map(([id, role]) => [id, { role, permissions: {} }])),
  }
}

describe('resolveStudio', () => {
  it('defaults to the active studio when the person holds assistant there', () => {
    const user = userWith({ active: 'b', roles: { a: 'owner', b: 'owner' } })
    const r = resolveStudio(user, null)
    expect(r.ok).toBe(true)
    expect(r.studio.id).toBe('b')
  })

  it('falls back to the first studio with assistant when the active one lacks it', () => {
    const user = userWith({ active: 'a', roles: { a: 'staff', b: 'owner', c: 'owner' } })
    const r = resolveStudio(user, null)
    expect(r.ok).toBe(true)
    expect(r.studio.id).toBe('b')
  })

  it('answers studio_not_found for a studio outside user.locations and for a random uuid alike', () => {
    const user = userWith({ active: 'a', roles: { a: 'owner' } })
    const outside = resolveStudio(user, 'someone-elses-studio')
    const random = resolveStudio(user, '3f0c2a52-9d1e-4a6f-8f55-0c9b6e2f1a77')
    expect(outside).toEqual({ ok: false, code: 'studio_not_found' })
    expect(random).toEqual(outside)
  })

  it('answers assistant_permission for a member studio without the permission', () => {
    const user = userWith({ active: 'a', roles: { a: 'owner', b: 'staff' } })
    expect(resolveStudio(user, 'b')).toEqual({ ok: false, code: 'assistant_permission' })
  })

  it('answers assistant_permission by default when no studio qualifies', () => {
    const user = userWith({ active: 'a', roles: { a: 'staff' } })
    expect(resolveStudio(user, null)).toEqual({ ok: false, code: 'assistant_permission' })
  })

  it('returns the studio row for an explicit qualifying id', () => {
    const user = userWith({ active: 'a', roles: { a: 'owner', b: 'owner' } })
    const r = resolveStudio(user, 'b')
    expect(r).toEqual({ ok: true, studio: user.locations[1] })
  })
})

describe('roleAt', () => {
  it('reads rolesByLocation and master overrides', () => {
    const user = userWith({ active: 'a', roles: { a: 'manager', b: 'staff' } })
    expect(roleAt(user, 'a')).toBe('manager')
    expect(roleAt(user, 'nope')).toBeNull()
    expect(roleAt({ ...user, isMaster: true }, 'nope')).toBe('master')
  })

  it('maps roles onto the manager and admin gates', () => {
    const user = userWith({ active: 'a', roles: { a: 'head_coach', b: 'manager', c: 'staff' } })
    expect(isManagerAt(user, 'a')).toBe(true)
    expect(isAdminAt(user, 'a')).toBe(false)
    expect(isAdminAt(user, 'b')).toBe(true)
    expect(isManagerAt(user, 'c')).toBe(false)
    expect(isManagerAt(user, 'zzz')).toBe(false)
    expect(isAdminAt({ ...user, isMaster: true }, 'zzz')).toBe(true)
  })
})
