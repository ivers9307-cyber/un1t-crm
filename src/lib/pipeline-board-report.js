// PIPEBUILD.6-3 — the board report: what an offer board did, in numbers.
//
// buildBoardReport(db, { board, locationId, nowMs, includeRevenue }) answers
// five blocks — funnel, conversion, revenue, followups, health — each its own
// object, or null when ITS reads failed (one logError with ids only, never the
// other blocks' problem). Every read is scoped to the studio it was given, and
// every fan-out is paged (selectAll / selectAllByKeys, explicit .order()).
//
// "Entered" is the board CLAIM's start (loadOfferClaimsForLocation), never the
// deal's created_at: a deal follows the person across boards (pipeline_id +
// stage_id in one update), so a deal on this board is usually months older
// than the board's own clock. funnel.entered7/entered30, conversion's
// entered30/converted30 and health's nobody_entered_7d all read the claims;
// when the claims cannot be read those numbers are null and the warning is
// not raised. They count distinct people.
//
// Honest limits, said in the output where they matter:
//   - movedIn* counts the "Pipeline: moved to <stage name>" timeline rows, so
//     history before a stage rename is not counted (historyNote);
//   - a deal CREATED onto the first stage logs no move, so deals created in the
//     window are added to the board's first stage (this one IS created_at: it
//     stands in for the move row a creation never writes).
import { RECIPES, templateNameFor } from '@shared/pipelines/recipes.js'
import { stageRoleOf, isPileRole } from '@shared/pipelines/stage-roles'
import { otherPackTemplateNames } from './pipeline-boards'
import { purchaseMatchesEntry, loadOfferClaimsForLocation } from './pipeline-offer-claims'
import { requiredFields as OFFER_CONTACT_FIELDS } from '@shared/pipelines/offer'
import { loadStageCoverage } from './pipeline-stage-coverage'
import { selectAll, selectAllByKeys } from './select-all'
import { logError } from './log'

const MODULE = 'pipeline-board-report'
const DAY_MS = 86400000
const CHUNK = 200
const REPLY_WINDOW_MS = 72 * 3600000
const BOOKING_WINDOW_MS = 14 * DAY_MS
const CANCELLED = new Set(['CANCELLED', 'CANCELED', 'LATE_CANCELLED'])
// Entry types matched on contact columns: the claims loader needs those columns.
const RECORDED_ENTRY_TYPES = new Set(['lead_source', 'glofox_plan', 'tag'])

// Change wording installs a new template per version (`_v<n>`), so a
// follow-up's sends live under every version's names, 1..followup.version:
// counting only the current one would reset the stats on each rewording.
const MAX_VERSIONS = 50

function packTemplateNames(board, followup, firstName) {
  const names = new Set([firstName])
  const pack = RECIPES[board.recipe_key]?.packs?.find((p) => p.key === followup.pack_key)
  if (!pack || !pack.templates?.length) return names
  const current = Number.isInteger(followup.version) && followup.version > 1 ? followup.version : 1
  try {
    // The studio prefix: whatever precedes the current version's first name.
    const suffix = templateNameFor({ studioSlug: 's', boardKey: board.key, packKey: pack.key, ref: pack.templates[0].ref, version: current }).slice(1)
    if (!String(firstName ?? '').endsWith(suffix)) return names
    const studioSlug = firstName.slice(0, -suffix.length)
    if (!studioSlug) return names
    for (let version = 1; version <= Math.min(current, MAX_VERSIONS); version += 1) {
      const first = templateNameFor({ studioSlug, boardKey: board.key, packKey: pack.key, ref: pack.templates[0].ref, version })
      names.add(first)
      if (pack.templates.length < 2) continue
      for (const n of otherPackTemplateNames({ board, followup: { ...followup, version }, pack, firstName: first }) || []) names.add(n)
    }
  } catch {
    // A name templateNameFor refuses was never installed.
  }
  return names
}
export const HISTORY_NOTE = 'History before a stage rename is not counted.'

