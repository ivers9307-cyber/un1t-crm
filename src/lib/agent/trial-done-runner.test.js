// src/lib/agent/trial-done-runner.test.js
// TRIALDONE.4 — the trial-done opener runner, against a small in-memory
// PostgREST fake (every chain is recorded; filters are applied to the rows, so
// a claim that loses a race really returns zero rows).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ilikeMatches } from '@/lib/like-escape.test-helpers'
import { WhatsAppNumberMissingError } from '@/lib/whatsapp-number-missing'
import { classify as classifyUn1t } from '@shared/pipelines/acquisition-un1t'

const m = vi.hoisted(() => ({
  sendTemplateMessage: null,
  getOrCreateConversation: null,
  pipelineInputs: null,
  trialEligibility: null,
  membershipReadsFor: null,
  loadActiveElsewhere: null,
}))

vi.mock('@/lib/whatsapp', () => ({
  sendTemplateMessage: (...a) => m.sendTemplateMessage(...a),
  headerComponentFor: () => null,
  getOrCreateConversation: (...a) => m.getOrCreateConversation(...a),
}))
vi.mock('@/lib/radar-outreach', () => ({ extractTemplateBody: () => ({ varCount: 1 }) }))
vi.mock('@/lib/membership/reads', () => ({
  membershipReadsFor: (...a) => m.membershipReadsFor(...a),
  supportsRead: (r, k) => typeof r?.reads?.[k] === 'function',
}))
vi.mock('@/lib/pipeline-other-studio-members', () => ({
  loadActiveElsewhere: (...a) => m.loadActiveElsewhere(...a),
}))

import { runTrialDoneOutreach } from './trial-done-runner'

const H = 3600_000
const MIN = 60_000
const NOW = Date.UTC(2026, 9, 20, 13, 0, 0) // 14:00 Dublin (IST)
const iso = (ms) => new Date(ms).toISOString()

const HATCH = '28c78d6b-f7b3-4edf-8c7c-840bd047b3f4'
const STILL = 'a0000000-0000-0000-0000-000000000001'
const C1 = '11111111-1111-4111-8111-111111111111'
const C2 = '22222222-2222-4222-8222-222222222222'
const C3 = '33333333-3333-4333-8333-333333333333'
const C4 = '44444444-4444-4444-8444-444444444444'

const THIRD_END = NOW - 2 * H

// One person's un1t evidence and snapshot: three attended, the third ending at `thirdEnd`.
function trialFinisher(thirdEnd = THIRD_END) {
  const ends = [thirdEnd - 48 * H, thirdEnd - 24 * H, thirdEnd]
  const evidence = {
    attended_starts: ends.map((e) => iso(e - H)),
    attended_ends: ends.map(iso),
    trial_expires_at: iso(thirdEnd + 72 * H),
  }
  const snapshot = {
    glofox_membership_status: null,
    last_attended_at: iso(thirdEnd - H),
    recent_bookings: ends.map((e) => ({ attended: true, time_start: Math.floor((e - H) / 1000) })),
    trial_expires_at: evidence.trial_expires_at,
  }
  return { evidence, snapshot }
}

const hatchLocation = (customerAgent = {}, extra = {}) => ({
  id: HATCH, name: 'UN1T Hatch Street', organization_id: null, membership_source: 'un1t_online', active: true,
  timezone: 'Europe/Dublin',
  settings: { customer_agent: { enabled: true, ...customerAgent, trial_done: { enabled: true, ...(customerAgent.trial_done || {}) } }, ...extra },
})

const contactRow = (id, over = {}) => ({
  id, location_id: HATCH, first_name: 'Aoife', name: 'Aoife Byrne', email: `${id.slice(0, 4)}@example.com`,
  wa_phone: `35387000${id.slice(0, 4)}`, phone: `+35387000${id.slice(0, 4)}`, wa_status: 'active', last_marketing_touch_at: null,
  ...over,
})

