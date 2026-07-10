// WA-BSUID.1 — capture-only persistence of Meta's Business-Scoped User IDs.
//
// Meta is rolling out usernames + BSUIDs: users will be able to hide their
// phone number, and webhooks will then carry a business-scoped id instead.
// All CRM identity is phone-keyed today (contacts.wa_phone, conversations
// unique on (location_id, wa_phone)) — when the rollout reaches Ireland,
// threading and consent history need an anchor. This module CAPTURES the id
// when Meta sends it (surfaced as `user_id` on the webhook `contacts[]`
// entry alongside `wa_id`); it changes NO matching/dedupe/auth/consent logic.

/**
 * Pull the BSUID off the inbound webhook `contacts[]` array, if present.
 * Prefers the entry whose wa_id matches the sender; falls back to the first
 * entry (the array carries exactly one entry per message in practice).
 * Defensive: today's payloads have no `user_id` at all → null.
 *
 * @param {Array|undefined} contacts   webhook change.value.contacts
 * @param {string} senderPhone         message.from (wa_id format, no '+')
 * @returns {string|null}
 */
export function extractInboundBsuid(contacts, senderPhone) {
  if (!Array.isArray(contacts) || contacts.length === 0) return null
  const entry = contacts.find((c) => c?.wa_id === senderPhone) || contacts[0]
  const bsuid = entry?.user_id
  if (typeof bsuid !== 'string') return null
  const trimmed = bsuid.trim()
  return trimmed || null
}

/**
 * Stamping decision for one row — pure.
 *   'set'      → nothing stored yet, write the incoming value
 *   'noop'     → nothing incoming, or stored value already matches
 *   'mismatch' → a DIFFERENT value is stored. NEVER overwrite — a changed
 *                BSUID on the same phone/conversation is a future identity
 *                collision signal (e.g. number recycled to a new person).
 *
 * @param {string|null|undefined} existing  stored wa_bsuid
 * @param {string|null} incoming            extracted from the webhook
 * @returns {'set'|'noop'|'mismatch'}
 */
export function bsuidStampAction(existing, incoming) {
  if (!incoming) return 'noop'
  if (existing == null || existing === '') return 'set'
  return existing === incoming ? 'noop' : 'mismatch'
}

/**
 * Capture the inbound BSUID onto the matched conversation + contact.
 * Best-effort and self-contained: swallows every error (the WhatsApp webhook
 * must never fail because of a capture-only column — including the window
 * where mig 397 hasn't been applied yet). Costs zero extra queries on
 * today's payloads (no user_id → immediate return).
 *
 * @param {object} db  service-role supabase client
 * @param {{ contacts?: Array, senderPhone: string, conversationId?: string|null, contactId?: string|null }} args
 */
export async function captureInboundBsuid(db, { contacts, senderPhone, conversationId, contactId }) {
  const bsuid = extractInboundBsuid(contacts, senderPhone)
  if (!bsuid) return

  try {
    if (conversationId) {
      const { data: conv } = await db
        .from('whatsapp_conversations')
        .select('id, wa_bsuid')
        .eq('id', conversationId)
        .maybeSingle()
      const action = bsuidStampAction(conv?.wa_bsuid, bsuid)
      if (action === 'set') {
        // .is() guard makes the write race-safe against a concurrent stamp.
        await db.from('whatsapp_conversations')
          .update({ wa_bsuid: bsuid })
          .eq('id', conversationId)
          .is('wa_bsuid', null)
      } else if (action === 'mismatch') {
        console.warn(`[wa-bsuid] conversation ${conversationId} already carries wa_bsuid ${conv?.wa_bsuid} but inbound webhook carried ${bsuid} — possible identity collision, NOT overwriting`)
      }
    }

    if (contactId) {
      const { data: contactRow } = await db
        .from('contacts')
        .select('id, wa_bsuid')
        .eq('id', contactId)
        .maybeSingle()
      const action = bsuidStampAction(contactRow?.wa_bsuid, bsuid)
      if (action === 'set') {
        await db.from('contacts')
          .update({ wa_bsuid: bsuid })
          .eq('id', contactId)
          .is('wa_bsuid', null)
      } else if (action === 'mismatch') {
        console.warn(`[wa-bsuid] contact ${contactId} already carries wa_bsuid ${contactRow?.wa_bsuid} but inbound webhook carried ${bsuid} — possible identity collision, NOT overwriting`)
      }
    }
  } catch (e) {
    console.warn('[wa-bsuid] capture failed (non-fatal):', e?.message)
  }
}
