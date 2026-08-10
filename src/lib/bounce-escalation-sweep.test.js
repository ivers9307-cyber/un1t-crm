// GAPS-P5 — the applier. The decision itself is pinned in
// bounce-escalation.test.js; these tests pin the things that make applying it
// SAFE: an audit row before any stamp, idempotence across runs, an operator
// release that sticks, and a suppression that heals itself when the stamp goes
// away underneath it.
//
// The Supabase client is a chainable thenable recorder (the style used by
// campaign-sender.test.js / postmark.test.js) — no DB.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./log.js', () => ({ logInfo: vi.fn(), logError: vi.fn(), logWarn: vi.fn() }))

import {
  runRepeatBounceSweep,
  ESCALATION_TABLE,
  RELEASE_REASON_OPERATOR,
  RELEASE_REASON_STAMP_CLEARED,
} from './bounce-escalation-sweep.js'

const NOW = new Date('2026-08-09T12:00:00.000Z')
const NOW_ISO = NOW.toISOString()

// ── chainable fake ──────────────────────────────────────────────────
// Each db.from() records a statement ({ table, ops }); awaiting it routes
// through the test's route function.
function makeDb(route) {
  const statements = []
  const db = {
    from(table) {
      const state = { table, ops: [] }
      statements.push(state)
      const b = new Proxy({}, {
        get(_, method) {
          if (method === 'then') {
            const p = Promise.resolve(route(state) ?? { data: [], error: null })
            return p.then.bind(p)
          }
          return (...args) => { state.ops.push({ method, args }); return b }
        },
      })
      return b
    },
  }
  return { db, statements }
}

const opsOf = (s, method) => s.ops.filter((o) => o.method === method)
const has = (s, method) => s.ops.some((o) => o.method === method)
const argOf = (s, method) => s.ops.find((o) => o.method === method)?.args
const inserts = (statements, table = ESCALATION_TABLE) =>
  statements.filter((s) => s.table === table && has(s, 'insert')).flatMap((s) => argOf(s, 'insert')[0])
const updates = (statements, table) =>
  statements.filter((s) => s.table === table && has(s, 'update'))

// A contact who bounced across `n` distinct campaigns, never hard.
const bouncesFor = (contactId, n, type = 'soft') =>
  Array.from({ length: n }, (_, i) => ({
    contact_id: contactId,
    campaign_id: `camp-${i + 1}`,
    bounce_type: type,
    bounced_at: `2026-0${i + 1}-01T00:00:00.000Z`,
  }))

/**
 * Standard route.
 *  bounceRows  — every bounced campaign_recipients row in the estate
 *  deliveries  — contact ids that have at least one successful recipient row
 *  existing    — pre-existing email_bounce_escalations rows
 *  contacts    — id -> { location_id, email, email_suppressed_at }
 */
function routeFor({ bounceRows = [], deliveries = [], existing = [], contacts = {}, campaigns = {} } = {}) {
  return (state) => {
    if (state.table === 'campaign_recipients') {
      // The delivery-count scan filters on status; the bounce scan does not.
      const statusFilter = state.ops.find((o) => o.method === 'in' && o.args[0] === 'status')
      if (statusFilter) {
        const ids = state.ops.find((o) => o.method === 'in' && o.args[0] === 'contact_id')?.args[1] || []
        return { data: deliveries.filter((id) => ids.includes(id)).map((id) => ({ contact_id: id })), error: null }
      }
      return { data: bounceRows, error: null }
    }
    if (state.table === ESCALATION_TABLE) {
      if (has(state, 'insert') || has(state, 'update')) return { data: null, error: null }
      const idFilter = state.ops.find((o) => o.method === 'in' && o.args[0] === 'contact_id')?.args[1]
      const activeOnly = state.ops.some((o) => o.method === 'is' && o.args[0] === 'released_at')
      let rows = existing
      if (idFilter) rows = rows.filter((r) => idFilter.includes(r.contact_id))
      if (activeOnly) rows = rows.filter((r) => !r.released_at && r.decision === 'suppress')
      return { data: rows, error: null }
    }
    if (state.table === 'contacts') {
      if (has(state, 'update')) return { data: null, error: null }
      const ids = state.ops.find((o) => o.method === 'in' && o.args[0] === 'id')?.args[1] || []
      return {
        data: ids.filter((id) => contacts[id]).map((id) => ({ id, ...contacts[id] })),
        error: null,
      }
    }
    if (state.table === 'campaigns') {
      const ids = state.ops.find((o) => o.method === 'in' && o.args[0] === 'id')?.args[1] || []
      return { data: ids.filter((id) => campaigns[id]).map((id) => ({ id, location_id: campaigns[id] })), error: null }
    }
    return { data: [], error: null }
  }
}

