import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccessOr404, requireInboxPermission } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { rankContactSuggestions } from '@/lib/instagram-contact-link'
import { escapeLikePattern } from '@/lib/like-escape'
import { linkThreadToContact } from '@/lib/instagram-contact-link-server'

// IG-LINK.1 — attach an Instagram thread to a CRM contact.
//
// Instagram gives no phone/email, so there is no automatic key like
// WhatsApp's number: a human picks the person once, and we remember the
// IGSID on the contact (mig 539) so every later thread resolves for free.
//
// GET    ?q=  → ranked suggestions (or a search) for the picker
// POST   { contact_id } → link this thread to an existing contact
// DELETE → unlink (clears the thread's contact and the stored IGSID)

const LinkSchema = z.object({ contact_id: uuidLike })

async function loadConversation(db, id) {
  const { data } = await db.from('instagram_conversations')
    .select('id, contact_id, location_id, ig_user_id, ig_username, customer_name')
    .eq('id', id)
    .single()
  return data
}

export async function GET(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const perm = requireInboxPermission(user, 'ig')
  if (perm) return perm

  const db = createServerClient()
  const conversation = await loadConversation(db, params.id)
  if (!conversation) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  const guard = assertLocationAccessOr404(user, conversation.location_id)
  if (guard) return guard

  const q = (new URL(request.url).searchParams.get('q') || '').trim()
  const select = 'id, name, first_name, last_name, email, phone, instagram_igsid'
  let candidates = []

  if (q) {
    // Explicit staff search — name/email/phone, same shape the contacts UI uses.
    // Escaped: a stray % or _ would silently widen the search, and a comma or
    // paren would break the PostgREST filter group into a 400.
    const like = `%${escapeLikePattern(q).replace(/[(),]/g, ' ')}%`
    const { data } = await db.from('contacts')
      .select(select)
      .eq('location_id', conversation.location_id)
      .or(`name.ilike.${like},email.ilike.${like},phone.ilike.${like}`)
      .order('name')
      .limit(10)
    candidates = data || []
    return NextResponse.json({
      success: true,
      results: candidates.map(contact => ({ contact, score: null })),
    })
  }

  // No query → suggest from what Instagram tells us. Candidates are narrowed
  // in SQL by the display-name tokens so this never walks the contact book;
  // ranking is advisory only and a human always confirms.
  // Tokens come from an Instagram display name the sender controls, so they
  // are escaped (LIKE wildcards) and stripped of the characters that would
  // break the PostgREST filter group.
  const name = (conversation.customer_name || '').trim()
  const tokens = name
    .split(/\s+/)
    .map(t => escapeLikePattern(t).replace(/[(),.]/g, ''))
    .filter(t => t.length > 1)
    .slice(0, 3)
  if (tokens.length) {
    const { data } = await db.from('contacts')
      .select(select)
      .eq('location_id', conversation.location_id)
      .or(tokens.map(t => `name.ilike.%${t}%`).join(','))
      .limit(25)
    candidates = data || []
  }

  return NextResponse.json({
    success: true,
    results: rankContactSuggestions(candidates, {
      displayName: name,
      handle: conversation.ig_username || '',
    }),
  })
}

export async function POST(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const perm = requireInboxPermission(user, 'ig')
  if (perm) return perm

  const validation = await validateBody(request, LinkSchema)
  if (!validation.ok) return validation.response

  const db = createServerClient()
  const conversation = await loadConversation(db, params.id)
  if (!conversation) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  const guard = assertLocationAccessOr404(user, conversation.location_id)
  if (guard) return guard

  // The contact must belong to this location — never link across studios.
  const { data: contact } = await db.from('contacts')
    .select('id')
    .eq('id', validation.data.contact_id)
    .eq('location_id', conversation.location_id)
    .maybeSingle()
  if (!contact) return NextResponse.json({ success: false, error: 'Contact not found' }, { status: 404 })

  const ok = await linkThreadToContact(db, {
    conversationId: conversation.id,
    contactId: contact.id,
    locationId: conversation.location_id,
    igsid: conversation.ig_user_id,
    handle: conversation.ig_username,
  })
  if (!ok) return NextResponse.json({ success: false, error: 'Failed to link' }, { status: 500 })

  return NextResponse.json({ success: true, contact_id: contact.id })
}

export async function DELETE(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const perm = requireInboxPermission(user, 'ig')
  if (perm) return perm

  const db = createServerClient()
  const conversation = await loadConversation(db, params.id)
  if (!conversation) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  const guard = assertLocationAccessOr404(user, conversation.location_id)
  if (guard) return guard

  // Forget the identity FIRST, then drop the thread's contact_id.
  //
  // Order is load-bearing, and getting it wrong is what BAREWRITE.1 shipped.
  // The identity clear must happen or the next inbound DM re-links the thread
  // instantly (resolveContactForInstagramThread step 1 looks the contact up by
  // `instagram_igsid` and links on the spot) and the unlink looks broken —
  // which is why a failed clear is a 500 and not a swallowed `await`.
  //
  // But the retry the operator is told to perform has to REDO the clear, and
  // the only handle on which contact to clear is `conversation.contact_id`. If
  // we nulled the conversation first, a failed clear would leave the retry
  // reading `contact_id = null`, skipping the clear entirely and answering
  // `{ success: true }` with the IGSID still set: the same silent re-link, one
  // click later, via the recovery path. Clearing first makes both legs
  // re-runnable — a failed clear leaves the thread still linked (so the retry
  // sees the same state and redoes both), and a failed conversation update
  // leaves an already-cleared identity that the retry's `.eq('instagram_igsid',
  // …)` guard turns into a legitimate zero-row no-op.
  //
  // A ZERO-row result on the clear is NOT an error: that guard means "clear it
  // only if it still points at this thread", so someone else having already
  // cleared or re-pointed it is a valid outcome. That is why count is not
  // judged here.
  if (conversation.contact_id && conversation.ig_user_id) {
    const { error: forgetError } = await db.from('contacts')
      .update({ instagram_igsid: null })
      .eq('id', conversation.contact_id)
      .eq('location_id', conversation.location_id)
      .eq('instagram_igsid', conversation.ig_user_id)
    if (forgetError) {
      return NextResponse.json({
        success: false,
        error: `Clearing the Instagram identity on the contact failed, so the thread was left linked rather than half-unlinked (an unlinked thread with the identity still set re-links on the next inbound DM). Retry: ${forgetError.message}`,
      }, { status: 500 })
    }
  }

  const { error } = await db.from('instagram_conversations')
    .update({ contact_id: null, updated_at: new Date().toISOString() })
    .eq('id', conversation.id)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

  return NextResponse.json({ success: true })
}
