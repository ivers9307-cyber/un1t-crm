import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { assertLocationAccess, requireWhatsAppInboxAnywhere, requireWhatsAppInboxAt } from '@/lib/auth'
import { inboxLocationIds } from '@/lib/inbox-location-ids'
import { withAuth } from '@/lib/with-auth'
import { logError } from '@/lib/log'
import { attachAssigneeNames } from '@/lib/inbox-assignment'
import { INBOX_SEARCH_MIN_LENGTH, buildInboxSearchOr, searchInboxContactIds, searchWhatsAppMessageHits } from '@/lib/inbox-search-server'
import { DEFAULT_FOLLOWUP_CFG } from '@/lib/inbox-queues'
import { readInboxFollowupConfig } from '@/lib/inbox-followup-config'
import { ACTIVE_SET_LIMIT, ACTIVE_SET_OR, mergeActiveSet } from '@/lib/inbox-active-set'

// GET /api/whatsapp/conversations — list conversations (inbox)
// ROUTEWRAP.R9 — withAuth only signs the caller in; the gates below judge access.
//
// INBOXPERM.1 — the inbox key (web or phone) is judged at the studio asked for,
// not at the active one: a coarse any-studio check first, then membership and
// the key at ?location_id. Without ?location_id the list covers only the
// studios where the caller holds the key, never every studio they merely
// belong to. (The phone reads this table directly, not through this route.)
export const GET = withAuth({ permission: null, location: false }, async ({ user, request }) => {
  // Service-role client, so these gates ARE the access control (INBOX-PERM.1).
  const perm = requireWhatsAppInboxAnywhere(user)
  if (perm) return perm

  const { searchParams } = new URL(request.url)
  const locationId = searchParams.get('location_id')
  if (locationId) {
    const guard = assertLocationAccess(user, locationId)
    if (guard) return guard
    const permHere = requireWhatsAppInboxAt(user, locationId)
    if (permHere) return permHere
  }

  const db = createServerClient()
  const LIST_SELECT = '*, contacts!contact_id(id, name, first_name, phone, wa_phone, pipeline_stage_slug)'
  let query = db.from('whatsapp_conversations')
    .select(LIST_SELECT)
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(50)

  if (locationId) {
    query = query.eq('location_id', locationId)
  } else {
    const userLocationIds = inboxLocationIds(user)
    if (userLocationIds.length === 0) return NextResponse.json({ success: true, conversations: [], followup: DEFAULT_FOLLOWUP_CFG })
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
    // The studios where the caller holds the inbox key (INBOXPERM.1): contacts
    // and message text are searched there only; membership alone opens neither.
    const scopeIds = locationId ? [locationId] : inboxLocationIds(user)
    const [contactIds, messageSearch] = await Promise.all([
      searchInboxContactIds(db, { q, locationIds: scopeIds }),
      searchWhatsAppMessageHits(db, { q, locationIds: scopeIds }),
    ])
    for (const hit of messageSearch.hits) snippets.set(hit.conversation_id, hit.snippet)
    query = query.or(buildInboxSearchOr('whatsapp_conversations', q, contactIds, [...snippets.keys()]))
  }

  // INBOXFOLLOW.1 — without a search, also read every unresolved thread the
  // queues need (owed a reply, asked for a person, waited on, snoozed), so a
  // busy studio's older waiting threads are not cut off by the latest-50
  // window. A failed read keeps the latest-50 list rather than failing it.
  let activeQuery = null
  if (q.length < INBOX_SEARCH_MIN_LENGTH) {
    activeQuery = db.from('whatsapp_conversations')
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
    logError('wa-inbox', 'conversation list failed', { err: error, locationId })
    return NextResponse.json({ success: false, error: 'Could not load conversations. Try again.' }, { status: 500 })
  }

  let data = latestData
  if (activeRes) {
    if (activeRes.error) {
      logError('wa-inbox', 'active set read failed; serving the latest 50', { err: activeRes.error, locationId })
    } else {
      if ((activeRes.data || []).length >= ACTIVE_SET_LIMIT) {
        logError('wa-inbox', 'active set hit its limit; the newest waiting threads beyond it are not listed', { limit: ACTIVE_SET_LIMIT, locationId })
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
        logError('wa-inbox', 'approval badges read failed; the list loads without them for this chunk', { err: pendErr.message })
        continue
      }
      for (const r of pend || []) pendingSet.add(r.conversation_id)
    }
    for (const c of conversations) {
      c.pending_approval = pendingSet.has(c.id)
      if (snippets.has(c.id)) c.search_snippet = snippets.get(c.id)
    }
  }

  // INBOXASSIGN.1 — each row's owner name for the queue (best effort;
  // profiles has no client grant, so the name resolves here or nowhere).
  await attachAssigneeNames(db, conversations)

  return NextResponse.json({ success: true, conversations, followup })
})
