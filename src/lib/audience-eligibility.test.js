// FILTER-B.4 — the preview must not become a second source of truth.
//
// These tests pin the ONE thing that makes an audience preview safe: it runs
// the same per-channel send-path builder the send runs, and the count route's
// will-receive number comes from the same call. If someone later hand-rolls a
// query in the preview route, the delegation assertions below fail.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./supabase', () => ({ createServerClient: vi.fn() }))

import { buildEligibleAudienceQuery } from './audience-eligibility'
import { buildAudienceQueryAsync } from './postmark'
import { buildSmsAudienceAsync } from './sms'
import { buildWhatsAppAudienceAsync } from './whatsapp'

vi.mock('./postmark', () => ({ buildAudienceQueryAsync: vi.fn(async () => ({ query: 'email-q' })) }))
vi.mock('./sms', () => ({ buildSmsAudienceAsync: vi.fn(async () => ({ query: 'sms-q' })) }))
vi.mock('./whatsapp', () => ({ buildWhatsAppAudienceAsync: vi.fn(async () => ({ query: 'wa-q' })) }))

const FILTER = { logic: 'and', filters: [{ field: 'pipeline_stage_slug', op: 'eq', value: 'member' }] }
const db = { from: vi.fn() }

beforeEach(() => { vi.clearAllMocks() })

describe('buildEligibleAudienceQuery delegates to the SEND-PATH builder', () => {
  it('email -> buildAudienceQueryAsync (the builder campaign-sender.js sends through)', async () => {
    const r = await buildEligibleAudienceQuery({
      db, channel: 'email', filter: FILTER, locationId: 'loc-1',
      columns: 'id, email', selectOpts: { count: 'exact' },
    })
    expect(r.query).toBe('email-q')
    expect(buildAudienceQueryAsync).toHaveBeenCalledWith(db, FILTER, 'loc-1', {
      columns: 'id, email', selectOpts: { count: 'exact' }, consentField: 'email_marketing',
    })
    expect(buildSmsAudienceAsync).not.toHaveBeenCalled()
    expect(buildWhatsAppAudienceAsync).not.toHaveBeenCalled()
  })

  it('sms -> buildSmsAudienceAsync', async () => {
    const r = await buildEligibleAudienceQuery({
      db, channel: 'sms', filter: FILTER, locationId: 'loc-1', columns: 'id, phone',
    })
    expect(r.query).toBe('sms-q')
    expect(buildSmsAudienceAsync).toHaveBeenCalledWith(db, FILTER, 'loc-1', {
      columns: 'id, phone', selectOpts: undefined,
    })
  })

  it('whatsapp -> buildWhatsAppAudienceAsync', async () => {
    const r = await buildEligibleAudienceQuery({
      db, channel: 'whatsapp', filter: FILTER, locationId: 'loc-1', columns: 'id, wa_phone',
    })
    expect(r.query).toBe('wa-q')
    expect(buildWhatsAppAudienceAsync).toHaveBeenCalledWith(db, FILTER, 'loc-1', {
      columns: 'id, wa_phone', selectOpts: undefined,
    })
  })

  it('honours a non-default consentField (Utility campaigns gate on email_administrative)', async () => {
    await buildEligibleAudienceQuery({
      db, channel: 'email', filter: FILTER, locationId: 'loc-1', consentField: 'email_administrative',
    })
    expect(buildAudienceQueryAsync.mock.calls[0][3].consentField).toBe('email_administrative')
  })

  it('rejects an unknown channel rather than silently counting everyone', async () => {
    await expect(buildEligibleAudienceQuery({ db, channel: 'carrier-pigeon', filter: FILTER, locationId: 'loc-1' }))
      .rejects.toThrow(/Unknown audience channel/)
  })
})

describe('buildEligibleAudienceQuery with NO channel is a MATCH set (the sequence case)', () => {
  it('pins the location on raw contacts and applies no deliverability gate', async () => {
    const calls = []
    const chain = new Proxy({}, {
      get: (_t, prop) => {
        if (prop === 'calls') return calls
        if (prop === 'then') return undefined
        return (...args) => { calls.push([prop, args]); return chain }
      },
    })
    const rawDb = { from: vi.fn(() => chain) }
    await buildEligibleAudienceQuery({ db: rawDb, channel: null, filter: FILTER, locationId: 'loc-1' })
    expect(rawDb.from).toHaveBeenCalledWith('contacts')
    expect(calls).toContainEqual(['eq', ['location_id', 'loc-1']])
    // The filter still applies — a match set is filtered, just not gated.
    expect(calls).toContainEqual(['eq', ['pipeline_stage_slug', 'member']])
    // No channel builder was consulted.
    expect(buildAudienceQueryAsync).not.toHaveBeenCalled()
    expect(buildSmsAudienceAsync).not.toHaveBeenCalled()
    expect(buildWhatsAppAudienceAsync).not.toHaveBeenCalled()
  })
})
