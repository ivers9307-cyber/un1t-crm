import { describe, it, expect, vi } from 'vitest'

// Schema-only regression tests — the modal sends `reason: null` for a
// blank Reason field, and .optional() rejected that (live 400 on every
// empty-reason override, 2026-07-31). validateBody uses safeParse on
// this schema, so pinning the schema pins the route's validation gate.
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn(), assertLocationAccess: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

import { PasswordOverrideSchema } from './route'

const base = { targetType: 'staff', targetId: 'prof-1', generateRandom: true }

describe('PasswordOverrideSchema — reason field', () => {
  it('accepts a null reason (blank field in the modal)', () => {
    expect(PasswordOverrideSchema.safeParse({ ...base, reason: null }).success).toBe(true)
  })

  it('accepts an omitted reason', () => {
    expect(PasswordOverrideSchema.safeParse(base).success).toBe(true)
  })

  it('accepts a string reason and rejects a non-string one', () => {
    expect(PasswordOverrideSchema.safeParse({ ...base, reason: 'locked out' }).success).toBe(true)
    expect(PasswordOverrideSchema.safeParse({ ...base, reason: 123 }).success).toBe(false)
  })

  it('accepts undefined newPassword alongside generateRandom (the modal shape)', () => {
    expect(PasswordOverrideSchema.safeParse({ ...base, newPassword: undefined, reason: null }).success).toBe(true)
  })
})
