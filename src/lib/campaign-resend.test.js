// CAMPAIGN-RESEND (mig 506) — auto-resend a marketing campaign to
// non-openers. spawnDueResends runs once per run-campaigns tick:
// finds flagged parents whose wait has elapsed, counts the parent's
// non-openers (zero → just clear the flag), inserts the child
// campaign (status='queued', parent_campaign_id set) and clears the
// parent's flag. The partial unique index on parent_campaign_id is
// the race guard — a 23505 on the child insert means another tick
// won, and the flag is still cleared.
//
// Fake DB is the chainable thenable recorder from campaign-sender.test.js.

import { describe, it, expect, vi } from 'vitest'

import {
  isResendDue,
  resolveResendSubject,
  buildResendChildRow,
  loadNonOpenerContactIds,
  spawnDueResends,
  NON_OPENER_STATUSES,
} from './campaign-resend.js'

// ── chainable fake ─────────────────────────────────────────────────
function makeDb(route) {
  const statements = []
  const db = {
    from(table) {
      const state = { table, ops: [] }
      statements.push(state)
      const b = new Proxy({}, {
        get(_, method) {
          if (method === 'then') {
            const p = Promise.resolve(route(state) ?? {})
            return p.then.bind(p)
          }
          return (...args) => { state.ops.push({ method, args }); return b }
        },
      })
      return b
    },
    rpc(...args) {
      const state = { table: '__rpc__', ops: [{ method: 'rpc', args }] }
      statements.push(state)
      return Promise.resolve(route(state) ?? { error: null })
    },
  }
  return { db, statements }
}

const op = (state, method) => state.ops.find(o => o.method === method)
const ops = (state, method) => state.ops.filter(o => o.method === method)
const hasEq = (state, col, val) => state.ops.some(o => o.method === 'eq' && o.args[0] === col && o.args[1] === val)

const HOUR = 3_600_000
const now = new Date('2026-08-08T12:00:00Z')

const parent = (over = {}) => ({
  id: 'parent-1',
  name: 'Weekend offer',
  subject: 'Last chance',
  ab_subject_b: null,
  ab_winner: null,
  preview_text: 'Ends Monday',
  html_content: '<html><body>Hi</body></html>',
  design_json: { body: [] },
  from_name: 'UN1T',
  from_email: 'hello@un1t.ie',
  reply_to: null,
  template_id: null,
  location_id: 'loc-1',
  postmark_stream: null, // null → broadcast (marketing)
  status: 'sent',
  sent_at: new Date(now.getTime() - 49 * HOUR).toISOString(),
  parent_campaign_id: null,
  resend_enabled: true,
  resend_wait_hours: 48,
  resend_subject: null,
  audience_filter: { logic: 'and', filters: [] },
  created_by: 'user-1',
  ...over,
})

// ── isResendDue ────────────────────────────────────────────────────
describe('isResendDue', () => {
  it('true when flagged, sent, broadcast, wait elapsed', () => {
    expect(isResendDue(parent(), now)).toBe(true)
  })

  it('false when resend_enabled is off', () => {
    expect(isResendDue(parent({ resend_enabled: false }), now)).toBe(false)
  })

  it('false while the wait has not elapsed', () => {
    expect(isResendDue(parent({ sent_at: new Date(now.getTime() - 47 * HOUR).toISOString() }), now)).toBe(false)
  })

  it('false for a campaign that is not sent yet (sending / cancelled)', () => {
    expect(isResendDue(parent({ status: 'sending' }), now)).toBe(false)
    expect(isResendDue(parent({ status: 'cancelled' }), now)).toBe(false)
  })

  it('false for a resend child — no chains', () => {
    expect(isResendDue(parent({ parent_campaign_id: 'grandparent' }), now)).toBe(false)
  })

  it('false for the outbound (utility) stream — no open tracking there', () => {
    expect(isResendDue(parent({ postmark_stream: 'outbound' }), now)).toBe(false)
  })

  it('false without sent_at or without a wait', () => {
    expect(isResendDue(parent({ sent_at: null }), now)).toBe(false)
    expect(isResendDue(parent({ resend_wait_hours: null }), now)).toBe(false)
  })
})

