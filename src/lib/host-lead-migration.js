// HOST-MASTER.7 — one-off migration of pre-HOST-MASTER host leads onto the
// org's master location.
//
// Before HOST-MASTER, a host signup/registration created its contact at the
// host's own hidden location (`locations.is_host_anchor = true`). Those rows
// are invisible to the operator's normal location-scoped views. This module
// walks every anchor location and relocates its contacts to the owning org's
// master location (`organizations.master_location_id`, mig 464):
//
//   • email matches an existing master contact  → MERGE (fold the anchor row
//     into the master row, then delete the anchor row)
//   • no match                                  → MOVE  (re-point location_id
//     and stamp automations_exempt = true)
//
// Idempotent: once a contact has been relocated it no longer sits at an anchor
// location, so a second run finds nothing to do. Dry-run by default — the
// caller must explicitly opt into writes.
//
// MERGE RULES (deliberate, do not "simplify"):
//   • automations_exempt is set ONLY on plain moves. A master row keeps its own
//     flag — a real member must not become automation-exempt just because it
//     absorbed a host lead.
//   • Consent: the MASTER's contact_preferences win. The anchor row's
//     preferences are deleted outright, never re-pointed over the master's.
//   • Nothing else on the master row is touched — no pipeline, no identity
//     fields. Only `tags` (union) changes.

import { mergeTagArrays } from '@/lib/contact-merge'
import { logWarn } from '@/lib/log'

const PAGE = 1000 // the supabase-js 1k select cap — always .range()-paginate
const SAMPLE_MAX = 20

// Every child row set keyed to a contact, as [table, column]. Authoritative
// list from src/lib/contact-merge.js, split by FK behaviour:
//
//   CASCADE   — the row dies with the contact, so it MUST be re-pointed before
//               the anchor row is deleted or the history is destroyed.
//   SET NULL  — the row survives but orphans; re-pointing keeps the history
//               attached to the surviving contact.
//   WhatsApp  — contact-merge REDACTS these on a delete. A merge is not a
//               deletion: the thread belongs to the same human, so it is
//               re-pointed (never redacted).
//   Host      — mig 400/401 join tables, each UNIQUE(parent, contact_id) and
//               ON DELETE CASCADE. The unique index is exactly why repoint()
//               tolerates 23505.
//
// contact_preferences is intentionally ABSENT: master consent wins, so the
// anchor's rows are deleted rather than re-pointed (see mergeContact below).
const REPOINT_TABLES = [
  // CASCADE
  ['activities', 'contact_id'],
  ['campaign_recipients', 'contact_id'],
  ['consent_log', 'contact_id'],
  ['contact_tags', 'contact_id'],
  ['deals', 'contact_id'],
  ['email_sends', 'contact_id'],
  ['notes', 'contact_id'],
  ['sequence_enrollments', 'contact_id'],
  ['sms_broadcast_recipients', 'contact_id'],
  // SET NULL
  ['bookings', 'contact_id'],
  ['contact_events', 'contact_id'],
  ['orders', 'contact_id'],
  ['race_payments', 'contact_id'],
  ['race_registrations', 'contact_id'],
  ['team_members', 'contact_id'],
  ['team_members', 'member_contact_id'],
  ['teams', 'captain_contact_id'],
  // WhatsApp (re-point, do NOT redact)
  ['whatsapp_broadcast_recipients', 'contact_id'],
  ['whatsapp_conversations', 'contact_id'],
  ['whatsapp_messages', 'contact_id'],
  // Host join tables (mig 400/401)
  ['host_contacts', 'contact_id'],
  ['host_email_suppressions', 'contact_id'],
  ['host_campaign_sends', 'contact_id'],
]

/** Lookup key for an email — null when there is nothing usable to match on. */
function emailKey(email) {
  const k = String(email || '').trim().toLowerCase()
  return k || null
}

