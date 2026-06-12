import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { MANAGER_ROLES } from '@/lib/schemas'
import { summariseChannel, mergeSummaries, containmentRate, rankTopics, summariseActions } from '@/lib/agent/analytics'

// RADAR-AGENT — operator analytics feed (plan §4e). Manager+ at the
// active location. Read-only: aggregates the agent's own WhatsApp +
// Instagram rows over a trailing window into headline numbers, a
// containment rate, the most-asked topics, and the list of escalated
// conversations to review. No new tables — derived from existing
// message/conversation columns.

export const dynamic = 'force-dynamic'

const MAX_WINDOW_DAYS = 90
const DEFAULT_WINDOW_DAYS = 30

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const locationId = user.activeLocation?.id
  if (!locationId) return NextResponse.json({ success: false, error: 'No active location' }, { status: 400 })

  const { searchParams } = new URL(request.url)
  let days = parseInt(searchParams.get('days') || String(DEFAULT_WINDOW_DAYS), 10)
  if (!Number.isFinite(days) || days <= 0) days = DEFAULT_WINDOW_DAYS
  if (days > MAX_WINDOW_DAYS) days = MAX_WINDOW_DAYS
  const since = new Date(Date.now() - days * 86400000).toISOString()

  const db = createServerClient()

  async function loadChannel(convTable, msgTable) {
    const { data: conversations } = await db.from(convTable)
      .select('id, agent_handed_off_at, agent_verified_contact_id, last_message_at')
      .eq('location_id', locationId)
      .gte('last_message_at', since)
    const { data: messages } = await db.from(msgTable)
      .select('conversation_id, direction, source, body, created_at')
      .eq('location_id', locationId)
      .gte('created_at', since)
    return {
      summary: summariseChannel(conversations || [], messages || []),
      conversations: conversations || [],
    }
  }

  const [wa, ig] = await Promise.all([
    loadChannel('whatsapp_conversations', 'whatsapp_messages'),
    loadChannel('instagram_conversations', 'instagram_messages'),
  ])

  const combined = mergeSummaries(wa.summary, ig.summary)

  // AGENT-ANALYTICS.2 — outcomes: what the agent actually DID
  // (bookings/cancellations from the audit trail) + proactive sends.
  const [{ data: actionRows }, { count: followupsSent }, { count: checkinsSent }] = await Promise.all([
    db.from('agent_membership_requests')
      .select('kind, status')
      .eq('location_id', locationId)
      .gte('created_at', since)
      .limit(2000),
    db.from('whatsapp_conversations')
      .select('id', { count: 'exact', head: true })
      .eq('location_id', locationId)
      .gte('agent_followup_sent_at', since),
    db.from('contacts')
      .select('id', { count: 'exact', head: true })
      .eq('location_id', locationId)
      .gte('first_class_checkin_at', since),
  ])
  const actions = {
    ...summariseActions(actionRows || []),
    followups_sent: followupsSent || 0,
    checkins_sent: checkinsSent || 0,
  }

  // AGENT-QA.1 — quality feedback from the inbox thumbs.
  const { data: feedbackRows } = await db.from('agent_message_feedback')
    .select('rating, note, channel, conversation_id, created_at')
    .eq('location_id', locationId)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(200)
  const feedback = {
    up: (feedbackRows || []).filter(f => f.rating === 'up').length,
    down: (feedbackRows || []).filter(f => f.rating === 'down').length,
    recent_downs: (feedbackRows || [])
      .filter(f => f.rating === 'down')
      .slice(0, 10)
      .map(f => ({ note: f.note, channel: f.channel, conversation_id: f.conversation_id, created_at: f.created_at })),
  }

  // Escalated conversations to review — newest first, capped. Each side
  // links back to its own inbox thread.
  const escalations = [
    ...wa.conversations.filter(c => c.agent_handed_off_at).map(c => ({ id: c.id, channel: 'whatsapp', handed_off_at: c.agent_handed_off_at })),
    ...ig.conversations.filter(c => c.agent_handed_off_at).map(c => ({ id: c.id, channel: 'instagram', handed_off_at: c.agent_handed_off_at })),
  ].sort((a, b) => new Date(b.handed_off_at) - new Date(a.handed_off_at)).slice(0, 50)

  return NextResponse.json({
    success: true,
    window_days: days,
    combined,
    by_channel: { whatsapp: wa.summary, instagram: ig.summary },
    containment_rate: containmentRate(combined),
    actions,
    feedback,
    topics: rankTopics(combined.topics),
    escalations,
  })
}
