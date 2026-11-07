import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./pipeline-stage-coverage', () => ({ loadStageCoverage: vi.fn() }))
vi.mock('./log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('./pipeline-offer-claims', async (importOriginal) => ({ ...(await importOriginal()), loadOfferClaimsForLocation: vi.fn() }))

import { buildBoardReport } from './pipeline-board-report'
import { loadStageCoverage } from './pipeline-stage-coverage'
import { loadOfferClaimsForLocation } from './pipeline-offer-claims'
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
        maybeSingle() {
          if (errors[table]) return Promise.resolve({ data: null, error: { message: 'boom' } })
          const rows = (tables[table] || []).filter((r) => filters.every((f) => f(r)))
          return Promise.resolve({ data: rows[0] ?? null, error: null })
        },
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
// Claim start per contact. By default each deal's claim starts when the deal
// was created (so the older tests read as before); a test can override it.
let claimStarts = null
const claimsFor = (deals) => (_db, { boards, contacts }) => {
  const starts = claimStarts || new Map((deals || []).map((d) => [d.contact_id, d.created_at]))
  const key = boards[0].key
  const offersByContact = new Map()
  for (const c of contacts) {
    const iso = starts.get(c.id)
    if (iso) offersByContact.set(c.id, new Map([[key, { start: Date.parse(iso), end: Date.parse(iso) + 14 * 86400000, source: 'trial_purchase' }]]))
  }
  return Promise.resolve({ ok: true, offersByContact, pending: [], skipped: [] })
}
const run = (tables, b = board(), opts = {}, dbOpts) => {
  if (!loadOfferClaimsForLocation.getMockImplementation()) loadOfferClaimsForLocation.mockImplementation(claimsFor(tables.deals))
  return buildBoardReport(fakeDb(tables, dbOpts), { board: b, locationId: LOC, nowMs: NOW, ...opts })
}

beforeEach(() => {
  vi.clearAllMocks()
  loadOfferClaimsForLocation.mockReset()
  claimStarts = null
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

describe('entered counts by the board claim', () => {
  it('counts a deal created long ago that moved in when its claim started 3 days ago', async () => {
    claimStarts = new Map([['c-old', ago(3)]])
    const r = await run({ deals: [deal('old', S1, ago(200), { contact_id: 'c-old' })], activities: [] })
    expect(r.funnel.entered7).toBe(1)
    expect(r.funnel.entered30).toBe(1)
    expect(r.conversion).toEqual({ entered30: 1, converted30: 0, rate: 0 })
    expect(r.health.map((h) => h.code)).not.toContain('nobody_entered_7d')
  })

  it('a deal created this week whose claim started long ago is not entered', async () => {
    claimStarts = new Map([['c-new', ago(90)]])
    const r = await run({ deals: [deal('new', S1, ago(1), { contact_id: 'c-new' })], activities: [] })
    expect(r.funnel.entered7).toBe(0)
    expect(r.conversion.entered30).toBe(0)
  })

  it('a claims read failure nulls the entered numbers and raises no nobody_entered_7d', async () => {
    loadOfferClaimsForLocation.mockResolvedValue({ ok: false, reason: 'purchases_unreadable', err: 'boom' })
    const r = await run({ deals: [deal('d5', S1, ago(60))], activities: [] })
    expect(r.funnel).not.toBeNull()
    expect(r.funnel.entered7).toBeNull()
    expect(r.funnel.entered30).toBeNull()
    expect(r.funnel.stages[0].now).toBe(1)
    expect(r.conversion).toEqual({ entered30: null, converted30: null, rate: null })
    expect(r.health.map((h) => h.code)).not.toContain('nobody_entered_7d')
    expect(logError).toHaveBeenCalledTimes(1)
  })

  it('a board config the loader skips counts as unreadable', async () => {
    loadOfferClaimsForLocation.mockResolvedValue({ ok: true, offersByContact: new Map(), pending: [], skipped: [{ key: 'k', errors: ['x'] }] })
    const r = await run({ deals: baseDeals(), activities: [] })
    expect(r.funnel.entered7).toBeNull()
  })

  it('passes ids only for a purchase board, and the board as enabled even when paused', async () => {
    await run({ deals: baseDeals(), activities: [] }, board({ enabled: false }))
    const args = loadOfferClaimsForLocation.mock.calls[0][1]
    expect(args.contacts).toEqual(['c-d1', 'c-d2', 'c-d3', 'c-d4', 'c-d5'].map((id) => ({ id })))
    expect(args.boards).toEqual([expect.objectContaining({ key: 'k', enabled: true })])
    expect(args).toMatchObject({ locationId: LOC, now: NOW })
  })

  it('reads the contact columns (paged) for a recorded entry type', async () => {
    const contacts = [{ id: 'c-d1', last_lead_source: 'meta' }, { id: 'c-d2', last_lead_source: null }]
    const pageLog = []
    await run({ deals: baseDeals().slice(0, 2), activities: [], contacts }, board({ config: { entry: { type: 'lead_source', values: ['meta'] } } }), {}, { pageLog })
    expect(loadOfferClaimsForLocation.mock.calls[0][1].contacts).toEqual(contacts)
    expect(pageLog.some(([t]) => t === 'contacts')).toBe(true)
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

describe('followups: earlier versions', () => {
  it('a version-2 follow-up still counts its version-1 sends', async () => {
    const t0 = ago(3)
    const b = board({
      recipe_key: 'paid_trial_offer',
      followups: [{ id: 'f1', stage_id: S1, pack_key: 'trial_done', state: 'live', version: 2, whatsapp_template_id: 'tpl2' }],
    })
    const msg = (id, name) => ({ id, location_id: LOC, direction: 'outbound', template_name: name, contact_id: 'c-d1', conversation_id: 'cv1', status: 'sent', sent_at: t0, delivered_at: null, read_at: null })
    const r = await run({
      deals: baseDeals(),
      activities: [],
      whatsapp_templates: [{ id: 'tpl2', location_id: LOC, name: 'stu_k_trial_done_main_v2', status: 'APPROVED' }],
      whatsapp_messages: [
        msg('m1', 'stu_k_trial_done_main'),
        msg('m2', 'stu_k_trial_done_followup'),
        msg('m3', 'stu_k_trial_done_main_v2'),
        msg('m4', 'stu_k_trial_done_followup_v2'),
        msg('m5', 'other_k_trial_done_main'),
        msg('m6', 'stu_k_trial_done_main_v3'),
      ],
    }, b)
    expect(r.followups[0].sent).toBe(4)
  })

  it('a single-message pack counts every version of its one message', async () => {
    const b = board({
      recipe_key: 'paid_trial_offer',
      followups: [{ id: 'f1', stage_id: S1, pack_key: 'book_first_class', state: 'live', version: 3, whatsapp_template_id: 'tpl3' }],
    })
    const msg = (id, name) => ({ id, location_id: LOC, direction: 'outbound', template_name: name, contact_id: 'c-d1', conversation_id: 'cv1', status: 'sent', sent_at: ago(3), delivered_at: null, read_at: null })
    const r = await run({
      deals: baseDeals(),
      activities: [],
      whatsapp_templates: [{ id: 'tpl3', location_id: LOC, name: 'stu_k_book_first_class_main_v3', status: 'APPROVED' }],
      whatsapp_messages: [msg('m1', 'stu_k_book_first_class_main'), msg('m2', 'stu_k_book_first_class_main_v2'), msg('m3', 'stu_k_book_first_class_main_v3')],
    }, b)
    expect(r.followups[0].sent).toBe(3)
  })
})

describe('health', () => {
  it('flags no follow-up, rejected template, paused sequence and an empty week', async () => {
    const b = board({
      recipe_key: 'paid_trial_offer',
      stages: [
        { id: S1, name: 'New', stage_role: 'new', display_order: 1 },
        { id: 's-done', name: 'Trial Done', stage_role: 'done', display_order: 2 },
        { id: S2, name: 'Converted', stage_role: 'converted', display_order: 3 },
        { id: 's-pile', name: 'Pile', stage_role: 'pile', display_order: 4 },
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
    expect(r.health.find((h) => h.code === 'no_followup').stageId).toBe('s-done')
  })

  // RAILS.4 — a held first placement, dated on the studio's own calendar.
  it('a held first placement is baseline_held, dated on the studio calendar; not held is quiet', async () => {
    const lastRun = { status: 'partial', errors: 3, started_at: '2026-11-07T03:30:00Z', finished_at: '2026-11-07T03:31:00Z' }
    const pendingBoard = (held) => board({ baseline_at: null, baseline_pending: { cadence: 'nightly', last_run: lastRun, held } })
    const tables = { deals: baseDeals(), activities: [], locations: [{ id: LOC, timezone: 'America/New_York' }] }
    const held = await run(tables, pendingBoard(true))
    expect(held.health.filter((h) => h.code === 'baseline_held')).toEqual([{
      code: 'baseline_held',
      message: "First placement is held: 3 people could not be checked on the last run (6 Nov). Follow-ups won't start until a run completes cleanly.",
    }])
    const exclusion = await run(tables, board({ baseline_at: null, baseline_pending: { cadence: 'nightly', last_run: { ...lastRun, status: 'success', errors: 0 }, held: true } }))
    expect(exclusion.health.find((h) => h.code === 'baseline_held').message)
      .toBe("First placement is held: the last run (6 Nov) could not complete. Follow-ups won't start until a run completes cleanly.")
    const quiet = await run(tables, pendingBoard(false))
    expect(quiet.health.map((h) => h.code)).not.toContain('baseline_held')
    const unread = await run(tables, board({ baseline_at: null, baseline_pending: { cadence: 'nightly', last_run: null, held: false, unread: true } }))
    expect(unread.health.map((h) => h.code)).not.toContain('baseline_held')
  })

  it("a paid_trial_offer board's Converted stage gives no warning (the recipe has no converted pack)", async () => {
    loadStageCoverage.mockResolvedValue({ ok: true, boards: [{ id: 'b1', stages: [{ id: S1, followups: [{ id: 'x' }] }, { id: S2, followups: [] }] }] })
    const r = await run({ deals: baseDeals(), activities: [] }, board({ recipe_key: 'paid_trial_offer' }))
    expect(r.health.filter((h) => h.code === 'no_followup')).toEqual([])
  })

  it('a custom stage without a follow-up is flagged on any board', async () => {
    const b = board({ stages: [...board().stages, { id: 's-custom', name: 'Called', stage_role: 'custom', display_order: 3 }] })
    const r = await run({ deals: baseDeals(), activities: [] }, b)
    expect(r.health.filter((h) => h.code === 'no_followup').map((h) => h.stageId)).toEqual(['s-custom'])
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