const ms = (v) => {
  const t = v ? Date.parse(v) : NaN
  return Number.isFinite(t) ? t : null
}

async function block(label, ids, fn) {
  try {
    return await fn()
  } catch (e) {
    logError(MODULE, `${label} block failed`, { ...ids, err: e?.message || String(e) })
    return null
  }
}

async function readDeals(db, locationId, boardId) {
  return selectAll((from, to) => db
    .from('deals')
    .select('id, contact_id, stage_id, status, created_at')
    .eq('location_id', locationId)
    .eq('pipeline_id', boardId)
    .order('id', { ascending: true })
    .range(from, to))
}

async function readMoves(db, locationId, dealIds, sinceIso) {
  return selectAllByKeys(dealIds, (keys, from, to) => db
    .from('activities')
    .select('id, deal_id, subject, created_at')
    .eq('location_id', locationId)
    .eq('type', 'pipeline')
    .in('deal_id', keys)
    .gte('created_at', sinceIso)
    .order('id', { ascending: true })
    .range(from, to), { chunkSize: CHUNK })
}

// Map<contactId, claim start ms> for THIS board's deal contacts. Throws when
// the claims cannot be read (or the board's config will not parse), so the
// caller reports "unknown", never "nobody entered". Never writes a claim.
async function readClaimStarts(db, board, locationId, deals, nowMs) {
  const contactIds = [...new Set(deals.map((d) => d.contact_id).filter(Boolean))]
  if (contactIds.length === 0) return new Map()
  const contacts = RECORDED_ENTRY_TYPES.has(board.config?.entry?.type)
    ? await selectAllByKeys(contactIds, (keys, from, to) => db
      .from('contacts')
      .select(OFFER_CONTACT_FIELDS.join(', '))
      .in('id', keys)
      .order('id', { ascending: true })
      .range(from, to), { chunkSize: CHUNK })
    : contactIds.map((id) => ({ id }))
  // The loader reads ENABLED boards only; a paused board still has a history.
  const res = await loadOfferClaimsForLocation(db, { locationId, boards: [{ ...board, enabled: true }], contacts, now: nowMs })
  if (!res?.ok) throw new Error(`claims unreadable: ${res?.reason || 'unknown'}`)
  if ((res.skipped || []).some((s) => s.key === board.key)) throw new Error('board config unreadable')
  const starts = new Map()
  for (const [contactId, offers] of res.offersByContact || []) {
    const start = Number(offers.get(board.key)?.start)
    if (Number.isFinite(start)) starts.set(contactId, start)
  }
  return starts
}

// Distinct people on this board whose claim started in the last 7 / 30 days,
// or nulls when the claims are unknown.
function enteredCounts(deals, starts, nowMs) {
  if (!starts) return { entered7: null, entered30: null }
  const since7 = nowMs - 7 * DAY_MS
  const since30 = nowMs - 30 * DAY_MS
  const in7 = new Set()
  const in30 = new Set()
  for (const d of deals) {
    const t = starts.get(d.contact_id)
    if (t == null) continue
    if (t >= since30) in30.add(d.contact_id)
    if (t >= since7) in7.add(d.contact_id)
  }
  return { entered7: in7.size, entered30: in30.size }
}

