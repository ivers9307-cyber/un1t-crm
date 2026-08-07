import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccess, getUserLocationIds, requireInboxPermission } from '@/lib/auth'

// GET /api/email/conversations — list email conversations (EMAIL-INBOX.1).
// Mirrors /api/instagram/conversations: reads are location-scoped to a
// specific ?location_id (access-checked) or the union of the caller's
// locations. Service-role client because the email_* RLS denies
// authenticated writes and we re-impose the read scope here in the query.
//
// INBOX-SPLIT.1 (2026-08-07) — the WEB unified inbox no longer calls this;
// email is worked at /communications/tickets. The route stays because the
// MOBILE app still reads it (mobile/lib/email-api.js → the Messages tab and
// mobile/app/email/[conversationId].jsx). What went with the web inbox is
// the ?q= branch: it existed only for INBOX-SEARCH.1's fan-out, mobile never
// sends ?q=, and `email_conversations` has left INBOX_SEARCH_FIELDS (where
// buildInboxSearchOr now throws on it), so keeping the branch would have
// turned any ?q= into a 500.
export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  // Channel permission — service-role client, so this IS the gate (INBOX-PERM.1).
  const perm = requireInboxPermission(user, 'em')
  if (perm) return perm

  const { searchParams } = new URL(request.url)
  const locationId = searchParams.get('location_id')

  const db = createServerClient()
  let query = db.from('email_conversations')
    .select('*, contacts!contact_id(id, name, first_name, email, pipeline_stage_slug)')
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(50)

  if (locationId) {
    const guard = assertLocationAccess(user, locationId)
    if (guard) return guard
    query = query.eq('location_id', locationId)
  } else {
    const userLocationIds = getUserLocationIds(user)
    if (userLocationIds.length === 0) return NextResponse.json({ success: true, conversations: [] })
    query = query.in('location_id', userLocationIds)
  }

  const { data, error } = await query
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

  return NextResponse.json({ success: true, conversations: data || [] })
}
