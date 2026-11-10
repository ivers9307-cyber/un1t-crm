import { describe, it, expect } from 'vitest'
import { resolveStudio, roleAt, isManagerAt, isAdminAt } from './context.js'

// Role defaults (shared/permissions.js): owner holds both `assistant` and
// `mcp_access`; staff holds neither; manager holds `assistant` but NOT
// `mcp_access` (MCPACCESS.1) — which is what lets these tests tell the two
// keys apart. `perms` sets per-studio web overrides where a role default is
// not enough.
const loc = (id, name) => ({ id, name, timezone: 'Europe/London', organization_id: 'org-1' })
function userWith({ active, roles, perms = {} }) {
  const locations = Object.keys(roles).map((id) => loc(id, `Studio ${id}`))
  return {
    isMaster: false,
    locations,
    activeLocation: active ? locations.find((l) => l.id === active) : null,
    rolesByLocation: roles,
    assignmentsByLocation: Object.fromEntries(
      Object.entries(roles).map(([id, role]) => [id, { role, permissions: perms[id] || {} }]),
    ),
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

  it('answers mcp_access_permission for a member studio without the permission', () => {
    const user = userWith({ active: 'a', roles: { a: 'owner', b: 'staff' } })
    expect(resolveStudio(user, 'b')).toEqual({ ok: false, code: 'mcp_access_permission' })
  })

  it('answers mcp_access_permission by default when no studio qualifies', () => {
    const user = userWith({ active: 'a', roles: { a: 'staff' } })
    expect(resolveStudio(user, null)).toEqual({ ok: false, code: 'mcp_access_permission' })
  })

  it('returns the studio row for an explicit qualifying id', () => {
    const user = userWith({ active: 'a', roles: { a: 'owner', b: 'owner' } })
    const r = resolveStudio(user, 'b')
    expect(r).toEqual({ ok: true, studio: user.locations[1] })
  })

  // MCPACCESS.1 Review Focus 3 — the whole point of the decouple, both
  // directions. The in-app assistant costs Anthropic tokens and MCP costs
  // none, so holding one must never imply the other.
  it('resolves a studio for someone holding mcp_access but not assistant', () => {
    const user = userWith({ active: 'a', roles: { a: 'staff' }, perms: { a: { mcp_access: true } } })
    const r = resolveStudio(user, null)
    expect(r.ok).toBe(true)
    expect(r.studio.id).toBe('a')
  })

  it('refuses someone holding assistant but not mcp_access', () => {
    // manager: assistant true by default, mcp_access false by default.
    const user = userWith({ active: 'a', roles: { a: 'manager' } })
    expect(resolveStudio(user, null).ok).toBe(false)
  })

  // MCPACCESS.1 Review Focus 1 — the Pride Training Club shape. MCP.1 would
  // have answered a question about Stillorgan using a host-events studio,
  // because an explicit studio that fails the gate must refuse, never fall
  // back to one that passes.
  it('refuses an explicit studio_id the person lacks mcp_access at, without falling back', () => {
    const user = userWith({ active: 'a', roles: { a: 'owner', b: 'manager' } })
    const r = resolveStudio(user, 'b')
    expect(r.ok).toBe(false)
    expect(r.studio).toBeUndefined()
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
