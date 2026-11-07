// src/lib/agent/followups-checkin-board.test.js
// PIPEBUILD.6-2 — the first-class check-in never doubles a board follow-up.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/location-branding', () => ({ getLocationBranding: vi.fn().mockResolvedValue({ companyName: 'UN1T' }) }))

import { runFirstClassCheckins, contactsCoveredByBoardFollowup } from './followups'

const H = 3600_000
const NOW = Date.UTC(2026, 8, 25, 13, 0, 0)
const LOCATION = { id: 'loc1', name: 'Stillorgan', organization_id: null, settings: { customer_agent: { enabled: true, first_class_checkin: { enabled: true, delay_hours: 2 } } } }
const CONTACT = {
  id: 'c1', first_name: 'Alex', name: 'Alex Example', wa_phone: '353870000000', phone: '353870000000',
  pipeline_stage_slug: 'first_class', last_attended_at: new Date(NOW - 3 * H).toISOString(),
  first_class_checkin_at: null, recent_bookings: [], wa_status: 'active',
}

const FILTERED = new Set(['deals', 'pipelines', 'pipeline_stages', 'pipeline_stage_followups'])

// Minimal in-memory db: filters eq / in, resolves rows; `fail` names a table that errors.
function makeDb({ deals = [], pipelines = [], stages = [], followups = [], fail = null } = {}) {
  const tables = {
    location_whatsapp_numbers: [{ location_id: LOCATION.id }],
    locations: [LOCATION], contacts: [CONTACT],
    deals, pipelines, pipeline_stages: stages, pipeline_stage_followups: followups,
  }
  const log = []
  return {
    log,
    from(table) {
      log.push(table)
      const filters = []
      let head = false
      const run = () => {
        if (fail === table) return { data: null, error: { message: 'boom' } }
        if (head) return { count: 0, error: null }
        const rows = (tables[table] || []).filter((r) => filters.every(([op, col, v]) => (op === 'eq' ? r[col] === v : !r[col] || v.includes(r[col]))))
        return { data: rows, error: null }
      }
      const b = {
        select: (_c, o) => { if (o?.head) head = true; return b },
        eq: (c, v) => { if (FILTERED.has(table)) filters.push(['eq', c, v]); return b },
        in: (c, v) => { if (FILTERED.has(table)) filters.push(['in', c, v]); return b },
        gte: () => b, lte: () => b, is: () => b, not: () => b, or: () => b, order: () => b, limit: () => b, range: () => b,
        update: () => b, insert: () => Promise.resolve({ error: null }), maybeSingle: () => b, single: () => b,
        then: (ok, bad) => Promise.resolve(run()).then(ok, bad),
      }
      return b
    },
  }
}

const board = (state, over = {}) => ({
  deals: [{ id: 'd1', contact_id: 'c1', location_id: 'loc1', pipeline_id: 'p1', stage_id: 's1', status: 'open' }],
  pipelines: [{ id: 'p1', location_id: 'loc1', enabled: true, board_type: 'offer' }],
  stages: [{ id: 's1', stage_role: 'first_class' }],
  followups: [{ id: 'f1', stage_id: 's1', state }],
  ...over,
})

beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {}) })
afterEach(() => vi.restoreAllMocks())

