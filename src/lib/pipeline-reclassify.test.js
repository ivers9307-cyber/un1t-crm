// PIPELINE5.6 — orchestrator tests for reclassifyAllContacts.
//
// Covers the four shapes that matter for the cron:
//   1. Empty location (no contacts) → ok with zero counts
//   2. Dry-run produces movement_matrix + samples without writes
//   3. Real run groups moves by target stage and bulk-UPDATEs once
//   4. Contacts with no open deal land in createsToApply
//
// fakeDb fluent shim mirrors the one in glofox-sync.test.js — each
// db.from('table').select().eq()...  is a chainable proxy that
// records the read + records writes for assertion.

import { describe, it, expect } from 'vitest'
import { reclassifyAllContacts } from './pipeline-reclassify.js'

const isoDaysAgo = (d) => new Date(Date.now() - d * 86_400_000).toISOString()

// Minimal stage set covering every classifier output.
const STAGES = [
  { id: 'stage-new', slug: 'new_lead' },
  { id: 'stage-active-trial', slug: 'active_trial' },
  { id: 'stage-hot', slug: 'hot_conversion' },
  { id: 'stage-active', slug: 'active_member' },
  { id: 'stage-at-risk', slug: 'at_risk_member' },
  { id: 'stage-cp', slug: 'classpass_active' },
  { id: 'stage-lapsed', slug: 'lapsed' },
  { id: 'stage-dormant', slug: 'dormant' },
  { id: 'stage-dormant-cp', slug: 'dormant_classpass' },
]

/**
 * @param {object} args
 * @param {object[]} [args.contacts]
 * @param {object[]} [args.deals]
 * @param {object[]} [args.stages]
 * @param {object} [args.runRow]   { id } returned for the audit insert
 * @returns {{ db, writes }}  writes captures every update / insert
 */
function fakeDb({ contacts = [], deals = [], stages = STAGES, runRow = { id: 'run-1' } } = {}) {
  const writes = {
    runInsert: null,
    runUpdates: [],
    dealUpdates: [],
    dealInserts: [],
  }

  function chain(table, op) {
    const c = {}
    let pendingInsert = null
    let inIds = null
    let updateFields = null
    c.select = () => c
    c.single = () => c
    c.eq = () => c
    c.limit = () => c
    c.order = () => c
    // .range(start, end) — no-op for the shim; the .then below returns
    // the full fixture array regardless. Tests use < PAGE_SIZE rows so
    // the orchestrator's pagination loop breaks after one iteration.
    c.range = () => c
    c.in = (_col, ids) => { inIds = ids; return c }
    c.update = (fields) => { updateFields = fields; op = 'update'; return c }
    c.insert = (row) => { pendingInsert = row; op = 'insert'; return c }
    c.then = (resolve) => {
      // INSERT branch
      if (op === 'insert') {
        if (table === 'pipeline_classification_runs') {
          writes.runInsert = pendingInsert
          return resolve({ data: runRow, error: null })
        }
        if (table === 'deals') {
          writes.dealInserts.push(pendingInsert)
          return resolve({ data: null, error: null })
        }
      }
      // UPDATE branch
      if (op === 'update') {
        if (table === 'pipeline_classification_runs') {
          writes.runUpdates.push(updateFields)
          return resolve({ data: null, error: null })
        }
        if (table === 'deals') {
          writes.dealUpdates.push({ fields: updateFields, ids: inIds })
          return resolve({ data: null, error: null })
        }
      }
      // SELECT branch
      if (table === 'pipeline_stages') return resolve({ data: stages, error: null })
      if (table === 'contacts')        return resolve({ data: contacts, error: null })
      if (table === 'deals')           return resolve({ data: deals, error: null })
      return resolve({ data: [], error: null })
    }
    return c
  }
  return {
    db: { from: (table) => chain(table, 'select') },
    writes,
  }
}

