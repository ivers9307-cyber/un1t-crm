import { NextResponse } from 'next/server'
import { assertLocationAccess, getUserLocationIds, requireInboxPermission } from '@/lib/auth'
import { withAuth } from '@/lib/with-auth'
import { logError } from '@/lib/log'
import { attachAssigneeNames } from '@/lib/inbox-assignment'
import { INBOX_SEARCH_MIN_LENGTH, buildInboxSearchOr, searchInboxContactIds } from '@/lib/inbox-search-server'
import { DEFAULT_FOLLOWUP_CFG } from '@/lib/inbox-queues'
import { readInboxFollowupConfig } from '@/lib/inbox-followup-config'
import { ACTIVE_SET_LIMIT, ACTIVE_SET_OR, mergeActiveSet } from '@/lib/inbox-active-set'

// GET /api/instagram/conversations — list IG conversations (operator inbox).
// Mirrors the WhatsApp conversations list. Reads are location-scoped:
// a specific ?location_id (access-checked) or the union of the caller's
// locations. Service-role client is used for the read because the
// instagram_* RLS denies all authenticated access except SELECT for
// assigned staff — we re-impose that scope here in the query.
//
// withAuth only signs the caller in; the channel permission (403), the
// ?location_id membership (403) and the query keep their order here.
export const GET = withAuth({ permission: null, location: false }, async ({ request, user, db }) => {
  // Channel permission — service-role client, so this IS the gate (INBOX-PERM.1).
  const perm = requireInboxPermission(user, 'ig')
  if (perm) return perm

  const { searchParams } = new URL(request.url)
  const locationId = searchParams.get('location_id')

  const LIST_SELECT = '*, contacts!contact_id(id, name, first_name, email, pipeline_stage_slug)'
  let query = db.from('instagram_conversations')
    .select(LIST_SELECT)
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(50)

  if (locationId) {
    const guard = assertLocationAccess(user, locationId)
    if (guard) return guard
    query = query.eq('location_id', locationId)
  } else {
    const userLocationIds = getUserLocationIds(user)
    if (userLocationIds.length === 0) return NextResponse.json({ success: true, conversations: [], followup: DEFAULT_FOLLOWUP_CFG })
    query = query.in('location_id', userLocationIds)
  }

  // INBOX-SEARCH.1 — see whatsapp/conversations: ?q= = most-recent 50 MATCHES.
  const q = (searchParams.get('q') || '').trim()
  if (q.length >= INBOX_SEARCH_MIN_LENGTH) {
    const scopeIds = locationId ? [locationId] : getUserLocationIds(user)
    const contactIds = await searchInboxContactIds(db, { q, locationIds: scopeIds })
    query = query.or(buildInboxSearchOr('instagram_conversations', q, contactIds))
  }

  // INBOXFOLLOW.1 — see whatsapp/conversations: without a search, also read the
  // unresolved threads the queues need; a failed read keeps the latest 50.
  let activeQuery = null
  if (q.length < INBOX_SEARCH_MIN_LENGTH) {
    activeQuery = db.from('instagram_conversations')
      .select(LIST_SELECT)
      .is('resolved_at', null)
      .or(ACTIVE_SET_OR)
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .limit(ACTIVE_SET_LIMIT)
    activeQuery = locationId ? activeQuery.eq('location_id', locationId) : activeQuery.in('location_id', getUserLocationIds(user))
  }

  const [latestRes, activeRes] = await Promise.all([query, activeQuery])
  const { data: latestData, error } = latestRes
  if (error) {
    logError('instagram-conversations', 'list failed', { err: error })
    return NextResponse.json({ success: false, error: 'Could not load the conversations.' }, { status: 500 })
  }

  let data = latestData
  if (activeRes) {
    if (activeRes.error) {
      logError('instagram-conversations', 'active set read failed; serving the latest 50', { err: activeRes.error, locationId })
    } else {
      data = mergeActiveSet(latestData, activeRes.data)
    }
  }

  // INBOX-APPROVALS — flag threads with a pending agent request so the
  // queue can badge them. One batched query over the merged ids (≤350).
  const conversations = data || []
  if (conversations.length) {
    // Chunked: 350 ids in one in() would run past a URL's length limit.
    const pendingSet = new Set()
    const ids = conversations.map(c => c.id)
    for (let i = 0; i < ids.length; i += 100) {
      const { data: pend } = await db.from('agent_membership_requests')
        .select('conversation_id')
        .eq('status', 'pending')
        .in('conversation_id', ids.slice(i, i + 100))
      for (const r of pend || []) pendingSet.add(r.conversation_id)
    }
    for (const c of conversations) c.pending_approval = pendingSet.has(c.id)
  }

  // INBOXASSIGN.1 — each row's owner name for the queue (best effort;
  // profiles has no client grant, so the name resolves here or nowhere).
  await attachAssigneeNames(db, conversations)

  const followup = locationId ? await readInboxFollowupConfig(db, locationId) : DEFAULT_FOLLOWUP_CFG

  return NextResponse.json({ success: true, conversations, followup })
})
