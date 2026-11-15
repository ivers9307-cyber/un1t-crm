// POST /api/contacts/bulk-delete
//
// Hard-delete N contacts in one request. MANAGER_ROLES required
// (head_coach / manager / owner / master). Each contact must be at
// the caller's location (master is exempt). Same cascade rules as
// the per-contact DELETE — we just iterate.
//
// Body: { contact_ids: uuid[] }  — capped at 200 per request
//
// Returns:
//   {
//     success: true,
//     data: {
//       requested: number,
//       deleted: number,
//       blocked: [{ id, name, reason, block_delete? }], // refused before any scrub (DELBLOCK.2), or a late FK refusal
//       forbidden: [{ id, name, reason }],   // 'Different location' or 'Role'
//       missing: string[],                   // ids that didn't resolve
//       scrub_warnings?: [{ id, name, failures }] // MAIL-GDPR.1: partial mail scrub (deleted anyway).
//                                            // Key ABSENT on a clean run, like the single route.
//     }
//   }
//
// We DON'T fail the whole request if a subset is blocked — partial
// success is the right shape for a bulk action so the operator gets
// a useful breakdown back, can dismiss the dialog, and resolve the
// blocked rows individually (typically by merging first).

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, hasRoleAtLocation, hasRoleAtAnyLocation } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { uuidLike, MANAGER_ROLES } from '@/lib/schemas'
import { redactWhatsAppForContact, redactInBodyForContact, getContactImpact } from '@/lib/contact-merge'
import { redactMailForContact } from '@/lib/contact-mail-erasure'
import { forgetRevolutCustomerForContact } from '@/lib/revolut-customers'
import { logError, logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Body = z.object({
  contact_ids: z.array(uuidLike).min(1).max(200),
})

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  // ROLESWEEP.1c — coarse pre-check; the role is judged per row below.
  if (!hasRoleAtAnyLocation(user, MANAGER_ROLES)) {
    return NextResponse.json({
      success: false,
      error: 'Head coach, manager, owner, or master required',
    }, { status: 403 })
  }

  const validation = await validateBody(request, Body)
  if (!validation.ok) return validation.response
  const { contact_ids } = validation.data
  const uniqueIds = [...new Set(contact_ids)]

  const db = createServerClient()
  const { data: rows, error: readErr } = await db
    .from('contacts')
    .select('id, name, location_id')
    .in('id', uniqueIds)
  // A failed read is not "none of these exist": it used to report every id
  // as missing. Refuse; nothing has been touched.
  if (readErr) {
    logError('contacts.bulk-delete', 'contacts read failed; nothing deleted', { code: readErr.code ?? null, message: readErr.message })
    return NextResponse.json({ success: false, error: 'Could not read those contacts. Nothing was changed — try again in a moment.' }, { status: 500 })
  }

  const byId = new Map((rows || []).map(r => [r.id, r]))
  const userLocIds = new Set((user.locations || []).map(l => l.id).filter(Boolean))

  const result = {
    requested: uniqueIds.length,
    deleted: 0,
    blocked: [],
    forbidden: [],
    missing: [],
  }

  for (const id of uniqueIds) {
    const row = byId.get(id)
    if (!row) {
      result.missing.push(id)
      continue
    }
    if (user.role !== 'master' && !userLocIds.has(row.location_id)) {
      result.forbidden.push({ id, name: row.name, reason: 'Different location' })
      continue
    }
    // ROLESWEEP.1c — MANAGER_ROLES at THIS contact's location.
    if (!hasRoleAtLocation(user, row.location_id, MANAGER_ROLES)) {
      result.forbidden.push({ id, name: row.name, reason: 'Role' })
      continue
    }
    // DELBLOCK.2 — the single-delete route's blocker check (DELBLOCK.1),
    // BEFORE any scrub. Without it a contact the database will refuse to
    // delete (a person-group primary, an offer purchase: RESTRICT / NO ACTION
    // FKs) had its WhatsApp redacted, InBody scans hard-deleted and mail
    // anonymised, then the delete failed and the row came back "blocked",
    // still there and stripped of its history (audit 2026-11-15, item 4).
    // Fail closed, as the single route does: "could not look" is a refusal.
    let impact
    try {
      impact = await getContactImpact(db, id)
    } catch (e) {
      logWarn('contacts.bulk-delete', `impact check threw for ${id}`, { err: e })
      impact = null
    }
    if (!impact || impact.partial) {
      result.blocked.push({
        id,
        name: row.name,
        reason: 'Could not check what depends on this contact, so it was not deleted. Nothing was changed.',
      })
      continue
    }
    const blockers = impact.block_delete || []
    if (blockers.length > 0) {
      result.blocked.push({
        id,
        name: row.name,
        reason: `${blockers.map(b => `${b.count} ${b.label}`).join(', ')}. Reassign or remove those first.`,
        block_delete: blockers,
      })
      continue
    }
    // Mig 094: GDPR scrub of WhatsApp PII before the contact row
    // delete. Idempotent — safe to call even if the contact has no
    // WhatsApp history. Best-effort: a scrub failure won't stop
    // us trying the delete, since the FK rules now SET NULL on
    // conversations + messages anyway.
    await redactWhatsAppForContact(db, id)
    // GDPR erasure gap (audit M3): InBody tables SET NULL their contact
    // FK, so raw body-composition payloads + phone survive orphaned.
    // Hard-delete them before the contact row (must run pre-delete).
    await redactInBodyForContact(db, id)
    // REVPAY.13: the email → Revolut customer mapping holds the address in
    // clear and is not keyed to the contact. Best-effort, like the scrubs here.
    await forgetRevolutCustomerForContact(db, id)
    // MAIL-GDPR.1: mail tickets/messages/attachments, same doctrine as the two
    // above (anonymise in place, best-effort, the delete still runs). Its
    // failures are reported per contact rather than swallowed — see the
    // single-delete route for why a partial is never a refusal.
    let mailScrub
    try {
      mailScrub = await redactMailForContact(db, id)
    } catch (e) {
      logError('contacts.bulk-delete', `mail scrub threw for ${id}`, { err: e })
      mailScrub = { ok: false, failures: [{ table: 'mail', op: 'scrub', message: e?.message || String(e) }] }
    }
    if (mailScrub.failures.length > 0) {
      (result.scrub_warnings ??= []).push({ id, name: row.name, failures: mailScrub.failures })
    }
    const { error } = await db.from('contacts').delete().eq('id', id)
    if (error) {
      // After mig 094 there shouldn't be FK-blocked deletes, but
      // we keep the friendly message in case some future protected
      // FK gets added without a redact step.
      const isFk = error.code === '23503' || /foreign key|violates/i.test(error.message || '')
      result.blocked.push({
        id,
        name: row.name,
        reason: isFk
          ? 'A protected FK is still pointing at this contact.'
          : (error.message || 'Delete failed'),
      })
      continue
    }
    result.deleted += 1
  }

  return NextResponse.json({ success: true, data: result })
}
