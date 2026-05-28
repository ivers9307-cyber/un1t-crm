// STUDIO-AC-EXTERNAL-RULE.1 — unit tests for the rule planner +
// table CRUD helpers. The planner is pure, so it gets a fat
// truth-table-style test. The CRUD helpers go through a mocked
// supabase chainable.

import { describe, it, expect, vi } from 'vitest'
import {
  planExternalRule,
  upsertExternalStart,
  clearExternalStart,
  getExternalStart,
} from './ac-external-rule.js'

const NOW = new Date('2026-05-28T10:00:00.000Z')

function makeRow({ minutesAgo = 0, minutesUntilOff = 60 } = {}) {
  return {
    device_id: 'd1',
    first_seen_at: new Date(NOW.getTime() - minutesAgo * 60_000).toISOString(),
    expected_off_at: new Date(NOW.getTime() + minutesUntilOff * 60_000).toISOString(),
  }
}

// Mock a Supabase chainable that captures the call and returns
// whatever .then-shape we hand it. The lib only chains: from().X().Y().Z()
// terminating in a select / maybeSingle / upsert / delete await.
function chainable(returns = { data: null, error: null }) {
  const chain = {}
  const trackers = { table: null, op: null, payload: null, filters: {}, options: {} }
  chain.from = vi.fn((t) => { trackers.table = t; return chain })
  chain.select = vi.fn(() => chain)
  chain.eq = vi.fn((col, val) => { trackers.filters[col] = val; return chain })
  chain.maybeSingle = vi.fn(() => Promise.resolve(returns))
  chain.upsert = vi.fn((payload, options) => {
    trackers.op = 'upsert'; trackers.payload = payload; trackers.options = options
    return Promise.resolve(returns)
  })
  chain.delete = vi.fn(() => {
    trackers.op = 'delete'
    return {
      eq: vi.fn((col, val) => {
        trackers.filters[col] = val
        return Promise.resolve(returns)
      }),
    }
  })
  return { chain, trackers }
}

// ----------------------------------------------------------------
// planExternalRule
// ----------------------------------------------------------------

describe('planExternalRule', () => {
  it("returns noop when the rule is disabled and no row exists", () => {
    const out = planExternalRule({
      vendorOn: true,
      hasActiveSession: false,
      externalRow: null,
      externalAutoOffMinutes: null,
      now: NOW,
    })
    expect(out).toEqual({ action: 'noop' })
  })

  it('clears a stale row when the rule is disabled', () => {
    // Master flipped external_auto_off_minutes to NULL mid-session.
    // We should drop the dangling row so the cron stops watching it.
    const out = planExternalRule({
      vendorOn: true,
      hasActiveSession: false,
      externalRow: makeRow(),
      externalAutoOffMinutes: null,
      now: NOW,
    })
    expect(out).toEqual({ action: 'clear', reason: 'rule_disabled' })
  })

  it('clears the row when the unit is off', () => {
    const out = planExternalRule({
      vendorOn: false,
      hasActiveSession: false,
      externalRow: makeRow(),
      externalAutoOffMinutes: 60,
      now: NOW,
    })
    expect(out.action).toBe('clear')
    expect(out.reason).toBe('vendor_off')
  })

  it('returns noop when the unit is off and no row exists', () => {
    const out = planExternalRule({
      vendorOn: false,
      hasActiveSession: false,
      externalRow: null,
      externalAutoOffMinutes: 60,
      now: NOW,
    })
    expect(out).toEqual({ action: 'noop' })
  })

  it('clears the row when a CRM session takes over', () => {
    // Staff opened the panel and hit Turn-on mid-cycle. Session
    // wins; external row should go away so the existing session
    // auto-off cron is the only thing managing the timer.
    const out = planExternalRule({
      vendorOn: true,
      hasActiveSession: true,
      externalRow: makeRow(),
      externalAutoOffMinutes: 60,
      now: NOW,
    })
    expect(out.action).toBe('clear')
    expect(out.reason).toBe('session_took_over')
  })

  it('returns noop when vendor on + session active + no external row', () => {
    const out = planExternalRule({
      vendorOn: true,
      hasActiveSession: true,
      externalRow: null,
      externalAutoOffMinutes: 60,
      now: NOW,
    })
    expect(out).toEqual({ action: 'noop' })
  })

  it('inserts when we observe vendor_on with no session and no existing row', () => {
    const out = planExternalRule({
      vendorOn: true,
      hasActiveSession: false,
      externalRow: null,
      externalAutoOffMinutes: 45,
      now: NOW,
    })
    expect(out.action).toBe('insert')
    expect(out.first_seen_at).toBe(NOW.toISOString())
    // expected_off_at = now + 45 min
    expect(new Date(out.expected_off_at).getTime()).toBe(NOW.getTime() + 45 * 60_000)
  })

  it('does NOT reset the timer when we observe vendor_on with an existing row', () => {
    // First observation wins. The cron tick 5 min later must not
    // shift expected_off_at forward — that would make the rule a
    // sliding window instead of a hard ceiling.
    const row = makeRow({ minutesAgo: 10, minutesUntilOff: 50 })
    const out = planExternalRule({
      vendorOn: true,
      hasActiveSession: false,
      externalRow: row,
      externalAutoOffMinutes: 60,
      now: NOW,
    })
    expect(out).toEqual({ action: 'noop' })
  })

  it('fires when an existing row has passed expected_off_at', () => {
    const row = makeRow({ minutesAgo: 65, minutesUntilOff: -5 })  // expired 5 min ago
    const out = planExternalRule({
      vendorOn: true,
      hasActiveSession: false,
      externalRow: row,
      externalAutoOffMinutes: 60,
      now: NOW,
    })
    expect(out.action).toBe('fire')
    expect(out.startedAt).toBe(row.first_seen_at)
  })

  it("treats externalAutoOffMinutes <= 0 the same as null (disabled)", () => {
    const out = planExternalRule({
      vendorOn: true,
      hasActiveSession: false,
      externalRow: null,
      externalAutoOffMinutes: 0,
      now: NOW,
    })
    expect(out).toEqual({ action: 'noop' })
  })
})