function buildFunnel(board, deals, moves, nowMs, entered) {
  const stages = [...(board.stages || [])].sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0))
  const since7 = nowMs - 7 * DAY_MS
  const since30 = nowMs - 30 * DAY_MS
  const subjectToStage = new Map(stages.map((s) => [`Pipeline: moved to ${s.name}`, s.id]))
  const now = new Map()
  const in7 = new Map()
  const in30 = new Map()
  for (const d of deals) if (d.status === 'open') now.set(d.stage_id, (now.get(d.stage_id) || 0) + 1)
  for (const m of moves) {
    const stageId = subjectToStage.get(m.subject)
    const t = ms(m.created_at)
    if (!stageId || t == null) continue
    if (t >= since30) in30.set(stageId, (in30.get(stageId) || 0) + 1)
    if (t >= since7) in7.set(stageId, (in7.get(stageId) || 0) + 1)
  }
  let created7 = 0
  let created30 = 0
  for (const d of deals) {
    const t = ms(d.created_at)
    if (t == null) continue
    if (t >= since30) created30 += 1
    if (t >= since7) created7 += 1
  }
  const first = stages[0]?.id
  if (first) {
    if (created7) in7.set(first, (in7.get(first) || 0) + created7)
    if (created30) in30.set(first, (in30.get(first) || 0) + created30)
  }
  return {
    stages: stages.map((s) => ({
      id: s.id,
      name: s.name,
      role: stageRoleOf(s),
      now: now.get(s.id) || 0,
      movedIn7: in7.get(s.id) || 0,
      movedIn30: in30.get(s.id) || 0,
    })),
    entered7: entered.entered7,
    entered30: entered.entered30,
    historyNote: HISTORY_NOTE,
  }
}

function buildConversion(board, deals, starts, nowMs) {
  if (!starts) return { entered30: null, converted30: null, rate: null }
  const since30 = nowMs - 30 * DAY_MS
  const roles = new Map((board.stages || []).map((s) => [s.id, stageRoleOf(s)]))
  const entered = new Set()
  const converted = new Set()
  for (const d of deals) {
    const t = starts.get(d.contact_id)
    if (t == null || t < since30) continue
    entered.add(d.contact_id)
    if (roles.get(d.stage_id) === 'converted' || d.status === 'won') converted.add(d.contact_id)
  }
  return { entered30: entered.size, converted30: converted.size, rate: entered.size === 0 ? null : converted.size / entered.size }
}

async function buildRevenue(db, board, locationId, deals) {
  const entry = board.config?.entry
  if (board.board_type !== 'offer' || entry?.type !== 'trial_purchase') {
    return { currency: 'EUR', offerCents: null, purchases: 0 }
  }
  const contactIds = [...new Set(deals.map((d) => d.contact_id).filter(Boolean))]
  const rows = await selectAllByKeys(contactIds, (keys, from, to) => db
    .from('trial_purchases')
    .select('id, contact_id, amount_cents, status, payment_status, landing_path, page_id, plan_code')
    .eq('location_id', locationId)
    .in('contact_id', keys)
    .order('id', { ascending: true })
    .range(from, to), { chunkSize: CHUNK })
  let offerCents = 0
  let purchases = 0
  for (const p of rows) {
    if (!purchaseMatchesEntry(p, entry)) continue
    if (!(p.status === 'granted' || p.payment_status === 'paid')) continue
    offerCents += Number(p.amount_cents) || 0
    purchases += 1
  }
  return { currency: 'EUR', offerCents, purchases }
}

