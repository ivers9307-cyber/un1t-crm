import { describe, it, expect } from 'vitest'
import {
  worstStatus,
  daysUntil,
  gradeWhatsappNumber,
  gradeXeroConnection,
  gradeShellyConnection,
  SHELLY_HREF,
  agentSignal,
  locationTabHref,
  gradeTenantEmail,
  emailDomainHref,
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
  assembleIntegrationsHub,
} from './integrations-hub'
// The tenants console counts hub attention rows THROUGH a.locationId; the
// Shelly card's card-level row is pinned to a real id so that count works.
// Imported here rather than mirrored, so a change to either side shows up.
import { attentionCountByOrg } from './admin-tenants'

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

describe('gradeShellyConnection', () => {
  it('no row → not_connected with no message', () => {
    expect(gradeShellyConnection(null)).toEqual({ status: 'not_connected', message: null })
    expect(gradeShellyConnection(undefined)).toEqual({ status: 'not_connected', message: null })
  })

  it('connected → connected, no message', () => {
    expect(gradeShellyConnection({ status: 'connected' })).toEqual({ status: 'connected', message: null })
  })

  it('action_needed → the re-paste prompt (the key rotates with the Shelly password)', () => {
    const g = gradeShellyConnection({ status: 'action_needed' })
    expect(g.status).toBe('action_needed')
    expect(g.message).toMatch(/re-paste/i)
    expect(g.message).toMatch(/password/i)
  })

  it('error reads as RETRYING, carrying last_error (obligation 6 — a blip parks 5 min)', () => {
    const g = gradeShellyConnection({ status: 'error', last_error: 'cloud timeout' })
    expect(g.status).toBe('error')
    expect(g.message).toBe('Retrying — cloud timeout')
    expect(g.message).not.toMatch(/check the connection/i)
  })

  it('error with no last_error still reads as retrying', () => {
    expect(gradeShellyConnection({ status: 'error', last_error: null }))
      .toEqual({ status: 'error', message: 'Retrying — Shelly unreachable' })
  })

  it('caps a runaway last_error rather than pasting it whole into the strip', () => {
    const g = gradeShellyConnection({ status: 'error', last_error: 'x'.repeat(900) })
    expect(g.message.length).toBeLessThanOrEqual('Retrying — '.length + 300)
  })

  it('an unknown status grades error, never connected (a broken studio must not read green)', () => {
    expect(gradeShellyConnection({ status: 'wat' })).toEqual({ status: 'error', message: 'Unknown connection state' })
    expect(gradeShellyConnection({})).toEqual({ status: 'error', message: 'Unknown connection state' })
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

describe('gradeTenantEmail', () => {
  it('no row → platform (the default shared-account state today)', () => {
    expect(gradeTenantEmail(null)).toBe('platform')
    expect(gradeTenantEmail(undefined)).toBe('platform')
  })

  it('live → connected', () => {
    expect(gradeTenantEmail({ status: 'live', sending_domain: 'mail.gymx.com' })).toBe('connected')
  })

  it('pending / verifying → action_needed', () => {
    expect(gradeTenantEmail({ status: 'pending' })).toBe('action_needed')
    expect(gradeTenantEmail({ status: 'verifying' })).toBe('action_needed')
  })

  it('failed / disabled → error', () => {
    expect(gradeTenantEmail({ status: 'failed' })).toBe('error')
    expect(gradeTenantEmail({ status: 'disabled' })).toBe('error')
  })

  it('unknown status → platform (defensive: shared account is the safe fallback)', () => {
    expect(gradeTenantEmail({ status: 'wat' })).toBe('platform')
    expect(gradeTenantEmail({})).toBe('platform')
  })
})

describe('emailDomainHref', () => {
  it('appends organization_id for master (owner ignores the param)', () => {
    expect(emailDomainHref('org-1')).toBe('/settings/email-domain?organization_id=org-1')
  })

  it('falls back to the bare wizard path when no org id', () => {
    expect(emailDomainHref(null)).toBe('/settings/email-domain')
    expect(emailDomainHref(undefined)).toBe('/settings/email-domain')
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

// ── Phase-2: per-provider has_* presence flags + non-secret prefill ──
// A stub db whose every read resolves to no rows, so the assembler drives
// glofox/unifi/climate/bca from the LEGACY location fields (registry empty).
// Pins two things: (1) the drawer's prefill fields are present, (2) NO raw
// secret value ever appears in the assembled payload.
function emptyDb() {
  const builder = {
    select: () => builder,
    in: () => builder,
    eq: () => builder,
    neq: () => builder,
    gte: () => builder,
    order: () => builder,
    limit: () => builder,
    range: () => builder,
    maybeSingle: () => Promise.resolve({ data: null, error: null }),
    single: () => Promise.resolve({ data: null, error: null }),
    then: (res, rej) => Promise.resolve({ data: [], error: null }).then(res, rej),
  }
  return { from: () => builder }
}

describe('assembleIntegrationsHub — Phase-2 presence flags + secret non-leak', () => {
  const LOCATION = {
    id: 'loc-1',
    name: 'Stillorgan',
    organization_id: null, // keep email-delivery + billing queries out
    settings: {
      glofox: { branch_id: 'br-1', api_key: 'SECRET_KEY', api_token: 'SECRET_TOKEN', webhook_secret: 'SECRET_HOOK', namespace: 'untstillorgan' },
      unifi: { host: 'https://u:12445', api_token: 'SECRET_UNIFI', staff_policy_id: 's1', allow_self_signed: true },
    },
    sensibo_api_key: 'SECRET_SENSIBO',
    thinq_pat: 'SECRET_PAT',
    thinq_client_id: 'cid-1',
    thinq_country_code: 'IE',
    twilio_alpha_sender_id: 'UN1T STILL',
    bca_config: { send_from: 'a@ccf.com', send_to: 'b@bca.com', documents: [{ slug: 'doc_01', label: 'x' }] },
    features: { bca_submit: true },
  }

  it('exposes has_* + non-secret prefill and never leaks a secret value', async () => {
    const data = await assembleIntegrationsHub(emptyDb(), [LOCATION], { now: NOW })

    const g = data.glofox[0]
    expect(g).toMatchObject({ branchId: 'br-1', namespace: 'untstillorgan', hasApiKey: true, hasApiToken: true, hasWebhookSecret: true })

    const u = data.unifi[0]
    expect(u).toMatchObject({ host: 'https://u:12445', hasToken: true, staffPolicyId: 's1', allowSelfSigned: true })

    const c = data.climate[0]
    expect(c.sensibo).toEqual({ hasKey: true })
    expect(c.thinq).toEqual({ hasPat: true, clientId: 'cid-1', countryCode: 'IE' })

    expect(data.bca[0]).toMatchObject({ sendFrom: 'a@ccf.com', sendTo: 'b@bca.com', documentCount: 1 })
    expect(data.sms[0].senderId).toBe('UN1T STILL')

    // The whole payload must not contain a single raw secret.
    const json = JSON.stringify(data)
    for (const secret of ['SECRET_KEY', 'SECRET_TOKEN', 'SECRET_HOOK', 'SECRET_UNIFI', 'SECRET_SENSIBO', 'SECRET_PAT']) {
      expect(json).not.toContain(secret)
    }
  })
})

// ── Shelly plugs card (SHELLY-UI.7) ──
//
// A fake db that answers PER TABLE, so a read can be given rows, an error,
// or nothing independently of its neighbours. organization_id is null on
// both fixtures, which keeps the email-delivery and billing queries out of
// the way (they short-circuit on an empty org set / no plan pin).
// It also RECORDS every .in() per table and HONOURS it — the fixture rows
// are filtered by the ids the assembler actually passed, and .range() slices
// the result. Both matter: without the filter a dropped .in('location_id',
// ids) would still pass every assertion below (the tenant boundary this
// payload inherits from the caller's scoped `locations` query would be gone
// and no test would notice), and without the slice the pagination test could
// not tell one page from five.
function tableDb(byTable = {}) {
  const inCalls = {}
  return {
    inCalls,
    from: (table) => {
      const result = byTable[table] ?? { data: [], error: null }
      const filters = (inCalls[table] ||= [])
      let slice = null
      const resolve = () => {
        if (result.error) return { data: null, error: result.error }
        let rows = result.data || []
        for (const [col, values] of filters) {
          if (Array.isArray(values)) rows = rows.filter((r) => values.includes(r[col]))
        }
        if (slice) rows = rows.slice(slice[0], slice[1] + 1)
        return { data: rows, error: null }
      }
      const builder = {
        select: () => builder,
        in: (...args) => { filters.push(args); return builder },
        eq: () => builder,
        neq: () => builder,
        gte: () => builder,
        lte: () => builder,
        order: () => builder,
        limit: () => builder,
        range: (from, to) => { slice = [from, to]; return builder },
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
        single: () => Promise.resolve({ data: null, error: null }),
        then: (res, rej) => Promise.resolve(resolve()).then(res, rej),
      }
      return builder
    },
  }
}

const LOC_A = { id: 'loc-a', name: 'Stillorgan', organization_id: null, settings: {} }
const LOC_B = { id: 'loc-b', name: 'Hatch Street', organization_id: null, settings: {} }

describe('assembleIntegrationsHub — Shelly plugs card', () => {
  it('NEVER leaks the auth key or its fingerprint, even when the row carries them', async () => {
    // The real select asks for neither column; this fixture hands them over
    // anyway, which is the point — the assembler must project an allowlist,
    // not spread the row it was given.
    const db = tableDb({
      shelly_connections: {
        data: [{
          location_id: LOC_A.id,
          host: 'shelly-77-eu.shelly.cloud',
          status: 'connected',
          last_error: null,
          last_ok_at: '2026-07-19T11:58:00Z',
          updated_at: '2026-07-19T11:59:30Z',
          key_hint: 'ab12',
          auth_key: 'SECRET_SHELLY',
          auth_key_fingerprint: 'FP_SECRET',
        }],
      },
    })
    const data = await assembleIntegrationsHub(db, [LOC_A], { now: NOW })

    expect(data.shelly).toHaveLength(1)
    expect(data.shelly[0]).toMatchObject({
      cardKey: 'shelly',
      locationId: LOC_A.id,
      locationName: 'Stillorgan',
      status: 'connected',
      message: null,
      host: 'shelly-77-eu.shelly.cloud',
      hasAuthKey: true,
      keyHint: 'ab12',
      lastOkAt: '2026-07-19T11:58:00Z',
      // last ATTEMPT (updated_at) is carried separately from last SUCCESS:
      // the pair is what distinguishes "still retrying" from "abandoned".
      lastAttemptAt: '2026-07-19T11:59:30Z',
      countsKnown: true,
      href: SHELLY_HREF,
    })
    expect(data.shelly[0].href).toBe('/automations/shelly')
    // BOTH Shelly reads are scoped to the caller's locations — deleting
    // either .in('location_id', ids) fails here, and with it the tenant
    // boundary the whole payload inherits from the route's scoped query.
    expect(db.inCalls.shelly_connections[0]).toEqual(['location_id', [LOC_A.id]])
    expect(db.inCalls.shelly_devices[0]).toEqual(['location_id', [LOC_A.id]])

    const json = JSON.stringify(data)
    expect(json).not.toContain('SECRET_SHELLY')
    expect(json).not.toContain('FP_SECRET')
    // The hint IS non-secret (publicConnectionView returns it) — pinned so a
    // future over-correction that strips it fails loudly rather than quietly.
    expect(json).toContain('ab12')
  })

  it('a location that never connected yields a not_connected row with zero counts', async () => {
    const data = await assembleIntegrationsHub(tableDb(), [LOC_A], { now: NOW })

    expect(data.shelly).toHaveLength(1)
    expect(data.shelly[0]).toMatchObject({
      locationId: LOC_A.id,
      status: 'not_connected',
      message: null,
      host: null,
      hasAuthKey: false,
      keyHint: null,
      lastOkAt: null,
      lastAttemptAt: null,
      // Zero here is a READING, not an absence of one — countsKnown says so.
      countsKnown: true,
      deviceCount: 0,
      enabledCount: 0,
      onlineCount: 0,
      href: SHELLY_HREF,
    })
    // Bare absence never nags.
    expect(data.attention.filter((a) => a.cardKey === 'shelly')).toEqual([])
  })

  it('a DISCONNECTED location that still has plugs adopted nags as partial setup', async () => {
    const db = tableDb({
      shelly_devices: {
        data: [
          { location_id: LOC_A.id, enabled: true, last_state: { online: true } },
          { location_id: LOC_A.id, enabled: false, last_state: { online: false } },
        ],
      },
    })
    const data = await assembleIntegrationsHub(db, [LOC_A], { now: NOW })

    expect(data.shelly[0]).toMatchObject({ status: 'not_connected', deviceCount: 2 })
    const nag = data.attention.filter((a) => a.cardKey === 'shelly')
    expect(nag).toHaveLength(1)
    expect(nag[0]).toMatchObject({
      severity: 'info',
      label: 'Shelly plugs',
      locationName: 'Stillorgan',
      href: SHELLY_HREF,
      // The copy has to say what the half-state COSTS, not just that it
      // exists: the relays hold wherever they were left and no schedule
      // will move them again until the account is reconnected.
      message: '2 plugs still adopted — nothing schedules them while the Shelly account is disconnected',
    })
  })

  it('singularises the stranded-plug nag', async () => {
    const db = tableDb({
      shelly_devices: { data: [{ location_id: LOC_A.id, enabled: true, last_state: { online: true } }] },
    })
    const data = await assembleIntegrationsHub(db, [LOC_A], { now: NOW })
    expect(data.attention.find((a) => a.cardKey === 'shelly').message).toMatch(/^1 plug still adopted/)
  })

  it('an unreadable read grades EVERY in-scope location error — never "not connected"', async () => {
    for (const failing of ['shelly_connections', 'shelly_devices']) {
      const db = tableDb({ [failing]: { error: { message: 'db exploded' } } })
      const data = await assembleIntegrationsHub(db, [LOC_A, LOC_B], { now: NOW })

      expect(data.shelly).toHaveLength(2)
      for (const row of data.shelly) {
        expect(row.status).toBe('error')
        expect(row.message).toBe('Could not read Shelly state')
        // UNKNOWN, not zero. A 0 here would render as "no plugs adopted"
        // directly under "Could not read Shelly state" — a fact we do not
        // have, printed beside the admission that we could not get it.
        expect(row).toMatchObject({
          countsKnown: false,
          deviceCount: null,
          enabledCount: null,
          onlineCount: null,
        })
      }
      // ONE row for one blip, not one per location: the failure is a property
      // of the card, so N locations would print the same sentence N times and
      // crowd everything else out of the strip.
      const nag = data.attention.filter((a) => a.cardKey === 'shelly')
      expect(nag).toHaveLength(1)
      expect(nag[0]).toMatchObject({
        severity: 'error',
        label: 'Shelly plugs',
        locationName: 'All locations',
        message: 'Could not read Shelly state — retrying',
        href: SHELLY_HREF,
      })
      // Pinned to a REAL location id, never null: attentionCountByOrg
      // (admin-tenants.js) resolves the org through it and drops what it
      // cannot map, so a null would be counted zero times.
      expect(nag[0].locationId).toBe(LOC_A.id)
      // The db's own failure text is never echoed to the operator.
      expect(JSON.stringify(data)).not.toContain('db exploded')
    }
  })

  it('the single read-blip attention row is counted exactly once per org', async () => {
    const db = tableDb({ shelly_connections: { error: { message: 'db exploded' } } })
    const data = await assembleIntegrationsHub(db, [LOC_A, LOC_B], { now: NOW })
    const shellyNag = data.attention.filter((a) => a.cardKey === 'shelly')
    expect(attentionCountByOrg(shellyNag, { [LOC_A.id]: 'org-1', [LOC_B.id]: 'org-1' }))
      .toEqual({ 'org-1': 1 })
  })

  it('paginates the device read past the 1,000-row PostgREST cap', async () => {
    // 1,001 rows in location order — one more than a single page, so a
    // .limit()-only read would silently lose the tail.
    const rows = [
      ...Array.from({ length: 600 }, (_, i) => ({
        location_id: LOC_A.id, enabled: i % 2 === 0, last_state: { online: i % 3 === 0 },
      })),
      ...Array.from({ length: 401 }, () => ({
        location_id: LOC_B.id, enabled: false, last_state: { online: true },
      })),
    ]
    const db = tableDb({ shelly_devices: { data: rows } })
    const data = await assembleIntegrationsHub(db, [LOC_A, LOC_B], { now: NOW })

    const a = data.shelly.find((r) => r.locationId === LOC_A.id)
    const b = data.shelly.find((r) => r.locationId === LOC_B.id)
    expect(a).toMatchObject({ countsKnown: true, deviceCount: 600, enabledCount: 300, onlineCount: 200 })
    // The 401st row of B lands on page two — the whole point of the fixture.
    expect(b).toMatchObject({ countsKnown: true, deviceCount: 401, enabledCount: 0, onlineCount: 401 })
    // Two pages were read, and both were scoped to the caller's locations.
    expect(db.inCalls.shelly_devices).toHaveLength(2)
    for (const call of db.inCalls.shelly_devices) {
      expect(call).toEqual(['location_id', [LOC_A.id, LOC_B.id]])
    }
  })

  it('counts are grouped per location and never cross locations', async () => {
    const db = tableDb({
      shelly_connections: {
        data: [
          { location_id: LOC_A.id, host: 'shelly-77-eu.shelly.cloud', status: 'connected', last_ok_at: '2026-07-19T11:00:00Z', key_hint: 'ab12' },
          { location_id: LOC_B.id, host: 'shelly-99-eu.shelly.cloud', status: 'action_needed', last_error: null, key_hint: 'cd34' },
        ],
      },
      shelly_devices: {
        data: [
          // A: 3 adopted, 2 enabled, 1 online (the third has never been read).
          { location_id: LOC_A.id, enabled: true, last_state: { online: true } },
          { location_id: LOC_A.id, enabled: true, last_state: { online: false } },
          { location_id: LOC_A.id, enabled: false, last_state: null },
          // B: 1 adopted, 0 enabled, 1 online.
          { location_id: LOC_B.id, enabled: false, last_state: { online: true } },
        ],
      },
    })
    const data = await assembleIntegrationsHub(db, [LOC_A, LOC_B], { now: NOW })

    const a = data.shelly.find((r) => r.locationId === LOC_A.id)
    const b = data.shelly.find((r) => r.locationId === LOC_B.id)
    expect(a).toMatchObject({ status: 'connected', countsKnown: true, deviceCount: 3, enabledCount: 2, onlineCount: 1, keyHint: 'ab12' })
    expect(b).toMatchObject({ status: 'action_needed', countsKnown: true, deviceCount: 1, enabledCount: 0, onlineCount: 1, keyHint: 'cd34' })
    expect(b.message).toMatch(/re-paste/i)

    // B's action_needed lands in the warning band with the re-paste prompt;
    // A (healthy) contributes nothing.
    const nag = data.attention.filter((n) => n.cardKey === 'shelly')
    expect(nag).toHaveLength(1)
    expect(nag[0]).toMatchObject({ severity: 'warning', locationId: LOC_B.id, label: 'Shelly plugs' })
  })
})
