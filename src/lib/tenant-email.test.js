// INTEG-B3 — tests for the send-path resolver, the add-on gate, and the
// REDACTING payload shaper. The resolver is FAIL SAFE: every error path
// resolves to the global default (today's behaviour) — proven here.

import { describe, it, expect, beforeEach, vi } from 'vitest'

// W1.E1 — the gate reads locationHasPlanFeature (tier OR add-on pins), not
// getLocationPlan (null without a tier pin, which hid an add-on-only pin).
vi.mock('@/lib/plans', () => ({ locationHasPlanFeature: vi.fn() }))
import { locationHasPlanFeature } from '@/lib/plans'

import {
  resolveEmailSender,
  globalDefaultSender,
  senderFromRow,
  orgHasEmailDomainAddon,
  tenantEmailStatePayload,
  dnsRecordsFromRow,
  _resetTenantEmailCache,
} from './tenant-email.js'

// Thenable fake db. handler(table, ops) → { data } | { data, error }.
function makeDb(handler) {
  let fromCount = 0
  const db = {
    fromCount: () => fromCount,
    from(table) {
      fromCount++
      const ops = { table, calls: [] }
      const run = () => Promise.resolve(handler(table, ops))
      const builder = new Proxy({}, {
        get(_, prop) {
          if (prop === 'then') { const p = run(); return p.then.bind(p) }
          if (prop === 'maybeSingle' || prop === 'single') return () => run()
          return (...args) => { ops.calls.push({ prop, args }); return builder }
        },
      })
      return builder
    },
  }
  return db
}

// W1.E2 — a row-driven fake: eq filters are applied, .maybeSingle()/.single()
// give one row, anything else gives the filtered array. Enough for the three
// readers the pre-domain sender touches (tenant row, branding chain, reply-to).
function fakeDb(tables) {
  return {
    from(table) {
      const filters = []
      let single = false
      const run = () => {
        const rows = (tables[table] || []).filter((r) => filters.every(([c, v]) => r[c] === v))
        return Promise.resolve(single ? { data: rows[0] ?? null, error: null } : { data: rows, error: null })
      }
      const b = new Proxy({}, {
        get(_, prop) {
          if (prop === 'then') { const p = run(); return p.then.bind(p) }
          if (prop === 'maybeSingle' || prop === 'single') return () => { single = true; return run() }
          if (prop === 'eq') return (c, v) => { filters.push([c, v]); return b }
          return () => b
        },
      })
      return b
    },
  }
}

beforeEach(() => {
  _resetTenantEmailCache()
  vi.clearAllMocks()
  // W1.E2 — the platform address is env-driven and a bare address; the tests
  // below prove the display name is never taken from it.
  process.env.POSTMARK_FROM_EMAIL = 'hello@platform.test'
})

describe('globalDefaultSender / senderFromRow (pure)', () => {
  it('global default has serverToken null + the platform address + PLATFORM_NAME, no reply-to', () => {
    expect(globalDefaultSender()).toEqual({ serverToken: null, fromEmail: 'hello@platform.test', fromName: 'Repset', replyTo: null })
  })
  it('W1.E2 — a "Name <addr>" env still yields the bare address, never its name', () => {
    process.env.POSTMARK_FROM_EMAIL = 'UN1T <hello@platform.test>'
    expect(globalDefaultSender()).toEqual({ serverToken: null, fromEmail: 'hello@platform.test', fromName: 'Repset', replyTo: null })
  })
  it('senderFromRow falls back to global when a row has no token', () => {
    expect(senderFromRow(null).serverToken).toBeNull()
    expect(senderFromRow({ from_email: 'x@y.com' }).serverToken).toBeNull()
  })
  it('senderFromRow builds a tenant sender from a live row', () => {
    expect(senderFromRow({ postmark_server_token: 'srv-tok', from_email: 'hi@mail.gymx.com', from_name: 'GymX' }))
      .toEqual({ serverToken: 'srv-tok', fromEmail: 'hi@mail.gymx.com', fromName: 'GymX', replyTo: null })
  })
})

