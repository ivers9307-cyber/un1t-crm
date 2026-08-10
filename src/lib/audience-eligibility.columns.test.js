// FILTER-B.4 — the same-query-path guarantee, checked against the REAL
// per-channel builders (no module mocks here; the sibling
// audience-eligibility.test.js mocks them to pin the delegation itself).
//
// The preview needs contact columns and a total; the count needs
// { count: 'exact', head: true } on the FIRST select(). Both have to travel
// through the send-path builder rather than round a parallel query, so each
// builder must accept them — and must keep its own gates while doing so.

import { describe, it, expect, vi } from 'vitest'

vi.mock('./supabase', () => ({ createServerClient: vi.fn() }))

import { buildEligibleAudienceQuery } from './audience-eligibility'

// Proxy recorder: every property access is a chaining call that logs itself.
// 'then' is excluded so an `await` never treats the recorder as a thenable.
function chainRecorder() {
  const calls = []
  const chain = new Proxy({}, {
    get: (_t, prop) => {
      if (prop === 'calls') return calls
      if (prop === 'then') return undefined
      return (...args) => { calls.push([prop, args]); return chain }
    },
  })
  return chain
}

const FILTER = { logic: 'and', filters: [] }
const COLUMNS = 'id, first_name, last_name, email, phone'
const HEAD_COUNT = { count: 'exact', head: true }

describe.each([
  ['email', 'contact_location_audience', [['eq', ['loc_email_marketing', true]]]],
  ['sms', 'contact_location_audience', [['eq', ['loc_sms_marketing', true]], ['eq', ['sms_status', 'active']]]],
  ['whatsapp', 'contact_location_audience', [['eq', ['loc_whatsapp_marketing', true]]]],
])('%s channel', (channel, table, expectedGates) => {
  it('passes the caller\'s columns + select options to the FIRST select()', async () => {
    const rec = chainRecorder()
    const db = { from: vi.fn(() => rec) }
    await buildEligibleAudienceQuery({
      db, channel, filter: FILTER, locationId: 'loc-1', columns: COLUMNS, selectOpts: HEAD_COUNT,
    })
    expect(db.from).toHaveBeenCalledWith(table)
    expect(rec.calls[0]).toEqual(['select', [COLUMNS, HEAD_COUNT]])
  })

  it('keeps its own send gates and the location pin while doing so', async () => {
    const rec = chainRecorder()
    const db = { from: vi.fn(() => rec) }
    await buildEligibleAudienceQuery({
      db, channel, filter: FILTER, locationId: 'loc-1', columns: COLUMNS,
    })
    expect(rec.calls).toContainEqual(['eq', ['audience_location_id', 'loc-1']])
    for (const gate of expectedGates) expect(rec.calls).toContainEqual(gate)
  })

  it('still defaults to the builder\'s own shape when no options are given', async () => {
    const rec = chainRecorder()
    const db = { from: vi.fn(() => rec) }
    await buildEligibleAudienceQuery({ db, channel, filter: FILTER, locationId: 'loc-1' })
    expect(rec.calls[0][0]).toBe('select')
    expect(typeof rec.calls[0][1][0]).toBe('string')
  })
})

// ── The send path must be BYTE-IDENTICAL to before FILTER-B.4 ────────
//
// smsAudienceBase and whatsAppAudienceBase are on the LIVE send path for both
// channels (fetchAllSmsAudience / fetchAllWhatsAppAudience page through them).
// Making columns overridable must not change what the SEND itself selects — a
// dropped column there is a merge tag that renders blank in a real broadcast,
// or a phone number the sender cannot find. These pin the no-argument shape.
describe('the send path\'s own projection is unchanged by the override', () => {
  it('SMS defaults to the exact column list the broadcast sender relies on', async () => {
    const rec = chainRecorder()
    const db = { from: vi.fn(() => rec) }
    const { buildSmsAudienceAsync } = await import('./sms')
    await buildSmsAudienceAsync(db, FILTER, 'loc-1')
    expect(rec.calls[0]).toEqual(['select', [
      'id, name, first_name, last_name, email, phone, pipeline_stage_slug, sms_status, location_id, audience_location_id, loc_sms_marketing',
      undefined,
    ]])
  })

  it('WhatsApp defaults to * as the drip/blast path has always had', async () => {
    const rec = chainRecorder()
    const db = { from: vi.fn(() => rec) }
    const { buildWhatsAppAudienceAsync } = await import('./whatsapp')
    await buildWhatsAppAudienceAsync(db, FILTER, 'loc-1')
    expect(rec.calls[0]).toEqual(['select', ['*', undefined]])
  })

  it('SMS sync sibling (buildSmsAudience) keeps its projection too', async () => {
    const rec = chainRecorder()
    const db = { from: vi.fn(() => rec) }
    const { buildSmsAudience } = await import('./sms')
    buildSmsAudience(db, FILTER, 'loc-1')
    expect(rec.calls[0][1][0]).toContain('phone')
    expect(rec.calls[0][1][0]).toContain('first_name')
  })

  it('WhatsApp sync sibling (buildWhatsAppAudience) keeps its projection too', async () => {
    const rec = chainRecorder()
    const db = { from: vi.fn(() => rec) }
    const { buildWhatsAppAudience } = await import('./whatsapp')
    buildWhatsAppAudience(db, FILTER, 'loc-1')
    expect(rec.calls[0][1][0]).toBe('*')
  })
})