function baseTables({ location = hatchLocation(), contacts = [contactRow(C1)], templateStatus = 'APPROVED' } = {}) {
  return {
    locations: [
      location,
      { id: STILL, name: 'UN1T Stillorgan', organization_id: null, membership_source: 'glofox', active: true, timezone: 'Europe/Dublin', settings: { customer_agent: { enabled: true } } },
    ],
    location_whatsapp_numbers: [{ location_id: HATCH, whatsapp_numbers: { id: 'num1' } }],
    pipelines: [{ id: 'pipe-h', location_id: HATCH, enabled: true, module: 'acquisition_un1t', mode: 'derived' }],
    pipeline_stages: [
      { id: 'st-td', pipeline_id: 'pipe-h', location_id: HATCH, slug: 'trial_done' },
      { id: 'st-2', pipeline_id: 'pipe-h', location_id: HATCH, slug: 'second_class' },
    ],
    deals: contacts.map((c, i) => ({ id: `deal-${i + 1}`, location_id: HATCH, contact_id: c.id, stage_id: 'st-td', pipeline_id: 'pipe-h', status: 'open' })),
    contacts,
    contact_location_preferences: contacts.map((c) => ({ contact_id: c.id, location_id: HATCH, whatsapp_marketing: true })),
    whatsapp_templates: [{
      location_id: HATCH, name: 'hatch_trial_done_checkin', language: 'en', status: templateStatus,
      components: [{ type: 'BODY', text: 'Hi {{1}}, well done on finishing your trial!' }],
      header_media_url: null, business_account_id: 'waba-1', created_at: iso(NOW - 48 * H),
    }],
    profiles: [{ id: 'p1', email: 'Coach@Example.com', deleted_at: null }],
    activities: [],
    trial_done_outreach: [],
    whatsapp_messages: [],
  }
}

// ── the in-memory PostgREST fake ─────────────────────────────────────
function parseOr(expr) {
  return expr.split(',').map((part) => {
    const [col, op, ...rest] = part.split('.')
    const v = rest.join('.')
    return [op, col, v === 'null' ? null : v]
  })
}
function matches(row, f) {
  const [op, col, val] = f
  if (op === 'or') return parseOr(col).some((g) => matches(row, g))
  if (col.includes('.')) return true // an embedded resource's filter
  const v = row[col]
  switch (op) {
    case 'eq': return v === val || (v != null && String(v) === String(val))
    case 'neq': return !(v === val || (v != null && String(v) === String(val)))
    case 'in': return val.includes(v)
    case 'is': return val === null ? v == null : v === val
    case 'gte': return v != null && v >= val
    case 'lte': return v != null && v <= val
    case 'lt': return v != null && v < val
    case 'ilike': return v != null && ilikeMatches(val, v)
    default: throw new Error(`fake: unsupported filter ${op}`)
  }
}
// Column defaults the database fills on insert (mig 756).
const INSERT_DEFAULTS = {
  trial_done_outreach: () => ({
    opener_claimed_at: null, opener_sent_at: null, opener_wa_message_id: null,
    followup_kind: null, followup_claimed_at: null, followup_sent_at: null, followup_wa_message_id: null,
    closed_at: null, closed_reason: null, updated_at: iso(NOW - 7 * 24 * H),
  }),
}
let idSeq = 0
function execute(tables, q) {
  const rows = (tables[q.table] ||= [])
  const hit = () => rows.filter((r) => q.filters.every((f) => matches(r, f)))
  if (q.op === 'select') {
    let out = hit()
    if (q.opts?.head) return { count: out.length, data: null, error: null }
    if (q.order) {
      const [c, o] = q.order
      const dir = o?.ascending === false ? -1 : 1
      out = [...out].sort((a, b) => (a[c] > b[c] ? dir : a[c] < b[c] ? -dir : 0))
    }
    if (q.range) out = out.slice(q.range[0], q.range[1] + 1)
    if (q.limit != null) out = out.slice(0, q.limit)
    if (q.single) return { data: out[0] ?? null, error: null }
    return { data: out.map((r) => ({ ...r })), error: null }
  }
  if (q.op === 'insert' || q.op === 'upsert') {
    const list = Array.isArray(q.patch) ? q.patch : [q.patch]
    const keys = q.upsert?.onConflict ? q.upsert.onConflict.split(',') : null
    const inserted = []
    for (const r of list) {
      if (keys && rows.some((x) => keys.every((k) => x[k] === r[k]))) {
        if (q.upsert.ignoreDuplicates) continue
        return { data: null, error: { code: '23505', message: 'duplicate' } }
      }
      const row = { id: r.id ?? `row-${++idSeq}`, created_at: iso(NOW), ...(INSERT_DEFAULTS[q.table]?.() || {}), ...r }
      rows.push(row)
      inserted.push(row)
    }
    return { data: q.returning ? inserted.map((r) => ({ ...r })) : null, error: null }
  }
  if (q.op === 'update') {
    const out = hit()
    for (const r of out) Object.assign(r, q.patch)
    return { data: q.returning ? out.map((r) => ({ ...r })) : null, error: null }
  }
  throw new Error(`fake: unsupported op ${q.op}`)
}
function makeDb(tables, { answer } = {}) {
  const log = []
  return {
    log,
    tables,
    from(table) {
      const q = { table, op: 'select', patch: null, filters: [], opts: null, order: null, range: null, limit: null, single: false, returning: false, upsert: null }
      const run = () => {
        log.push(q)
        const over = answer?.(q, tables)
        return over !== undefined ? over : execute(tables, q)
      }
      const add = (name) => (...args) => { q.filters.push([name, ...args]); return b }
      const b = {
        select: (_cols, o) => { if (q.op === 'select') { if (o) q.opts = o } else q.returning = true; return b },
        insert: (row) => { q.op = 'insert'; q.patch = row; return b },
        upsert: (row, o) => { q.op = 'upsert'; q.patch = row; q.upsert = o || {}; return b },
        update: (patch) => { q.op = 'update'; q.patch = patch; return b },
        eq: add('eq'), neq: add('neq'), in: add('in'), is: add('is'), gte: add('gte'), lte: add('lte'), lt: add('lt'), ilike: add('ilike'),
        or: (expr) => { q.filters.push(['or', expr]); return b },
        order: (c, o) => { q.order = [c, o]; return b },
        range: (f, t) => { q.range = [f, t]; return b },
        limit: (n) => { q.limit = n; return b },
        maybeSingle: () => { q.single = true; return b },
        then: (ok, bad) => Promise.resolve().then(run).then(ok, bad),
      }
      return b
    },
  }
}
const outreach = (db, contactId) => db.tables.trial_done_outreach.find((r) => r.contact_id === contactId)
const tablesRead = (db) => [...new Set(db.log.map((q) => q.table))].sort()

