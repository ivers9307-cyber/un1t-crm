import { describe, it, expect } from 'vitest'
import {
  worstStatus,
  daysUntil,
  gradeWhatsappNumber,
  gradeXeroConnection,
  agentSignal,
  locationTabHref,
  buildAttention,
  calendarDaysBetween,
  billingExpiresOn,
  walletLapseWarning,
  groupPlanPins,
  foldMeterUsage,
  foldDrawCents,
  buildBillingMeters,
  LAPSE_WARN_MIN_CENTS,
  LAPSE_WARN_DAYS,
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

// ─── Plan & wallet strip (INTEG-C4) ───

describe('calendarDaysBetween', () => {
  it('whole calendar days, to - from', () => {
    expect(calendarDaysBetween('2026-07-20', '2026-07-31')).toBe(11)
    expect(calendarDaysBetween('2026-07-31', '2026-07-31')).toBe(0)
    expect(calendarDaysBetween('2026-07-31', '2026-07-20')).toBe(-11)
  })

  it('crosses month + DST boundaries as pure calendar math', () => {
    expect(calendarDaysBetween('2026-03-28', '2026-04-01')).toBe(4) // spans the IST switch
  })

  it('null on unparseable input', () => {
    expect(calendarDaysBetween('nope', '2026-07-31')).toBeNull()
    expect(calendarDaysBetween('2026-07-31', null)).toBeNull()
  })
})

describe('billingExpiresOn', () => {
  it('last day of the current Dublin month', () => {
    expect(billingExpiresOn('2026-07-20')).toBe('2026-07-31')
    expect(billingExpiresOn('2026-07-01')).toBe('2026-07-31')
    expect(billingExpiresOn('2026-07-31')).toBe('2026-07-31')
  })

  it('handles short months, December and leap February', () => {
    expect(billingExpiresOn('2026-04-15')).toBe('2026-04-30')
    expect(billingExpiresOn('2026-12-05')).toBe('2026-12-31')
    expect(billingExpiresOn('2028-02-10')).toBe('2028-02-29')
  })
})

describe('walletLapseWarning', () => {
  it('warns when >€10 would expire within 7 days (boundary: exactly 7 days out)', () => {
    // July: expires 2026-07-31. 7 days out = 2026-07-24.
    expect(walletLapseWarning({ balanceCents: 2500, todayStr: '2026-07-24' })).toBe(true)
    expect(walletLapseWarning({ balanceCents: 2500, todayStr: '2026-07-31' })).toBe(true)
  })

  it('quiet at 8 days out', () => {
    expect(walletLapseWarning({ balanceCents: 2500, todayStr: '2026-07-23' })).toBe(false)
  })

  it('€10 exactly does NOT warn — the threshold is strictly over €10', () => {
    expect(walletLapseWarning({ balanceCents: LAPSE_WARN_MIN_CENTS, todayStr: '2026-07-30' })).toBe(false)
    expect(walletLapseWarning({ balanceCents: LAPSE_WARN_MIN_CENTS + 1, todayStr: '2026-07-30' })).toBe(true)
  })

  it('zero / negative balances never warn', () => {
    expect(walletLapseWarning({ balanceCents: 0, todayStr: '2026-07-31' })).toBe(false)
    expect(walletLapseWarning({ balanceCents: -500, todayStr: '2026-07-31' })).toBe(false)
  })

  it('honours an explicit expiresOn override', () => {
    expect(walletLapseWarning({ balanceCents: 2000, todayStr: '2026-07-20', expiresOn: '2026-07-22' })).toBe(true)
    expect(
      walletLapseWarning({
        balanceCents: 2000,
        todayStr: '2026-07-20',
        expiresOn: `2026-07-${20 + LAPSE_WARN_DAYS + 1}`,
      }),
    ).toBe(false)
  })
})

describe('groupPlanPins', () => {
  const tierRow = {
    location_id: 'loc-1',
    version: {
      id: 'v1', effective_from: '2026-07-01', price_cents: 19900,
      allowances: { wa_template_send: 500 },
      plan: { id: 'p1', slug: 'core', name: 'Core', kind: 'tier' },
    },
  }
  const addonRow = {
    location_id: 'loc-1',
    version: {
      id: 'v2', effective_from: '2026-07-01', price_cents: 900,
      allowances: {},
      plan: { id: 'p2', slug: 'custom_email_domain', name: 'Custom email domain', kind: 'addon' },
    },
  }

  it('splits tier vs addons per location and strips plan off the version', () => {
    const pins = groupPlanPins([tierRow, addonRow])
    expect(pins['loc-1'].tier.plan.slug).toBe('core')
    expect(pins['loc-1'].tier.version.plan).toBeUndefined()
    expect(pins['loc-1'].tier.version.price_cents).toBe(19900)
    expect(pins['loc-1'].addons).toHaveLength(1)
    expect(pins['loc-1'].addons[0].plan.kind).toBe('addon')
  })

  it('a location with only an addon pin has tier: null (still unpinned for the strip)', () => {
    const pins = groupPlanPins([{ ...addonRow, location_id: 'loc-2' }])
    expect(pins['loc-2'].tier).toBeNull()
  })

  it('empty / malformed rows → no pins (the unpinned normal state)', () => {
    expect(groupPlanPins([])).toEqual({})
    expect(groupPlanPins(null)).toEqual({})
    expect(groupPlanPins([{ location_id: 'loc-3', version: null }])).toEqual({})
  })
})

describe('foldMeterUsage / foldDrawCents', () => {
  it('sums rollup quantities per location per meter', () => {
    const out = foldMeterUsage([
      { location_id: 'loc-1', meter: 'wa_template_send', quantity: 10 },
      { location_id: 'loc-1', meter: 'wa_template_send', quantity: 5 },
      { location_id: 'loc-1', meter: 'email_send', quantity: 200 },
      { location_id: 'loc-2', meter: 'email_send', quantity: 7 },
    ])
    expect(out['loc-1']).toEqual({ wa_template_send: 15, email_send: 200 })
    expect(out['loc-2']).toEqual({ email_send: 7 })
  })

  it('folds negative draw amounts into positive cents drawn', () => {
    const out = foldDrawCents([
      { location_id: 'loc-1', meter: 'wa_template_send', amount_cents: -120 },
      { location_id: 'loc-1', meter: 'wa_template_send', amount_cents: -30 },
      { location_id: 'loc-1', meter: 'ai_message', amount_cents: -55 },
    ])
    expect(out['loc-1']).toEqual({ wa_template_send: 150, ai_message: 55 })
  })

  it('maps unit-rate draw keys (wa_marketing/wa_utility/email_per_1k) onto their strip meters', () => {
    const out = foldDrawCents([
      { location_id: 'loc-1', meter: 'wa_marketing', amount_cents: -100 },
      { location_id: 'loc-1', meter: 'wa_utility', amount_cents: -40 },
      { location_id: 'loc-1', meter: 'email_per_1k', amount_cents: -80 },
    ])
    expect(out['loc-1']).toEqual({ wa_template_send: 140, email_send: 80 })
  })

  it('ignores positive amounts defensively (draws are stored negative)', () => {
    const out = foldDrawCents([{ location_id: 'loc-1', meter: 'ai_message', amount_cents: 100 }])
    expect(out['loc-1']).toEqual({ ai_message: 0 })
  })
})

describe('buildBillingMeters', () => {
  const resolved = {
    allowances: { wa_template_send: 500, email_send: 2000, ai_message: 300 },
  }

  it('one entry per shared METER_KEYS with usage vs allowance', () => {
    const out = buildBillingMeters(resolved, { wa_template_send: 120, email_send: 2500, ai_message: 0 })
    expect(out.map((m) => m.key)).toEqual(['wa_template_send', 'email_send', 'ai_message'])
    const wa = out.find((m) => m.key === 'wa_template_send')
    expect(wa).toMatchObject({ used: 120, allowance: 500, overQty: 0, overageDrawnCents: 0 })
    expect(wa.label).toBe('WhatsApp templates')
  })

  it('overage: overQty = used - allowance, drawn cents carried through', () => {
    const out = buildBillingMeters(
      resolved,
      { email_send: 2500 },
      { email_send: 80 },
    )
    const email = out.find((m) => m.key === 'email_send')
    expect(email.overQty).toBe(500)
    expect(email.overageDrawnCents).toBe(80)
  })

  it('zero allowance with usage is all overage', () => {
    const out = buildBillingMeters({ allowances: {} }, { ai_message: 12 })
    const ai = out.find((m) => m.key === 'ai_message')
    expect(ai.allowance).toBe(0)
    expect(ai.overQty).toBe(12)
  })

  it('null resolved (defensive) still yields the full meter list at zero', () => {
    const out = buildBillingMeters(null)
    expect(out).toHaveLength(3)
    for (const m of out) expect(m).toMatchObject({ used: 0, allowance: 0, overQty: 0, overageDrawnCents: 0 })
  })
})
