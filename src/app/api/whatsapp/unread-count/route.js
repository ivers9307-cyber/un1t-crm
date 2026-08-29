// GET /api/whatsapp/unread-count
//
// SIDEBAR-BADGES.2 — the Communications badge (sidebar nav item AND the
// Communications tab-strip Inbox tab both poll this one endpoint). It counts
// conversations that NEED A HUMAN TO ACT — unresolved threads awaiting a reply
// or handed off by the agent — across the inbox's two channels (WhatsApp +
// Instagram; email left the inbox in INBOX-SPLIT.1, see below) at
// the active location. This mirrors the UnifiedInbox's own needs-reply/handoff
// queues via the shared `needsAction` predicate, so the badge and the inbox can
// never disagree.
//
// It used to sum raw unread_count, which read 0 the moment a thread was opened
// (without being replied to or resolved) and never saw an agent handoff whose
// last line was Mia's holding message — so genuinely-pending work showed no
// badge. Route path kept ("unread-count") because both pollers point here.
//
// Follows the { success, data: { count } } envelope the Sidebar's
// usePolledCount expects; returns 0 for users without the whatsapp permission
// (or no active location). Not paginated, by design — one gym never has >1000
// unresolved conversations; the badge caps display at 99+ regardless.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { needsAction } from '@/lib/inbox-queues'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const user = await getCurrentUser()
  if (!user || !hasPermission(user, 'whatsapp')) {
    return NextResponse.json({ success: true, data: { count: 0 } })
  }
  const locationId = user.activeLocation?.id
  if (!locationId) {
    return NextResponse.json({ success: true, data: { count: 0 } })
  }

  const db = createServerClient()
  // Only the columns the needsAction predicate reads. Pre-filter to unresolved
  // rows in the query so the payload stays tiny; the predicate does the final
  // needs-reply-or-handoff decision (and drops empty conversation shells).
  const cols = 'resolved_at, last_message_at, last_message_direction, agent_handed_off_at'
  const countActionable = rows => (rows || []).filter(needsAction).length
  try {
    // INBOX-SPLIT.1 — email_conversations LEFT this count (Richard,
    // 2026-08-07). EMAIL-INBOX.1 had added it as a third channel, but the
    // Inbox is WhatsApp + Instagram only now, so a badge counting email
    // pointed at work that isn't reachable from the surface it badges —
    // which is exactly why it sat on 1 with an empty-looking queue. Email
    // is worked at /communications/mail and counts itself there.
    const [wa, ig] = await Promise.all([
      db.from('whatsapp_conversations').select(cols)
        .eq('location_id', locationId).is('resolved_at', null),
      db.from('instagram_conversations').select(cols)
        .eq('location_id', locationId).is('resolved_at', null),
    ])
    // A failure on any channel degrades to that channel counting 0
    // rather than erroring the badge.
    const count = countActionable(wa.error ? [] : wa.data)
      + countActionable(ig.error ? [] : ig.data)
    return NextResponse.json({ success: true, data: { count } })
  } catch {
    return NextResponse.json({ success: true, data: { count: 0 } })
  }
}
