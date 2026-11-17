// INBOXASSIGN.1 — who owns an inbox thread, on all three channels.
//
// `assigned_to` has existed on whatsapp_conversations (mig 007),
// instagram_conversations (mig 231) and email_tickets (mig 482) for months,
// and nothing wrote it, so two people could answer the same customer. The
// WhatsApp webhook and the Instagram agent already page ONLY the owner of an
// assigned thread, and the mail push narrows to the owner too
// (EMAIL-PUSH-ASSIGNEE.1), so an owner set here changes who is woken up.
//
// SPLIT OF WORK. Each channel's route keeps that channel's own thread gate
// (it reads the thread, 404s anything the caller may not have) and then hands
// the loaded thread to this module, which owns the rest: who may be named,
// the write and its two checks, and the names the UI shows. One definition of
// "assignable", so the three channels cannot drift.
//
// WHO MAY BE NAMED. A current member of the THREAD'S studio (a
// profile_locations row there), active, not a tombstone, who can use the
// channel AT THAT STUDIO, resolved through the same tier order as
// hasPermissionForLocation (studio switch + bundle, master, per-user
// override, employment-type template over the 'all' template, role default):
//   • whatsapp / instagram — the web OR the mobile `whatsapp` key, the rule
//     the WhatsApp thread routes use (requireWhatsAppInboxAt). Instagram has
//     no key of its own; its routes ride `whatsapp` (INBOX_CHANNEL_PERMISSION_KEYS).
//   • mail — the web `email_inbox` key AND sight of the thread's mailbox (a
//     grant in email_mailbox_access, owner at the studio, or master), the
//     rule loadConversationForUser applies; a NULL-mailbox thread is
//     elevated-only, exactly as it is to read.
// Not covered, on purpose: SAAS-4 org admins and masters who hold no
// profile_locations row at the studio are not offered in the picker (there is
// no membership row to resolve them from — the trade email-inbound-push.js
// makes). They can still take a thread themselves ("assign to me"), because
// the caller has already passed the thread's gate.
//
// THE WRITE. Last write wins (no compare-and-set): the person looking at the
// thread is correcting it. It is pinned to the thread's id AND studio, its
// error is checked, and exactly one row must come back — a zero-row update
// (the thread was moved to another studio or vanished between the read and
// the write) is a 409, never a success.

import { z } from 'zod'
import { uuidLike } from '@/lib/schemas'
import { excludeTombstones } from '@/lib/staff-tombstone'
import { logError } from '@/lib/log'
import {
  resolvePermission,
  mergeTemplates,
  DEFAULT_WEB_PERMISSIONS_BY_ROLE,
  DEFAULT_MOBILE_PERMISSIONS_BY_ROLE,
} from '@shared/permissions'

export const ASSIGN_CHANNELS = Object.freeze(['whatsapp', 'instagram', 'mail'])

export const ASSIGN_TABLES = Object.freeze({
  whatsapp: 'whatsapp_conversations',
  instagram: 'instagram_conversations',
  mail: 'email_tickets',
})

// 'me' claims it, null clears it, an id names a colleague. uuidLike, never
// z.string().uuid(): zod 4's RFC check refuses the estate's seeded ids.
export const AssignBodySchema = z.object({
  assignee: z.union([z.literal('me'), z.null(), uuidLike]),
})

// A studio has tens of staff; every select caps at 1,000 rows, so the bound
// is stated rather than left implicit.
const MEMBER_LIMIT = 500

/**
 * Pure. Can this member use `channel` at the studio whose links, templates
 * and features were read? `link` is their profile_locations row there,
 * `profile` their profiles row.
 */
