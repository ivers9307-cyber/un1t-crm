// INTEG-B3 — tests for the send-path resolver, the add-on gate, and the
// REDACTING payload shaper. The resolver is FAIL SAFE: every error path
// resolves to the global default (today's behaviour) — proven here.

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@/lib/plans', () => ({ getLocationPlan: vi.fn() }))
import { getLocationPlan } from '@/lib/plans'

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

beforeEach(() => {
  _resetTenantEmailCache()
  vi.clearAllMocks()
  process.env.POSTMARK_FROM_EMAIL = 'UN1T <hello@un1t.ie>'
})

describe('globalDefaultSender / senderFromRow (pure)', () => {
  it('global default has serverToken null + env From', () => {
    expect(globalDefaultSender()).toEqual({ serverToken: null, fromEmail: 'UN1T <hello@un1t.ie>', fromName: null })
  })
  it('senderFromRow falls back to global when a row has no token', () => {
    expect(senderFromRow(null).serverToken).toBeNull()
    expect(senderFromRow({ from_email: 'x@y.com' }).serverToken).toBeNull()
  })
  it('senderFromRow builds a tenant sender from a live row', () => {
    expect(senderFromRow({ postmark_server_token: 'srv-tok', from_email: 'hi@mail.gymx.com', from_name: 'GymX' }))
      .toEqual({ serverToken: 'srv-tok', fromEmail: 'hi@mail.gymx.com', fromName: 'GymX' })
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

  it('location with no org → global default', async () => {
    const db = makeDb((table) => table === 'locations' ? { data: { organization_id: null } } : { data: null })
    expect(await resolveEmailSender(db, 'loc-1')).toEqual(globalDefaultSender())
  })

  it('org has no live row → global default', async () => {
    const db = makeDb((table) =>
      table === 'locations' ? { data: { organization_id: 'org-1' } } : { data: null })
    expect(await resolveEmailSender(db, 'loc-1')).toEqual(globalDefaultSender())
  })

  it('LIVE row → tenant sender (server token + verified From)', async () => {
    const db = makeDb((table) =>
      table === 'locations'
        ? { data: { organization_id: 'org-1' } }
        : { data: { postmark_server_token: 'srv-secret', from_email: 'hi@mail.gymx.com', from_name: 'GymX', status: 'live' } })
    expect(await resolveEmailSender(db, 'loc-1')).toEqual({ serverToken: 'srv-secret', fromEmail: 'hi@mail.gymx.com', fromName: 'GymX' })
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

describe('orgHasEmailDomainAddon — fail closed', () => {
  it('true when any active location has custom_email_domain', async () => {
    const db = makeDb(() => ({ data: [{ id: 'loc-1' }, { id: 'loc-2' }] }))
    getLocationPlan.mockImplementation((_db, id) =>
      Promise.resolve(id === 'loc-2' ? { resolved: { features: { custom_email_domain: true } } } : null))
    expect(await orgHasEmailDomainAddon(db, 'org-1')).toBe(true)
  })

  it('false when no location has it', async () => {
    const db = makeDb(() => ({ data: [{ id: 'loc-1' }] }))
    getLocationPlan.mockResolvedValue({ resolved: { features: { custom_email_domain: false } } })
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
    expect(payload).toMatchObject({ status: 'not_configured', addon_active: false, account_configured: true, records: [] })
  })

  it('dnsRecordsFromRow omits records missing a name or value', () => {
    expect(dnsRecordsFromRow({ dkim_pending_host: 'h', dkim_pending_value: '' })).toHaveLength(0)
    expect(dnsRecordsFromRow(liveRow)).toEqual([
      { purpose: 'DKIM', type: 'TXT', name: 'pm._domainkey.mail.gymx.com', value: 'k=rsa; p=abc' },
      { purpose: 'Return-Path', type: 'CNAME', name: 'pm-bounces.mail.gymx.com', value: 'pm.mtasv.net' },
    ])
  })
})