// ── resolveResendSubject ───────────────────────────────────────────
describe('resolveResendSubject', () => {
  it('explicit resend_subject wins', () => {
    expect(resolveResendSubject(parent({ resend_subject: 'Still open?' }))).toBe('Still open?')
  })

  it('falls back to the parent subject', () => {
    expect(resolveResendSubject(parent())).toBe('Last chance')
  })

  it('uses the A/B winner variant when the parent tested', () => {
    expect(resolveResendSubject(parent({ ab_subject_b: 'B line', ab_winner: 'b' }))).toBe('B line')
    expect(resolveResendSubject(parent({ ab_subject_b: 'B line', ab_winner: 'a' }))).toBe('Last chance')
  })
})

// ── buildResendChildRow ────────────────────────────────────────────
describe('buildResendChildRow', () => {
  it('clones content + sender fields, queued, parent linked, no A/B or resend flags', () => {
    const row = buildResendChildRow(parent({ resend_subject: 'Still open?' }))
    expect(row).toMatchObject({
      name: 'Weekend offer (resend)',
      subject: 'Still open?',
      html_content: '<html><body>Hi</body></html>',
      design_json: { body: [] },
      preview_text: 'Ends Monday',
      from_name: 'UN1T',
      from_email: 'hello@un1t.ie',
      location_id: 'loc-1',
      postmark_stream: null,
      parent_campaign_id: 'parent-1',
      status: 'queued',
      created_by: 'user-1',
    })
    expect(row.ab_subject_b).toBeUndefined()
    expect(row.resend_enabled).toBeUndefined()
    expect(row.id).toBeUndefined()
  })
})

// ── loadNonOpenerContactIds ────────────────────────────────────────
describe('loadNonOpenerContactIds', () => {
  it('filters to unopened sent/delivered rows and pages past 1000', async () => {
    const pages = [
      Array.from({ length: 1000 }, (_, i) => ({ contact_id: `c-${i}` })),
      Array.from({ length: 250 }, (_, i) => ({ contact_id: `c-${1000 + i}` })),
    ]
    let call = 0
    const { db, statements } = makeDb((state) => {
      if (state.table === 'campaign_recipients') return { data: pages[call++] }
      return {}
    })

    const ids = await loadNonOpenerContactIds(db, 'parent-1')
    expect(ids).toHaveLength(1250)
    expect(ids[0]).toBe('c-0')
    expect(ids[1249]).toBe('c-1249')

    const q = statements.find(s => s.table === 'campaign_recipients')
    expect(hasEq(q, 'campaign_id', 'parent-1')).toBe(true)
    expect(op(q, 'is').args).toEqual(['opened_at', null])
    expect(op(q, 'in').args).toEqual(['status', NON_OPENER_STATUSES])
  })

  it('throws when the page read errors', async () => {
    const { db } = makeDb(() => ({ data: null, error: { message: 'boom' } }))
    await expect(loadNonOpenerContactIds(db, 'parent-1')).rejects.toThrow(/boom/)
  })
})

// ── spawnDueResends ────────────────────────────────────────────────
// Route helper: campaigns select → due parents; campaign_recipients
// head-count → non-opener count; campaigns insert → child; campaigns
// update → flag clear.
function spawnRoute({ parents, nonOpeners = 5, insertResult = { data: [{ id: 'child-1' }] } }) {
  const calls = { inserts: [], updates: [], counts: 0 }
  const route = (state) => {
    if (state.table === 'campaigns') {
      const first = state.ops[0]
      if (first.method === 'select') return { data: parents }
      if (first.method === 'insert') { calls.inserts.push(first.args[0]); return insertResult }
      if (first.method === 'update') { calls.updates.push({ set: first.args[0], state }); return {} }
    }
    if (state.table === 'campaign_recipients') {
      calls.counts++
      return { count: nonOpeners }
    }
    return {}
  }
  return { route, calls }
}