const LOC = 'loc-1'
const withContact = (id, extra = {}) => ({ [id]: { location_id: LOC, email: `${id}@x.ie`, email_suppressed_at: null, ...extra } })

beforeEach(() => { vi.clearAllMocks() })

describe('runRepeatBounceSweep — what it acts on', () => {
  it('suppresses a contact that bounced across 3 campaigns and was never delivered to', async () => {
    const { db, statements } = makeDb(routeFor({
      bounceRows: bouncesFor('a', 3),
      deliveries: [],
      contacts: withContact('a'),
    }))
    const out = await runRepeatBounceSweep({ db, now: NOW })

    expect(out.ok).toBe(true)
    expect(out.suppressed).toBe(1)
    expect(out.review).toBe(0)

    const row = inserts(statements)[0]
    expect(row).toMatchObject({
      contact_id: 'a',
      location_id: LOC,
      decision: 'suppress',
      reason: 'repeat_bounce_never_delivered',
      bounced_campaign_count: 3,
      successful_deliveries: 0,
    })
    expect(row.bounced_campaign_ids).toEqual(['camp-1', 'camp-2', 'camp-3'])
  })

  it('stamps contacts.email_suppressed_at — the mechanism sends already exclude on', async () => {
    const { db, statements } = makeDb(routeFor({
      bounceRows: bouncesFor('a', 3),
      contacts: withContact('a'),
    }))
    await runRepeatBounceSweep({ db, now: NOW })

    const stamp = updates(statements, 'contacts')[0]
    expect(argOf(stamp, 'update')[0]).toEqual({ email_suppressed_at: NOW_ISO })
    expect(argOf(stamp, 'in')).toEqual(['id', ['a']])
    // Guarded: a concurrent open-webhook clear or a hygiene stamp between
    // scan and write must win, exactly like the hygiene sweep does it.
    expect(argOf(stamp, 'is')).toEqual(['email_suppressed_at', null])
  })

  it('writes the audit row BEFORE the stamp — no suppression without a reason', async () => {
    const { db, statements } = makeDb(routeFor({
      bounceRows: bouncesFor('a', 3),
      contacts: withContact('a'),
    }))
    await runRepeatBounceSweep({ db, now: NOW })

    const auditIdx = statements.findIndex((s) => s.table === ESCALATION_TABLE && has(s, 'insert'))
    const stampIdx = statements.findIndex((s) => s.table === 'contacts' && has(s, 'update'))
    expect(auditIdx).toBeGreaterThanOrEqual(0)
    expect(stampIdx).toBeGreaterThan(auditIdx)
  })

  it('records a review row for a repeat bouncer that HAS been delivered to, and never stamps it', async () => {
    const { db, statements } = makeDb(routeFor({
      bounceRows: bouncesFor('a', 4),
      deliveries: ['a'],
      contacts: withContact('a'),
    }))
    const out = await runRepeatBounceSweep({ db, now: NOW })

    expect(out.review).toBe(1)
    expect(out.suppressed).toBe(0)
    expect(inserts(statements)[0]).toMatchObject({ decision: 'review', reason: 'repeat_bounce_previously_delivered' })
    expect(updates(statements, 'contacts')).toHaveLength(0)
  })

  it('leaves a single soft bounce completely alone', async () => {
    const { db, statements } = makeDb(routeFor({
      bounceRows: bouncesFor('a', 1),
      contacts: withContact('a'),
    }))
    const out = await runRepeatBounceSweep({ db, now: NOW })
    expect(out.suppressed).toBe(0)
    expect(out.review).toBe(0)
    expect(inserts(statements)).toHaveLength(0)
    expect(updates(statements, 'contacts')).toHaveLength(0)
  })

  it('never escalates a hard bouncer — that path already works', async () => {
    const rows = bouncesFor('a', 3)
    rows[0].bounce_type = 'hard'
    const { db, statements } = makeDb(routeFor({ bounceRows: rows, contacts: withContact('a') }))
    const out = await runRepeatBounceSweep({ db, now: NOW })
    expect(out.suppressed).toBe(0)
    expect(inserts(statements)).toHaveLength(0)
  })

  it('splits a mixed population correctly in one pass', async () => {
    const { db, statements } = makeDb(routeFor({
      bounceRows: [
        ...bouncesFor('dead', 3),
        ...bouncesFor('recovered', 3),
        ...bouncesFor('shallow', 2),
      ],
      deliveries: ['recovered'],
      contacts: { ...withContact('dead'), ...withContact('recovered'), ...withContact('shallow') },
    }))
    const out = await runRepeatBounceSweep({ db, now: NOW })
    expect(out.suppressed).toBe(1)
    expect(out.review).toBe(1)
    const rows = inserts(statements)
    expect(rows.find((r) => r.contact_id === 'dead').decision).toBe('suppress')
    expect(rows.find((r) => r.contact_id === 'recovered').decision).toBe('review')
    expect(rows.find((r) => r.contact_id === 'shallow')).toBeUndefined()
  })
})