// ── per-test wiring ──────────────────────────────────────────────────
let people // contactId → { evidence, snapshot }
let eligibility // contactId → reasons
let activeElsewhere
beforeEach(() => {
  idSeq = 0
  people = new Map([[C1, trialFinisher()]])
  eligibility = new Map()
  activeElsewhere = { ok: true, contactIds: new Set(), studios: [] }
  m.sendTemplateMessage = vi.fn(async () => ({ messageId: 'wamid.1' }))
  m.getOrCreateConversation = vi.fn(async () => 'conv-1')
  m.pipelineInputs = vi.fn(async () => ({
    success: true,
    data: {
      contacts: [...people.keys()].map((id) => ({ id })),
      snapshots: new Map([...people].map(([id, p]) => [id, p.snapshot])),
      evidence: new Map([...people].map(([id, p]) => [id, p.evidence])),
    },
  }))
  m.trialEligibility = vi.fn(async (_db, _loc, { contactId }) => {
    const reasons = eligibility.get(contactId) ?? ['trial_used']
    return { success: true, data: { eligible: reasons.length === 0, reasons } }
  })
  m.membershipReadsFor = vi.fn(async () => ({
    source: 'un1t_online', state: 'configured', reads: { pipelineInputs: m.pipelineInputs, trialEligibility: m.trialEligibility },
  }))
  m.loadActiveElsewhere = vi.fn(async () => activeElsewhere)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe('runTrialDoneOutreach — the opener', () => {
  it('the fixture is a trial finisher on the un1t board', () => {
    expect(classifyUn1t(trialFinisher().snapshot, NOW)).toBe('trial_done')
  })

  it('sends the opener 2 hours after the third class ends, at the studio, with the first name', async () => {
    const db = makeDb(baseTables())

    const early = await runTrialDoneOutreach(db, { nowMs: NOW - MIN }) // 1h59m after the class ended
    expect(m.sendTemplateMessage).not.toHaveBeenCalled()
    expect(early.reasons).toEqual({ too_soon: 1 })
    expect(outreach(db, C1)).toMatchObject({
      location_id: HATCH, contact_id: C1, deal_id: 'deal-1', trigger_kind: 'three_attended', trigger_at: iso(THIRD_END),
      opener_claimed_at: null, opener_sent_at: null, closed_at: null,
    })

    const res = await runTrialDoneOutreach(db, { nowMs: NOW })
    expect(res).toMatchObject({ openers: 1, followups: 0, skipped: 0 })
    expect(m.sendTemplateMessage).toHaveBeenCalledTimes(1)
    expect(m.sendTemplateMessage).toHaveBeenCalledWith(
      contactRow(C1).wa_phone, 'hatch_trial_done_checkin', 'en',
      [{ type: 'body', parameters: [{ type: 'text', text: 'Aoife' }] }],
      { locationId: HATCH, businessAccountId: 'waba-1' },
    )
    expect(outreach(db, C1)).toMatchObject({
      opener_claimed_at: iso(NOW), opener_sent_at: iso(NOW), opener_wa_message_id: 'wamid.1', updated_at: iso(NOW), closed_at: null,
    })
    // the thread, the message, the activity and the marketing touch, all at the studio
    expect(m.getOrCreateConversation).toHaveBeenCalledWith(db, expect.objectContaining({ id: C1, wa_phone: contactRow(C1).wa_phone }), HATCH)
    expect(db.tables.whatsapp_messages).toEqual([expect.objectContaining({
      conversation_id: 'conv-1', contact_id: C1, location_id: HATCH, wa_message_id: 'wamid.1', direction: 'outbound',
      message_type: 'template', template_name: 'hatch_trial_done_checkin', source: 'agent',
      body: 'Hi Aoife, well done on finishing your trial!',
    })])
    expect(db.tables.activities).toEqual([expect.objectContaining({
      contact_id: C1, location_id: HATCH, type: 'agent_trial_done', kind: 'event', subject: 'Mia messaged after their trial',
    })])
    expect(db.tables.contacts.find((c) => c.id === C1).last_marketing_touch_at).toBe(iso(NOW))
    // eligibility was read fresh for this person at this studio
    expect(m.trialEligibility).toHaveBeenCalledWith(db, HATCH, expect.objectContaining({ contactId: C1 }))

    // once ever: a later tick sends nothing
    m.sendTemplateMessage.mockClear()
    const again = await runTrialDoneOutreach(db, { nowMs: NOW + 15 * MIN })
    expect(m.sendTemplateMessage).not.toHaveBeenCalled()
    expect(again.reasons).toEqual({ already_sent: 1 })
  })

  it('the first name falls back to the name, then "there"', async () => {
    const db = makeDb(baseTables({ contacts: [contactRow(C1, { first_name: null, name: null })] }))
    await runTrialDoneOutreach(db, { nowMs: NOW })
    expect(m.sendTemplateMessage.mock.calls[0][3]).toEqual([{ type: 'body', parameters: [{ type: 'text', text: 'there' }] }])
  })

  it('finds a sibling-studio contact through the Hatch deal', async () => {
    const tables = baseTables({ contacts: [contactRow(C2, { location_id: STILL, first_name: 'Ciara' })] })
    // Stillorgan's own consent row says no; only Hatch's counts here.
    tables.contact_location_preferences.push({ contact_id: C2, location_id: STILL, whatsapp_marketing: false })
    people = new Map([[C2, trialFinisher()]])
    const db = makeDb(tables)
    const res = await runTrialDoneOutreach(db, { nowMs: NOW })
    expect(res.openers).toBe(1)
    const consentReads = db.log.filter((q) => q.table === 'contact_location_preferences')
    expect(consentReads).toHaveLength(1)
    expect(consentReads[0].filters).toEqual(expect.arrayContaining([['eq', 'contact_id', C2], ['eq', 'location_id', HATCH]]))
    expect(m.sendTemplateMessage.mock.calls[0][4]).toEqual({ locationId: HATCH, businessAccountId: 'waba-1' })
    expect(m.sendTemplateMessage.mock.calls[0][3][0].parameters[0].text).toBe('Ciara')
    expect(m.getOrCreateConversation).toHaveBeenCalledWith(db, expect.objectContaining({ id: C2 }), HATCH)
    expect(outreach(db, C2)).toMatchObject({ location_id: HATCH, opener_sent_at: iso(NOW) })
    expect(db.tables.activities[0]).toMatchObject({ location_id: HATCH, contact_id: C2 })
  })

  it('a second runner losing the claim sends nothing', async () => {
    const db = makeDb(baseTables())
    const [a, b] = await Promise.all([
      runTrialDoneOutreach(db, { nowMs: NOW }),
      runTrialDoneOutreach(db, { nowMs: NOW }),
    ])
    expect(m.sendTemplateMessage).toHaveBeenCalledTimes(1)
    expect(a.openers + b.openers).toBe(1)
    expect({ ...a.reasons, ...b.reasons }).toEqual({ claimed: 1 })
    expect(db.tables.trial_done_outreach).toHaveLength(1)
  })

  it('a claim taken by another tick between the read and the claim sends nothing', async () => {
    const db = makeDb(baseTables(), {
      answer: (q, t) => {
        if (q.table === 'trial_done_outreach' && q.op === 'update' && 'opener_claimed_at' in q.patch && q.patch.opener_claimed_at) {
          t.trial_done_outreach[0].opener_claimed_at = iso(NOW - MIN) // the other runner's claim
        }
        return undefined
      },
    })
    const res = await runTrialDoneOutreach(db, { nowMs: NOW })
    expect(m.sendTemplateMessage).not.toHaveBeenCalled()
    expect(res.reasons).toEqual({ claimed: 1 })
  })

  it('an expired claim (past the lease) is taken again', async () => {
    const tables = baseTables()
    tables.trial_done_outreach.push({
      id: 'r-old', location_id: HATCH, contact_id: C1, deal_id: 'deal-1', trigger_kind: 'three_attended', trigger_at: iso(THIRD_END),
      opener_claimed_at: iso(NOW - 31 * MIN), opener_sent_at: null, closed_at: null,
    })
    const db = makeDb(tables)
    const res = await runTrialDoneOutreach(db, { nowMs: NOW })
    expect(res.openers).toBe(1)
    expect(outreach(db, C1).opener_sent_at).toBe(iso(NOW))
  })

  it('unapproved template skips without closing or claiming', async () => {
    const db = makeDb(baseTables({ templateStatus: 'PENDING' }))
    const res = await runTrialDoneOutreach(db, { nowMs: NOW })
    expect(m.sendTemplateMessage).not.toHaveBeenCalled()
    expect(res.reasons).toEqual({ template_not_approved: 1 })
    expect(outreach(db, C1)).toMatchObject({ closed_at: null, opener_claimed_at: null })
    expect(db.log.some((q) => q.table === 'trial_done_outreach' && q.op === 'update')).toBe(false)
  })

  it('a missing template is not approved either', async () => {
    const tables = baseTables()
    tables.whatsapp_templates = []
    const db = makeDb(tables)
    const res = await runTrialDoneOutreach(db, { nowMs: NOW })
    expect(res.reasons).toEqual({ template_not_approved: 1 })
  })

  it('staff, an active Stillorgan member, a purchaser and an opted-out contact are closed with their reason, never sent', async () => {
    const contacts = [
      contactRow(C1, { email: 'coach@example.com' }), // a profiles row, any case
      contactRow(C2),
      contactRow(C3),
      contactRow(C4, { wa_status: 'opted_out' }),
    ]
    people = new Map(contacts.map((c) => [c.id, trialFinisher()]))
    activeElsewhere = { ok: true, contactIds: new Set([C2]), studios: [{ locationId: STILL, members: 1 }] }
    eligibility.set(C3, ['trial_used', 'paid_pack'])
    const db = makeDb(baseTables({ contacts }))
    const res = await runTrialDoneOutreach(db, { nowMs: NOW })
    expect(m.sendTemplateMessage).not.toHaveBeenCalled()
    expect(res.openers).toBe(0)
    expect(res.reasons).toEqual({ staff: 1, active_elsewhere: 1, purchased: 1, opted_out: 1 })
    expect(outreach(db, C1)).toMatchObject({ closed_at: iso(NOW), closed_reason: 'staff', updated_at: iso(NOW) })
    expect(outreach(db, C2)).toMatchObject({ closed_at: iso(NOW), closed_reason: 'active_elsewhere' })
    expect(outreach(db, C3)).toMatchObject({ closed_at: iso(NOW), closed_reason: 'purchased' })
    expect(outreach(db, C4)).toMatchObject({ closed_at: iso(NOW), closed_reason: 'opted_out' })
    // the active-elsewhere read ran once for the studio this tick
    expect(m.loadActiveElsewhere).toHaveBeenCalledTimes(1)
    expect(m.loadActiveElsewhere).toHaveBeenCalledWith(db, HATCH)
    // the staff read is an escaped, case-insensitive equality on live profiles
    const staffReads = db.log.filter((q) => q.table === 'profiles')
    expect(staffReads[0].filters).toEqual(expect.arrayContaining([['ilike', 'email', 'coach@example.com'], ['is', 'deleted_at', null]]))
  })

  it('a tombstoned staff profile is not staff, and an email with a wildcard matches only itself', async () => {
    const tables = baseTables({ contacts: [contactRow(C1, { email: 'a_b@example.com' })] })
    tables.profiles = [
      { id: 'p-dead', email: 'a_b@example.com', deleted_at: iso(NOW - 24 * H) },
      { id: 'p-other', email: 'axb@example.com', deleted_at: null },
    ]
    const db = makeDb(tables)
    const res = await runTrialDoneOutreach(db, { nowMs: NOW })
    expect(res.openers).toBe(1)
  })

  it('no studio consent row closes no_consent, and a classification that moved on closes not_trial_done', async () => {
    const contacts = [contactRow(C1), contactRow(C2)]
    const tables = baseTables({ contacts })
    tables.contact_location_preferences = tables.contact_location_preferences.filter((p) => p.contact_id !== C1)
    const moved = trialFinisher()
    moved.snapshot = { ...moved.snapshot, glofox_membership_status: 'member', converted_at: iso(NOW - H) }
    people = new Map([[C1, trialFinisher()], [C2, moved]])
    const db = makeDb(tables)
    const res = await runTrialDoneOutreach(db, { nowMs: NOW })
    expect(m.sendTemplateMessage).not.toHaveBeenCalled()
    expect(res.reasons).toEqual({ no_consent: 1, not_trial_done: 1 })
    expect(outreach(db, C1).closed_reason).toBe('no_consent')
    expect(outreach(db, C2).closed_reason).toBe('not_trial_done')
  })

  it('an unreadable eligibility read skips this tick: never sent, never closed', async () => {
    m.trialEligibility = vi.fn(async () => ({ success: false, error: 'timeout' }))
    const db = makeDb(baseTables())
    const res = await runTrialDoneOutreach(db, { nowMs: NOW })
    expect(m.sendTemplateMessage).not.toHaveBeenCalled()
    expect(res.reasons).toEqual({ eligibility_unreadable: 1 })
    expect(outreach(db, C1)).toMatchObject({ closed_at: null, opener_claimed_at: null })
  })

  it('an unreadable active-elsewhere read skips this tick: never sent, never closed', async () => {
    activeElsewhere = { ok: false, reason: 'read_failed' }
    const db = makeDb(baseTables())
    const res = await runTrialDoneOutreach(db, { nowMs: NOW })
    expect(m.sendTemplateMessage).not.toHaveBeenCalled()
    expect(res.reasons).toEqual({ active_elsewhere_unreadable: 1 })
    expect(outreach(db, C1).closed_at).toBeNull()
  })

  it('more than 24 hours after the trigger the row is closed stale, never sent', async () => {
    people = new Map([[C1, trialFinisher(NOW - 24 * H - MIN)]])
    const db = makeDb(baseTables())
    const res = await runTrialDoneOutreach(db, { nowMs: NOW })
    expect(m.sendTemplateMessage).not.toHaveBeenCalled()
    expect(res.reasons).toEqual({ stale: 1 })
    expect(outreach(db, C1)).toMatchObject({ closed_at: iso(NOW), closed_reason: 'stale' })
  })

  it('frequency-capped is deferred, not closed', async () => {
    const location = hatchLocation({}, { comms_frequency_cap: { enabled: true, min_hours_between: 24 } })
    const db = makeDb(baseTables({ location, contacts: [contactRow(C1, { last_marketing_touch_at: iso(NOW - 3 * H) })] }))
    const res = await runTrialDoneOutreach(db, { nowMs: NOW })
    expect(m.sendTemplateMessage).not.toHaveBeenCalled()
    expect(res.reasons).toEqual({ frequency_capped: 1 })
    expect(outreach(db, C1)).toMatchObject({ closed_at: null, opener_claimed_at: null })
  })

  it('outside 09:00-19:59 nothing is sent', async () => {
    const night = Date.UTC(2026, 9, 20, 20, 0, 0) // 21:00 Dublin
    people = new Map([[C1, trialFinisher(night - 2 * H)]])
    const db = makeDb(baseTables())
    const res = await runTrialDoneOutreach(db, { nowMs: night })
    expect(m.sendTemplateMessage).not.toHaveBeenCalled()
    expect(res.reasons).toEqual({ outside_daytime: 1 })
    expect(tablesRead(db)).not.toContain('deals')
  })

  it('operator quiet hours hold it too', async () => {
    const location = hatchLocation({ quiet_hours: { start: '13:00', end: '15:00' } })
    const db = makeDb(baseTables({ location }))
    const res = await runTrialDoneOutreach(db, { nowMs: NOW })
    expect(m.sendTemplateMessage).not.toHaveBeenCalled()
    expect(res.reasons).toEqual({ operator_quiet_hours: 1 })
  })

  it('a studio with trial_done off is never read', async () => {
    const location = hatchLocation({ trial_done: { enabled: false } })
    const db = makeDb(baseTables({ location }))
    const res = await runTrialDoneOutreach(db, { nowMs: NOW })
    expect(res).toEqual({ openers: 0, followups: 0, skipped: 0, reasons: {} })
    expect(tablesRead(db)).toEqual(['locations'])
    expect(m.membershipReadsFor).not.toHaveBeenCalled()
    expect(m.loadActiveElsewhere).not.toHaveBeenCalled()
  })

  it('a studio with Mia off is never read', async () => {
    const location = hatchLocation({ enabled: false, test_mode: false })
    const db = makeDb(baseTables({ location }))
    await runTrialDoneOutreach(db, { nowMs: NOW })
    expect(tablesRead(db)).toEqual(['locations'])
  })

  it('only reads un1t.online studios', async () => {
    const db = makeDb(baseTables())
    await runTrialDoneOutreach(db, { nowMs: NOW })
    const first = db.log[0]
    expect(first.table).toBe('locations')
    expect(first.filters).toEqual(expect.arrayContaining([['eq', 'membership_source', 'un1t_online'], ['eq', 'active', true]]))
  })

  it('only_contact_ids limits every send to those contacts', async () => {
    const contacts = [contactRow(C1), contactRow(C3, { first_name: 'Test' })]
    people = new Map(contacts.map((c) => [c.id, trialFinisher()]))
    const location = hatchLocation({ trial_done: { only_contact_ids: [C3] } })
    const db = makeDb(baseTables({ location, contacts }))
    const res = await runTrialDoneOutreach(db, { nowMs: NOW })
    expect(res.openers).toBe(1)
    expect(m.sendTemplateMessage).toHaveBeenCalledTimes(1)
    expect(m.sendTemplateMessage.mock.calls[0][0]).toBe(contactRow(C3).wa_phone)
    expect(outreach(db, C1)).toBeUndefined() // nothing recorded for anyone else
    expect(m.trialEligibility).toHaveBeenCalledTimes(1)
  })

  it('test mode (agent not enabled) sends only to the test phones', async () => {
    const contacts = [contactRow(C1), contactRow(C3)]
    people = new Map(contacts.map((c) => [c.id, trialFinisher()]))
    const location = hatchLocation({ enabled: false, test_mode: true, test_phones: [contactRow(C3).wa_phone] })
    const db = makeDb(baseTables({ location, contacts }))
    const res = await runTrialDoneOutreach(db, { nowMs: NOW })
    expect(res.openers).toBe(1)
    expect(m.sendTemplateMessage.mock.calls[0][0]).toBe(contactRow(C3).wa_phone)
    expect(res.reasons).toEqual({ test_allowlist: 1 })
    expect(outreach(db, C1).closed_at).toBeNull()
  })

  it('the daily cap stops the studio', async () => {
    const contacts = [contactRow(C1), contactRow(C2), contactRow(C3)]
    people = new Map(contacts.map((c) => [c.id, trialFinisher()]))
    const location = hatchLocation({ trial_done: { daily_cap: 2 } })
    const tables = baseTables({ location, contacts })
    // one already sent today at Hatch; one at Stillorgan and one yesterday do not count
    tables.activities.push(
      { id: 'a1', location_id: HATCH, type: 'agent_trial_done', created_at: iso(NOW - 3 * H) },
      { id: 'a2', location_id: STILL, type: 'agent_trial_done', created_at: iso(NOW - 3 * H) },
      { id: 'a3', location_id: HATCH, type: 'agent_trial_done', created_at: iso(NOW - 20 * H) },
    )
    const db = makeDb(tables)
    const res = await runTrialDoneOutreach(db, { nowMs: NOW })
    expect(res.openers).toBe(1)
    expect(m.sendTemplateMessage).toHaveBeenCalledTimes(1)
    expect(res.reasons).toEqual({ daily_cap: 1 })
  })

  it('a studio already at its cap reads no candidates', async () => {
    const location = hatchLocation({ trial_done: { daily_cap: 1 } })
    const tables = baseTables({ location })
    tables.activities.push({ id: 'a1', location_id: HATCH, type: 'agent_trial_done', created_at: iso(NOW - 3 * H) })
    const db = makeDb(tables)
    const res = await runTrialDoneOutreach(db, { nowMs: NOW })
    expect(m.sendTemplateMessage).not.toHaveBeenCalled()
    expect(res.reasons).toEqual({ daily_cap: 1 })
    expect(tablesRead(db)).not.toContain('deals')
  })

  it('an unreadable daily count skips the studio (unknown is not 0)', async () => {
    const db = makeDb(baseTables(), {
      answer: (q) => (q.table === 'activities' && q.op === 'select' ? { data: null, count: null, error: { message: 'timeout' } } : undefined),
    })
    const res = await runTrialDoneOutreach(db, { nowMs: NOW })
    expect(m.sendTemplateMessage).not.toHaveBeenCalled()
    expect(res.reasons).toEqual({ cap_read_failed: 1 })
  })

  it('a failed send releases the claim', async () => {
    m.sendTemplateMessage = vi.fn(async () => ({ messageId: null }))
    const db = makeDb(baseTables())
    const res = await runTrialDoneOutreach(db, { nowMs: NOW })
    expect(res.reasons).toEqual({ send_failed: 1 })
    expect(outreach(db, C1)).toMatchObject({ opener_claimed_at: null, opener_sent_at: null, closed_at: null, updated_at: iso(NOW) })
    expect(db.tables.activities).toEqual([])

    // so the next tick sends it
    m.sendTemplateMessage = vi.fn(async () => ({ messageId: 'wamid.2' }))
    const next = await runTrialDoneOutreach(db, { nowMs: NOW + 15 * MIN })
    expect(next.openers).toBe(1)
  })

  it('a send that throws releases the claim too', async () => {
    m.sendTemplateMessage = vi.fn(async () => { throw new Error('(#131026) Message undeliverable') })
    const db = makeDb(baseTables())
    const res = await runTrialDoneOutreach(db, { nowMs: NOW })
    expect(res.reasons).toEqual({ send_failed: 1 })
    expect(outreach(db, C1).opener_claimed_at).toBeNull()
  })

  it('a number refusal at send time is a recorded no_number skip, the claim released', async () => {
    m.sendTemplateMessage = vi.fn(async () => { throw new WhatsAppNumberMissingError(HATCH) })
    const db = makeDb(baseTables())
    const res = await runTrialDoneOutreach(db, { nowMs: NOW })
    expect(res.reasons).toEqual({ no_number: 1 })
    expect(outreach(db, C1).opener_claimed_at).toBeNull()
  })

  it('a studio with no number switched on is skipped before any candidate read', async () => {
    const tables = baseTables()
    tables.location_whatsapp_numbers = []
    const db = makeDb(tables)
    const res = await runTrialDoneOutreach(db, { nowMs: NOW })
    expect(res.reasons).toEqual({ no_number: 1 })
    expect(tablesRead(db)).not.toContain('deals')
  })

  it('only open deals in the trial_done column of the un1t board are candidates', async () => {
    const tables = baseTables({ contacts: [contactRow(C1), contactRow(C2), contactRow(C3)] })
    people = new Map([[C1, trialFinisher()], [C2, trialFinisher()], [C3, trialFinisher()]])
    tables.deals[1].stage_id = 'st-2' // second_class column
    tables.deals[2].status = 'won'
    const db = makeDb(tables)
    const res = await runTrialDoneOutreach(db, { nowMs: NOW })
    expect(res.openers).toBe(1)
    expect(m.sendTemplateMessage.mock.calls[0][0]).toBe(contactRow(C1).wa_phone)
    const dealRead = db.log.find((q) => q.table === 'deals')
    expect(dealRead.range).toEqual([0, 999])
    expect(dealRead.order).toEqual(['id', { ascending: true }])
  })

  it('an unreadable pipelineInputs skips the studio', async () => {
    m.pipelineInputs = vi.fn(async () => ({ success: false, error: 'boom' }))
    const db = makeDb(baseTables())
    const res = await runTrialDoneOutreach(db, { nowMs: NOW })
    expect(m.sendTemplateMessage).not.toHaveBeenCalled()
    expect(res.reasons).toEqual({ inputs_unreadable: 1 })
  })

  it('a two-attended, expired trial is a trigger too', async () => {
    const two = trialFinisher()
    const expiry = NOW - 2 * H
    two.evidence = { attended_starts: [iso(NOW - 100 * H), iso(NOW - 80 * H)], attended_ends: [iso(NOW - 99 * H), iso(NOW - 79 * H)], trial_expires_at: iso(expiry) }
    two.snapshot = { ...two.snapshot, recent_bookings: two.snapshot.recent_bookings.slice(0, 2), trial_expires_at: iso(expiry) }
    people = new Map([[C1, two]])
    const db = makeDb(baseTables())
    const res = await runTrialDoneOutreach(db, { nowMs: NOW })
    expect(res.openers).toBe(1)
    expect(outreach(db, C1)).toMatchObject({ trigger_kind: 'two_attended_expired', trigger_at: iso(expiry) })
  })
})