const uncapped = async () => ({ capped: false })

describe('spawnDueResends', () => {
  it('spawns a child for a due parent then clears the flag', async () => {
    const { route, calls } = spawnRoute({ parents: [parent()] })
    const { db } = makeDb(route)

    const summary = await spawnDueResends(db, { getCapStatus: uncapped, now })

    expect(summary.spawned).toBe(1)
    expect(calls.inserts).toHaveLength(1)
    expect(calls.inserts[0]).toMatchObject({ parent_campaign_id: 'parent-1', status: 'queued' })
    // Flag cleared on the parent, guarded to the parent id.
    expect(calls.updates).toHaveLength(1)
    expect(calls.updates[0].set).toEqual({ resend_enabled: false })
    expect(hasEq(calls.updates[0].state, 'id', 'parent-1')).toBe(true)
  })

  it('skips a parent whose wait has not elapsed', async () => {
    const early = parent({ sent_at: new Date(now.getTime() - 1 * HOUR).toISOString() })
    const { route, calls } = spawnRoute({ parents: [early] })
    const { db } = makeDb(route)

    const summary = await spawnDueResends(db, { getCapStatus: uncapped, now })
    expect(summary.spawned).toBe(0)
    expect(calls.inserts).toHaveLength(0)
    expect(calls.updates).toHaveLength(0)
  })

  it('zero non-openers → clears the flag without inserting a child', async () => {
    const { route, calls } = spawnRoute({ parents: [parent()], nonOpeners: 0 })
    const { db } = makeDb(route)

    const summary = await spawnDueResends(db, { getCapStatus: uncapped, now })
    expect(summary.spawned).toBe(0)
    expect(calls.inserts).toHaveLength(0)
    expect(calls.updates).toHaveLength(1)
    expect(calls.updates[0].set).toEqual({ resend_enabled: false })
  })

  it('23505 on the child insert (another tick won) still clears the flag', async () => {
    const { route, calls } = spawnRoute({
      parents: [parent()],
      insertResult: { data: null, error: { code: '23505', message: 'duplicate key' } },
    })
    const { db } = makeDb(route)

    const summary = await spawnDueResends(db, { getCapStatus: uncapped, now })
    expect(summary.spawned).toBe(0)
    expect(calls.updates).toHaveLength(1)
    expect(calls.updates[0].set).toEqual({ resend_enabled: false })
  })

  it('a non-conflict insert error leaves the flag set so the next tick retries', async () => {
    const { route, calls } = spawnRoute({
      parents: [parent()],
      insertResult: { data: null, error: { code: '500', message: 'db down' } },
    })
    const { db } = makeDb(route)

    const summary = await spawnDueResends(db, { getCapStatus: uncapped, now })
    expect(summary.spawned).toBe(0)
    expect(summary.errors).toHaveLength(1)
    expect(calls.updates).toHaveLength(0)
  })

  it('a capped org is skipped untouched (retries after the cap clears)', async () => {
    const { route, calls } = spawnRoute({ parents: [parent()] })
    const { db } = makeDb(route)
    const capStatus = vi.fn(async () => ({ capped: true, monthSends: 10, capSends: 10 }))

    const summary = await spawnDueResends(db, { getCapStatus: capStatus, now })
    expect(summary.spawned).toBe(0)
    expect(calls.inserts).toHaveLength(0)
    expect(calls.updates).toHaveLength(0)
    expect(capStatus).toHaveBeenCalledWith({ locationId: 'loc-1' }, { db })
  })

  it('resend_subject flows into the child; A/B winner used otherwise', async () => {
    const p1 = parent({ id: 'p1', resend_subject: 'New line' })
    const p2 = parent({ id: 'p2', ab_subject_b: 'B line', ab_winner: 'b' })
    const { route, calls } = spawnRoute({ parents: [p1, p2] })
    const { db } = makeDb(route)

    await spawnDueResends(db, { getCapStatus: uncapped, now })
    expect(calls.inserts.map(r => r.subject)).toEqual(['New line', 'B line'])
  })
})
