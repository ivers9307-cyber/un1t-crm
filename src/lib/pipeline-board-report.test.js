import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./pipeline-stage-coverage', () => ({ loadStageCoverage: vi.fn() }))
vi.mock('./log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))

import { buildBoardReport } from './pipeline-board-report'
import { loadStageCoverage } from './pipeline-stage-coverage'
import { logError } from './log'

const LOC = 'loc-1'
const NOW = Date.parse('2026-11-07T12:00:00Z')
const ago = (days, extraMs = 0) => new Date(NOW - days * 86400000 + extraMs).toISOString()

// A tiny PostgREST stand-in: eq / in / gte filters, order, range, per-table errors.
function fakeDb(tables, { errors = {}, pageLog = [] } = {}) {
  return {
    from(table) {
      const filters = []
      let range = null
      const q = {
        select() { return q },
        eq(c, v) { filters.push((r) => r[c] === v); return q },
        in(c, vs) { filters.push((r) => vs.includes(r[c])); return q },
        gte(c, v) { filters.push((r) => r[c] >= v); return q },
        order() { return q },
        range(a, b) { range = [a, b]; return q },
        then(res, rej) {
          if (errors[table]) return Promise.resolve({ data: null, error: { message: 'boom' } }).then(res, rej)
          let rows = (tables[table] || []).filter((r) => filters.every((f) => f(r)))
          if (range) { pageLog.push([table, range[0], range[1]]); rows = rows.slice(range[0], range[1] + 1) }
          return Promise.resolve({ data: rows, error: null }).then(res, rej)
        },
      }
      return q
    },
  }
}

const S1 = 's-new'
const S2 = 's-conv'
const board = (over = {}) => ({
  id: 'b1', key: 'k', recipe_key: null, board_type: 'offer', enabled: true, baseline_at: ago(40),
  config: { entry: { type: 'trial_purchase', match: 'plan_code', values: ['PLAN'] } },
  stages: [
    { id: S1, name: 'New', stage_role: 'new', display_order: 1 },
    { id: S2, name: 'Converted', stage_role: 'converted', display_order: 2 },
  ],
  followups: [], ...over,
})
const deal = (id, stage, created, over = {}) => ({ id, contact_id: `c-${id}`, stage_id: stage, status: 'open', created_at: created, pipeline_id: 'b1', location_id: LOC, ...over })
const baseDeals = () => [
  deal('d1', S1, ago(2)), deal('d2', S1, ago(5)), deal('d3', S2, ago(10)),
  deal('d4', S2, ago(20), { status: 'won' }), deal('d5', S1, ago(60)),
]
const run = (tables, b = board(), opts = {}, dbOpts) => buildBoardReport(fakeDb(tables, dbOpts), { board: b, locationId: LOC, nowMs: NOW, ...opts })

beforeEach(() => {
  vi.clearAllMocks()
  loadStageCoverage.mockResolvedValue({ ok: true, boards: [{ id: 'b1', stages: [{ id: S1, followups: [] }, { id: S2, followups: [] }] }] })
})

describe('funnel', () => {
  it('counts open deals now and entries in the windows', async () => {
    const r = await run({ deals: baseDeals(), activities: [] })
    expect(r.funnel.entered7).toBe(2)
    expect(r.funnel.entered30).toBe(4)
    const byId = Object.fromEntries(r.funnel.stages.map((s) => [s.id, s]))
    expect(byId[S1].now).toBe(3)
    expect(byId[S2].now).toBe(1) // the won deal is not open
    expect(byId[S1].role).toBe('new')
    expect(r.funnel.historyNote).toBe('History before a stage rename is not counted.')
  })

  it('counts only exact-subject moves inside the window, plus creations on the first stage', async () => {
    const activities = [
      { id: 'a1', location_id: LOC, type: 'pipeline', deal_id: 'd3', subject: 'Pipeline: moved to Converted', created_at: ago(3) },
      { id: 'a2', location_id: LOC, type: 'pipeline', deal_id: 'd4', subject: 'Pipeline: moved to Converted', created_at: ago(20) },
      { id: 'a3', location_id: LOC, type: 'pipeline', deal_id: 'd4', subject: 'Pipeline: moved to Converted ', created_at: ago(1) },
      { id: 'a4', location_id: LOC, type: 'pipeline', deal_id: 'd4', subject: 'Pipeline: moved to Old name', created_at: ago(1) },
      { id: 'a5', location_id: LOC, type: 'note', deal_id: 'd4', subject: 'Pipeline: moved to Converted', created_at: ago(1) },
      { id: 'a6', location_id: LOC, type: 'pipeline', deal_id: 'd4', subject: 'Pipeline: moved to Converted', created_at: ago(45) },
    ]
    const r = await run({ deals: baseDeals(), activities })
    const byId = Object.fromEntries(r.funnel.stages.map((s) => [s.id, s]))
    expect(byId[S2].movedIn7).toBe(1)
    expect(byId[S2].movedIn30).toBe(2)
    expect(byId[S1].movedIn7).toBe(2)   // two creations, first stage only
    expect(byId[S1].movedIn30).toBe(4)
  })

  it('a failed activities read nulls the funnel only', async () => {
    const r = await run({ deals: baseDeals() }, board(), {}, { errors: { activities: true } })
    expect(r.funnel).toBeNull()
    expect(r.conversion).not.toBeNull()
    expect(r.health).not.toBeNull()
    expect(logError).toHaveBeenCalledTimes(1)
  })

  it('pages reads past 1,000 rows', async () => {
    const deals = Array.from({ length: 1500 }, (_, i) => deal(`d${String(i).padStart(4, '0')}`, S1, ago(1)))
    const pageLog = []
    const r = await run({ deals, activities: [] }, board(), {}, { pageLog })
    expect(r.funnel.entered7).toBe(1500)
    expect(r.funnel.stages[0].now).toBe(1500)
    expect(pageLog.filter(([t]) => t === 'deals').length).toBe(2)
  })
})

describe('conversion', () => {
  it('counts deals created in 30 days now converted or won; null rate at zero', async () => {
    const r = await run({ deals: baseDeals(), activities: [] })
    expect(r.conversion).toEqual({ entered30: 4, converted30: 2, rate: 0.5 })
    const none = await run({ deals: [deal('x', S1, ago(90))], activities: [] })
    expect(none.conversion).toEqual({ entered30: 0, converted30: 0, rate: null })
  })
})

describe('revenue', () => {
  const purchases = [
    { id: 'p1', contact_id: 'c-d1', location_id: LOC, amount_cents: 3900, status: 'granted', payment_status: 'paid', plan_code: 'PLAN' },
    { id: 'p2', contact_id: 'c-d2', location_id: LOC, amount_cents: 3900, status: 'awaiting_payment', payment_status: 'paid', plan_code: 'PLAN' },
    { id: 'p3', contact_id: 'c-d3', location_id: LOC, amount_cents: 3900, status: 'awaiting_payment', payment_status: null, plan_code: 'PLAN' },
    { id: 'p4', contact_id: 'c-d1', location_id: LOC, amount_cents: 9900, status: 'granted', payment_status: 'paid', plan_code: 'OTHER' },
    { id: 'p5', contact_id: 'zzz', location_id: LOC, amount_cents: 3900, status: 'granted', payment_status: 'paid', plan_code: 'PLAN' },
    { id: 'p6', contact_id: 'c-d2', location_id: 'other', amount_cents: 3900, status: 'granted', payment_status: 'paid', plan_code: 'PLAN' },
  ]
  it('sums only matching claim rows for board contacts at the studio', async () => {
    const r = await run({ deals: baseDeals(), activities: [], trial_purchases: purchases }, board(), { includeRevenue: true })
    expect(r.revenue).toEqual({ currency: 'EUR', offerCents: 7800, purchases: 2 })
  })
  it('is null without includeRevenue', async () => {
    const r = await run({ deals: baseDeals(), activities: [], trial_purchases: purchases }, board(), { includeRevenue: false })
    expect(r.revenue).toBeNull()
  })
  it('omits revenue for other entry types', async () => {
    const b = board({ config: { entry: { type: 'un1t_product', values: ['x'] } } })
    const r = await run({ deals: baseDeals(), activities: [] }, b, { includeRevenue: true })
    expect(r.revenue).toEqual({ currency: 'EUR', offerCents: null, purchases: 0 })
  })
})

describe('followups', () => {
  it('counts sent, delivered, read, replied (72h) and booked after (7d)', async () => {
    const t0 = ago(3)
    const t0ms = Date.parse(t0)
    const b = board({ followups: [{ id: 'f1', stage_id: S1, pack_key: 'p', state: 'live', whatsapp_template_id: 'tpl1', sequence_id: null }] })
    const tables = {
      deals: baseDeals(),
      activities: [],
      whatsapp_templates: [{ id: 'tpl1', location_id: LOC, name: 'tmpl_a', status: 'APPROVED' }],
      whatsapp_messages: [
        { id: 'm1', location_id: LOC, direction: 'outbound', template_name: 'tmpl_a', contact_id: 'c-d1', conversation_id: 'cv1', sent_at: t0, delivered_at: t0, read_at: t0 },
        { id: 'm2', location_id: LOC, direction: 'outbound', template_name: 'tmpl_a', contact_id: 'c-d2', conversation_id: 'cv2', sent_at: t0, delivered_at: t0, read_at: null },
        { id: 'm3', location_id: LOC, direction: 'outbound', template_name: 'tmpl_a', contact_id: 'c-d3', conversation_id: 'cv3', sent_at: t0, delivered_at: null, read_at: null },
        { id: 'm4', location_id: LOC, direction: 'outbound', template_name: 'tmpl_a', contact_id: 'not-on-board', conversation_id: 'cv4', sent_at: t0, delivered_at: t0, read_at: t0 },
        { id: 'm5', location_id: LOC, direction: 'outbound', template_name: 'other', contact_id: 'c-d1', conversation_id: 'cv1', sent_at: t0, delivered_at: t0, read_at: t0 },
        { id: 'in1', location_id: LOC, direction: 'inbound', conversation_id: 'cv1', sent_at: new Date(t0ms + 3600000).toISOString() },
        { id: 'in2', location_id: LOC, direction: 'inbound', conversation_id: 'cv2', sent_at: new Date(t0ms + 80 * 3600000).toISOString() },
      ],
      class_bookings: [
        { id: 'cb1', location_id: LOC, contact_id: 'c-d1', starts_at: new Date(t0ms + 86400000).toISOString(), created_at: ago(0), status: 'BOOKED' },
        { id: 'cb2', location_id: LOC, contact_id: 'c-d2', starts_at: new Date(t0ms + 15 * 86400000).toISOString(), status: 'BOOKED' },
        { id: 'cb3', location_id: LOC, contact_id: 'c-d3', starts_at: new Date(t0ms - 86400000).toISOString(), created_at: ago(0), status: 'BOOKED' },
        { id: 'cb4', location_id: LOC, contact_id: 'c-d2', starts_at: new Date(t0ms + 2 * 86400000).toISOString(), status: 'CANCELLED' },
      ],
    }
    const r = await run(tables, b)
    expect(r.followups).toEqual([{ stageId: S1, packKey: 'p', state: 'live', sent: 3, failed: 0, delivered: 2, read: 1, replied: 1, bookedAfter: 1 }])
  })
})

describe('followups: failed sends and distinct contacts', () => {
  const t0 = ago(3)
  const t0ms = Date.parse(t0)
  const b = () => board({ followups: [{ id: 'f1', stage_id: S1, pack_key: 'p', state: 'live', whatsapp_template_id: 'tpl1' }] })
  const msg = (id, over = {}) => ({ id, location_id: LOC, direction: 'outbound', template_name: 'tmpl_a', contact_id: 'c-d1', conversation_id: 'cv1', status: 'sent', sent_at: t0, delivered_at: t0, read_at: null, ...over })
  const base = { deals: baseDeals(), activities: [], whatsapp_templates: [{ id: 'tpl1', location_id: LOC, name: 'tmpl_a', status: 'APPROVED' }] }
  it('a failed row counts in failed, not sent/delivered/read', async () => {
    const r = await run({ ...base, whatsapp_messages: [msg('m1'), msg('m2', { status: 'failed', delivered_at: t0, read_at: t0 })] }, b())
    expect(r.followups[0]).toMatchObject({ sent: 1, failed: 1, delivered: 1, read: 0 })
  })
  it('three messages to one contact who replies and books once count once', async () => {
    const r = await run({
      ...base,
      whatsapp_messages: [msg('m1'), msg('m2'), msg('m3'), { id: 'in', location_id: LOC, direction: 'inbound', conversation_id: 'cv1', sent_at: new Date(t0ms + 3600000).toISOString() }],
      class_bookings: [{ id: 'cb', location_id: LOC, contact_id: 'c-d1', starts_at: new Date(t0ms + 86400000).toISOString(), status: 'BOOKED' }],
    }, b())
    expect(r.followups[0]).toMatchObject({ sent: 3, replied: 1, bookedAfter: 1 })
  })
  it('a class before the send (synced later) and a cancelled class do not count', async () => {
    const r = await run({
      ...base,
      whatsapp_messages: [msg('m1')],
      class_bookings: [
        { id: 'a', location_id: LOC, contact_id: 'c-d1', starts_at: new Date(t0ms - 86400000).toISOString(), created_at: new Date(t0ms + 86400000).toISOString(), status: 'ATTENDED' },
        { id: 'b', location_id: LOC, contact_id: 'c-d1', starts_at: new Date(t0ms + 86400000).toISOString(), status: 'CANCELLED' },
      ],
    }, b())
    expect(r.followups[0].bookedAfter).toBe(0)
  })
})

describe('health', () => {
  it('flags no follow-up, rejected template, paused sequence and an empty week', async () => {
    const b = board({
      stages: [
        { id: S1, name: 'New', stage_role: 'new', display_order: 1 },
        { id: S2, name: 'Converted', stage_role: 'converted', display_order: 2 },
        { id: 's-pile', name: 'Pile', stage_role: 'pile', display_order: 3 },
      ],
      followups: [{ id: 'f1', stage_id: S1, pack_key: 'p', state: 'live', whatsapp_template_id: 'tpl1', sequence_id: 'seq1' }],
    })
    const tables = {
      deals: [deal('d5', S1, ago(60))],
      activities: [],
      whatsapp_templates: [{ id: 'tpl1', location_id: LOC, name: 'tmpl_a', status: 'REJECTED' }],
      email_sequences: [{ id: 'seq1', location_id: LOC, status: 'paused' }],
    }
    const r = await run(tables, b)
    const codes = r.health.map((h) => h.code).sort()
    expect(codes).toEqual(['no_followup', 'nobody_entered_7d', 'sequence_paused', 'template_rejected'])
    expect(r.health.find((h) => h.code === 'no_followup').stageId).toBe(S2)
  })

  it('a sequence aimed at the stage counts as coverage', async () => {
    loadStageCoverage.mockResolvedValue({ ok: true, boards: [{ id: 'b1', stages: [{ id: S1, followups: [{ id: 'x' }] }, { id: S2, followups: [{ id: 'y' }] }] }] })
    const r = await run({ deals: baseDeals(), activities: [] })
    expect(r.health).toEqual([])
  })

  it('is null when coverage cannot be read', async () => {
    loadStageCoverage.mockResolvedValue({ ok: false, error: 'x' })
    const r = await run({ deals: baseDeals(), activities: [] })
    expect(r.health).toBeNull()
    expect(r.funnel).not.toBeNull()
  })
})
