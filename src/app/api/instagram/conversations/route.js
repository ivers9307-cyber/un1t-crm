import { NextResponse } from 'next/server'
import { assertLocationAccess, getUserLocationIds, requireWhatsAppInboxAnywhere, requireWhatsAppInboxAt } from '@/lib/auth'
import { hasPermissionForLocation, hasMobilePermissionForLocation } from '@/lib/permissions'
import { withAuth } from '@/lib/with-auth'
import { logError } from '@/lib/log'
import { attachAssigneeNames } from '@/lib/inbox-assignment'
import { INBOX_SEARCH_MIN_LENGTH, buildInboxSearchOr, searchInboxContactIds } from '@/lib/inbox-search-server'
import { DEFAULT_FOLLOWUP_CFG } from '@/lib/inbox-queues'
import { readInboxFollowupConfig } from '@/lib/inbox-followup-config'
import { ACTIVE_SET_LIMIT, ACTIVE_SET_OR, mergeActiveSet } from '@/lib/inbox-active-set'

// The studios where the caller holds the inbox key (web or phone), of those
// they belong to.
const inboxLocationIds = (user) => getUserLocationIds(user).filter((id) => (
  hasPermissionForLocation(user, id, 'whatsapp') || hasMobilePermissionForLocation(user, id, 'whatsapp')
))

// GET /api/instagram/conversations — list IG conversations (operator inbox).
// Mirrors the WhatsApp conversations list. Reads are location-scoped:
// a specific ?location_id (access-checked) or the union of the caller's
// locations. Service-role client is used for the read because the
// instagram_* RLS denies all authenticated access except SELECT for
// assigned staff — we re-impose that scope here in the query.
//
// withAuth only signs the caller in; the channel permission (403), the
// ?location_id membership (403) and the query keep their order here.
//
// INBOXPERM.1 — the inbox key ('ig' rides the `whatsapp` key; web or phone, the
// phone calls this route) is judged at the studio asked for, not at the active
// one: a coarse any-studio check first, then the key at ?location_id once its
// membership has passed. Without ?location_id the list covers only the studios
// where the caller holds the key, never every studio they merely belong to.
export const GET = withAuth({ permission: null, location: false }, async ({ request, user, db }) => {
  // Channel permission — service-role client, so this IS the gate (INBOX-PERM.1).
  const perm = requireWhatsAppInboxAnywhere(user)
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
    const permHere = requireWhatsAppInboxAt(user, locationId)
    if (permHere) return permHere
    query = query.eq('location_id', locationId)
  } else {
    const userLocationIds = inboxLocationIds(user)
    if (userLocationIds.length === 0) return NextResponse.json({ success: true, conversations: [], followup: DEFAULT_FOLLOWUP_CFG })
    query = query.in('location_id', userLocationIds)
  }

  // INBOX-SEARCH.1 — see whatsapp/conversations: ?q= = most-recent 50 MATCHES.
  const q = (searchParams.get('q') || '').trim()
  if (q.length >= INBOX_SEARCH_MIN_LENGTH) {
    const scopeIds = locationId ? [locationId] : inboxLocationIds(user)
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
      // Oldest first: the longest-waiting threads must never be the ones cut at the limit.
      .order('last_message_at', { ascending: true, nullsFirst: false })
      .limit(ACTIVE_SET_LIMIT)
    activeQuery = locationId ? activeQuery.eq('location_id', locationId) : activeQuery.in('location_id', inboxLocationIds(user))
  }

  // INBOXFOLLOW.3 — the follow-up config reads alongside the lists, not after them
  // (it never throws: a failed read answers the defaults). Several studios at
  // once (no location_id) use the defaults.
  const followupPromise = locationId ? readInboxFollowupConfig(db, locationId) : Promise.resolve(DEFAULT_FOLLOWUP_CFG)
  const [latestRes, activeRes, followup] = await Promise.all([query, activeQuery, followupPromise])
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
      if ((activeRes.data || []).length >= ACTIVE_SET_LIMIT) {
        logError('instagram-conversations', 'active set hit its limit; the newest waiting threads beyond it are not listed', { limit: ACTIVE_SET_LIMIT, locationId })
      }
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
    const chunks = []
    for (let i = 0; i < ids.length; i += 100) chunks.push(ids.slice(i, i + 100))
    // INBOXFOLLOW.2 — the chunks run together; the badges are best effort, so a
    // failed chunk is logged and its rows simply show no badge.
    const results = await Promise.all(chunks.map((chunk) => db.from('agent_membership_requests')
      .select('conversation_id')
      .eq('status', 'pending')
      .in('conversation_id', chunk)))
    for (const { data: pend, error: pendErr } of results) {
      if (pendErr) {
        logError('instagram-conversations', 'approval badges read failed; the list loads without them for this chunk', { err: pendErr.message })
        continue
      }
      for (const r of pend || []) pendingSet.add(r.conversation_id)
    }
    for (const c of conversations) c.pending_approval = pendingSet.has(c.id)
  }

  // INBOXASSIGN.1 — each row's owner name for the queue (best effort;
  // profiles has no client grant, so the name resolves here or nowhere).
  await attachAssigneeNames(db, conversations)

  return NextResponse.json({ success: true, conversations, followup })
})
