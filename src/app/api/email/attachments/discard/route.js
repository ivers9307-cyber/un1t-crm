// POST /api/email/attachments/discard — EMAIL-OUTBOUND-ATTACH.1.
//
// The "×" on a chip, and the cancelled composer. A draft that is removed before
// the email goes out has its bytes taken back out of the bucket immediately,
// which is what keeps the ordinary "attached the wrong file" case from leaving
// billable objects behind.
//
// ══ WHY THIS NEEDS NO TICKET OR MAILBOX ═════════════════════════════
// The object key is BUILT from the caller's own profile id
// (outbound/<profile_id>/<draft_id>/<index>.<ext>), so a session can only ever
// address its own drafts. There is no path parameter, no id belonging to anyone
// else, and nothing to enumerate: a caller passing someone else's draft uuid
// simply derives a key under their own prefix that does not exist, and Storage
// removes nothing. That is why the gate is `getCurrentUser()` and stops there —
// adding a ticket check would be authorising against something this route never
// touches.
//
// ALWAYS 200. A remove that found nothing is indistinguishable from one that
// found something, deliberately: the client calls this while tidying up its own
// state, and an error it cannot act on would surface as a scary red line under
// a composer that is working perfectly. Storage failures are logged inside
// discardOutboundDraft.
//
// A DRAFT THAT IS NEVER DISCARDED IS NOT FREE, AND THE RESIDUE IS STATED:
// a browser closed mid-compose, or a send that failed after the files uploaded
// (where the drafts are deliberately KEPT so the retry still has them), leaves
// objects under `outbound/`. They are never metered — quota is charged only when
// a message row is filed — so they cost storage, not a studio's ceiling, and
// they are confined to one prefix so a sweep can be added later with an exact
// search space. Same posture, and the same accepted cost, as the shim's staged
// residue.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { OutboundAttachmentSchema, discardOutboundDraft } from '@/lib/email-outbound-attachments-server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// The filename is irrelevant here (it never addressed the object) but the
// schema is shared so the client can hand back the same object it holds.
const DiscardSchema = OutboundAttachmentSchema

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const validation = await validateBody(request, DiscardSchema)
  if (!validation.ok) return validation.response
  const { draft_id: draftId, index, mime } = validation.data

  const db = createServerClient()
  await discardOutboundDraft(db, { profileId: user.id, draftId, index, mime })

  return NextResponse.json({ success: true, data: { discarded: true } })
}
