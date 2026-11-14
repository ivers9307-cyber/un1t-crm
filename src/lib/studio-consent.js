// STAFFCONSENT.1 — the ONE per-studio consent write.
//
// A change to ONE studio's list (contact_location_preferences) used to live
// only inside the preference centre's PUT (LOCCOMMS.4). Staff now make the same
// change from the contact page (POST /api/contacts/[id]/studio-consent), so the
// rules live here and both callers use them:
//
//   * the studio row ONLY. Never contact_preferences: the mig 489 trigger fans
//     any channel going FALSE out to every studio, which would turn "leave the
//     Hatch list" into "leave every list".
//   * the studio-row write failing is a failure (status 500), never success.
//   * consent_log rows, one per channel that actually changed, carrying the
//     studio, and for staff the person, the reason and the note. A log failure
//     after the change landed is logged, not returned (UNSUBAUTO.3).
//   * opt-outs propagate to the person's other addresses (DUPEUNSUB.1); an
//     opt-in never does.
//   * an email opt-in normalises email_status by the shared reputation rule,
//     and lifts a MANUAL Postmark suppression (never a bounce or a complaint).
//     A studio opt-out never suppresses at Postmark: a Postmark suppression is
//     server-wide, so it would stop the other studios' mail too.
import { consentActionFor } from '@/lib/consent-actions'
import { propagateOptOut } from '@/lib/consent-propagation'
import { emailStatusNormaliseForOptIn } from '@/lib/email-reputation'
import { unsuppressAtPostmark } from '@/lib/postmark-suppressions'
import { serverTokenForLocation } from '@/lib/postmark-server-for-location'

export const STUDIO_CONSENT_CHANNELS = Object.freeze([
  'email_marketing', 'email_administrative',
  'whatsapp_marketing', 'whatsapp_administrative',
  'sms_marketing', 'sms_administrative',
])

/**
 * Apply a change to one studio's consent row for one contact.
 *
 * @param {object} db service-role client
 * @param {object} args
 * @param {{ id: string, email?: string|null, wa_phone?: string|null, email_status?: string|null, location_id?: string|null }} args.contact
 * @param {string} args.locationId the studio whose list changes
 * @param {Record<string, boolean>} args.changes channel → wanted state
 * @param {string} args.source consent_log.source (registered in consent-sources.js)
 * @returns {Promise<{ ok: true, changed: string[] } | { ok: false, status: 404|500, error: string }>}
 */
export async function applyStudioPreferenceChange(db, {
  contact,
  locationId,
  changes,
  source,
  ipAddress = null,
  performedBy = null,
  reason = null,
  note = null,
}) {
  const contactId = contact.id

  // Compare against THAT studio's row, not the global one (LOCCOMMS.4).
  const { data: locRow, error: readErr } = await db
    .from('contact_location_preferences')
    .select('email_marketing, sms_marketing, whatsapp_marketing')
    .eq('contact_id', contactId)
    .eq('location_id', locationId)
    .maybeSingle()
  if (readErr) {
    console.error('[studio-consent] studio row read failed:', { contactId, locationId, message: readErr.message })
    return { ok: false, status: 500, error: 'Could not read the studio preference' }
  }
  if (!locRow) return { ok: false, status: 404, error: 'Not found' }

  const updates = {}
  const logEntries = []
  for (const channel of STUDIO_CONSENT_CHANNELS) {
    if (typeof changes?.[channel] === 'boolean' && changes[channel] !== locRow[channel]) {
      updates[channel] = changes[channel]
      const entry = {
        contact_id: contactId,
        channel,
        action: consentActionFor(changes[channel]),
        source,
        ip_address: ipAddress,
        location_id: locationId,
      }
      // Only staff changes carry these; the preference centre's rows stay as they were.
      if (performedBy) entry.performed_by = performedBy
      if (reason) entry.reason = reason
      if (note) entry.note = note
      logEntries.push(entry)
    }
  }

  const changed = Object.keys(updates)
  if (changed.length === 0) return { ok: true, changed: [] }

  const { error: writeErr } = await db
    .from('contact_location_preferences')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('contact_id', contactId)
    .eq('location_id', locationId)
  if (writeErr) {
    console.error('[studio-consent] studio preference write failed — change NOT recorded:', {
      contactId, locationId, channels: changed, message: writeErr.message,
    })
    return { ok: false, status: 500, error: 'Could not record the preference' }
  }

  // The change has landed; the audit row is secondary (UNSUBAUTO.3).
  const { error: logErr } = await db.from('consent_log').insert(logEntries)
  if (logErr) {
    console.error('[studio-consent] consent_log insert failed (the change itself IS recorded):', {
      contactId, locationId, message: logErr.message,
    })
  }

  const optedOut = changed.filter((k) => updates[k] === false)
  if (optedOut.length > 0) {
    await propagateOptOut(db, {
      contactId,
      email: contact.email,
      waPhone: contact.wa_phone,
      channels: optedOut,
      locationId,
    })
  }

  if (updates.email_marketing === true) {
    // EMAILREP.4 — consent is not evidence the mailbox works.
    const nextStatus = emailStatusNormaliseForOptIn(contact.email_status)
    if (nextStatus) {
      const { error: statusErr } = await db
        .from('contacts')
        .update({ email_status: nextStatus })
        .eq('id', contactId)
      if (statusErr) {
        console.error('[studio-consent] email_status normalise failed (the opt-in itself IS recorded):', {
          contactId, message: statusErr.message,
        })
      }
    }

    // PMSUPP.1 — lift Postmark's refusal on an opt-in, scoped or not. The
    // helper deletes only a ManualSuppression. Best-effort: the change is durable.
    if (contact.email) {
      try {
        const serverToken = await serverTokenForLocation(db, contact.location_id)
        const result = await unsuppressAtPostmark(contact.email, { serverToken })
        if (result?.failed?.length) {
          console.error('[studio-consent] Postmark un-suppression failed (the opt-in itself IS recorded):', {
            contactId, message: result.failed[0]?.message,
          })
        }
        const heldBack = (result?.skipped || []).filter((s) => s.reason !== 'NotSuppressed')
        if (heldBack.length) {
          console.warn('[studio-consent] Postmark suppression left in place on opt-in:', {
            contactId, reason: heldBack[0].reason,
          })
        }
      } catch (err) {
        console.error('[studio-consent] Postmark un-suppression threw (the change itself IS recorded):', err?.message || err)
      }
    }
  }

  return { ok: true, changed }
}
