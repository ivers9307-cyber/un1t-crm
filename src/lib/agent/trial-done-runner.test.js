// src/lib/agent/trial-done-runner.test.js
// TRIALDONE.4/.5 — the trial-done opener and follow-up runner, against a small in-memory
// PostgREST fake (every chain is recorded; filters are applied to the rows, so
// a claim that loses a race really returns zero rows).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ilikeMatches } from '@/lib/like-escape.test-helpers'
import { WhatsAppNumberMissingError } from '@/lib/whatsapp-number-missing'
import { classify as classifyUn1t } from '@shared/pipelines/acquisition-un1t'

const m = vi.hoisted(() => ({
  sendTemplateMessage: null,
  sendTextMessage: null,
  composeAgentText: null,
  getOrCreateConversation: null,
  pipelineInputs: null,
  trialEligibility: null,
  membershipReadsFor: null,
  loadActiveElsewhere: null,
}))

vi.mock('@/lib/whatsapp', () => ({
  sendTemplateMessage: (...a) => m.sendTemplateMessage(...a),
  sendTextMessage: (...a) => m.sendTextMessage(...a),
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
vi.mock('@/lib/location-branding', () => ({
  getLocationBranding: async () => ({ companyName: 'UN1T' }),
}))
// Mia's composer is the only part of followups.js faked: the runner reuses the
// rest (recordProactiveMessage, proactiveWindowOpen, the knowledge read) as is.
vi.mock('./followups', async (importOriginal) => ({
  ...(await importOriginal()),
  composeAgentText: (...a) => m.composeAgentText(...a),
}))

import { runTrialDoneOutreach } from './trial-done-runner'
import { trialDoneLineFor } from './trial-done-context'

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
  // TRIALDONE.7 — the sale path (MIAHATCH.6's switch + un1t writes) is on by default here.
  settings: {
    customer_agent: { enabled: true, un1t_chat_actions_enabled: true, ...customerAgent, trial_done: { enabled: true, ...(customerAgent.trial_done || {}) } },
    un1t_online: { writes_enabled: true },
    ...extra,
  },
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
    }, {
      location_id: HATCH, name: 'hatch_trial_done_followup', language: 'en', status: templateStatus,
      components: [{ type: 'BODY', text: 'Hey {{1}}, just bumping this in case it got buried!' }],
      header_media_url: null, business_account_id: 'waba-1', created_at: iso(NOW - 48 * H),
    }],
    // the studio's thread per person, keyed (location_id, wa_phone) as in mig 008
    whatsapp_conversations: contacts.map((c) => ({
      id: `conv-${c.id.slice(0, 1)}`, location_id: HATCH, wa_phone: c.wa_phone, contact_id: c.id,
      agent_active: true, agent_handed_off_at: null, agent_paused_at: null,
    })),
    agent_knowledge: [],
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
  if (op === 'not') return !matches(row, [f[2], col, f[3]])
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
    case 'gt': return v != null && v > val
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
        eq: add('eq'), neq: add('neq'), in: add('in'), is: add('is'), gte: add('gte'), lte: add('lte'), lt: add('lt'), gt: add('gt'), ilike: add('ilike'),
        or: (expr) => { q.filters.push(['or', expr]); return b },
        not: (col, op, val) => { q.filters.push(['not', col, op, val]); return b },
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
  m.sendTextMessage = vi.fn(async () => ({ messageId: 'wamid.text' }))
  m.composeAgentText = vi.fn(async () => ({ text: 'Hi Aoife, any thoughts on the Foundation spots? Happy to help.' }))
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
    // the follow-up stage now owns the row: nothing is due 15 minutes later
    expect(again.reasons).toEqual({ too_soon: 1 })
    expect(again.openers).toBe(0)
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

  // TRIALDONE.8 — Mia off stops the send pass; only the buyer sweep's one read runs.
  it('a studio with Mia off reads no candidates (the buyer sweep only)', async () => {
    const location = hatchLocation({ enabled: false, test_mode: false })
    const db = makeDb(baseTables({ location }))
    await runTrialDoneOutreach(db, { nowMs: NOW })
    expect(tablesRead(db)).toEqual(['locations', 'trial_done_outreach'])
    expect(db.log.filter((q) => q.table === 'trial_done_outreach').every((q) => q.op === 'select' && q.filters.some((f) => f[0] === 'not'))).toBe(true)
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

// ── TRIALDONE.5 — the one follow-up ──────────────────────────────────
const CONV1 = 'conv-1'
// A row whose opener went at `openerAt`; the person is still a trial finisher.
function openedRow(contactId, openerAt, over = {}) {
  return {
    id: `r-${contactId.slice(0, 1)}`, location_id: HATCH, contact_id: contactId, deal_id: 'deal-1',
    trigger_kind: 'three_attended', trigger_at: iso(openerAt - 2 * H),
    opener_claimed_at: iso(openerAt), opener_sent_at: iso(openerAt), opener_wa_message_id: 'wamid.opener',
    followup_kind: null, followup_claimed_at: null, followup_sent_at: null, followup_wa_message_id: null,
    closed_at: null, closed_reason: null, updated_at: iso(openerAt),
    ...over,
  }
}
const msg = (direction, atMs, over = {}) => ({
  id: `m-${direction}-${atMs}`, conversation_id: CONV1, contact_id: C1, location_id: HATCH, direction,
  source: direction === 'outbound' ? 'agent' : null, body: direction === 'inbound' ? 'Tell me more' : 'Sure, here you go',
  message_type: 'text', created_at: iso(atMs), ...over,
})
function followupTables({ openerAt, messages = [], contacts = [contactRow(C1)], location, rows } = {}) {
  const tables = baseTables({ location, contacts })
  tables.trial_done_outreach = rows || contacts.map((c) => openedRow(c.id, openerAt))
  tables.whatsapp_messages = messages
  return tables
}

describe('runTrialDoneOutreach — the one follow-up', () => {
  beforeEach(() => {
    // finished a day ago: still trial_done on the board, long past the opener's 24h
    people = new Map([[C1, trialFinisher(NOW - 30 * H)], [C2, trialFinisher(NOW - 30 * H)], [C3, trialFinisher(NOW - 30 * H)]])
  })

  it('template at opener + 22h when they never replied', async () => {
    const db = makeDb(followupTables({ openerAt: NOW - 22 * H }))

    const early = await runTrialDoneOutreach(db, { nowMs: NOW - MIN })
    expect(early.reasons).toEqual({ too_soon: 1 })
    expect(m.sendTemplateMessage).not.toHaveBeenCalled()
    expect(outreach(db, C1)).toMatchObject({ followup_claimed_at: null, followup_kind: null, closed_at: null })

    db.log.length = 0
    const res = await runTrialDoneOutreach(db, { nowMs: NOW })
    expect(res).toMatchObject({ openers: 0, followups: 1, skipped: 0 })
    expect(m.sendTextMessage).not.toHaveBeenCalled()
    expect(m.composeAgentText).not.toHaveBeenCalled()
    expect(m.sendTemplateMessage).toHaveBeenCalledTimes(1)
    expect(m.sendTemplateMessage).toHaveBeenCalledWith(
      contactRow(C1).wa_phone, 'hatch_trial_done_followup', 'en',
      [{ type: 'body', parameters: [{ type: 'text', text: 'Aoife' }] }],
      { locationId: HATCH, businessAccountId: 'waba-1' },
    )
    expect(outreach(db, C1)).toMatchObject({
      followup_kind: 'template', followup_claimed_at: iso(NOW), followup_sent_at: iso(NOW), followup_wa_message_id: 'wamid.1',
      updated_at: iso(NOW), closed_at: null, opener_sent_at: iso(NOW - 22 * H),
    })
    expect(db.tables.whatsapp_messages).toEqual([expect.objectContaining({
      conversation_id: 'conv-1', contact_id: C1, location_id: HATCH, wa_message_id: 'wamid.1', direction: 'outbound',
      message_type: 'template', template_name: 'hatch_trial_done_followup', source: 'agent',
      body: 'Hey Aoife, just bumping this in case it got buried!',
    })])
    expect(db.tables.activities).toEqual([expect.objectContaining({
      contact_id: C1, location_id: HATCH, type: 'agent_trial_done', kind: 'event', subject: 'Mia followed up after their trial',
      note: 'hatch_trial_done_followup',
    })])
    expect(db.tables.contacts.find((c) => c.id === C1).last_marketing_touch_at).toBe(iso(NOW))
    // eligibility read fresh before the follow-up
    expect(m.trialEligibility).toHaveBeenCalledWith(db, HATCH, expect.objectContaining({ contactId: C1 }))
    // the thread is the studio's, found by its unique key; replies are read after the opener only
    const convRead = db.log.find((q) => q.table === 'whatsapp_conversations')
    expect(convRead.filters).toEqual(expect.arrayContaining([['eq', 'location_id', HATCH], ['eq', 'wa_phone', contactRow(C1).wa_phone]]))
    const msgReads = db.log.filter((q) => q.table === 'whatsapp_messages' && q.op === 'select')
    expect(msgReads).toHaveLength(2)
    for (const r of msgReads) {
      expect(r.filters).toEqual(expect.arrayContaining([['gt', 'created_at', iso(NOW - 22 * H)]]))
      expect(r.order).toEqual(['created_at', { ascending: false }])
      expect(r.limit).toBe(1)
    }
    // TRIALDONE.7: replies on any of the organisation's threads for them; Mia's
    // last word on the studio's own thread only
    const [inRead, outRead] = ['inbound', 'outbound'].map((d) => msgReads.find((r) => r.filters.some((f) => f[0] === 'eq' && f[1] === 'direction' && f[2] === d)))
    expect(inRead.filters).toEqual(expect.arrayContaining([['in', 'conversation_id', ['conv-1']]]))
    expect(outRead.filters).toEqual(expect.arrayContaining([['eq', 'conversation_id', 'conv-1']]))
  })

  it('a reply from before the opener is not a reply: still the template', async () => {
    const db = makeDb(followupTables({ openerAt: NOW - 22 * H, messages: [msg('inbound', NOW - 30 * H)] }))
    const res = await runTrialDoneOutreach(db, { nowMs: NOW })
    expect(res.followups).toBe(1)
    expect(outreach(db, C1).followup_kind).toBe('template')
  })

  it('nudge 3h after their last message when Mia answered last', async () => {
    const lastIn = NOW - 3 * H
    m.composeAgentText = vi.fn(async () => ({ text: 'Hi Aoife — any thoughts on the Foundation spots?' }))
    const db = makeDb(followupTables({
      openerAt: NOW - 10 * H,
      messages: [msg('inbound', lastIn), msg('outbound', lastIn + 5 * MIN)],
    }))

    const early = await runTrialDoneOutreach(db, { nowMs: NOW - MIN })
    expect(early.reasons).toEqual({ too_soon: 1 })
    expect(m.composeAgentText).not.toHaveBeenCalled()

    const res = await runTrialDoneOutreach(db, { nowMs: NOW })
    expect(res).toMatchObject({ openers: 0, followups: 1, skipped: 0 })
    expect(m.sendTemplateMessage).not.toHaveBeenCalled()
    expect(m.composeAgentText).toHaveBeenCalledTimes(1)
    const compose = m.composeAgentText.mock.calls[0][0]
    expect(compose.instruction).toBe('[STUDIO SYSTEM - not the customer] They finished their trial and talked with you about continuing, then went quiet. Write one short, friendly check-in that picks up where you left off. No prices unless you already gave them. No pressure. If they declined, said they will decide later, or there is nothing open to follow up on, reply with exactly [[SKIP]] and nothing else.')
    expect(compose.location).toMatchObject({ id: HATCH, name: 'UN1T Hatch Street' })
    expect(compose.zone).toBe('Europe/Dublin')
    expect(compose.companyName).toBe('UN1T')
    expect(compose.historyRows.map((r) => r.direction)).toEqual(['inbound', 'outbound'])
    expect(compose.membershipSource).toMatchObject({ key: 'un1t_online' })
    // in the window, on the studio's own number, with no em-dash
    expect(m.sendTextMessage).toHaveBeenCalledTimes(1)
    const [to, text, opts] = m.sendTextMessage.mock.calls[0]
    expect(to).toBe(contactRow(C1).wa_phone)
    expect(text).not.toMatch(/[–—]/)
    expect(text).toContain('any thoughts on the Foundation spots?')
    expect(opts).toEqual({ locationId: HATCH })
    expect(outreach(db, C1)).toMatchObject({
      followup_kind: 'nudge', followup_sent_at: iso(NOW), followup_wa_message_id: 'wamid.text', closed_at: null,
    })
    // recorded on the studio's own thread like the opener
    expect(m.getOrCreateConversation).not.toHaveBeenCalled()
    expect(db.tables.whatsapp_messages.at(-1)).toMatchObject({
      conversation_id: 'conv-1', contact_id: C1, location_id: HATCH, wa_message_id: 'wamid.text', direction: 'outbound',
      message_type: 'text', source: 'agent', body: text,
    })
    expect(db.tables.activities).toEqual([expect.objectContaining({
      contact_id: C1, location_id: HATCH, type: 'agent_trial_done', subject: 'Mia followed up after their trial', note: 'nudge',
    })])
  })

  it('no follow-up while the customer is waiting on Mia', async () => {
    const lastIn = NOW - 5 * H
    const db = makeDb(followupTables({
      openerAt: NOW - 10 * H,
      messages: [msg('inbound', lastIn - H), msg('outbound', lastIn - 30 * MIN), msg('inbound', lastIn)],
    }))
    const res = await runTrialDoneOutreach(db, { nowMs: NOW })
    expect(res.reasons).toEqual({ awaiting_mia: 1 })
    expect(m.sendTemplateMessage).not.toHaveBeenCalled()
    expect(m.sendTextMessage).not.toHaveBeenCalled()
    expect(m.composeAgentText).not.toHaveBeenCalled()
    expect(outreach(db, C1)).toMatchObject({ followup_claimed_at: null, closed_at: null })
  })

  it('followup skipped and closed when the person bought', async () => {
    eligibility.set(C1, ['trial_used', 'membership_history'])
    const db = makeDb(followupTables({ openerAt: NOW - 22 * H }))
    const res = await runTrialDoneOutreach(db, { nowMs: NOW })
    expect(m.sendTemplateMessage).not.toHaveBeenCalled()
    expect(res.reasons).toEqual({ purchased: 1 })
    expect(outreach(db, C1)).toMatchObject({ closed_at: iso(NOW), closed_reason: 'purchased', followup_claimed_at: null, updated_at: iso(NOW) })
  })

  it('opt-out after the opener closes the row', async () => {
    const contacts = [contactRow(C1, { wa_status: 'opted_out' }), contactRow(C2)]
    const tables = followupTables({ openerAt: NOW - 22 * H, contacts })
    // C2 said STOP at the studio: its consent row is now false
    tables.contact_location_preferences.find((p) => p.contact_id === C2).whatsapp_marketing = false
    const db = makeDb(tables)
    const res = await runTrialDoneOutreach(db, { nowMs: NOW })
    expect(m.sendTemplateMessage).not.toHaveBeenCalled()
    expect(res.reasons).toEqual({ opted_out: 2 })
    expect(outreach(db, C1)).toMatchObject({ closed_at: iso(NOW), closed_reason: 'opted_out' })
    expect(outreach(db, C2)).toMatchObject({ closed_at: iso(NOW), closed_reason: 'opted_out' })
  })

  it('a staff or active-elsewhere verdict closes with its own reason', async () => {
    const contacts = [contactRow(C1, { email: 'coach@example.com' }), contactRow(C2)]
    activeElsewhere = { ok: true, contactIds: new Set([C2]), studios: [] }
    const db = makeDb(followupTables({ openerAt: NOW - 22 * H, contacts }))
    const res = await runTrialDoneOutreach(db, { nowMs: NOW })
    expect(res.reasons).toEqual({ staff: 1, active_elsewhere: 1 })
    expect(outreach(db, C1).closed_reason).toBe('staff')
    expect(outreach(db, C2).closed_reason).toBe('active_elsewhere')
  })

  it('only one follow-up ever', async () => {
    const db = makeDb(followupTables({ openerAt: NOW - 22 * H }))
    const first = await runTrialDoneOutreach(db, { nowMs: NOW })
    expect(first.followups).toBe(1)

    // they reply to the template, Mia answers, then they go quiet
    db.tables.whatsapp_messages.push(msg('inbound', NOW + H), msg('outbound', NOW + H + 2 * MIN))
    for (const later of [NOW + 15 * MIN, NOW + 5 * H, NOW + 24 * H]) {
      const res = await runTrialDoneOutreach(db, { nowMs: later })
      expect(res.followups).toBe(0)
      expect(res.reasons).toEqual({ already_followed_up: 1 })
    }
    expect(m.sendTemplateMessage).toHaveBeenCalledTimes(1)
    expect(m.sendTextMessage).not.toHaveBeenCalled()
    expect(m.composeAgentText).not.toHaveBeenCalled()
    expect(outreach(db, C1).closed_at).toBeNull()
  })

  it('a second runner losing the follow-up claim sends nothing', async () => {
    const db = makeDb(followupTables({ openerAt: NOW - 22 * H }))
    const [a, b] = await Promise.all([
      runTrialDoneOutreach(db, { nowMs: NOW }),
      runTrialDoneOutreach(db, { nowMs: NOW }),
    ])
    expect(m.sendTemplateMessage).toHaveBeenCalledTimes(1)
    expect(a.followups + b.followups).toBe(1)
    expect({ ...a.reasons, ...b.reasons }).toEqual({ claimed: 1 })
  })

  it('a follow-up claim inside the lease is not taken; past it, it is', async () => {
    const rows = [openedRow(C1, NOW - 22 * H, { followup_kind: 'template', followup_claimed_at: iso(NOW - 29 * MIN) })]
    const db = makeDb(followupTables({ rows }))
    const held = await runTrialDoneOutreach(db, { nowMs: NOW })
    expect(held.reasons).toEqual({ claimed: 1 })
    expect(m.sendTemplateMessage).not.toHaveBeenCalled()

    const taken = await runTrialDoneOutreach(db, { nowMs: NOW + 2 * MIN })
    expect(taken.followups).toBe(1)
    expect(outreach(db, C1)).toMatchObject({ followup_claimed_at: iso(NOW + 2 * MIN), followup_sent_at: iso(NOW + 2 * MIN) })
  })

  it('past opener + 30h with no reply the row is closed window_passed, never sent', async () => {
    const db = makeDb(followupTables({ openerAt: NOW - 30 * H - MIN }))
    const res = await runTrialDoneOutreach(db, { nowMs: NOW })
    expect(m.sendTemplateMessage).not.toHaveBeenCalled()
    expect(res.reasons).toEqual({ window_passed: 1 })
    expect(outreach(db, C1)).toMatchObject({ closed_at: iso(NOW), closed_reason: 'window_passed' })
    // no eligibility read is needed to close a passed window
    expect(m.trialEligibility).not.toHaveBeenCalled()
  })

  it('past their last message + 20h the nudge window is closed window_passed', async () => {
    const lastIn = NOW - 20 * H - MIN
    const db = makeDb(followupTables({ openerAt: NOW - 25 * H, messages: [msg('inbound', lastIn), msg('outbound', lastIn + MIN)] }))
    const res = await runTrialDoneOutreach(db, { nowMs: NOW })
    expect(res.reasons).toEqual({ window_passed: 1 })
    expect(outreach(db, C1).closed_reason).toBe('window_passed')
    expect(m.composeAgentText).not.toHaveBeenCalled()
  })

  it('unapproved follow-up template skips without closing or claiming', async () => {
    const tables = followupTables({ openerAt: NOW - 22 * H })
    tables.whatsapp_templates.find((t) => t.name === 'hatch_trial_done_followup').status = 'REJECTED'
    const db = makeDb(tables)
    const res = await runTrialDoneOutreach(db, { nowMs: NOW })
    expect(res.reasons).toEqual({ template_not_approved: 1 })
    expect(outreach(db, C1)).toMatchObject({ followup_claimed_at: null, followup_kind: null, closed_at: null })
  })

  it('the follow-up template name is read from the settings', async () => {
    const tables = followupTables({ openerAt: NOW - 22 * H, location: hatchLocation({ trial_done: { followup_template: 'my_followup' } }) })
    tables.whatsapp_templates.push({ ...tables.whatsapp_templates[1], name: 'my_followup' })
    const db = makeDb(tables)
    await runTrialDoneOutreach(db, { nowMs: NOW })
    expect(m.sendTemplateMessage.mock.calls[0][1]).toBe('my_followup')
  })

  it('the frequency cap defers the template, not the in-window nudge', async () => {
    const location = hatchLocation({}, { comms_frequency_cap: { enabled: true, min_hours_between: 24 } })
    // the opener stamped the touch
    const capped = makeDb(followupTables({ openerAt: NOW - 22 * H, location, contacts: [contactRow(C1, { last_marketing_touch_at: iso(NOW - 22 * H) })] }))
    const res = await runTrialDoneOutreach(capped, { nowMs: NOW })
    expect(res.reasons).toEqual({ frequency_capped: 1 })
    expect(outreach(capped, C1)).toMatchObject({ followup_claimed_at: null, closed_at: null })

    const lastIn = NOW - 3 * H
    const nudge = makeDb(followupTables({
      openerAt: NOW - 10 * H, location, contacts: [contactRow(C1, { last_marketing_touch_at: iso(NOW - 10 * H) })],
      messages: [msg('inbound', lastIn), msg('outbound', lastIn + MIN)],
    }))
    const res2 = await runTrialDoneOutreach(nudge, { nowMs: NOW })
    expect(res2.followups).toBe(1)
    expect(outreach(nudge, C1).followup_kind).toBe('nudge')
  })

  it('test mode (agent not enabled) follows up only to the test phones', async () => {
    const contacts = [contactRow(C1), contactRow(C3)]
    const location = hatchLocation({ enabled: false, test_mode: true, test_phones: [contactRow(C3).wa_phone] })
    const db = makeDb(followupTables({ openerAt: NOW - 22 * H, contacts, location }))
    const res = await runTrialDoneOutreach(db, { nowMs: NOW })
    expect(res.followups).toBe(1)
    expect(m.sendTemplateMessage.mock.calls[0][0]).toBe(contactRow(C3).wa_phone)
    expect(res.reasons).toEqual({ test_allowlist: 1 })
    expect(outreach(db, C1)).toMatchObject({ followup_claimed_at: null, closed_at: null })
  })

  it('a nudge waits while the thread is handed off or paused', async () => {
    const lastIn = NOW - 3 * H
    const tables = followupTables({ openerAt: NOW - 10 * H, messages: [msg('inbound', lastIn), msg('outbound', lastIn + MIN, { source: 'operator' })] })
    tables.whatsapp_conversations[0].agent_paused_at = iso(NOW - 2 * H)
    const db = makeDb(tables)
    const res = await runTrialDoneOutreach(db, { nowMs: NOW })
    expect(res.reasons).toEqual({ mia_not_active: 1 })
    expect(m.composeAgentText).not.toHaveBeenCalled()
    expect(outreach(db, C1)).toMatchObject({ followup_claimed_at: null, closed_at: null })
  })

  it('a nudge Mia cannot compose releases the claim for the next tick', async () => {
    m.composeAgentText = vi.fn(async () => ({ error: 'model_http_529' }))
    const lastIn = NOW - 3 * H
    const db = makeDb(followupTables({ openerAt: NOW - 10 * H, messages: [msg('inbound', lastIn), msg('outbound', lastIn + MIN)] }))
    const res = await runTrialDoneOutreach(db, { nowMs: NOW })
    expect(res.reasons).toEqual({ nudge_compose_failed: 1 })
    expect(m.sendTextMessage).not.toHaveBeenCalled()
    expect(outreach(db, C1)).toMatchObject({ followup_claimed_at: null, followup_kind: null, followup_sent_at: null, closed_at: null })
  })

  it('a nudge Mia skips (nothing open) closes the row', async () => {
    m.composeAgentText = vi.fn(async () => ({ text: '[[SKIP]]' }))
    const lastIn = NOW - 3 * H
    const db = makeDb(followupTables({ openerAt: NOW - 10 * H, messages: [msg('inbound', lastIn), msg('outbound', lastIn + MIN)] }))
    const res = await runTrialDoneOutreach(db, { nowMs: NOW })
    expect(res.reasons).toEqual({ nothing_open: 1 })
    expect(m.sendTextMessage).not.toHaveBeenCalled()
    expect(outreach(db, C1)).toMatchObject({ closed_at: iso(NOW), closed_reason: 'nothing_open', followup_sent_at: null })
  })

  it('a nudge send that throws releases the claim; a number refusal is no_number', async () => {
    const lastIn = NOW - 3 * H
    const setup = () => makeDb(followupTables({ openerAt: NOW - 10 * H, messages: [msg('inbound', lastIn), msg('outbound', lastIn + MIN)] }))

    m.sendTextMessage = vi.fn(async () => { throw new Error('(#131047) Re-engagement message') })
    const a = setup()
    expect((await runTrialDoneOutreach(a, { nowMs: NOW })).reasons).toEqual({ send_failed: 1 })
    expect(outreach(a, C1)).toMatchObject({ followup_claimed_at: null, followup_kind: null })

    m.sendTextMessage = vi.fn(async () => { throw new WhatsAppNumberMissingError(HATCH) })
    const b = setup()
    expect((await runTrialDoneOutreach(b, { nowMs: NOW })).reasons).toEqual({ no_number: 1 })
    expect(outreach(b, C1).followup_claimed_at).toBeNull()

    m.sendTextMessage = vi.fn(async () => ({ messageId: null }))
    const c = setup()
    expect((await runTrialDoneOutreach(c, { nowMs: NOW })).reasons).toEqual({ send_failed: 1 })
    expect(outreach(c, C1).followup_claimed_at).toBeNull()
  })

  it('a failed template send releases the follow-up claim', async () => {
    m.sendTemplateMessage = vi.fn(async () => ({ messageId: null }))
    const db = makeDb(followupTables({ openerAt: NOW - 22 * H }))
    const res = await runTrialDoneOutreach(db, { nowMs: NOW })
    expect(res.reasons).toEqual({ send_failed: 1 })
    expect(outreach(db, C1)).toMatchObject({ followup_claimed_at: null, followup_kind: null, followup_sent_at: null })
    expect(db.tables.activities).toEqual([])
  })

  it('an unreadable thread skips this tick: never sent, never closed', async () => {
    const db = makeDb(followupTables({ openerAt: NOW - 22 * H }), {
      answer: (q) => (q.table === 'whatsapp_messages' && q.op === 'select' ? { data: null, error: { message: 'timeout' } } : undefined),
    })
    const res = await runTrialDoneOutreach(db, { nowMs: NOW })
    expect(res.reasons).toEqual({ thread_read_failed: 1 })
    expect(m.sendTemplateMessage).not.toHaveBeenCalled()
    expect(outreach(db, C1)).toMatchObject({ closed_at: null, followup_claimed_at: null })
  })

  it('no thread at the studio yet means no reply: the template', async () => {
    const tables = followupTables({ openerAt: NOW - 22 * H })
    tables.whatsapp_conversations = []
    const db = makeDb(tables)
    const res = await runTrialDoneOutreach(db, { nowMs: NOW })
    expect(res.followups).toBe(1)
    expect(m.getOrCreateConversation).toHaveBeenCalledWith(db, expect.objectContaining({ id: C1 }), HATCH)
  })

  it('a follow-up counts against the daily cap', async () => {
    const contacts = [contactRow(C1), contactRow(C2)]
    const location = hatchLocation({ trial_done: { daily_cap: 1 } })
    const db = makeDb(followupTables({ openerAt: NOW - 22 * H, contacts, location }))
    const res = await runTrialDoneOutreach(db, { nowMs: NOW })
    expect(res.followups).toBe(1)
    expect(res.reasons).toEqual({ daily_cap: 1 })
  })

  it('the follow-up sent-stamp is judged by its rows: zero rows is logged loudly', async () => {
    const db = makeDb(followupTables({ openerAt: NOW - 22 * H }), {
      answer: (q) => (q.table === 'trial_done_outreach' && q.op === 'update' && q.patch.followup_sent_at ? { data: [], error: null } : undefined),
    })
    const res = await runTrialDoneOutreach(db, { nowMs: NOW })
    expect(res.followups).toBe(1)
    const stamp = db.log.find((q) => q.table === 'trial_done_outreach' && q.op === 'update' && q.patch.followup_sent_at)
    expect(stamp.returning).toBe(true)
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('[trial-done] follow-up sent but not stamped'),
      expect.objectContaining({ rowId: 'r-1', waMessageId: 'wamid.1', rows: 0 }),
    )
  })
})

// ── TRIALDONE.5 — hardening of the TRIALDONE.4 review findings ─────────
describe('runTrialDoneOutreach — hardening', () => {
  it('the opener sent-stamp is judged by its rows: zero rows is logged loudly', async () => {
    const db = makeDb(baseTables(), {
      answer: (q) => (q.table === 'trial_done_outreach' && q.op === 'update' && q.patch.opener_sent_at ? { data: [], error: null } : undefined),
    })
    const res = await runTrialDoneOutreach(db, { nowMs: NOW })
    expect(res.openers).toBe(1)
    const stamp = db.log.find((q) => q.table === 'trial_done_outreach' && q.op === 'update' && q.patch.opener_sent_at)
    expect(stamp.returning).toBe(true)
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('[trial-done] opener sent but not stamped'),
      expect.objectContaining({ contactId: C1, waMessageId: 'wamid.1', rows: 0 }),
    )
  })

  it('a throw recording the message still writes the activity and the marketing touch', async () => {
    const db = makeDb(baseTables(), {
      answer: (q) => {
        if (q.table === 'whatsapp_messages' && q.op === 'insert') throw new Error('socket hang up')
        return undefined
      },
    })
    const res = await runTrialDoneOutreach(db, { nowMs: NOW })
    expect(res).toMatchObject({ openers: 1, skipped: 0 })
    expect(db.tables.activities).toEqual([expect.objectContaining({ contact_id: C1, type: 'agent_trial_done' })])
    expect(db.tables.contacts.find((c) => c.id === C1).last_marketing_touch_at).toBe(iso(NOW))
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('[trial-done] message not recorded in the inbox'),
      expect.objectContaining({ contactId: C1, waMessageId: 'wamid.1' }),
    )
  })

  it.each([
    ['a string', 'not-a-list'],
    ['an object', { id: C1 }],
    ['a list with no valid id', ['', 'nope', 42, null]],
  ])('only_contact_ids that is %s skips the studio (test_list_invalid), never everyone', async (_label, value) => {
    const location = hatchLocation({ trial_done: { only_contact_ids: value } })
    const db = makeDb(baseTables({ location }))
    const res = await runTrialDoneOutreach(db, { nowMs: NOW })
    expect(m.sendTemplateMessage).not.toHaveBeenCalled()
    expect(res.reasons).toEqual({ test_list_invalid: 1 })
    expect(tablesRead(db)).not.toContain('deals')
  })

  it('only_contact_ids keeps its valid ids and drops the rest', async () => {
    const contacts = [contactRow(C1), contactRow(C3, { first_name: 'Test' })]
    people = new Map(contacts.map((c) => [c.id, trialFinisher()]))
    const location = hatchLocation({ trial_done: { only_contact_ids: ['nope', C3, ''] } })
    const db = makeDb(baseTables({ location, contacts }))
    const res = await runTrialDoneOutreach(db, { nowMs: NOW })
    expect(res.openers).toBe(1)
    expect(m.sendTemplateMessage.mock.calls[0][0]).toBe(contactRow(C3).wa_phone)
  })

  it('an empty only_contact_ids is everyone (the operator listed none)', async () => {
    const location = hatchLocation({ trial_done: { only_contact_ids: [] } })
    const db = makeDb(baseTables({ location }))
    const res = await runTrialDoneOutreach(db, { nowMs: NOW })
    expect(res.openers).toBe(1)
  })
})

