import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/with-auth'
import { assertLocationAccessOr404, requireWebWhatsAppInboxAnywhere, requireWebWhatsAppInboxAt } from '@/lib/auth'
import { logError } from '@/lib/log'
import { validateBody } from '@/lib/validate'
import { email as emailSchema, phone as phoneSchema } from '@/lib/schemas'
import { linkThreadToContact } from '@/lib/instagram-contact-link-server'

// IG-LINK.1 — promote an unknown Instagram sender to a full contact.
// Mirrors the WhatsApp add-contact route; the Instagram difference is that
// there is no phone number to identify them by, so we stamp the IGSID
// (mig 539) as the durable identity instead.

const AddContactSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  first_name: z.string().max(100).optional(),
  email: emailSchema.nullable().optional(),
  phone: phoneSchema.nullable().optional(),
})

// withAuth only signs the caller in (the same 401); the channel permission, the
// body, the conversation (404) and its studio (404) keep their order.
export const POST = withAuth({ permission: null, location: false }, async ({ user, db, request, params }) => {

  // Channel permission — service-role client, so this IS the gate (INBOX-PERM.1).
  // SECGAPS.1 — 'ig' rides the web `whatsapp` key: a coarse any-studio check
  // here, the decision at the conversation's own studio once it is read (the
  // WhatsApp thread routes' INBOXLOC.1 rule).
  const perm = requireWebWhatsAppInboxAnywhere(user)
  if (perm) return perm

  const validation = await validateBody(request, AddContactSchema)
  if (!validation.ok) return validation.response
  const { name, first_name, email, phone } = validation.data

  const { data: conversation, error: convErr } = await db.from('instagram_conversations')
    .select('id, contact_id, location_id, ig_user_id, ig_username, customer_name')
    .eq('id', params.id)
    .single()
  if (convErr || !conversation) {
    return NextResponse.json({ success: false, error: 'Conversation not found' }, { status: 404 })
  }

  const guard = assertLocationAccessOr404(user, conversation.location_id)
  if (guard) return guard
  const permHere = requireWebWhatsAppInboxAt(user, conversation.location_id)
  if (permHere) return permHere

  if (conversation.contact_id) {
    return NextResponse.json({ success: true, contact_id: conversation.contact_id, already_linked: true })
  }

  // Instagram gives us a display name and handle only — no phone/email — so
  // fall back to the handle for a name rather than creating a nameless row.
  const resolvedName = name
    || conversation.customer_name
    || (conversation.ig_username ? `@${conversation.ig_username}` : 'Instagram user')

  const { data: contact, error: contactErr } = await db.from('contacts')
    .insert({
      name: resolvedName,
      first_name: first_name || resolvedName.split(' ')[0] || null,
      email: email || null,
      phone: phone || null,
      instagram_igsid: conversation.ig_user_id,
      instagram_handle: conversation.ig_username || null,
      lead_source: 'instagram',
      location_id: conversation.location_id,
    })
    .select('id')
    .single()

  if (contactErr) {
    logError('ig-add-contact', 'contact create failed', { conversationId: conversation.id, err: contactErr })
    return NextResponse.json({ success: false, error: 'Could not create the contact. Try again.' }, { status: 500 })
  }

  // Links the thread, stamps the identity, and backfills the thread's
  // existing messages onto the new contact's timeline. Reported honestly: if
  // the link fails the contact still exists, but the thread is NOT attached —
  // saying "success" there would close the modal on a half-done job.
  const linked = await linkThreadToContact(db, {
    conversationId: conversation.id,
    contactId: contact.id,
    locationId: conversation.location_id,
    igsid: conversation.ig_user_id,
    handle: conversation.ig_username,
  })
  if (!linked) {
    return NextResponse.json({
      success: false,
      error: 'Contact created, but linking the conversation failed — try linking it to that contact.',
      contact_id: contact.id,
    }, { status: 500 })
  }

  try {
    // Genuinely best-effort (see the catch below) — but read the error rather
    // than discarding it, so a systematic timeline failure is visible in logs.
    const { error: timelineError } = await db.from('activities').insert({
      contact_id: contact.id,
      location_id: conversation.location_id,
      kind: 'event',
      type: 'instagram',
      subject: 'Contact created from Instagram',
      note: `Created from the Instagram conversation${conversation.ig_username ? ` with @${conversation.ig_username}` : ''}.`,
      done: true,
    })
    if (timelineError) console.error('[ig-add-contact] timeline entry failed (non-fatal):', timelineError.message)
  } catch { /* timeline entry is a nicety, never fail the create */ }

  return NextResponse.json({ success: true, contact_id: contact.id })
})