describe('resolveEmailSender — fail safe to the global default', () => {
  it('no locationId → global default, no DB touch', async () => {
    const db = makeDb(() => ({ data: null }))
    expect(await resolveEmailSender(db, null)).toEqual(globalDefaultSender())
    expect(db.fromCount()).toBe(0)
  })

  it('no db → global default', async () => {
    expect(await resolveEmailSender(null, 'loc-1')).toEqual(globalDefaultSender())
  })

  it('location with no org → the platform sender (brand unresolved → PLATFORM_NAME), no reply-to', async () => {
    const db = makeDb((table) => table === 'locations' ? { data: { organization_id: null } } : { data: null })
    expect(await resolveEmailSender(db, 'loc-1')).toEqual(globalDefaultSender())
  })

  it('org has no live row → the platform sender', async () => {
    const db = makeDb((table) =>
      table === 'locations' ? { data: { organization_id: 'org-1' } } : { data: null })
    expect(await resolveEmailSender(db, 'loc-1')).toEqual(globalDefaultSender())
  })

  it('LIVE row → tenant sender (server token + verified From)', async () => {
    const db = makeDb((table) =>
      table === 'locations'
        ? { data: { organization_id: 'org-1' } }
        : { data: { postmark_server_token: 'srv-secret', from_email: 'hi@mail.gymx.com', from_name: 'GymX', status: 'live' } })
    expect(await resolveEmailSender(db, 'loc-1')).toEqual({ serverToken: 'srv-secret', fromEmail: 'hi@mail.gymx.com', fromName: 'GymX', replyTo: null })
  })

  // ── W1.E2 — the PRE-DOMAIN sender: platform address, tenant display name,
  // tenant reply-to. Nothing says UN1T. ──────────────────────────────────
  const GYM_A = {
    locations: [{ id: 'loc-1', name: 'Gym A', organization_id: 'org-a', email: 'hi@gyma.ie', email_inbox_reply_to: null }],
    tenant_email_domains: [],
    company_settings: [],
    org_settings: [],
    email_mailboxes: [],
  }

  it('W1.E2 — with no live tenant row the sender is the platform address with the brand as display name and the location reply-to', async () => {
    vi.stubEnv('POSTMARK_FROM_EMAIL', 'hello@platform.test')
    expect(await resolveEmailSender(fakeDb(GYM_A), 'loc-1'))
      .toEqual({ serverToken: null, fromEmail: 'hello@platform.test', fromName: 'Gym A', replyTo: 'hi@gyma.ie' })
    vi.unstubAllEnvs()
  })

  it('W1.E2 — the brand chain is honoured: company_settings beats the location name', async () => {
    const db = fakeDb({ ...GYM_A, company_settings: [{ location_id: 'loc-1', company_name: 'Gym A Studios', logo_url: null, favicon_url: null }] })
    expect((await resolveEmailSender(db, 'loc-1')).fromName).toBe('Gym A Studios')
  })

  it('W1.E2 — the default mailbox beats locations.email for reply-to; a NULL location email yields replyTo null', async () => {
    const withMailbox = fakeDb({
      ...GYM_A,
      email_mailboxes: [{ location_id: 'loc-1', address: 'inbox@gyma.ie', is_default: true, active: true }],
    })
    expect((await resolveEmailSender(withMailbox, 'loc-1')).replyTo).toBe('inbox@gyma.ie')

    _resetTenantEmailCache()
    const noEmail = fakeDb({
      ...GYM_A,
      locations: [{ id: 'loc-1', name: 'Gym A', organization_id: 'org-a', email: null, email_inbox_reply_to: null }],
    })
    expect(await resolveEmailSender(noEmail, 'loc-1'))
      .toEqual({ serverToken: null, fromEmail: 'hello@platform.test', fromName: 'Gym A', replyTo: null })
  })

  it('W1.E2 — a LIVE tenant row still wins outright (its own from + server token), replyTo still the location', async () => {
    const db = fakeDb({
      ...GYM_A,
      tenant_email_domains: [{ organization_id: 'org-a', status: 'live', postmark_server_token: 'srv-secret', from_email: 'hi@mail.gyma.ie', from_name: 'Gym A Mail' }],
    })
    expect(await resolveEmailSender(db, 'loc-1'))
      .toEqual({ serverToken: 'srv-secret', fromEmail: 'hi@mail.gyma.ie', fromName: 'Gym A Mail', replyTo: 'hi@gyma.ie' })
  })

  it('W1.E2 — the whole pre-domain object is cached (brand + reply-to resolve once per TTL)', async () => {
    let fromCount = 0
    const inner = fakeDb(GYM_A)
    const db = { from(t) { fromCount++; return inner.from(t) } }
    const first = await resolveEmailSender(db, 'loc-1')
    const after = fromCount
    const second = await resolveEmailSender(db, 'loc-1')
    expect(fromCount).toBe(after)
    expect(second).toEqual(first)
    expect(second).not.toBe(first) // a copy, so a caller cannot mutate the cache
  })

  it('W1.E2 — no code path produces a UN1T literal for a foreign tenant', async () => {
    const sender = await resolveEmailSender(fakeDb(GYM_A), 'loc-1')
    expect(JSON.stringify(sender)).not.toMatch(/un1t/i)
  })

  it('ANY DB error → global default (never throws)', async () => {
    const db = { from() { throw new Error('db down') } }
    await expect(resolveEmailSender(db, 'loc-1')).resolves.toEqual(globalDefaultSender())
  })

  it('PostgREST error object → global default', async () => {
    const db = makeDb((table) =>
      table === 'locations' ? { data: null, error: { message: 'boom' } } : { data: null })
    expect(await resolveEmailSender(db, 'loc-1')).toEqual(globalDefaultSender())
  })

  it('caches the lookup within the TTL (second call hits no table)', async () => {
    const db = makeDb((table) =>
      table === 'locations'
        ? { data: { organization_id: 'org-1' } }
        : { data: { postmark_server_token: 'srv-secret', from_email: 'hi@mail.gymx.com', status: 'live' } })
    await resolveEmailSender(db, 'loc-1')
    const after = db.fromCount()
    await resolveEmailSender(db, 'loc-1')
    expect(db.fromCount()).toBe(after) // no new queries
  })
})