/** Per follow-up: sent/failed/delivered/read are messages; replied and bookedAfter are DISTINCT contacts (bookedAfter = has a class starting after the message within 14 days, not cancelled). */
async function buildFollowups(db, board, locationId, deals) {
  const followups = board.followups || []
  const linked = followups.filter((f) => f.whatsapp_template_id)
  const templates = linked.length === 0 ? [] : await selectAllByKeys(
    [...new Set(linked.map((f) => f.whatsapp_template_id))],
    (keys, from, to) => db
      .from('whatsapp_templates')
      .select('id, name, status')
      .eq('location_id', locationId)
      .in('id', keys)
      .order('id', { ascending: true })
      .range(from, to),
    { chunkSize: CHUNK },
  )
  const byId = new Map(templates.map((t) => [t.id, t]))
  const namesOf = new Map()
  for (const f of followups) {
    const first = byId.get(f.whatsapp_template_id)
    namesOf.set(f.id ?? `${f.stage_id}:${f.pack_key}`, first?.name ? packTemplateNames(board, f, first.name) : new Set())
  }
  const allNames = [...new Set([...namesOf.values()].flatMap((s) => [...s]))]
  const contactIds = new Set(deals.map((d) => d.contact_id).filter(Boolean))

  const messages = allNames.length === 0 ? [] : (await selectAllByKeys(allNames, (keys, from, to) => db
    .from('whatsapp_messages')
    .select('id, contact_id, conversation_id, template_name, status, sent_at, delivered_at, read_at')
    .eq('location_id', locationId)
    .eq('direction', 'outbound')
    .in('template_name', keys)
    .order('id', { ascending: true })
    .range(from, to), { chunkSize: CHUNK })).filter((m) => contactIds.has(m.contact_id))

  const convIds = [...new Set(messages.map((m) => m.conversation_id).filter(Boolean))]
  const inbound = convIds.length === 0 ? [] : await selectAllByKeys(convIds, (keys, from, to) => db
    .from('whatsapp_messages')
    .select('id, conversation_id, sent_at')
    .eq('location_id', locationId)
    .eq('direction', 'inbound')
    .in('conversation_id', keys)
    .order('id', { ascending: true })
    .range(from, to), { chunkSize: CHUNK })
  const inboundBy = new Map()
  for (const i of inbound) {
    const t = ms(i.sent_at)
    if (t == null) continue
    if (!inboundBy.has(i.conversation_id)) inboundBy.set(i.conversation_id, [])
    inboundBy.get(i.conversation_id).push(t)
  }

  const msgContacts = [...new Set(messages.map((m) => m.contact_id))]
  const bookings = msgContacts.length === 0 ? [] : await selectAllByKeys(msgContacts, (keys, from, to) => db
    .from('class_bookings')
    .select('id, contact_id, starts_at, status')
    .eq('location_id', locationId)
    .in('contact_id', keys)
    .order('id', { ascending: true })
    .range(from, to), { chunkSize: CHUNK })
  const bookingsBy = new Map()
  for (const b of bookings) {
    const t = ms(b.starts_at)
    if (t == null || CANCELLED.has(String(b.status || '').toUpperCase())) continue
    if (!bookingsBy.has(b.contact_id)) bookingsBy.set(b.contact_id, [])
    bookingsBy.get(b.contact_id).push(t)
  }

  return followups.map((f) => {
    const names = namesOf.get(f.id ?? `${f.stage_id}:${f.pack_key}`)
    const out = { stageId: f.stage_id, packKey: f.pack_key, state: f.state, sent: 0, failed: 0, delivered: 0, read: 0, replied: 0, bookedAfter: 0 }
    const replied = new Set()
    const booked = new Set()
    for (const m of messages) {
      if (!names.has(m.template_name)) continue
      const sent = ms(m.sent_at)
      if (m.status === 'failed' || sent == null) { out.failed += 1; continue }
      out.sent += 1
      if (m.delivered_at) out.delivered += 1
      if (m.read_at) out.read += 1
      if ((inboundBy.get(m.conversation_id) || []).some((t) => t > sent && t <= sent + REPLY_WINDOW_MS)) replied.add(m.contact_id)
      if ((bookingsBy.get(m.contact_id) || []).some((t) => t > sent && t <= sent + BOOKING_WINDOW_MS)) booked.add(m.contact_id)
    }
    out.replied = replied.size
    out.bookedAfter = booked.size
    return out
  })
}

