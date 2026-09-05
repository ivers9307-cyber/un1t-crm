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
//       blocked: [{ id, name, reason }],     // FK violation (whatsapp_*) etc.
//       forbidden: [{ id, name, reason }],   // wrong location
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
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { uuidLike, MANAGER_ROLES } from '@/lib/schemas'
import { redactWhatsAppForContact, redactInBodyForContact } from '@/lib/contact-merge'
import { redactMailForContact } from '@/lib/contact-mail-erasure'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Body = z.object({
  contact_ids: z.array(uuidLike).min(1).max(200),
})

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!MANAGER_ROLES.includes(user.role)) {
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
  const { data: rows } = await db
    .from('contacts')
    .select('id, name, location_id')
    .in('id', uniqueIds)

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
