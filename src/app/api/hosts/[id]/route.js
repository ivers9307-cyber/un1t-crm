// GET    /api/hosts/[id]        — one host (org-scoped; 404 if not in caller's org)
// PATCH  /api/hosts/[id] { … }  — update name / email / booking fee
// DELETE /api/hosts/[id]        — remove the host (assigned events revert to
//                                 internal/Revolut via ON DELETE SET NULL)
//
// Auth: Manager+. Detail routes 404 (not 403) on a cross-org id — no IDOR
// enumeration. (EVENTS-HOST.2)

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { HOST_COLS, loadHostForOrg } from '@/lib/hosts'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// HOST-CONSENT.1 — Postmark's own reserved/default stream ids. All three
// match the stream-id shape regex below, so without this an operator typing
// "broadcast" would silently put the host back on UN1T's shared marketing
// stream — the exact coupling mig 588 removes.
const RESERVED_POSTMARK_STREAMS = new Set(['broadcast', 'outbound', 'inbound'])

async function gate() {
  const user = await getCurrentUser()
  if (!user) return { error: NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 }) }
  if (!['master', 'owner', 'manager'].includes(user.role)) {
    return { error: NextResponse.json({ success: false, error: 'Manager+ required' }, { status: 403 }) }
  }
  const orgId = user.activeOrganization?.id || user.activeLocation?.organization_id || null
  if (!orgId) return { error: NextResponse.json({ success: false, error: 'no_active_organization' }, { status: 400 }) }
  return { user, orgId }
}

const PatchSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  email: z.string().trim().email().max(200).nullable().optional().or(z.literal('')),
  platform_fee_cents: z.number().int().min(0).max(100000).optional(),
  // HOST-EMAIL.5 — sender defaults, editable directly (the email-domain flow
  // also writes sender_email/sender_name when provisioning; direct edits let
  // an operator set an interim from-address on an already-verified domain,
  // e.g. host@un1tdublin.com, and an explicit Reply-To).
  sender_email: z.string().trim().email().max(200).nullable().optional().or(z.literal('')),
  sender_name: z.string().trim().max(200).nullable().optional().or(z.literal('')),
  reply_to_email: z.string().trim().email().max(200).nullable().optional().or(z.literal('')),
  // HOST-CONSENT.1 — Postmark Broadcasts stream id, created by hand in Postmark
  // (Message Streams → Create → Broadcasts, unsubscribe handling Custom, then a
  // webhook on that stream to /api/webhooks/postmark with all six events and
  // the x-webhook-token header). Empty string clears it → sends fail closed.
  postmark_stream_id: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
    .refine((s) => !RESERVED_POSTMARK_STREAMS.has(s), { message: "That is UN1T's shared Postmark stream — enter the host's own stream id" })
    .nullable().optional().or(z.literal('')),
}).refine((o) => Object.keys(o).length > 0, { message: 'No fields to update' })

export async function GET(_request, props) {
  const params = await props.params
  const g = await gate()
  if (g.error) return g.error
  const db = createServerClient()
  const host = await loadHostForOrg(db, params.id, g.orgId)
  if (!host) return NextResponse.json({ success: false, error: 'Host not found' }, { status: 404 })
  return NextResponse.json({ success: true, data: host })
}

export async function PATCH(request, props) {
  const params = await props.params
  const g = await gate()
  if (g.error) return g.error
  const v = await validateBody(request, PatchSchema)
  if (!v.ok) return v.response
  const db = createServerClient()
  const host = await loadHostForOrg(db, params.id, g.orgId)
  if (!host) return NextResponse.json({ success: false, error: 'Host not found' }, { status: 404 })

  const updates = {}
  if (v.data.name !== undefined) updates.name = v.data.name
  if (v.data.email !== undefined) updates.email = v.data.email || null
  if (v.data.platform_fee_cents !== undefined) updates.platform_fee_cents = v.data.platform_fee_cents
  if (v.data.sender_email !== undefined) updates.sender_email = v.data.sender_email || null
  if (v.data.sender_name !== undefined) updates.sender_name = v.data.sender_name || null
  if (v.data.reply_to_email !== undefined) updates.reply_to_email = v.data.reply_to_email || null
  if (v.data.postmark_stream_id !== undefined) updates.postmark_stream_id = v.data.postmark_stream_id || null

  const { data, error } = await db
    .from('event_hosts')
    .update(updates)
    .eq('id', host.id)
    .select(HOST_COLS)
    .single()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, data })
}

export async function DELETE(_request, props) {
  const params = await props.params
  const g = await gate()
  if (g.error) return g.error
  const db = createServerClient()
  const host = await loadHostForOrg(db, params.id, g.orgId)
  if (!host) return NextResponse.json({ success: false, error: 'Host not found' }, { status: 404 })
  // race_events.host_id is ON DELETE SET NULL (mig 381), so any events assigned
  // to this host revert to internal/UN1T (Revolut) automatically — no orphaned
  // FK, no broken checkout. The host's own Stripe connected account is NOT
  // touched: it lives on Stripe and belongs to them, not us. We only drop our
  // row (the payee record + fee config).
  const { error } = await db.from('event_hosts').delete().eq('id', host.id)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
