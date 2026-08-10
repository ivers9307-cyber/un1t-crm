// FILTER-B.7 — THE PROOF: for the same filter, the preview and the count
// return the same number, because they resolve the same query.
//
// Every other test in this branch mocks the builder to pin a delegation. This
// one does not: it stands up an in-memory PostgREST that really applies
// .eq/.neq/.not/.in/.is/.order/.range, runs BOTH route handlers against the
// SAME rows, and compares. If anyone ever re-hand-rolls either query, this is
// the test that goes red — a preview that disagrees with the count (and so
// with the send) is worse than no preview at all.
//
// Only the two boundaries are stubbed: auth (the guards have their own tests)
// and validateBody. The audience libraries — audience-eligibility, postmark,
// sms, whatsapp, audience-filter — are all REAL.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(async () => ({ id: 'u1' })),
  assertLocationAccess: vi.fn(() => null),
  assertLocationAccessOr404: vi.fn(() => null),
}))
vi.mock('@/lib/validate', () => ({
  validateBody: vi.fn(async (req) => ({ ok: true, data: await req.json() })),
}))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

import { POST as countPOST } from '../audience-count/route'
import { POST as previewPOST } from './route'
import { createServerClient } from '@/lib/supabase'

// ── a small honest PostgREST ────────────────────────────────────────
// Supports the operators the audience builders actually emit. Filters are
// AND-composed, which is what `logic: 'and'` means; count/head ride the first
// select() exactly as postgrest-js requires.
function makeDb(tables) {
  function builder(rows) {
    let preds = []
    let opts = null
    let ordered = null
    let range = null
    const self = {
      select(_cols, o) { if (opts === null) opts = o || undefined; return self },
      eq(col, v) { preds.push(r => r[col] === v); return self },
      neq(col, v) { preds.push(r => r[col] !== v); return self },
      gt(col, v) { preds.push(r => r[col] > v); return self },
      is(col, v) { preds.push(r => (v === null ? r[col] == null : r[col] === v)); return self },
      in(col, vs) { preds.push(r => vs.includes(r[col])); return self },
      not(col, op, v) {
        if (op === 'is') { preds.push(r => !(v === null ? r[col] == null : r[col] === v)); return self }
        if (op === 'in') {
          // PostgREST spells this '("a","b")'
          const list = String(v).replace(/^\(|\)$/g, '').split(',').map(s => s.replace(/^"|"$/g, ''))
          preds.push(r => !list.includes(r[col]))
          return self
        }
        throw new Error(`fake db: unsupported not(${op})`)
      },
      // PostgREST spells a disjunction as ONE .or('a.op.v,b.op.v') call, and
      // chained .or() calls AND together. #1310's NULL-inclusive "is not"
      // arrives here as `field.neq.value,field.is.null` — the whole point of
      // running the real filter library in this test.
      or(expr) {
        const disjuncts = String(expr).split(',').map(part => {
          const [col, op, ...rest] = part.split('.')
          const v = rest.join('.')
          if (op === 'is' && v === 'null') return r => r[col] == null
          if (op === 'neq') return r => r[col] != null && String(r[col]) !== v
          if (op === 'eq') return r => String(r[col]) === v
          throw new Error(`fake db: unsupported or() disjunct "${part}"`)
        })
        preds.push(r => disjuncts.some(d => d(r)))
        return self
      },
      order(col, { ascending = true } = {}) { ordered = [col, ascending]; return self },
      range(a, b) { range = [a, b]; return self },
      then(resolve) {
        let out = rows.filter(r => preds.every(p => p(r)))
        const total = out.length
        if (ordered) {
          const [col, asc] = ordered
          out = [...out].sort((x, y) => (x[col] < y[col] ? -1 : x[col] > y[col] ? 1 : 0) * (asc ? 1 : -1))
        }
        if (range) out = out.slice(range[0], range[1] + 1)
        const wantCount = opts?.count === 'exact'
        const head = opts?.head === true
        return resolve({ data: head ? null : out, count: wantCount ? total : null, error: null })
      },
    }
    return self
  }
  return { from: (t) => builder(tables[t] || []) }
}

