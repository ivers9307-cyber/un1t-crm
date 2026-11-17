import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccess , getUserLocationIds, requireInboxPermission } from '@/lib/auth'
import { attachAssigneeNames } from '@/lib/inbox-assignment'
import { INBOX_SEARCH_MIN_LENGTH, buildInboxSearchOr, searchInboxContactIds, searchWhatsAppMessageHits } from '@/lib/inbox-search-server'
import { hasPermissionForLocation, hasMobilePermissionForLocation } from '@/lib/permissions'

// GET /api/whatsapp/conversations — list conversations (inbox)
export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  // Channel permission — service-role client, so this IS the gate (INBOX-PERM.1).
  const perm = requireInboxPermission(user, 'wa')
  if (perm) return perm

  const { searchParams } = new URL(request.url)
  const locationId = searchParams.get('location_id')
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard

  const db = createServerClient()
  let query = db.from('whatsapp_conversations')
    .select('*, contacts!contact_id(id, name, first_name, phone, wa_phone, pipeline_stage_slug)')
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(50)

  if (locationId) {
    query = query.eq('location_id', locationId)
  } else {
    const userLocationIds = getUserLocationIds(user)
    if (userLocationIds.length === 0) return NextResponse.json({ success: true, conversations: [] })
    query = query.in('location_id', userLocationIds)
  }

  // INBOX-SEARCH.1 — ?q= turns the latest-50 window into the most-recent
  // 50 MATCHES: linked-contact hits (name/phone/email, via a scoped id
  // lookup — embedded-resource filters are unreliable, see CLAUDE.md) OR
  // the conversation's own denormalised fields.
  const q = (searchParams.get('q') || '').trim()
  // WAMSGSEARCH.1 — snippet of the newest matching message, per thread.
  const snippets = new Map()
  if (q.length >= INBOX_SEARCH_MIN_LENGTH) {
    const scopeIds = locationId ? [locationId] : getUserLocationIds(user)
    // WAMSGSEARCH.1 — message TEXT (3+ characters) only at the studios where
    // the caller holds WhatsApp (web or mobile), the thread routes' rule
    // (requireWhatsAppInboxAt): membership alone does not open the bodies.
    const messageScope = scopeIds.filter((id) => (
      hasPermissionForLocation(user, id, 'whatsapp') || hasMobilePermissionForLocation(user, id, 'whatsapp')
    ))
    const [contactIds, messageSearch] = await Promise.all([
      searchInboxContactIds(db, { q, locationIds: scopeIds }),
      searchWhatsAppMessageHits(db, { q, locationIds: messageScope }),
    ])
    for (const hit of messageSearch.hits) snippets.set(hit.conversation_id, hit.snippet)
    query = query.or(buildInboxSearchOr('whatsapp_conversations', q, contactIds, [...snippets.keys()]))
  }

  const { data, error } = await query
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

  // INBOX-APPROVALS — flag threads with a pending agent request so the
  // queue can badge them. One batched query over this page's ids (≤50).
  const conversations = data || []
  if (conversations.length) {
    const { data: pend } = await db.from('agent_membership_requests')
      .select('conversation_id')
      .eq('status', 'pending')
      .in('conversation_id', conversations.map(c => c.id))
    const pendingSet = new Set((pend || []).map(r => r.conversation_id))
    for (const c of conversations) {
      c.pending_approval = pendingSet.has(c.id)
      if (snippets.has(c.id)) c.search_snippet = snippets.get(c.id)
    }
  }

  // INBOXASSIGN.1 — each row's owner name for the queue (best effort;
  // profiles has no client grant, so the name resolves here or nowhere).
  await attachAssigneeNames(db, conversations)

  return NextResponse.json({ success: true, conversations })
}