// ── TRIALDONE.7 — the final whole-branch review's findings ────────────
describe('runTrialDoneOutreach — final review fixes (TRIALDONE.7)', () => {
  const ORG = 'org-1'
  // Mia's brief for C1 at Hatch, read through the same fake.
  const brief = (db, nowMs = NOW) => trialDoneLineFor(db, {
    locationId: HATCH, contactId: C1, nowMs, settings: { trial_done: { enabled: true } }, studioName: 'Hatch', zone: 'Europe/Dublin',
  })

  // Finding 1 — a person who left the trial_done column after the opener.
  describe('the sweep of opened rows off the column', () => {
    beforeEach(() => {
      people = new Map([[C1, trialFinisher(NOW - 30 * H)], [C2, trialFinisher(NOW - 30 * H)]])
    })

    it('bought at the desk after the opener: row closed purchased, no brief', async () => {
      eligibility.set(C1, ['trial_used', 'membership_history'])
      const tables = followupTables({ openerAt: NOW - 10 * H, messages: [msg('inbound', NOW - 9 * H), msg('outbound', NOW - 9 * H + MIN)] })
      tables.deals[0].status = 'won' // the board moved them off the column
      const db = makeDb(tables)
      expect(await brief(db)).not.toBeNull() // open row: the brief is live before the sweep

      const res = await runTrialDoneOutreach(db, { nowMs: NOW })
      expect(res.reasons).toEqual({ purchased: 1 })
      expect(outreach(db, C1)).toMatchObject({ closed_at: iso(NOW), closed_reason: 'purchased', updated_at: iso(NOW) })
      expect(m.sendTemplateMessage).not.toHaveBeenCalled()
      expect(m.sendTextMessage).not.toHaveBeenCalled()
      expect(m.trialEligibility).toHaveBeenCalledWith(db, HATCH, expect.objectContaining({ contactId: C1 }))
      expect(await brief(db)).toBeNull()
    })

    it('left the column while still eligible: closed left_trial_done', async () => {
      const tables = followupTables({ openerAt: NOW - 10 * H })
      tables.deals[0].stage_id = 'st-2'
      const db = makeDb(tables)
      const res = await runTrialDoneOutreach(db, { nowMs: NOW })
      expect(res.reasons).toEqual({ left_trial_done: 1 })
      expect(outreach(db, C1)).toMatchObject({ closed_at: iso(NOW), closed_reason: 'left_trial_done' })
      expect(m.sendTemplateMessage).not.toHaveBeenCalled()
      expect(await brief(db)).toBeNull()
    })

    it('every other verdict closes with its own reason (staff, active elsewhere, no consent as opted_out)', async () => {
      const contacts = [contactRow(C1, { email: 'coach@example.com' }), contactRow(C2), contactRow(C3)]
      people = new Map(contacts.map((c) => [c.id, trialFinisher(NOW - 30 * H)]))
      activeElsewhere = { ok: true, contactIds: new Set([C2]), studios: [] }
      const tables = followupTables({ openerAt: NOW - 10 * H, contacts })
      tables.contact_location_preferences.find((p) => p.contact_id === C3).whatsapp_marketing = false
      tables.deals = []
      const db = makeDb(tables)
      const res = await runTrialDoneOutreach(db, { nowMs: NOW })
      expect(res.reasons).toEqual({ staff: 1, active_elsewhere: 1, opted_out: 1 })
      expect(outreach(db, C1).closed_reason).toBe('staff')
      expect(outreach(db, C2).closed_reason).toBe('active_elsewhere')
      expect(outreach(db, C3).closed_reason).toBe('opted_out')
    })

    it('reads only open rows whose opener went, paginated and ordered', async () => {
      const tables = followupTables({ openerAt: NOW - 10 * H })
      tables.deals = []
      tables.trial_done_outreach.push(
        { ...openedRow(C2, NOW - 10 * H), id: 'r-closed', closed_at: iso(NOW - H), closed_reason: 'window_passed' },
        { ...openedRow(C3, NOW - 10 * H), id: 'r-unsent', opener_claimed_at: null, opener_sent_at: null },
      )
      const db = makeDb(tables)
      const res = await runTrialDoneOutreach(db, { nowMs: NOW })
      expect(res.reasons).toEqual({ left_trial_done: 1 })
      const sweep = db.log.find((q) => q.table === 'trial_done_outreach' && q.op === 'select' && q.filters.some((f) => f[0] === 'not'))
      expect(sweep.filters).toEqual(expect.arrayContaining([
        ['eq', 'location_id', HATCH], ['is', 'closed_at', null], ['not', 'opener_sent_at', 'is', null],
      ]))
      expect(sweep.order).toEqual(['id', { ascending: true }])
      expect(sweep.range).toEqual([0, 999])
      expect(tables.trial_done_outreach.find((r) => r.id === 'r-closed').closed_reason).toBe('window_passed')
      expect(tables.trial_done_outreach.find((r) => r.id === 'r-unsent').closed_at).toBeNull()
    })

    it('a failed sweep read defers: nothing closed, the candidates still run', async () => {
      const tables = followupTables({ openerAt: NOW - 10 * H, contacts: [contactRow(C1), contactRow(C2)] })
      tables.deals = tables.deals.filter((d) => d.contact_id === C2)
      tables.trial_done_outreach = [openedRow(C1, NOW - 10 * H)] // C2 has no row yet: a candidate, stale trigger
      const db = makeDb(tables, {
        answer: (q) => (q.table === 'trial_done_outreach' && q.op === 'select' && q.filters.some((f) => f[0] === 'not')
          ? { data: null, error: { message: 'timeout' } } : undefined),
      })
      const res = await runTrialDoneOutreach(db, { nowMs: NOW })
      expect(res.reasons).toEqual({ sweep_read_failed: 1, stale: 1 })
      expect(outreach(db, C1)).toMatchObject({ closed_at: null, closed_reason: null })
    })

    it('a failed eligibility read for a swept row defers, never closes', async () => {
      m.trialEligibility = vi.fn(async () => ({ success: false, error: 'boom' }))
      const tables = followupTables({ openerAt: NOW - 10 * H })
      tables.deals = []
      const db = makeDb(tables)
      const res = await runTrialDoneOutreach(db, { nowMs: NOW })
      expect(res.reasons).toEqual({ eligibility_unreadable: 1 })
      expect(outreach(db, C1).closed_at).toBeNull()
    })

    it('with only_contact_ids set, a row of a contact outside the list is never swept', async () => {
      const location = hatchLocation({ trial_done: { only_contact_ids: [C3] } })
      const tables = followupTables({ openerAt: NOW - 10 * H, location })
      tables.deals = []
      const db = makeDb(tables)
      const res = await runTrialDoneOutreach(db, { nowMs: NOW })
      expect(res.reasons).toEqual({})
      expect(outreach(db, C1).closed_at).toBeNull()
    })
  })

  // Finding 2 — Mia may decline to nudge.
  it('declined: Mia answers [[SKIP]], the row closes nothing_open and nothing is sent', async () => {
    m.composeAgentText = vi.fn(async () => ({ text: '[[SKIP]]' }))
    const lastIn = NOW - 3 * H
    const db = makeDb(followupTables({
      openerAt: NOW - 10 * H,
      messages: [msg('inbound', lastIn, { body: 'No thanks, not for me right now' }), msg('outbound', lastIn + MIN, { body: 'No problem at all!' })],
    }))
    const res = await runTrialDoneOutreach(db, { nowMs: NOW })
    expect(res.reasons).toEqual({ nothing_open: 1 })
    expect(m.composeAgentText.mock.calls[0][0].instruction).toContain(
      'If they declined, said they will decide later, or there is nothing open to follow up on, reply with exactly [[SKIP]] and nothing else.')
    expect(m.sendTextMessage).not.toHaveBeenCalled()
    expect(m.sendTemplateMessage).not.toHaveBeenCalled()
    expect(outreach(db, C1)).toMatchObject({ closed_at: iso(NOW), closed_reason: 'nothing_open', followup_sent_at: null })
  })

  // Finding 3 — a reply filed at another studio of the organisation.
  describe('a reply on another studio\'s thread', () => {
    beforeEach(() => {
      people = new Map([[C1, trialFinisher(NOW - 30 * H)]])
    })
    const orgTables = () => {
      const tables = followupTables({ openerAt: NOW - 22 * H })
      tables.locations[0].organization_id = ORG
      tables.locations[1].organization_id = ORG
      return tables
    }

    it('reply filed at Stillorgan after the opener: no template follow-up', async () => {
      const tables = orgTables()
      tables.whatsapp_conversations.push({ id: 'conv-s', location_id: STILL, wa_phone: contactRow(C1).wa_phone, contact_id: C1, agent_active: true })
      tables.whatsapp_messages.push(msg('inbound', NOW - 5 * H, { conversation_id: 'conv-s', location_id: STILL }))
      const db = makeDb(tables)
      const res = await runTrialDoneOutreach(db, { nowMs: NOW })
      expect(m.sendTemplateMessage).not.toHaveBeenCalled()
      expect(res.reasons).toEqual({ awaiting_mia: 1 })
      expect(outreach(db, C1)).toMatchObject({ followup_claimed_at: null, closed_at: null })
      // the inbound read spans the organisation's threads for this contact or number
      const convRead = db.log.find((q) => q.table === 'whatsapp_conversations' && q.filters.some((f) => f[0] === 'in'))
      expect(convRead.filters).toEqual(expect.arrayContaining([
        ['in', 'location_id', expect.arrayContaining([HATCH, STILL])],
        ['or', `contact_id.eq.${C1},wa_phone.eq.${contactRow(C1).wa_phone}`],
      ]))
    })

    it('a Stillorgan thread found by contact_id alone counts too', async () => {
      const tables = orgTables()
      tables.whatsapp_conversations.push({ id: 'conv-s', location_id: STILL, wa_phone: '353860000000', contact_id: C1, agent_active: true })
      tables.whatsapp_messages.push(msg('inbound', NOW - 5 * H, { conversation_id: 'conv-s', location_id: STILL }))
      const res = await runTrialDoneOutreach(makeDb(tables), { nowMs: NOW })
      expect(m.sendTemplateMessage).not.toHaveBeenCalled()
      expect(res.reasons).toEqual({ awaiting_mia: 1 })
    })

    it('a thread at a studio of another organisation does not count', async () => {
      const tables = orgTables()
      tables.locations.push({ id: 'loc-other', name: 'Elsewhere', organization_id: 'org-2', membership_source: 'glofox', active: true, settings: {} })
      tables.whatsapp_conversations.push({ id: 'conv-x', location_id: 'loc-other', wa_phone: contactRow(C1).wa_phone, contact_id: C1, agent_active: true })
      tables.whatsapp_messages.push(msg('inbound', NOW - 5 * H, { conversation_id: 'conv-x', location_id: 'loc-other' }))
      const res = await runTrialDoneOutreach(makeDb(tables), { nowMs: NOW })
      expect(res.followups).toBe(1)
      expect(m.sendTemplateMessage.mock.calls[0][1]).toBe('hatch_trial_done_followup')
    })

    it('Mia\'s last outbound and the nudge stay on the studio\'s own thread', async () => {
      const tables = orgTables()
      const lastIn = NOW - 3 * H
      tables.trial_done_outreach = [openedRow(C1, NOW - 10 * H)]
      tables.whatsapp_conversations.push({ id: 'conv-s', location_id: STILL, wa_phone: contactRow(C1).wa_phone, contact_id: C1, agent_active: true })
      // she answered on Stillorgan's thread only: not an answer on Hatch's
      tables.whatsapp_messages.push(
        msg('inbound', lastIn, { conversation_id: 'conv-s', location_id: STILL }),
        msg('outbound', lastIn + MIN, { conversation_id: 'conv-s', location_id: STILL }),
      )
      const db = makeDb(tables)
      const res = await runTrialDoneOutreach(db, { nowMs: NOW })
      expect(res.reasons).toEqual({ awaiting_mia: 1 })
      // answered on Hatch's thread: the nudge goes there
      db.tables.whatsapp_messages.push(msg('outbound', lastIn + 2 * MIN))
      const res2 = await runTrialDoneOutreach(db, { nowMs: NOW + MIN })
      expect(res2.followups).toBe(1)
      expect(db.tables.whatsapp_messages.at(-1)).toMatchObject({ conversation_id: CONV1, location_id: HATCH, wa_message_id: 'wamid.text' })
    })

    it('an unreadable organisation studio list skips this tick: never sent, never closed', async () => {
      const tables = orgTables()
      const db = makeDb(tables, {
        answer: (q) => (q.table === 'locations' && q.filters.some((f) => f[0] === 'eq' && f[1] === 'organization_id')
          ? { data: null, error: { message: 'timeout' } } : undefined),
      })
      const res = await runTrialDoneOutreach(db, { nowMs: NOW })
      expect(res.reasons).toEqual({ thread_read_failed: 1 })
      expect(m.sendTemplateMessage).not.toHaveBeenCalled()
      expect(outreach(db, C1)).toMatchObject({ closed_at: null, followup_claimed_at: null })
    })
  })

  // Finding 4 — the sale path must be on.
  it.each([
    ['the chat-actions switch off', hatchLocation({ un1t_chat_actions_enabled: false })],
    ['the switch absent', (() => { const l = hatchLocation(); delete l.settings.customer_agent.un1t_chat_actions_enabled; return l })()],
    ['un1t writes off', hatchLocation({}, { un1t_online: { writes_enabled: false } })],
  ])('%s: the studio is skipped sale_path_off before any candidate read', async (_label, location) => {
    const db = makeDb(baseTables({ location }))
    const res = await runTrialDoneOutreach(db, { nowMs: NOW })
    expect(res.reasons).toEqual({ sale_path_off: 1 })
    expect(m.sendTemplateMessage).not.toHaveBeenCalled()
    expect(tablesRead(db)).not.toContain('deals')
    // TRIALDONE.8 — the buyer sweep's read of opened rows is the only outreach read
    expect(db.log.filter((q) => q.table === 'trial_done_outreach').every((q) => q.op === 'select' && q.filters.some((f) => f[0] === 'not'))).toBe(true)
  })

  // Finding 7 — the stored trigger times a row whose evidence has none now.
  it('no trigger in the evidence: the stored trigger_at still closes the row stale', async () => {
    people = new Map([[C1, { ...trialFinisher(), evidence: {} }]])
    const tables = baseTables()
    tables.trial_done_outreach = [{
      id: 'r-1', location_id: HATCH, contact_id: C1, deal_id: 'deal-1', trigger_kind: 'three_attended', trigger_at: iso(NOW - 25 * H),
      opener_claimed_at: null, opener_sent_at: null, opener_wa_message_id: null,
      followup_kind: null, followup_claimed_at: null, followup_sent_at: null, followup_wa_message_id: null,
      closed_at: null, closed_reason: null, updated_at: iso(NOW - 25 * H),
    }]
    const db = makeDb(tables)
    const res = await runTrialDoneOutreach(db, { nowMs: NOW })
    expect(res.reasons).toEqual({ stale: 1 })
    expect(outreach(db, C1)).toMatchObject({ closed_at: iso(NOW), closed_reason: 'stale' })
    expect(m.sendTemplateMessage).not.toHaveBeenCalled()
  })

  it('no trigger in the evidence: inside the window the stored trigger_at times the opener', async () => {
    people = new Map([[C1, { ...trialFinisher(), evidence: {} }]])
    const tables = baseTables()
    tables.trial_done_outreach = [{
      id: 'r-1', location_id: HATCH, contact_id: C1, deal_id: 'deal-1', trigger_kind: 'three_attended', trigger_at: iso(NOW - 2 * H - MIN),
      opener_claimed_at: null, opener_sent_at: null, opener_wa_message_id: null,
      followup_kind: null, followup_claimed_at: null, followup_sent_at: null, followup_wa_message_id: null,
      closed_at: null, closed_reason: null, updated_at: iso(NOW - 3 * H),
    }]
    const db = makeDb(tables)
    expect((await runTrialDoneOutreach(db, { nowMs: NOW - 2 * MIN })).reasons).toEqual({ too_soon: 1 })
    const res = await runTrialDoneOutreach(db, { nowMs: NOW })
    expect(res.openers).toBe(1)
  })
})