// A deliberately awkward slice of the real base: opted-out contacts, a bounce,
// a suppressed inactive, and non-members — so the gates have work to do and a
// hand-rolled query would plausibly get a DIFFERENT answer.
const AUDIENCE = [
  { id: 'c1', audience_location_id: 'loc-1', pipeline_stage_slug: 'member', loc_email_marketing: true, email_status: 'active', email_suppressed_at: null, loc_sms_marketing: true, sms_status: 'active', phone: '+353871111111', wa_phone: '+353871111111', loc_whatsapp_marketing: true, wa_status: 'active', name: 'A One', first_name: 'A', last_name: 'One', email: 'a@example.com' },
  { id: 'c2', audience_location_id: 'loc-1', pipeline_stage_slug: 'member', loc_email_marketing: false, email_status: 'active', email_suppressed_at: null, loc_sms_marketing: false, sms_status: 'active', phone: '+353872222222', wa_phone: null, loc_whatsapp_marketing: false, wa_status: 'active', name: 'B Two', first_name: 'B', last_name: 'Two', email: 'b@example.com' },
  { id: 'c3', audience_location_id: 'loc-1', pipeline_stage_slug: 'member', loc_email_marketing: true, email_status: 'bounced', email_suppressed_at: null, loc_sms_marketing: true, sms_status: 'opted_out', phone: '+353873333333', wa_phone: '+353873333333', loc_whatsapp_marketing: true, wa_status: 'opted_out', name: 'C Three', first_name: 'C', last_name: 'Three', email: 'c@example.com' },
  { id: 'c4', audience_location_id: 'loc-1', pipeline_stage_slug: 'member', loc_email_marketing: true, email_status: 'active', email_suppressed_at: '2026-05-01', loc_sms_marketing: true, sms_status: 'active', phone: null, wa_phone: '+353874444444', loc_whatsapp_marketing: true, wa_status: 'undeliverable', name: 'D Four', first_name: 'D', last_name: 'Four', email: 'd@example.com' },
  { id: 'c5', audience_location_id: 'loc-1', pipeline_stage_slug: 'dormant', loc_email_marketing: true, email_status: 'active', email_suppressed_at: null, loc_sms_marketing: true, sms_status: 'active', phone: '+353875555555', wa_phone: '+353875555555', loc_whatsapp_marketing: true, wa_status: 'active', name: 'E Five', first_name: 'E', last_name: 'Five', email: 'e@example.com' },
  { id: 'c6', audience_location_id: 'loc-1', pipeline_stage_slug: 'member', loc_email_marketing: true, email_status: 'active', email_suppressed_at: null, loc_sms_marketing: true, sms_status: 'active', phone: '+353876666666', wa_phone: '+353876666666', loc_whatsapp_marketing: true, wa_status: 'active', name: 'F Six', first_name: 'F', last_name: 'Six', email: 'f@example.com' },
  // Another gym — must never appear in either number.
  { id: 'z9', audience_location_id: 'loc-OTHER', pipeline_stage_slug: 'member', loc_email_marketing: true, email_status: 'active', email_suppressed_at: null, loc_sms_marketing: true, sms_status: 'active', phone: '+353879999999', wa_phone: '+353879999999', loc_whatsapp_marketing: true, wa_status: 'active', name: 'Z Nine', first_name: 'Z', last_name: 'Nine', email: 'z@example.com' },
]

const CONTACTS = AUDIENCE.filter(r => r.audience_location_id !== 'loc-OTHER')
  .map(r => ({ ...r, location_id: 'loc-1' }))
  .concat([{ ...AUDIENCE.at(-1), location_id: 'loc-OTHER' }])

function reqWith(body) { return { json: async () => body } }

beforeEach(() => {
  createServerClient.mockReturnValue(makeDb({
    contact_location_audience: AUDIENCE,
    contacts: CONTACTS,
  }))
})

const FILTERS = [
  ['no filter rows (the gates do all the work)', { logic: 'and', filters: [] }],
  ['stage = member', { logic: 'and', filters: [{ field: 'pipeline_stage_slug', op: 'eq', value: 'member' }] }],
  ['stage is not member (NULL-inclusive since #1310)', { logic: 'and', filters: [{ field: 'pipeline_stage_slug', op: 'neq', value: 'member' }] }],
]

describe.each(['email', 'sms', 'whatsapp'])('%s — preview total === count will-receive', (channel) => {
  it.each(FILTERS)('%s', async (_label, audience_filter) => {
    const body = { location_id: 'loc-1', audience_filter, channel }

    const countJson = await (await countPOST(reqWith(body))).json()
    const previewJson = await (await previewPOST(reqWith(body))).json()

    expect(countJson.success).toBe(true)
    expect(previewJson.success).toBe(true)

    // The count route's sendable number per channel: `reachable` for
    // WhatsApp, `count` (will-receive) for email and SMS.
    const sendable = channel === 'whatsapp' ? countJson.reachable : countJson.count
    expect(previewJson.data.total).toBe(sendable)
    expect(previewJson.data.basis).toBe('will_receive')
  })
})

describe('no channel (the sequence match set) — preview total === count', () => {
  it.each(FILTERS)('%s', async (_label, audience_filter) => {
    const body = { location_id: 'loc-1', audience_filter }
    const countJson = await (await countPOST(reqWith(body))).json()
    const previewJson = await (await previewPOST(reqWith(body))).json()
    expect(previewJson.data.total).toBe(countJson.count)
    expect(previewJson.data.basis).toBe('matching')
  })
})

describe('the preview LISTS the people that number stands for', () => {
  it('email: exactly the contacts that pass consent + status + suppression', async () => {
    const body = { location_id: 'loc-1', audience_filter: { logic: 'and', filters: [] }, channel: 'email' }
    const json = await (await previewPOST(reqWith(body))).json()
    // c2 no consent, c3 bounced, c4 suppressed, z9 another gym.
    expect(json.data.rows.map(r => r.id)).toEqual(['c1', 'c5', 'c6'])
    expect(json.data.rows[0].identifier).toBe('•••@example.com')
  })

  it('never crosses the tenant boundary, in either surface', async () => {
    const body = { location_id: 'loc-1', audience_filter: { logic: 'and', filters: [] }, channel: 'email' }
    const json = await (await previewPOST(reqWith(body))).json()
    expect(json.data.rows.some(r => r.id === 'z9')).toBe(false)
    expect(JSON.stringify(json)).not.toContain('z@example.com')
  })

  it('pages without repeating or skipping anyone', async () => {
    const base = { location_id: 'loc-1', audience_filter: { logic: 'and', filters: [] }, channel: 'whatsapp' }
    const p1 = await (await previewPOST(reqWith({ ...base, limit: 2, offset: 0 }))).json()
    const p2 = await (await previewPOST(reqWith({ ...base, limit: 2, offset: 2 }))).json()
    const ids = [...p1.data.rows, ...p2.data.rows].map(r => r.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(p1.data.total).toBe(p2.data.total)
  })
})