/**
 * Decide what happens to each anchor-location contact. Pure — no I/O, so the
 * whole decision surface is unit-testable.
 *
 * @param {Array<{id: string, email?: string|null}>} anchorContacts
 * @param {Map<string, {id: string}>} masterByEmail lowercased email → master contact
 * @returns {Array<{action: 'merge'|'move'|'skip', id?: string, from?: string, into?: string, reason?: string}>}
 */
export function planHostLeadMigration(anchorContacts, masterByEmail) {
  const plan = []
  for (const c of anchorContacts || []) {
    const key = emailKey(c?.email)
    const match = key ? masterByEmail?.get(key) : null
    // A contact with no usable email can never be matched — it always moves.
    if (!match) {
      plan.push({ action: 'move', id: c.id })
      continue
    }
    // Defensive: the row is already the master contact (a re-run mid-flight, or
    // an anchor/master location mix-up). Merging it would delete it.
    if (match.id === c.id) {
      plan.push({ action: 'skip', id: c.id, reason: 'already master' })
      continue
    }
    plan.push({ action: 'merge', from: c.id, into: match.id })
  }
  return plan
}

/** Range-paginate a whole table past the 1k select cap. */
async function pageAll(db, table, columns, applyFilters) {
  const out = []
  for (let from = 0; ; from += PAGE) {
    const base = db.from(table).select(columns)
    const q = applyFilters ? applyFilters(base) : base
    const { data, error } = await q.order('id', { ascending: true }).range(from, from + PAGE - 1)
    if (error) throw new Error(`${table}: ${error.message}`)
    out.push(...(data || []))
    if (!data || data.length < PAGE) break
  }
  return out
}

/**
 * Re-point a child row set from the anchor contact to the master.
 * A unique violation (23505) means the master already holds the
 * equivalent row (e.g. same host list, same tag) — the anchor's
 * duplicate is then redundant, so delete it instead.
 */
async function repoint(db, table, column, fromId, toId) {
  const { error } = await db.from(table).update({ [column]: toId }).eq(column, fromId)
  if (!error) return
  if (error.code !== '23505') throw new Error(`${table}.${column}: ${error.message}`)
  const { error: delErr } = await db.from(table).delete().eq(column, fromId)
  if (delErr) throw new Error(`${table}.${column} cleanup: ${delErr.message}`)
}

/** Plain move: relocate the contact and exempt it from automations. */
async function moveContact(db, id, masterId) {
  const { error } = await db
    .from('contacts')
    .update({ location_id: masterId, automations_exempt: true })
    .eq('id', id)
  if (error) throw new Error(`contacts move: ${error.message}`)
}

/** Fold the anchor contact into the master contact, then delete the anchor. */
async function mergeContact(db, fromId, toId) {
  for (const [table, column] of REPOINT_TABLES) {
    await repoint(db, table, column, fromId, toId)
  }

  // Consent: the MASTER's preferences win. Never overwrite them with the
  // anchor's — drop the anchor's rows instead.
  const { error: prefErr } = await db.from('contact_preferences').delete().eq('contact_id', fromId)
  if (prefErr) throw new Error(`contact_preferences: ${prefErr.message}`)

  // Tags are the only field on the master row this touches.
  const { data: rows, error: tagErr } = await db.from('contacts').select('id, tags').in('id', [fromId, toId])
  if (tagErr) throw new Error(`contacts tags read: ${tagErr.message}`)
  const survivor = (rows || []).find((r) => r.id === toId)
  const loser = (rows || []).find((r) => r.id === fromId)
  const merged = mergeTagArrays(survivor?.tags, loser?.tags)
  if (merged.join(' ') !== (survivor?.tags || []).join(' ')) {
    const { error } = await db.from('contacts').update({ tags: merged }).eq('id', toId)
    if (error) throw new Error(`contacts tags: ${error.message}`)
  }

  // LAST — every child row is now re-pointed, so the CASCADE takes nothing
  // that still matters.
  const { error: delErr } = await db.from('contacts').delete().eq('id', fromId)
  if (delErr) throw new Error(`contacts delete: ${delErr.message}`)
}