async function buildHealth(db, board, locationId, entered7) {
  const items = []
  const coverage = await loadStageCoverage(db, locationId)
  if (!coverage.ok) throw new Error(coverage.error || 'coverage unreadable')
  const covered = new Map()
  for (const b of coverage.boards) {
    if (b.id !== board.id) continue
    for (const s of b.stages) covered.set(s.id, (s.followups || []).length > 0)
  }
  const followups = board.followups || []
  // A missing follow-up is only news where the recipe HAS one to install (or
  // on a custom stage the operator added): a recipe with no converted pack
  // leaves its Converted stage quiet on purpose.
  const packRoles = new Set((RECIPES[board.recipe_key]?.packs || []).map((p) => p.role))
  for (const s of board.stages || []) {
    const role = stageRoleOf(s)
    if (isPileRole(role)) continue
    if (role !== 'custom' && !packRoles.has(role)) continue
    const live = followups.some((f) => f.stage_id === s.id && f.state === 'live')
    if (!live && !covered.get(s.id)) {
      items.push({ code: 'no_followup', message: `${s.name} has no follow-up.`, stageId: s.id })
    }
  }

  const templateIds = [...new Set(followups.map((f) => f.whatsapp_template_id).filter(Boolean))]
  if (templateIds.length) {
    const rows = await selectAllByKeys(templateIds, (keys, from, to) => db
      .from('whatsapp_templates')
      .select('id, status')
      .eq('location_id', locationId)
      .in('id', keys)
      .order('id', { ascending: true })
      .range(from, to), { chunkSize: CHUNK })
    const status = new Map(rows.map((t) => [t.id, String(t.status || '').toLowerCase()]))
    for (const f of followups) {
      const st = status.get(f.whatsapp_template_id)
      if (st === 'rejected') items.push({ code: 'template_rejected', message: 'A follow-up message was rejected by WhatsApp.', stageId: f.stage_id })
      else if (st === 'paused') items.push({ code: 'template_paused', message: 'A follow-up message is paused by WhatsApp.', stageId: f.stage_id })
    }
  }

  const sequenceIds = [...new Set(followups.map((f) => f.sequence_id).filter(Boolean))]
  if (sequenceIds.length) {
    const rows = await selectAllByKeys(sequenceIds, (keys, from, to) => db
      .from('email_sequences')
      .select('id, status')
      .eq('location_id', locationId)
      .in('id', keys)
      .order('id', { ascending: true })
      .range(from, to), { chunkSize: CHUNK })
    const paused = new Set(rows.filter((r) => r.status === 'paused').map((r) => r.id))
    for (const f of followups) {
      if (f.sequence_id && paused.has(f.sequence_id)) {
        items.push({ code: 'sequence_paused', message: 'A follow-up sequence is paused.', stageId: f.stage_id })
      }
    }
  }

  if (board.enabled && board.baseline_at && entered7 === 0) {
    items.push({ code: 'nobody_entered_7d', message: 'Nobody has entered this board in the last 7 days.' })
  }
  return items
}

/**
 * @returns {Promise<{funnel: object|null, conversion: object|null, revenue: object|null, followups: object[]|null, health: object[]|null}>}
 */
export async function buildBoardReport(db, { board, locationId, nowMs = Date.now(), includeRevenue = false }) {
  const ids = { boardId: board?.id, locationId }
  let deals = null
  try {
    deals = await readDeals(db, locationId, board.id)
  } catch (e) {
    logError(MODULE, 'deals read failed', { ...ids, err: e?.message || String(e) })
  }

  let moves = null
  if (deals) {
    moves = await block('moves', ids, () => readMoves(db, locationId, deals.map((d) => d.id), new Date(nowMs - 30 * DAY_MS).toISOString()))
  }
  let starts = null
  if (deals) starts = await block('claims', ids, () => readClaimStarts(db, board, locationId, deals, nowMs))
  const entered = deals ? enteredCounts(deals, starts, nowMs) : { entered7: null, entered30: null }
  const funnel = deals && moves ? buildFunnel(board, deals, moves, nowMs, entered) : null
  const conversion = deals ? buildConversion(board, deals, starts, nowMs) : null
  const revenue = includeRevenue && deals
    ? await block('revenue', ids, () => buildRevenue(db, board, locationId, deals))
    : null
  const followups = deals ? await block('followups', ids, () => buildFollowups(db, board, locationId, deals)) : null
  const entered7 = entered.entered7
  const health = await block('health', ids, () => buildHealth(db, board, locationId, entered7))
  return { funnel, conversion, revenue, followups, health }
}