export function canUseChannelHere({ channel, link, profile, templates, features, grantedProfileIds, mailboxId }) {
  if (!link || !profile) return false
  const isMaster = profile.role === 'master'
  const role = isMaster ? 'master' : link.role
  if (!role) return false
  const location = { features: features || {} }
  const rowFor = (r, emp) =>
    (templates || []).find(t => t.role === r && t.employment_type === emp)?.permissions || null
  const template = mergeTemplates(
    rowFor(link.role, 'all'),
    profile.employment_type ? rowFor(link.role, profile.employment_type) : null,
  )
  const perms = link.permissions || {}
  const web = (key) => resolvePermission({
    role, location, permissions: perms, roleTemplate: template,
    defaults: DEFAULT_WEB_PERMISSIONS_BY_ROLE, key,
  })
  const mobile = (key) => resolvePermission({
    role, location, permissions: perms.mobile || {}, roleTemplate: template?.mobile || null,
    defaults: DEFAULT_MOBILE_PERMISSIONS_BY_ROLE, key,
  })

  if (channel === 'whatsapp' || channel === 'instagram') {
    return web('whatsapp') || mobile('whatsapp')
  }
  if (channel === 'mail') {
    if (!web('email_inbox')) return false
    if (isMaster || link.role === 'owner') return true
    if (!mailboxId) return false // NULL-mailbox threads are elevated-only
    return (grantedProfileIds || []).includes(profile.id)
  }
  return false // unknown channel: fail closed
}

/**
 * The staff who may own a thread on `channel` at `locationId`: names only.
 *
 * @returns {Promise<{ ok: true, staff: Array<{ id: string, full_name: string|null }> } | { ok: false }>}
 *   ok:false means a read FAILED — never treat it as "nobody".
 */
export async function loadAssignableStaff(db, { channel, locationId, mailboxId = null }) {
  if (!ASSIGN_CHANNELS.includes(channel) || !locationId) return { ok: false }

  const [linksRes, tplRes, locRes, grantRes] = await Promise.all([
    db.from('profile_locations')
      .select('profile_id, role, permissions')
      .eq('location_id', locationId)
      .limit(MEMBER_LIMIT),
    db.from('location_role_permissions')
      .select('role, employment_type, permissions')
      .eq('location_id', locationId)
      .limit(MEMBER_LIMIT),
    db.from('locations').select('features').eq('id', locationId).maybeSingle(),
    channel === 'mail' && mailboxId
      ? db.from('email_mailbox_access').select('profile_id').eq('mailbox_id', mailboxId).limit(MEMBER_LIMIT)
      : Promise.resolve({ data: [], error: null }),
  ])

  // Every one of these decides WHO, so a failure in any of them is refused
  // rather than degraded: a guessed template or feature switch could offer
  // someone who cannot open the thread.
  const failed = linksRes?.error || tplRes?.error || locRes?.error || grantRes?.error
  if (failed) {
    logError('inbox-assignment', 'assignable staff lookup failed', { channel, locationId, error: failed.message })
    return { ok: false }
  }
  if (!locRes?.data) {
    logError('inbox-assignment', 'studio row missing for assignable staff', { channel, locationId })
    return { ok: false }
  }

  const links = linksRes.data || []
  if (links.length === 0) return { ok: true, staff: [] }
  const linkById = new Map(links.map(l => [l.profile_id, l]))

  const { data: profiles, error: profErr } = await excludeTombstones(
    db.from('profiles')
      .select('id, full_name, role, employment_type')
      .in('id', [...linkById.keys()])
      .eq('active', true),
  ).limit(MEMBER_LIMIT)
  if (profErr) {
    logError('inbox-assignment', 'assignable staff profiles read failed', { channel, locationId, error: profErr.message })
    return { ok: false }
  }

  const grantedProfileIds = (grantRes.data || []).map(g => g.profile_id)
  const staff = (profiles || [])
    .filter(profile => canUseChannelHere({
      channel,
      link: linkById.get(profile.id),
      profile,
      templates: tplRes.data || [],
      features: locRes.data.features || {},
      grantedProfileIds,
      mailboxId,
    }))
    .map(p => ({ id: p.id, full_name: p.full_name || null }))
    .sort((a, b) => String(a.full_name || '').localeCompare(String(b.full_name || '')))

  return { ok: true, staff }
}

/**
 * Names for a set of profile ids, best effort: a failed read is an empty map
 * (the UI then says "Assigned"), never a failed list.
 *
 * @returns {Promise<Map<string, string|null>>}
 */