describe('orgHasEmailDomainAddon — fail closed (W1.E1: add-on pins count)', () => {
  it('true when any active location has custom_email_domain', async () => {
    const db = makeDb(() => ({ data: [{ id: 'loc-1' }, { id: 'loc-2' }] }))
    locationHasPlanFeature.mockImplementation((_db, id, key) =>
      Promise.resolve(key === 'custom_email_domain' && id === 'loc-2'))
    expect(await orgHasEmailDomainAddon(db, 'org-1')).toBe(true)
    expect(locationHasPlanFeature).toHaveBeenCalledWith(db, 'loc-1', 'custom_email_domain')
    expect(locationHasPlanFeature).toHaveBeenCalledWith(db, 'loc-2', 'custom_email_domain')
  })

  it('an org whose only pin is the ADD-ON has the add-on (the live Test Studio pin)', async () => {
    // locationHasPlanFeature answers true for an add-on-only pin; the gate
    // must take that answer as-is, never re-derive it through a tier.
    const db = makeDb(() => ({ data: [{ id: 'test-studio' }] }))
    locationHasPlanFeature.mockResolvedValue(true)
    expect(await orgHasEmailDomainAddon(db, 'org-1')).toBe(true)
  })

  it('false when no location has it', async () => {
    const db = makeDb(() => ({ data: [{ id: 'loc-1' }] }))
    locationHasPlanFeature.mockResolvedValue(false)
    expect(await orgHasEmailDomainAddon(db, 'org-1')).toBe(false)
  })

  it('false (fail closed) on error', async () => {
    const db = { from() { throw new Error('db down') } }
    expect(await orgHasEmailDomainAddon(db, 'org-1')).toBe(false)
  })

  it('false with no orgId', async () => {
    expect(await orgHasEmailDomainAddon(makeDb(() => ({ data: [] })), null)).toBe(false)
  })
})

describe('tenantEmailStatePayload / dnsRecordsFromRow — redaction', () => {
  const liveRow = {
    organization_id: 'org-1',
    postmark_server_id: 101,
    postmark_server_token: 'srv-SECRET-must-not-leak',
    postmark_domain_id: 55,
    sending_domain: 'mail.gymx.com',
    from_email: 'hello@mail.gymx.com',
    from_name: 'GymX',
    dkim_pending_host: 'pm._domainkey.mail.gymx.com',
    dkim_pending_value: 'k=rsa; p=abc',
    dkim_verified: true,
    return_path_domain: 'pm-bounces.mail.gymx.com',
    return_path_cname_value: 'pm.mtasv.net',
    return_path_verified: true,
    status: 'live',
    last_error: null,
  }

  it('NEVER includes the server token or server id', () => {
    const payload = tenantEmailStatePayload(liveRow, { addonActive: true, accountConfigured: true })
    const serialized = JSON.stringify(payload)
    expect(serialized).not.toContain('srv-SECRET-must-not-leak')
    expect(payload).not.toHaveProperty('postmark_server_token')
    expect(payload).not.toHaveProperty('postmark_server_id')
    expect(payload.status).toBe('live')
    expect(payload.records).toHaveLength(2)
  })

  it('null row → not_configured with the meta flags', () => {
    const payload = tenantEmailStatePayload(null, { addonActive: false, accountConfigured: true })
    expect(payload).toMatchObject({ status: 'not_configured', addon_active: false, account_configured: true, records: [], webhooks_registered: false })
  })

  // W1.E3 — the GET payload says whether the server's broadcast stream +
  // webhooks were registered (mig 718 webhooks_registered_at), as a boolean:
  // the timestamp itself stays on the row.
  it('W1.E3 — webhooks_registered is the boolean of webhooks_registered_at', () => {
    expect(tenantEmailStatePayload({ ...liveRow, webhooks_registered_at: '2026-10-10T10:00:00.000Z' }, {}).webhooks_registered).toBe(true)
    expect(tenantEmailStatePayload({ ...liveRow, webhooks_registered_at: null }, {}).webhooks_registered).toBe(false)
    expect(tenantEmailStatePayload(liveRow, {})).not.toHaveProperty('webhooks_registered_at')
  })

  it('dnsRecordsFromRow omits records missing a name or value', () => {
    expect(dnsRecordsFromRow({ dkim_pending_host: 'h', dkim_pending_value: '' })).toHaveLength(0)
    expect(dnsRecordsFromRow(liveRow)).toEqual([
      { purpose: 'DKIM', type: 'TXT', name: 'pm._domainkey.mail.gymx.com', value: 'k=rsa; p=abc' },
      { purpose: 'Return-Path', type: 'CNAME', name: 'pm-bounces.mail.gymx.com', value: 'pm.mtasv.net' },
    ])
  })
})