describe('reclassifyAllContacts', () => {
  it('rejects when locationId missing', async () => {
    const { db } = fakeDb()
    const out = await reclassifyAllContacts(db, {})
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/locationId/)
  })

  it('handles a location with zero contacts', async () => {
    const { db, writes } = fakeDb({ contacts: [], deals: [] })
    const out = await reclassifyAllContacts(db, { locationId: 'loc-1' })
    expect(out.ok).toBe(true)
    expect(out.contacts_seen).toBe(0)
    expect(out.deals_moved).toBe(0)
    expect(writes.dealUpdates).toHaveLength(0)
    // Audit row opened + closed (status=success).
    expect(writes.runInsert).toMatchObject({ source: 'cron', dry_run: false })
    expect(writes.runUpdates.at(-1)).toMatchObject({ status: 'success', contacts_seen: 0 })
  })

  it('dry-run computes moves but writes nothing', async () => {
    // Active-member contact stuck in 'lapsed' should move to active_member.
    // status='member' (not 'active') — only member/credit_member/etc.
    // are real classifier inputs. attended7d=0 to avoid hot_conversion
    // (which only fires for trial-family statuses anyway, but keeping
    // the fixture clean).
    const contacts = [{
      id: 'c1', name: 'Member A', email: 'a@x.com',
      glofox_membership_status: 'member',
      last_attended_at: isoDaysAgo(2), total_attended_30d: 8, total_attended_7d: 0,
      last_payment_at: isoDaysAgo(20), joined_at: isoDaysAgo(120), created_at: isoDaysAgo(120),
      trial_credits_remaining: null,
    }]
    const deals = [{ id: 'd1', contact_id: 'c1', stage_id: 'stage-lapsed' }]
    const { db, writes } = fakeDb({ contacts, deals })

    const out = await reclassifyAllContacts(db, { locationId: 'loc-1', dryRun: true })
    expect(out.ok).toBe(true)
    expect(out.deals_moved).toBe(1)
    expect(out.movement_matrix).toHaveProperty('lapsed')
    expect(out.samples).toHaveLength(1)
    // No DB writes on dry-run — not even the audit row.
    expect(writes.runInsert).toBeNull()
    expect(writes.dealUpdates).toHaveLength(0)
  })

  it('groups moves by target stage and bulk-UPDATEs once per stage', async () => {
    // Three contacts: two should land in active_member, one in dormant.
    // Both "should-be-active" deals are currently in 'lapsed'.
    const contacts = [
      {
        id: 'c1', name: 'A', email: 'a@x.com',
        glofox_membership_status: 'member',
        last_attended_at: isoDaysAgo(3), total_attended_30d: 8, total_attended_7d: 0,
        last_payment_at: isoDaysAgo(20), joined_at: isoDaysAgo(120), created_at: isoDaysAgo(120),
      },
      {
        id: 'c2', name: 'B', email: 'b@x.com',
        glofox_membership_status: 'member',
        last_attended_at: isoDaysAgo(5), total_attended_30d: 6, total_attended_7d: 0,
        last_payment_at: isoDaysAgo(30), joined_at: isoDaysAgo(200), created_at: isoDaysAgo(200),
      },
      {
        id: 'c3', name: 'C', email: 'c@x.com',
        glofox_membership_status: 'ex_member',
        last_attended_at: isoDaysAgo(400), total_attended_30d: 0, total_attended_7d: 0,
        last_payment_at: isoDaysAgo(400), joined_at: isoDaysAgo(800), created_at: isoDaysAgo(800),
      },
    ]
    const deals = [
      { id: 'd1', contact_id: 'c1', stage_id: 'stage-lapsed' },
      { id: 'd2', contact_id: 'c2', stage_id: 'stage-lapsed' },
      { id: 'd3', contact_id: 'c3', stage_id: 'stage-active' }, // wrong: should be dormant
    ]
    const { db, writes } = fakeDb({ contacts, deals })

    const out = await reclassifyAllContacts(db, { locationId: 'loc-1' })
    expect(out.ok).toBe(true)
    expect(out.contacts_seen).toBe(3)
    expect(out.deals_moved).toBe(3)
    // Two bulk UPDATEs — one for stage-active (2 deals), one for stage-dormant (1).
    expect(writes.dealUpdates).toHaveLength(2)
    const activeUpdate = writes.dealUpdates.find((u) => u.fields.stage_id === 'stage-active')
    const dormantUpdate = writes.dealUpdates.find((u) => u.fields.stage_id === 'stage-dormant')
    expect(activeUpdate.ids.sort()).toEqual(['d1', 'd2'])
    expect(dormantUpdate.ids).toEqual(['d3'])
    // Audit closed with success.
    expect(writes.runUpdates.at(-1)).toMatchObject({
      status: 'success', contacts_seen: 3, deals_moved: 3, deals_unchanged: 0,
    })
  })

  it('creates a deal for a contact with no open deal', async () => {
    const contacts = [{
      id: 'c1', name: 'New Lead', email: 'nl@x.com',
      glofox_membership_status: null,
      last_attended_at: null, total_attended_30d: 0, total_attended_7d: 0,
      last_payment_at: null, joined_at: null, created_at: isoDaysAgo(5),
      trial_credits_remaining: null,
    }]
    const { db, writes } = fakeDb({ contacts, deals: [] })
    const out = await reclassifyAllContacts(db, { locationId: 'loc-1' })
    expect(out.ok).toBe(true)
    expect(out.deals_created).toBe(1)
    expect(writes.dealInserts).toHaveLength(1)
    expect(writes.dealInserts[0]).toMatchObject({
      contact_id: 'c1', location_id: 'loc-1', status: 'open',
    })
  })

  it('counts unchanged when classifier matches current stage', async () => {
    // Contact already in active_member, classifier agrees → unchanged.
    const contacts = [{
      id: 'c1', name: 'Stable Member', email: 'sm@x.com',
      glofox_membership_status: 'member',
      last_attended_at: isoDaysAgo(3), total_attended_30d: 8, total_attended_7d: 0,
      last_payment_at: isoDaysAgo(20), joined_at: isoDaysAgo(120), created_at: isoDaysAgo(120),
    }]
    const deals = [{ id: 'd1', contact_id: 'c1', stage_id: 'stage-active' }]
    const { db, writes } = fakeDb({ contacts, deals })

    const out = await reclassifyAllContacts(db, { locationId: 'loc-1' })
    expect(out.ok).toBe(true)
    expect(out.deals_unchanged).toBe(1)
    expect(out.deals_moved).toBe(0)
    expect(writes.dealUpdates).toHaveLength(0) // no UPDATE issued
  })
})