export async function loadAssigneeNames(db, ids) {
  const unique = [...new Set((ids || []).filter(Boolean))]
  if (unique.length === 0) return new Map()
  try {
    const { data, error } = await db.from('profiles')
      .select('id, full_name')
      .in('id', unique)
    if (error) {
      logError('inbox-assignment', 'assignee names read failed', { error: error.message })
      return new Map()
    }
    return new Map((data || []).map(p => [p.id, p.full_name || null]))
  } catch (err) {
    logError('inbox-assignment', 'assignee names read threw', { error: err?.message })
    return new Map()
  }
}

/** Stamp `assignee_name` on each list row that has an owner. Mutates and returns `rows`. */
export async function attachAssigneeNames(db, rows) {
  const list = rows || []
  const names = await loadAssigneeNames(db, list.map(r => r?.assigned_to))
  for (const row of list) {
    if (row) row.assignee_name = row.assigned_to ? (names.get(row.assigned_to) ?? null) : null
  }
  return list
}

/**
 * Decide and write the owner of an already-gated thread.
 *
 * @param {object} db  service-role client
 * @param {{ channel: string, user: object, thread: { id: string, location_id: string, assigned_to?: string|null, mailbox_id?: string|null }, assignee: 'me'|null|string }} args
 * @returns {Promise<{ status: number, body: object }>}
 */
export async function assignThread(db, { channel, user, thread, assignee }) {
  const table = ASSIGN_TABLES[channel]
  if (!table || !thread?.id || !thread?.location_id || !user?.id) {
    return { status: 400, body: { success: false, error: 'Unknown channel' } }
  }

  let next
  if (assignee === null) next = null
  else if (assignee === 'me' || assignee === user.id) next = user.id // passed the thread gate already
  else {
    const assignable = await loadAssignableStaff(db, {
      channel, locationId: thread.location_id, mailboxId: thread.mailbox_id || null,
    })
    if (!assignable.ok) {
      return { status: 500, body: { success: false, error: 'Could not check who can take this conversation. Nothing was changed — try again.' } }
    }
    if (!assignable.staff.some(s => s.id === assignee)) {
      return {
        status: 400,
        body: { success: false, error: 'That person cannot work this conversation at this studio.', code: 'assignee_not_eligible' },
      }
    }
    next = assignee
  }

  if ((thread.assigned_to || null) !== next) {
    const { data, error } = await db.from(table)
      .update({ assigned_to: next })
      .eq('id', thread.id)
      .eq('location_id', thread.location_id)
      .select('id, assigned_to')
    if (error) {
      logError('inbox-assignment', 'owner write failed', { channel, threadId: thread.id, error: error.message })
      return { status: 500, body: { success: false, error: 'Could not save who owns this conversation. Try again.' } }
    }
    if (!Array.isArray(data) || data.length !== 1) {
      logError('inbox-assignment', 'owner write matched no thread', { channel, threadId: thread.id, rows: Array.isArray(data) ? data.length : null })
      return { status: 409, body: { success: false, error: 'This conversation changed while you were looking at it. Reload and try again.' } }
    }
  }

  const names = next ? await loadAssigneeNames(db, [next]) : new Map()
  return {
    status: 200,
    body: { success: true, data: { assigned_to: next, assignee_name: next ? (names.get(next) ?? null) : null } },
  }
}

/**
 * The picker's answer for an already-gated thread: the current owner and the
 * staff who may be named, names only.
 *
 * @returns {Promise<{ status: number, body: object }>}
 */
export async function assignPickerFor(db, { channel, user, thread }) {
  const assignable = await loadAssignableStaff(db, {
    channel, locationId: thread.location_id, mailboxId: thread.mailbox_id || null,
  })
  if (!assignable.ok) {
    return { status: 500, body: { success: false, error: 'Could not load who can take this conversation. Try again.' } }
  }
  const owner = thread.assigned_to || null
  const listed = owner ? assignable.staff.find(s => s.id === owner) : null
  const ownerName = owner
    ? (listed ? listed.full_name : ((await loadAssigneeNames(db, [owner])).get(owner) ?? null))
    : null
  return {
    status: 200,
    body: {
      success: true,
      data: {
        assigned_to: owner,
        assignee_name: ownerName,
        viewer_id: user.id,
        staff: assignable.staff,
      },
    },
  }
}
