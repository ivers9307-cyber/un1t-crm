// src/lib/person-aggregate.js — unified read-model for a person_group (PERSON-LINK.1)
//
// aggregatePerson(db, groupId) rolls every linked account's data into one
// payload for the unified profile view. The result merges contacts, arrears,
// attendance, deals, and activities across all member contact rows.
//
// Design notes:
//  - arrears: reuses nettedOutByRetry from glofox-arrears.js exactly as
//    fetchPastDue (churn-radar-data.js) does, so behaviour matches the live
//    Overdue feature.
//  - attended: sums total_attended_30d across member contacts. This mirrors
//    the signal the contact page surfaces (contacts.total_attended_30d) and
//    the churn radar reads (last_attended_at / total_attended_30d). Naming is
//    honest: the field is `attended` with value from total_attended_30d
//    summed across accounts — a rolling 30-day window, not an all-time count.
//    If a cross-member all-time figure is needed later, query bookings.attended
//    directly; the current codebase has no cross-member attended aggregation.
//  - timeline: single .in() query, limit 50, newest-first — no pagination
//    (the 50-row cap is the spec; the data source is the activities table).
//  - invoices: may exceed 1k rows; paginated with .range() following the
//    CLAUDE.md pattern from pipeline-reclassify.js.
//  - thenables: never .catch() a supabase builder — try { await } catch {} only.

import { nettedOutByRetry } from './glofox-arrears'
import { normalisePhone9 } from './person-links'

const PAGE_SIZE = 1000
const HARD_LIMIT = 20_000

// Non-contactable email statuses (mirrors the per-channel gate in CLAUDE.md)
const NON_CONTACTABLE_EMAIL_STATUSES = new Set(['bounced', 'complained', 'unsubscribed'])

/**
 * Page all glofox_invoices rows for a given set of contact_ids and status.
 * Uses the CLAUDE.md pagination loop; invoices can exceed the 1k row cap.
 */
async function fetchGroupInvoicesByStatus(db, memberIds, status, columns) {
  const rows = []
  let pageStart = 0
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const pageEnd = Math.min(pageStart + PAGE_SIZE - 1, HARD_LIMIT - 1)
    const { data: page, error } = await db
      .from('glofox_invoices')
      .select(columns)
      .in('contact_id', memberIds)
      .eq('status', status)
      .order('id', { ascending: true })
      .range(pageStart, pageEnd)
    if (error) throw new Error(error.message)
    if (!Array.isArray(page) || page.length === 0) break
    rows.push(...page)
    if (page.length < PAGE_SIZE) break
    if (rows.length >= HARD_LIMIT) break
    pageStart += PAGE_SIZE
  }
  return rows
}

/**
 * aggregatePerson(db, groupId)
 *
 * Loads all data for a person_group and returns a unified payload.
 * Returns null if the group doesn't exist or has no members.
 *
 * @param {object} db  Supabase service-role client
 * @param {string} groupId  UUID of the person_group
 * @returns {Promise<object|null>}
 */