// TRIALDONE.8 — the buyer sweep runs in its own pass, ahead of every send-only
// gate (sale path, Mia on, daytime and quiet hours, a number, the daily cap):
// it sends nothing, so none of them apply to it.
describe('runTrialDoneOutreach — the buyer sweep runs in its own pass (TRIALDONE.8)', () => {
  const NIGHT = Date.UTC(2026, 9, 20, 21, 0, 0) // 22:00 Dublin (IST)
  const brief = (db, nowMs) => trialDoneLineFor(db, {
    locationId: HATCH, contactId: C1, nowMs, settings: { trial_done: { enabled: true } }, studioName: 'Hatch', zone: 'Europe/Dublin',
  })
  // C1 got the opener 10 h before `nowMs`, then bought: the board moved the deal off the column.
  function buyer(nowMs, { location } = {}) {
    people = new Map([[C1, trialFinisher(nowMs - 30 * H)]])
    eligibility.set(C1, ['trial_used', 'membership_history'])
    const tables = followupTables({ openerAt: nowMs - 10 * H, location })
    tables.deals[0].status = 'won'
    return tables
  }
  const expectClosedPurchased = (db, nowMs) => {
    expect(outreach(db, C1)).toMatchObject({ closed_at: iso(nowMs), closed_reason: 'purchased', updated_at: iso(nowMs) })
    expect(m.sendTemplateMessage).not.toHaveBeenCalled()
    expect(m.sendTextMessage).not.toHaveBeenCalled()
  }

  it('a buyer is closed out at 22:00 (outside daytime)', async () => {
    const db = makeDb(buyer(NIGHT))
    expect(await brief(db, NIGHT)).not.toBeNull()
    const res = await runTrialDoneOutreach(db, { nowMs: NIGHT })
    expect(res.reasons).toEqual({ purchased: 1, outside_daytime: 1 })
    expectClosedPurchased(db, NIGHT)
    expect(await brief(db, NIGHT)).toBeNull()
  })

  it('a buyer is closed out when the daily cap is already reached', async () => {
    const tables = buyer(NOW, { location: hatchLocation({ trial_done: { daily_cap: 1 } }) })
    tables.activities.push({ id: 'a1', location_id: HATCH, type: 'agent_trial_done', created_at: iso(NOW - 3 * H) })
    const db = makeDb(tables)
    const res = await runTrialDoneOutreach(db, { nowMs: NOW })
    expect(res.reasons).toEqual({ purchased: 1, daily_cap: 1 })
    expectClosedPurchased(db, NOW)
  })

  it('a buyer is closed out when the sale path is off but trial_done is on', async () => {
    const db = makeDb(buyer(NOW, { location: hatchLocation({ un1t_chat_actions_enabled: false }) }))
    const res = await runTrialDoneOutreach(db, { nowMs: NOW })
    expect(res.reasons).toEqual({ sale_path_off: 1, purchased: 1 })
    expectClosedPurchased(db, NOW)
  })

  it.each([
    ['Mia off', () => hatchLocation({ enabled: false, test_mode: false }), {}],
    ['operator quiet hours', () => hatchLocation({ quiet_hours: { start: '13:00', end: '15:00' } }), { operator_quiet_hours: 1 }],
  ])('a buyer is closed out with %s too', async (_label, location, gateReason) => {
    const db = makeDb(buyer(NOW, { location: location() }))
    const res = await runTrialDoneOutreach(db, { nowMs: NOW })
    expect(res.reasons).toEqual({ purchased: 1, ...gateReason })
    expectClosedPurchased(db, NOW)
  })

  it('a buyer is closed out when no number is switched on at the studio', async () => {
    const tables = buyer(NOW)
    tables.location_whatsapp_numbers = []
    const db = makeDb(tables)
    const res = await runTrialDoneOutreach(db, { nowMs: NOW })
    expect(res.reasons).toEqual({ purchased: 1, no_number: 1 })
    expectClosedPurchased(db, NOW)
  })

  it('trial_done off: the sweep never runs', async () => {
    const db = makeDb(buyer(NOW, { location: hatchLocation({ trial_done: { enabled: false } }) }))
    const res = await runTrialDoneOutreach(db, { nowMs: NOW })
    expect(res).toEqual({ openers: 0, followups: 0, skipped: 0, reasons: {} })
    expect(tablesRead(db)).toEqual(['locations'])
    expect(m.membershipReadsFor).not.toHaveBeenCalled()
    expect(m.trialEligibility).not.toHaveBeenCalled()
    expect(outreach(db, C1)).toMatchObject({ closed_at: null, closed_reason: null })
  })

  it('deals read fails: nothing is closed', async () => {
    const db = makeDb(buyer(NOW), {
      answer: (q) => (q.table === 'deals' && q.op === 'select' ? { data: null, error: { message: 'timeout' } } : undefined),
    })
    const res = await runTrialDoneOutreach(db, { nowMs: NOW })
    // the sweep defers, and the send pass (which reuses the same failed read) skips the studio as before
    expect(res.reasons).toEqual({ sweep_read_failed: 1, deals_read_failed: 1 })
    expect(db.log.filter((q) => q.table === 'deals')).toHaveLength(1)
    expect(outreach(db, C1)).toMatchObject({ closed_at: null, closed_reason: null })
    expect(m.trialEligibility).not.toHaveBeenCalled()
    expect(m.sendTemplateMessage).not.toHaveBeenCalled()
  })

  it('deals read fails at night: the sweep defers (nothing closed) and the arm sees the read failure', async () => {
    const db = makeDb(buyer(NIGHT), {
      answer: (q) => (q.table === 'deals' && q.op === 'select' ? { data: null, error: { message: 'timeout' } } : undefined),
    })
    const res = await runTrialDoneOutreach(db, { nowMs: NIGHT })
    expect(res.reasons).toEqual({ sweep_read_failed: 1, outside_daytime: 1 })
    expect(outreach(db, C1)).toMatchObject({ closed_at: null, closed_reason: null })
  })

  it('the deals and the pipeline inputs are read once per studio per tick, shared by the sweep and the send pass', async () => {
    const tables = buyer(NOW)
    // C2 is a fresh trial finisher still on the column: the send pass's candidate
    tables.contacts.push(contactRow(C2))
    tables.contact_location_preferences.push({ contact_id: C2, location_id: HATCH, whatsapp_marketing: true })
    tables.deals.push({ id: 'deal-2', location_id: HATCH, contact_id: C2, stage_id: 'st-td', pipeline_id: 'pipe-h', status: 'open' })
    people.set(C2, trialFinisher())
    const db = makeDb(tables)
    const res = await runTrialDoneOutreach(db, { nowMs: NOW })
    expect(res.openers).toBe(1)
    expect(res.reasons).toEqual({ purchased: 1 })
    expect(db.log.filter((q) => q.table === 'deals')).toHaveLength(1)
    expect(db.log.filter((q) => q.table === 'pipelines')).toHaveLength(1)
    expect(m.pipelineInputs).toHaveBeenCalledTimes(1)
    expect(outreach(db, C1).closed_reason).toBe('purchased')
  })
})
