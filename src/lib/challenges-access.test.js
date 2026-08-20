// HUBDOOR.2 — one predicate for the challenges admin, and the proof that
// the three surfaces reading it agree with /api/challenges.
//
// The defect: /challenges was a client page with NO server gate. Its only
// access control was the load fetch's 403 handler calling
// router.replace('/'), while the API gated on MANAGER_ROLES *and* the key.
// So a staff-role holder of `challenges` got shell, chrome, a round trip
// and a bounce — reachable from the Members tab strip and the Members hub
// redirect, not just by typing the URL.

import { describe, it, expect } from 'vitest'
import { canAdminChallenges, CHALLENGE_ADMIN_ROLES } from './challenges-access'
import { MANAGER_ROLES } from './schemas'
import { HUB_INDEX_CHAINS } from './hub-index-chains'

// Real resolver, fixture user — same style as the issues-access suite.
const at = (role, permissions = {}, features = {}) => ({
  id: 'prof-1',
  role,
  activeLocation: { id: 'loc-1', features },
  activeAssignment: { permissions },
})

describe('CHALLENGE_ADMIN_ROLES', () => {
  it('is MANAGER_ROLES — the floor /api/challenges enforces', () => {
    expect([...CHALLENGE_ADMIN_ROLES]).toEqual([...MANAGER_ROLES])
  })

  it('excludes the two grantable roles below the floor', () => {
    expect(CHALLENGE_ADMIN_ROLES).not.toContain('staff')
    expect(CHALLENGE_ADMIN_ROLES).not.toContain('reception')
  })

  // The binding that keeps the Members redirect chain honest: its
  // /challenges step must carry THIS floor, not a re-derived copy.
  it('is the floor the Members chain step declares', () => {
    const step = HUB_INDEX_CHAINS['/members'].chain.find((s) => s.target === '/challenges')
    expect(step.roles).toBe(CHALLENGE_ADMIN_ROLES)
  })
})

describe('canAdminChallenges', () => {
  it('refuses a missing user', () => {
    expect(canAdminChallenges(null)).toBe(false)
    expect(canAdminChallenges(undefined)).toBe(false)
  })

  it('admits manager and owner, who hold the key by role default', () => {
    expect(canAdminChallenges(at('manager'))).toBe(true)
    expect(canAdminChallenges(at('owner'))).toBe(true)
  })

  it('refuses a head_coach by default and admits one who is GRANTED the key', () => {
    expect(canAdminChallenges(at('head_coach'))).toBe(false)
    expect(canAdminChallenges(at('head_coach', { challenges: true }))).toBe(true)
  })

  // The defect persona: grantable role, granted key, below the floor.
  it('refuses a staff or reception holder EVEN WITH the key granted', () => {
    expect(canAdminChallenges(at('staff', { challenges: true }))).toBe(false)
    expect(canAdminChallenges(at('reception', { challenges: true }))).toBe(false)
  })

  it('refuses a manager whose key is explicitly revoked', () => {
    expect(canAdminChallenges(at('manager', { challenges: false }))).toBe(false)
  })

  it('honours the per-location feature gate', () => {
    expect(canAdminChallenges(at('manager', {}, { challenges: false }))).toBe(false)
  })

  // user.role is the ACTIVE-LOCATION role, and that is the field
  // /api/challenges reads. Being more generous here than the data route
  // is what produces a page that renders and then fails.
  it('refuses a master whose active-location role is below the floor, matching the API', () => {
    expect(canAdminChallenges(at('staff', {}))).toBe(false)
    expect(canAdminChallenges(at('master'))).toBe(true)
  })
})