describe('runRepeatBounceSweep — idempotence', () => {
  it('re-running with an unchanged active row writes nothing', async () => {
    const { db, statements } = makeDb(routeFor({
      bounceRows: bouncesFor('a', 3),
      contacts: withContact('a', { email_suppressed_at: NOW_ISO }),
      existing: [{
        id: 'esc-1', contact_id: 'a', decision: 'suppress', released_at: null,
        release_reason: null, bounced_campaign_count: 3,
      }],
    }))
    const out = await runRepeatBounceSweep({ db, now: NOW })

    expect(out.suppressed).toBe(0)
    expect(out.unchanged).toBe(1)
    expect(inserts(statements)).toHaveLength(0)
    expect(updates(statements, ESCALATION_TABLE)).toHaveLength(0)
    expect(updates(statements, 'contacts')).toHaveLength(0)
  })

  it('refreshes the counts on an active row when the contact bounced again', async () => {
    const { db, statements } = makeDb(routeFor({
      bounceRows: bouncesFor('a', 5),
      contacts: withContact('a', { email_suppressed_at: NOW_ISO }),
      existing: [{
        id: 'esc-1', contact_id: 'a', decision: 'suppress', released_at: null,
        release_reason: null, bounced_campaign_count: 3,
      }],
    }))
    const out = await runRepeatBounceSweep({ db, now: NOW })

    expect(out.refreshed).toBe(1)
    expect(inserts(statements)).toHaveLength(0)
    const upd = updates(statements, ESCALATION_TABLE)[0]
    expect(argOf(upd, 'update')[0]).toMatchObject({ bounced_campaign_count: 5 })
    expect(argOf(upd, 'eq')).toEqual(['id', 'esc-1'])
    // The decision is never rewritten by a refresh — only an operator or the
    // release path changes what a row says was decided.
    expect(argOf(upd, 'update')[0].decision).toBeUndefined()
  })
})

describe('runRepeatBounceSweep — reversibility', () => {
  it('never re-suppresses a contact an operator released', async () => {
    const { db, statements } = makeDb(routeFor({
      bounceRows: bouncesFor('a', 3),
      contacts: withContact('a'),
      existing: [{
        id: 'esc-1', contact_id: 'a', decision: 'suppress',
        released_at: '2026-08-01T00:00:00.000Z', release_reason: RELEASE_REASON_OPERATOR,
        bounced_campaign_count: 3,
      }],
    }))
    const out = await runRepeatBounceSweep({ db, now: NOW })

    expect(out.suppressed).toBe(0)
    expect(out.skippedOperatorReleased).toBe(1)
    expect(inserts(statements)).toHaveLength(0)
    expect(updates(statements, 'contacts')).toHaveLength(0)
  })

  it('auto-releases an active suppression whose stamp has gone (an open cleared it)', async () => {
    const { db, statements } = makeDb(routeFor({
      // No bounce rows at all: this pass is purely the reconcile step.
      bounceRows: [],
      contacts: withContact('a', { email_suppressed_at: null }),
      existing: [{
        id: 'esc-1', contact_id: 'a', decision: 'suppress', released_at: null,
        release_reason: null, bounced_campaign_count: 3,
      }],
    }))
    const out = await runRepeatBounceSweep({ db, now: NOW })

    expect(out.autoReleased).toBe(1)
    const upd = updates(statements, ESCALATION_TABLE)[0]
    expect(argOf(upd, 'update')[0]).toMatchObject({
      released_at: NOW_ISO,
      release_reason: RELEASE_REASON_STAMP_CLEARED,
    })
    expect(argOf(upd, 'in')).toEqual(['id', ['esc-1']])
  })

  it('leaves an active suppression alone while its stamp is still in place', async () => {
    const { db, statements } = makeDb(routeFor({
      bounceRows: [],
      contacts: withContact('a', { email_suppressed_at: '2026-07-01T00:00:00.000Z' }),
      existing: [{
        id: 'esc-1', contact_id: 'a', decision: 'suppress', released_at: null,
        release_reason: null, bounced_campaign_count: 3,
      }],
    }))
    const out = await runRepeatBounceSweep({ db, now: NOW })
    expect(out.autoReleased).toBe(0)
    expect(updates(statements, ESCALATION_TABLE)).toHaveLength(0)
  })
})

