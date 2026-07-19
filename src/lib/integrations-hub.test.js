import { describe, it, expect } from 'vitest'
import {
  worstStatus,
  daysUntil,
  gradeWhatsappNumber,
  gradeXeroConnection,
  agentSignal,
  locationTabHref,
  buildAttention,
} from './integrations-hub'

const NOW = new Date('2026-07-19T12:00:00Z')

describe('worstStatus', () => {
  it('returns not_connected for empty / unknown input', () => {
    expect(worstStatus([])).toBe('not_connected')
    expect(worstStatus(undefined)).toBe('not_connected')
    expect(worstStatus(['bogus'])).toBe('not_connected')
  })

  it('error outranks everything', () => {
    expect(worstStatus(['connected', 'action_needed', 'error'])).toBe('error')
  })

  it('action_needed outranks connected', () => {
    expect(worstStatus(['connected', 'action_needed'])).toBe('action_needed')
  })

  it('connected outranks not_connected (mixed-location card shows Connected)', () => {
    expect(worstStatus(['not_connected', 'connected'])).toBe('connected')
  })

  it('all not_connected stays not_connected', () => {
    expect(worstStatus(['not_connected', 'not_connected'])).toBe('not_connected')
  })
})

describe('daysUntil', () => {
  it('null for absent or invalid input', () => {
    expect(daysUntil(null, NOW)).toBeNull()
    expect(daysUntil('not-a-date', NOW)).toBeNull()
  })

  it('counts whole days (ceil)', () => {
    expect(daysUntil('2026-07-28T13:00:00Z', NOW)).toBe(10)
    expect(daysUntil('2026-07-20T11:00:00Z', NOW)).toBe(1)
  })

  it('past timestamps go non-positive', () => {
    expect(daysUntil('2026-07-18T12:00:00Z', NOW)).toBeLessThanOrEqual(0)
  })
})

describe('gradeWhatsappNumber', () => {
  it('no row → not_connected', () => {
    expect(gradeWhatsappNumber(null).status).toBe('not_connected')
  })

  it('deactivated number → not_connected', () => {
    expect(gradeWhatsappNumber({ is_active: false }).status).toBe('not_connected')
  })

  it('token_invalid_at → error with dated message', () => {
    const g = gradeWhatsappNumber({ is_active: true, token_invalid_at: '2026-07-10T08:00:00Z' })
    expect(g.status).toBe('error')
    expect(g.message).toContain('2026-07-10')
  })

  it('RED quality → action_needed', () => {
    const g = gradeWhatsappNumber({ is_active: true, quality_rating: 'RED' })
    expect(g.status).toBe('action_needed')
  })

  it('healthy → connected', () => {
    expect(gradeWhatsappNumber({ is_active: true, quality_rating: 'GREEN' }).status).toBe('connected')
  })
})

describe('gradeXeroConnection', () => {
  it('no row / no tenant → not_connected', () => {
    expect(gradeXeroConnection(null).status).toBe('not_connected')
    expect(gradeXeroConnection({ tenant_id: null }).status).toBe('not_connected')
  })

  it('tenant bound and no sync errors → connected', () => {
    expect(gradeXeroConnection({ tenant_id: 't1' }).status).toBe('connected')
  })

  it('any sync error → error with the message surfaced', () => {
    const g = gradeXeroConnection({ tenant_id: 't1', contacts_sync_error: 'invalid_grant: token revoked' })
    expect(g.status).toBe('error')
    expect(g.message).toContain('invalid_grant')
  })
})

describe('agentSignal', () => {
  it('enabled=true is LIVE even with test_mode=true (the invariant)', () => {
    expect(agentSignal({ enabled: true, test_mode: true })).toBe('live')
  })

  it('enabled=false + test_mode=true → test', () => {
    expect(agentSignal({ enabled: false, test_mode: true })).toBe('test')
  })

  it('neither → off (and missing settings → off)', () => {
    expect(agentSignal({})).toBe('off')
    expect(agentSignal(null)).toBe('off')
  })
})

describe('locationTabHref', () => {
  it('deep-links into the existing per-location integrations tab', () => {
    expect(locationTabHref('loc-1', 'glofox')).toBe('/settings/locations/loc-1?tab=glofox')
  })
})

describe('buildAttention', () => {
  const base = { locationId: 'loc-1', locationName: 'Stillorgan', href: '/x' }

  it('orders errors, then expiring tokens, then partial setup', () => {
    const rows = [
      { ...base, cardKey: 'glofox', status: 'not_connected', partialSetup: true },
      { ...base, cardKey: 'instagram', status: 'connected', tokenExpiresAt: '2026-07-25T00:00:00Z' },
      { ...base, cardKey: 'xero', status: 'error', message: 'invalid_grant' },
    ]
    const out = buildAttention(rows, { now: NOW })
    expect(out.map((r) => r.cardKey)).toEqual(['xero', 'instagram', 'glofox'])
    expect(out.map((r) => r.severity)).toEqual(['error', 'warning', 'info'])
  })

  it('a healthy token runway produces no entry', () => {
    const out = buildAttention(
      [{ ...base, cardKey: 'instagram', status: 'connected', tokenExpiresAt: '2026-09-19T00:00:00Z' }],
      { now: NOW },
    )
    expect(out).toEqual([])
  })

  it('expiring window follows expirySoonDays', () => {
    const rows = [{ ...base, cardKey: 'instagram', status: 'connected', tokenExpiresAt: '2026-07-27T00:00:00Z' }]
    expect(buildAttention(rows, { now: NOW, expirySoonDays: 10 })).toHaveLength(1)
    expect(buildAttention(rows, { now: NOW, expirySoonDays: 3 })).toHaveLength(0)
  })

  it('action_needed rows land in the warning band with their message', () => {
    const out = buildAttention(
      [{ ...base, cardKey: 'whatsapp', status: 'action_needed', message: 'Meta quality rating is RED' }],
      { now: NOW },
    )
    expect(out).toHaveLength(1)
    expect(out[0].severity).toBe('warning')
    expect(out[0].message).toContain('RED')
  })

  it('bare not_connected without partial setup never nags', () => {
    const out = buildAttention(
      [{ ...base, cardKey: 'glofox', status: 'not_connected', partialSetup: false }],
      { now: NOW },
    )
    expect(out).toEqual([])
  })

  it('expired tokens read as expired, not negative days', () => {
    const out = buildAttention(
      [{ ...base, cardKey: 'instagram', status: 'connected', tokenExpiresAt: '2026-07-01T00:00:00Z' }],
      { now: NOW },
    )
    expect(out[0].message).toMatch(/expired/i)
  })
})