export async function aggregatePerson(db, groupId) {
  // ── Step 1: Load group + members ──────────────────────────────────────────
  const [groupRes, membersRes] = await Promise.all([
    db.from('person_groups').select('*').eq('id', groupId).single(),
    db.from('person_group_members').select('contact_id').eq('group_id', groupId),
  ])

  const group = groupRes.data
  const members = membersRes.data

  if (!group || !Array.isArray(members) || members.length === 0) return null

  const memberIds = members.map(m => m.contact_id)
  const primaryContactId = group.primary_contact_id

  // ── Step 2: Fetch member contact rows ────────────────────────────────────
  const { data: contactRows } = await db
    .from('contacts')
    .select('id, name, first_name, last_name, email, email_status, phone, wa_phone, glofox_member_id, glofox_membership_status, glofox_membership_state, glofox_account_active, pipeline_stage_slug, last_attended_at, total_attended_30d')
    .in('id', memberIds)

  const contacts = contactRows || []

  // ── Step 3: Build parallel fetches ───────────────────────────────────────
  const [pastDueRows, paidRows, dealCountRes, timelineRes] = await Promise.all([
    // Arrears: PAST_DUE invoices for these members
    fetchGroupInvoicesByStatus(
      db,
      memberIds,
      'PAST_DUE',
      'id, contact_id, glofox_user_id, amount_cents, invoice_date',
    ),
    // Arrears: PAID invoices for netting (retry detection)
    fetchGroupInvoicesByStatus(
      db,
      memberIds,
      'PAID',
      'glofox_user_id, amount_cents, invoice_date',
    ),
    // Deals count — select ids and count client-side (avoids head-only count
    // which supabase-js requires on the FIRST .select() call, not chained)
    db.from('deals').select('id').in('contact_id', memberIds),
    // Timeline: newest 50 activities across all members
    db
      .from('activities')
      .select('id, contact_id, type, title, created_at')
      .in('contact_id', memberIds)
      .order('created_at', { ascending: false })
      .limit(50),
  ])

  // ── Step 4: Accounts — primary first ─────────────────────────────────────
  const primaryContact = contacts.find(c => c.id === primaryContactId)
  const otherContacts = contacts.filter(c => c.id !== primaryContactId)
  // Put primary first, then others in the order they came back
  const orderedContacts = primaryContact
    ? [primaryContact, ...otherContacts]
    : [...contacts]

  const accounts = orderedContacts.map(c => ({
    contactId: c.id,
    name: c.name || [c.first_name, c.last_name].filter(Boolean).join(' ') || null,
    email: c.email || null,
    status: c.glofox_membership_status || null,
    state: c.glofox_membership_state || null,
    glofoxMemberId: c.glofox_member_id || null,
    active: c.glofox_account_active ?? false,
    isPrimary: c.id === primaryContactId,
    attended30d: Number(c.total_attended_30d) || 0,
    lastAttendedAt: c.last_attended_at || null,
  }))

  // ── Step 5: Emails — deduped by lowercased value ─────────────────────────
  const emailsSeen = new Set()
  const emails = []
  for (const c of orderedContacts) {
    if (!c.email) continue
    const normalised = c.email.toLowerCase().trim()
    if (!normalised) continue
    if (emailsSeen.has(normalised)) continue
    emailsSeen.add(normalised)
    emails.push({
      value: normalised,
      sourceContactId: c.id,
      contactable: !NON_CONTACTABLE_EMAIL_STATUSES.has(c.email_status),
    })
  }

  // ── Step 6: Phones — deduped by normalised last-9-digits ─────────────────
  const phonesSeen = new Set()
  const phones = []
  for (const c of orderedContacts) {
    const rawPhone = c.wa_phone || c.phone
    if (!rawPhone) continue
    const norm = normalisePhone9(rawPhone)
    if (!norm) continue
    if (phonesSeen.has(norm)) continue
    phonesSeen.add(norm)
    phones.push({
      value: rawPhone,
      sourceContactId: c.id,
    })
  }

  // ── Step 7: Arrears — nettedOutByRetry (same as fetchPastDue) ────────────
  const { kept: survivingPastDue } = nettedOutByRetry(pastDueRows, paidRows)
  const arrearsCents = survivingPastDue.reduce(
    (sum, r) => sum + (Number(r.amount_cents) || 0),
    0,
  )

  // ── Step 8: Attended — sum total_attended_30d across member contacts ──────
  // Signal: contacts.total_attended_30d — the rolling 30-day attendance count
  // that the contact page and churn radar both surface. Named `attended` in
  // the payload; the field counts "attended in the last 30 days" summed across
  // all linked accounts. This is the cleanest existing cross-account signal
  // without a separate bookings query; a future all-time query could use
  // bookings.attended=true but that table isn't queried per-member here.
  const attended = contacts.reduce(
    (sum, c) => sum + (Number(c.total_attended_30d) || 0),
    0,
  )

  // ── Step 8b: lastAttendedAt — MAX last_attended_at across member contacts ──
  // A person can be ACTIVE on a non-primary account (e.g. ClassPass: 6 visits/30d,
  // last seen last week) while their PRIMARY account is dormant. Reading only from
  // the primary would make the person look quiet when they're actually in every
  // other day. Take the max across all accounts so the profile reflects combined
  // real activity. Attendance data only exists as rolled-up Glofox fields —
  // total_attended_30d and last_attended_at — so we compare those directly.
  const lastAttendedAt = contacts.reduce((max, c) => {
    if (!c.last_attended_at) return max
    if (!max) return c.last_attended_at
    return new Date(c.last_attended_at) > new Date(max) ? c.last_attended_at : max
  }, null)

  // ── Step 9: Deals count ───────────────────────────────────────────────────
  const dealsCount = Array.isArray(dealCountRes?.data) ? dealCountRes.data.length : 0

  // ── Step 10: Timeline — newest-first, capped at 50, tagged with sourceContactId
  const rawTimeline = timelineRes?.data || []
  const timeline = rawTimeline.map(e => ({
    sourceContactId: e.contact_id,
    type: e.type || null,
    title: e.title || null,
    createdAt: e.created_at,
  }))
  // The .order('created_at', { ascending: false }).limit(50) on the builder
  // already returns the newest 50 rows from the mock (and from Supabase).
  // The slice below is a safety cap in case the mock returns more.
  const cappedTimeline = timeline.slice(0, 50)

  return {
    groupId,
    primaryContactId,
    accounts,
    emails,
    phones,
    arrearsCents,
    attended,
    lastAttendedAt,
    dealsCount,
    timeline: cappedTimeline,
  }
}
