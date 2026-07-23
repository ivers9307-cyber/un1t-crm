// APPROVALS-PERCAT.1 — six per-category approval permission keys.
// Locks the provider→permission map and role-default seeding derived
// from the current source-route approver sets, ahead of registry/route
// wiring (later tasks). See shared/permissions.js for the canonical
// approvals_inbox + sub-key definitions.

import { describe, it, expect } from 'vitest'
import {
  WEB_PERMISSION_KEYS,
  DEFAULT_WEB_PERMISSIONS_BY_ROLE,
  APPROVAL_CATEGORY_PERMISSION,
  APPROVAL_SUBPERMISSION_KEYS,
  isFeatureGatedByLocation,
} from '../permissions.js'

const SUB_KEYS = [
  'approvals_contractor_invoices',
  'approvals_fte_expenses',
  'approvals_agent_requests',
  'approvals_time_off',
  'approvals_shift_swaps',
  'approvals_rosters',
  // HYROX-TC.2 — seventh sub-key, added alongside the others.
  'approvals_hyrox_sessions',
]

describe('per-category approval permissions', () => {
  it('registers the sub-keys and the provider→permission map', () => {
    for (const k of SUB_KEYS) expect(WEB_PERMISSION_KEYS).toContain(k)
    expect(APPROVAL_SUBPERMISSION_KEYS).toEqual(SUB_KEYS)
    expect(APPROVAL_CATEGORY_PERMISSION).toEqual({
      contractor_invoices: 'approvals_contractor_invoices',
      fte_expenses: 'approvals_fte_expenses',
      agent_requests: 'approvals_agent_requests',
      time_off: 'approvals_time_off',
      shift_swaps: 'approvals_shift_swaps',
      rosters: 'approvals_rosters',
      hyrox_sessions: 'approvals_hyrox_sessions',
    })
  })

  it('the sub-keys are NOT location-gated (approvals_inbox is the only gate)', () => {
    for (const k of SUB_KEYS) expect(isFeatureGatedByLocation(k)).toBe(false)
    expect(isFeatureGatedByLocation('approvals_inbox')).toBe(true)
  })

  it('seeds role defaults from current source-route approver sets', () => {
    const finance = ['approvals_contractor_invoices', 'approvals_fte_expenses', 'approvals_rosters']
    const managerish = ['approvals_agent_requests', 'approvals_time_off', 'approvals_shift_swaps', 'approvals_hyrox_sessions']
    for (const role of ['owner', 'master']) {
      for (const k of SUB_KEYS) expect(DEFAULT_WEB_PERMISSIONS_BY_ROLE[role][k]).toBe(true)
    }
    for (const role of ['manager', 'head_coach']) {
      for (const k of managerish) expect(DEFAULT_WEB_PERMISSIONS_BY_ROLE[role][k]).toBe(true)
      for (const k of finance) expect(DEFAULT_WEB_PERMISSIONS_BY_ROLE[role][k]).toBe(false)
    }
    for (const role of ['staff', 'reception']) {
      for (const k of SUB_KEYS) expect(DEFAULT_WEB_PERMISSIONS_BY_ROLE[role][k]).toBe(false)
    }
  })

  it('no longer seeds approvals_inbox as a role grant', () => {
    for (const role of Object.keys(DEFAULT_WEB_PERMISSIONS_BY_ROLE)) {
      expect('approvals_inbox' in DEFAULT_WEB_PERMISSIONS_BY_ROLE[role]).toBe(false)
    }
  })
})