// ----------------------------------------------------------------
// upsertExternalStart / clearExternalStart / getExternalStart
// ----------------------------------------------------------------

describe('upsertExternalStart', () => {
  it("upserts on the device_id conflict target with the right payload", async () => {
    const { chain, trackers } = chainable({ data: null, error: null })
    const out = await upsertExternalStart(chain, {
      deviceId: 'd1',
      firstSeenAt: '2026-05-28T10:00:00.000Z',
      expectedOffAt: '2026-05-28T11:00:00.000Z',
    })
    expect(out).toEqual({ ok: true })
    expect(trackers.table).toBe('ac_external_starts')
    expect(trackers.op).toBe('upsert')
    expect(trackers.payload).toMatchObject({
      device_id: 'd1',
      first_seen_at: '2026-05-28T10:00:00.000Z',
      expected_off_at: '2026-05-28T11:00:00.000Z',
    })
    expect(trackers.options).toEqual({ onConflict: 'device_id' })
  })

  it('returns ok=false with the error message on failure', async () => {
    const { chain } = chainable({ data: null, error: { message: 'boom' } })
    const out = await upsertExternalStart(chain, {
      deviceId: 'd1',
      firstSeenAt: 'a', expectedOffAt: 'b',
    })
    expect(out.ok).toBe(false)
    expect(out.error).toBe('boom')
  })
})

describe('clearExternalStart', () => {
  it('deletes by device_id', async () => {
    const { chain, trackers } = chainable({ data: null, error: null })
    const out = await clearExternalStart(chain, 'd1')
    expect(out).toEqual({ ok: true })
    expect(trackers.table).toBe('ac_external_starts')
    expect(trackers.op).toBe('delete')
    expect(trackers.filters.device_id).toBe('d1')
  })
})

describe('getExternalStart', () => {
  it('returns the row when present', async () => {
    const row = makeRow()
    const { chain } = chainable({ data: row, error: null })
    const out = await getExternalStart(chain, 'd1')
    expect(out).toEqual(row)
  })

  it('returns null when no row exists', async () => {
    const { chain } = chainable({ data: null, error: null })
    expect(await getExternalStart(chain, 'd1')).toBeNull()
  })
})