describe('runRepeatBounceSweep — safety rails', () => {
  it('dry mode decides everything and writes nothing', async () => {
    const { db, statements } = makeDb(routeFor({
      bounceRows: bouncesFor('a', 3),
      contacts: withContact('a'),
    }))
    const out = await runRepeatBounceSweep({ db, now: NOW, dry: true })

    expect(out.dry).toBe(true)
    expect(out.suppressed).toBe(1)
    expect(inserts(statements)).toHaveLength(0)
    expect(updates(statements, 'contacts')).toHaveLength(0)
    expect(updates(statements, ESCALATION_TABLE)).toHaveLength(0)
  })

  it('skips a contact with no resolvable location rather than inventing one', async () => {
    const { db, statements } = makeDb(routeFor({
      bounceRows: bouncesFor('a', 3),
      contacts: { a: { location_id: null, email: 'a@x.ie', email_suppressed_at: null } },
      campaigns: {},
    }))
    const out = await runRepeatBounceSweep({ db, now: NOW })
    expect(out.skippedNoLocation).toBe(1)
    expect(inserts(statements)).toHaveLength(0)
  })

  it('falls back to the campaign location when the contact carries none', async () => {
    const { db, statements } = makeDb(routeFor({
      bounceRows: bouncesFor('a', 3),
      contacts: { a: { location_id: null, email: 'a@x.ie', email_suppressed_at: null } },
      campaigns: { 'camp-1': 'loc-9', 'camp-2': 'loc-9', 'camp-3': 'loc-9' },
    }))
    const out = await runRepeatBounceSweep({ db, now: NOW })
    expect(out.skippedNoLocation).toBe(0)
    expect(inserts(statements)[0].location_id).toBe('loc-9')
  })

  it('paginates the bounce scan with an explicit order and range (1k-row cap)', async () => {
    const { db, statements } = makeDb(routeFor({ bounceRows: [], contacts: {} }))
    await runRepeatBounceSweep({ db, now: NOW })
    const scan = statements.find((s) => s.table === 'campaign_recipients')
    expect(has(scan, 'order')).toBe(true)
    expect(opsOf(scan, 'range')).toHaveLength(1)
    expect(argOf(scan, 'range')).toEqual([0, 999])
  })

  it('scans on bounce_type, not bounced_at — send-time rejections carry no timestamp', async () => {
    // campaign-sender's permanent-rejection branch writes status='bounced'
    // and bounce_type='rejected' with NO bounced_at. A bounced_at filter
    // would drop every one of them, and a send-time rejection is the
    // strongest evidence an address is dead.
    const { db, statements } = makeDb(routeFor({ bounceRows: [], contacts: {} }))
    await runRepeatBounceSweep({ db, now: NOW })
    const scan = statements.find((s) => s.table === 'campaign_recipients')
    expect(argOf(scan, 'not')).toEqual(['bounce_type', 'is', null])
  })

  it('escalates a contact whose bounces are all timestamp-less rejections', async () => {
    const rejections = ['camp-1', 'camp-2', 'camp-3'].map((campaign_id) => ({
      contact_id: 'a', campaign_id, bounce_type: 'rejected', bounced_at: null,
    }))
    const { db, statements } = makeDb(routeFor({ bounceRows: rejections, contacts: withContact('a') }))
    const out = await runRepeatBounceSweep({ db, now: NOW })
    expect(out.suppressed).toBe(1)
    expect(inserts(statements)[0]).toMatchObject({
      bounce_types: ['rejected'], first_bounce_at: null, last_bounce_at: null,
    })
  })

  it('reports ok:false and writes no stamp when the audit insert fails', async () => {
    const base = routeFor({ bounceRows: bouncesFor('a', 3), contacts: withContact('a') })
    const { db, statements } = makeDb((state) => {
      if (state.table === ESCALATION_TABLE && has(state, 'insert')) {
        return { data: null, error: { message: 'insert boom' } }
      }
      return base(state)
    })
    const out = await runRepeatBounceSweep({ db, now: NOW })
    expect(out.ok).toBe(false)
    expect(out.errors[0]).toContain('insert boom')
    expect(updates(statements, 'contacts')).toHaveLength(0)
  })

  it('reports ok:false when the bounce scan itself fails, and touches nothing', async () => {
    const { db, statements } = makeDb((state) => {
      if (state.table === 'campaign_recipients') return { data: null, error: { message: 'scan boom' } }
      return { data: [], error: null }
    })
    const out = await runRepeatBounceSweep({ db, now: NOW })
    expect(out.ok).toBe(false)
    expect(inserts(statements)).toHaveLength(0)
  })
})