describe('contactsCoveredByBoardFollowup', () => {
  it('covers a contact whose open offer-board deal sits on a first_class stage with a live follow-up', async () => {
    const r = await contactsCoveredByBoardFollowup(makeDb(board('live')), { locationId: 'loc1', contactIds: ['c1'], role: 'first_class' })
    expect(r).toEqual({ ok: true, ids: new Set(['c1']) })
  })
  it('does not cover when the follow-up is off', async () => {
    const r = await contactsCoveredByBoardFollowup(makeDb(board('off')), { locationId: 'loc1', contactIds: ['c1'], role: 'first_class' })
    expect(r).toEqual({ ok: true, ids: new Set() })
  })
  it('does not cover a built-in (non-offer) board deal', async () => {
    const db = makeDb(board('live', { pipelines: [{ id: 'p1', location_id: 'loc1', enabled: true, board_type: 'builtin' }] }))
    const r = await contactsCoveredByBoardFollowup(db, { locationId: 'loc1', contactIds: ['c1'], role: 'first_class' })
    expect(r).toEqual({ ok: true, ids: new Set() })
  })
  it('does not cover a disabled board or a closed deal', async () => {
    const off = makeDb(board('live', { pipelines: [{ id: 'p1', location_id: 'loc1', enabled: false, board_type: 'offer' }] }))
    expect((await contactsCoveredByBoardFollowup(off, { locationId: 'loc1', contactIds: ['c1'] })).ids.size).toBe(0)
    const closed = makeDb(board('live', { deals: [{ id: 'd1', contact_id: 'c1', location_id: 'loc1', pipeline_id: 'p1', stage_id: 's1', status: 'won' }] }))
    expect((await contactsCoveredByBoardFollowup(closed, { locationId: 'loc1', contactIds: ['c1'] })).ids.size).toBe(0)
  })
  it('a studio with no offer boards makes exactly one read (pipelines) and covers nobody', async () => {
    const db = makeDb(board('live', { pipelines: [] }))
    const r = await contactsCoveredByBoardFollowup(db, { locationId: 'loc1', contactIds: ['c1'] })
    expect(r).toEqual({ ok: true, ids: new Set() })
    expect(db.log).toEqual(['pipelines'])
  })
  it('a failing pipelines read is ok:false', async () => {
    const r = await contactsCoveredByBoardFollowup(makeDb({ ...board('live'), fail: 'pipelines' }), { locationId: 'loc1', contactIds: ['c1'] })
    expect(r).toEqual({ ok: false })
  })
  it('a failing pipeline_stages read is ok:false', async () => {
    const r = await contactsCoveredByBoardFollowup(makeDb({ ...board('live'), fail: 'pipeline_stages' }), { locationId: 'loc1', contactIds: ['c1'] })
    expect(r).toEqual({ ok: false })
  })
  it('returns ok:false on a read error', async () => {
    const r = await contactsCoveredByBoardFollowup(makeDb({ ...board('live'), fail: 'pipeline_stage_followups' }), { locationId: 'loc1', contactIds: ['c1'] })
    expect(r).toEqual({ ok: false })
  })
})

describe('runFirstClassCheckins — board follow-up coverage', () => {
  it('skips a covered candidate with board_followup', async () => {
    const res = await runFirstClassCheckins(makeDb(board('live')), { nowMs: NOW })
    expect(res.reasons.board_followup).toBe(1)
    expect(res.skipped).toBe(1)
  })
  it('does not skip when the follow-up is off', async () => {
    const res = await runFirstClassCheckins(makeDb(board('off')), { nowMs: NOW })
    expect(res.reasons.board_followup).toBeUndefined()
  })
  it('does not skip a built-in board deal', async () => {
    const db = makeDb(board('live', { pipelines: [{ id: 'p1', location_id: 'loc1', enabled: true, board_type: 'builtin' }] }))
    const res = await runFirstClassCheckins(db, { nowMs: NOW })
    expect(res.reasons.board_followup).toBeUndefined()
  })
  it('a studio with no offer boards still checks in even if deals would error', async () => {
    const db = makeDb({ ...board('live', { pipelines: [] }), fail: 'deals' })
    const res = await runFirstClassCheckins(db, { nowMs: NOW })
    expect(res.reasons.board_followup_read_failed).toBeUndefined()
    expect(db.log).not.toContain('deals')
    expect(db.log).toContain('whatsapp_conversations')
  })
  it('a coverage read error skips the studio: no candidate is classified', async () => {
    const db = makeDb({ ...board('live'), fail: 'deals' })
    const res = await runFirstClassCheckins(db, { nowMs: NOW })
    expect(res.reasons.board_followup_read_failed).toBe(1)
    expect(db.log).not.toContain('whatsapp_conversations')
    expect(res.freeform + res.templates).toBe(0)
  })
})
