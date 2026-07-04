import { NextResponse } from 'next/server'
import { getCurrentUser, getUserLocationIds } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { composeApprovalSuggestion } from '@/lib/agent/approval-suggest'

// POST /api/agent/membership-requests/[id]/suggest — INBOX-APPROVALS-AI.2.
// Wave 3: after staff decide a queued agent request, fire this to get ONE
// bespoke Mia-voice follow-up suggestion for the customer. Click-to-prefill
// only in the UI — this route never sends anything itself.
//
// Auth copied verbatim from the PATCH sibling (location-staff auth,
// 404-not-403 non-leak). Any model failure degrades silently to
// { success: true, suggestion: null } — this route must never 5xx because
// the model had a bad day.

const DEFAULT_TIMEOUT_MS = 5000

export async function POST(request, { params }) {
  const { id } = await params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const db = createServerClient()

  // Confirm the request belongs to a location this user can act on.
  const { data: row } = await db.from('agent_membership_requests')
    .select('id, location_id, kind, status, decision_note, contact_id, channel, conversation_id')
    .eq('id', id).maybeSingle()
  if (!row) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  const allowed = getUserLocationIds(user) // masters carry every active location in user.locations
  if (allowed !== null && !allowed.includes(row.location_id)) {
    // 404 not 403 — detail routes never confirm a foreign id exists.
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }

  // Suggestions are post-decision only — nothing to follow up on yet.
  if (row.status === 'pending') {
    return NextResponse.json({ success: false, error: 'Not decided yet' }, { status: 400 })
  }

  const { data: location } = await db.from('locations')
    .select('settings')
    .eq('id', row.location_id)
    .maybeSingle()
  const agentSettings = location?.settings?.customer_agent || null
  const inlineSuggestion = agentSettings?.inline_suggestion || null
  if (!agentSettings?.enabled || inlineSuggestion?.enabled === false) {
    return NextResponse.json({ success: true, suggestion: null })
  }

  const timeoutMs = inlineSuggestion?.timeout_ms ?? DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let composed
  try {
    composed = await composeApprovalSuggestion(db, row, { signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }

  if (composed.error) {
    console.warn('[approval-suggest]', JSON.stringify({ requestId: id, reason: composed.error }))
    return NextResponse.json({ success: true, suggestion: null })
  }
  return NextResponse.json({ success: true, suggestion: composed.text })
}