/**
 * Walk every host-anchor location and relocate its contacts onto the owning
 * org's master location. Dry-run by default.
 *
 * @param {object} db service-role supabase client
 * @param {{dryRun?: boolean}} [opts]
 * @returns {Promise<{dry_run: boolean, planned: number, merged: number, moved: number,
 *   skipped: number, skipped_no_master: number, errors: Array<{id: string, message: string}>,
 *   sample?: Array<object>}>}
 *   In dry-run every count is a WOULD-count and `sample` carries the first
 *   {SAMPLE_MAX} planned actions.
 */
export async function runHostLeadMigration(db, { dryRun = true } = {}) {
  const summary = {
    dry_run: dryRun,
    planned: 0,
    merged: 0,
    moved: 0,
    skipped: 0,
    skipped_no_master: 0,
    errors: [],
  }
  const sample = []

  const anchors = await pageAll(db, 'locations', 'id, organization_id', (q) =>
    q.eq('is_host_anchor', true)
  )
  if (!anchors.length) {
    if (dryRun) summary.sample = sample
    return summary
  }

  // Resolve each org's master location once (mig 464).
  const orgIds = [...new Set(anchors.map((a) => a.organization_id).filter(Boolean))]
  const orgs = orgIds.length
    ? await pageAll(db, 'organizations', 'id, master_location_id', (q) => q.in('id', orgIds))
    : []
  const masterByOrg = new Map(orgs.map((o) => [o.id, o.master_location_id]))

  // masterId → (lowercased email → { id }). Cached because several anchor
  // locations can share one org, and refreshed as moves add new emails.
  const masterIndexes = new Map()

  for (const anchor of anchors) {
    const masterId = anchor.organization_id ? masterByOrg.get(anchor.organization_id) : null
    if (!masterId) {
      summary.skipped_no_master += 1
      continue
    }

    const anchorContacts = await pageAll(db, 'contacts', 'id, email, tags', (q) =>
      q.eq('location_id', anchor.id)
    )
    if (!anchorContacts.length) continue

    if (!masterIndexes.has(masterId)) {
      const masterContacts = await pageAll(db, 'contacts', 'id, email', (q) =>
        q.eq('location_id', masterId)
      )
      const index = new Map()
      for (const m of masterContacts) {
        const key = emailKey(m.email)
        if (key && !index.has(key)) index.set(key, { id: m.id })
      }
      masterIndexes.set(masterId, index)
    }
    const masterByEmail = masterIndexes.get(masterId)

    const plan = planHostLeadMigration(anchorContacts, masterByEmail)
    summary.planned += plan.length
    const emailById = new Map(anchorContacts.map((c) => [c.id, emailKey(c.email)]))

    for (const step of plan) {
      if (step.action === 'skip') {
        summary.skipped += 1
        continue
      }
      if (sample.length < SAMPLE_MAX) sample.push(step)

      if (dryRun) {
        if (step.action === 'merge') summary.merged += 1
        else summary.moved += 1
        // Keep the index honest across anchor locations in the same org: a
        // would-be move makes that email present on the master, so a later
        // anchor's same-email contact is a merge, not a second move.
        if (step.action === 'move') {
          const key = emailById.get(step.id)
          if (key && !masterByEmail.has(key)) masterByEmail.set(key, { id: step.id })
        }
        continue
      }

      // Each action is independently fatal — one bad contact must not abort
      // the run.
      try {
        if (step.action === 'merge') {
          await mergeContact(db, step.from, step.into)
          summary.merged += 1
          logWarn('host-lead-migration', 'merged', { from: step.from, into: step.into })
        } else {
          await moveContact(db, step.id, masterId)
          summary.moved += 1
          const key = emailById.get(step.id)
          if (key && !masterByEmail.has(key)) masterByEmail.set(key, { id: step.id })
        }
      } catch (e) {
        summary.errors.push({ id: step.action === 'merge' ? step.from : step.id, message: e.message })
      }
    }
  }

  if (dryRun) summary.sample = sample
  return summary
}
