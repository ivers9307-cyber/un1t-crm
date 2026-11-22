// @ts-check
// INVOICEPREP.1 — remember an inbound email that matched no studio.
//
// Before this, such mail was only logged and the webhook answered 200, so it
// was gone for good. A row here lets someone see it arrived and where it was
// meant to go. email_message_id is unique: the same email retried is success.

import { logError } from '@/lib/log'
import { sanitizeDbText } from '@/lib/db-safe-text'

const MAX_TEXT = 500

/** @param {unknown} v */
const clean = (v) => {
  if (typeof v !== 'string') return null
  return sanitizeDbText(v.slice(0, MAX_TEXT)) || null
}

/**
 * @param {import('@/lib/supabase').Db} db
 * @param {{ messageId: string, to?: string|null, from?: string|null, subject?: string|null,
 *   reason: 'unparseable_recipient'|'unknown_slug', slug?: string|null }} stray
 * @returns {Promise<{ ok: boolean }>}
 */
export async function recordInboundStray(db, { messageId, to, from, subject, reason, slug }) {
  const { error } = await db.from('invoice_inbound_strays').insert({
    email_message_id: sanitizeDbText(messageId),
    to_address: clean(to),
    from_address: clean(from),
    subject: clean(subject),
    reason,
    slug: reason === 'unknown_slug' ? clean(slug) : null,
  })
  if (error && error.code !== '23505') {
    logError('invoices-inbound', 'stray insert failed', { messageId, reason, error: error.message })
    return { ok: false }
  }
  return { ok: true }
}
