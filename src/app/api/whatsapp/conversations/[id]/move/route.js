import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccessOr404, requireWhatsAppInboxAnywhere, requireWhatsAppInboxAt } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { logError } from '@/lib/log'
import { locationsWithWhatsApp } from '@/lib/whatsapp-config'

// WAHOMESTUDIO.1 (R7) — move a WhatsApp thread to another studio of the SAME
// organisation (an unknown sender who turns out to be a Hatch customer, a
// thread filed before WAHOMESTUDIO.1). The move (or merge into an existing
// thread there) is ONE SQL function, move_whatsapp_conversation (mig 723).
// The caller needs WhatsApp inbox access at BOTH studios. Registered in
// src/lib/openapi.js.
//
// WAMOVENUMBER.1 — the target must have an active WhatsApp number switched on
// (location_whatsapp_numbers). Since WAORGNUMBER.6 a studio with nothing
// switched on cannot answer a thread (no sibling's number), so a move there is
// a 409, and GET flags each target with `whatsapp` so the inbox can say why.
// A failed read is a 500, never "no number" and never a silent allow.
const MoveSchema = z.object({ location_id: uuidLike })

const NOT_FOUND = () => NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
const READ_FAILED = () => NextResponse.json({ success: false, error: 'Could not load the conversation.' }, { status: 500 })
const SAME_STUDIO = 'The conversation is already at this studio.'
const WRONG_ORG = 'A conversation can only move to a studio in the same organisation.'
const NO_NUMBER = (name) => `${name || 'That studio'} has no WhatsApp number switched on, so a conversation there could not be answered. Switch a number on at that studio first (Settings, WhatsApp).`

async function load(props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return { res: NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 }) }
  const perm = requireWhatsAppInboxAnywhere(user)
  if (perm) return { res: perm }
  const db = createServerClient()
  const { data: conversation, error: convErr } = await db.from('whatsapp_conversations')
    .select('id, location_id').eq('id', params.id).maybeSingle()
  if (convErr) {
    logError('wa-move', 'conversation read failed', { conversationId: params.id, err: convErr.message })
    return { res: READ_FAILED() }
  }
  if (!conversation) return { res: NOT_FOUND() }
  const guard = assertLocationAccessOr404(user, conversation.location_id) || requireWhatsAppInboxAt(user, conversation.location_id)
  if (guard) return { res: guard }
  const { data: source, error: srcErr } = await db.from('locations').select('id, organization_id').eq('id', conversation.location_id).maybeSingle()
  if (srcErr) {
    logError('wa-move', 'source studio read failed', { conversationId: conversation.id, err: srcErr.message })
    return { res: READ_FAILED() }
  }
  return { user, db, conversation, orgId: source?.organization_id || null }
}

export async function GET(request, props) {
  const ctx = await load(props)
  if (ctx.res) return ctx.res
  const { user, db, conversation, orgId } = ctx
  // The caller's studios: the field assertLocationAccessOr404 reads.
  const ids = (user.locations || []).map((l) => l.id).filter((id) => id && id !== conversation.location_id)
  if (!orgId || ids.length === 0) return NextResponse.json({ success: true, data: { targets: [] } })
  const { data: locs, error } = await db.from('locations').select('id, name, organization_id').in('id', ids).eq('organization_id', orgId).order('name')
  if (error) {
    logError('wa-move', 'target studios read failed', { conversationId: conversation.id, err: error.message })
    return NextResponse.json({ success: false, error: 'Could not load the studios.' }, { status: 500 })
  }
  const allowed = (locs || []).filter((l) => !requireWhatsAppInboxAt(user, l.id))
  let withNumber
  try {
    withNumber = await locationsWithWhatsApp(db, allowed.map((l) => l.id))
  } catch (e) {
    logError('wa-move', 'target studios’ WhatsApp numbers read failed', { conversationId: conversation.id, err: e?.message || String(e) })
    return NextResponse.json({ success: false, error: 'Could not load the studios.' }, { status: 500 })
  }
  const targets = allowed.map((l) => ({ id: l.id, name: l.name, whatsapp: withNumber.has(l.id) }))
  return NextResponse.json({ success: true, data: { targets } })
}

export async function POST(request, props) {
  const ctx = await load(props)
  if (ctx.res) return ctx.res
  const { user, db, conversation, orgId } = ctx
  const v = await validateBody(request, MoveSchema)
  if (!v.ok) return v.response
  const target = v.data.location_id
  if (target === conversation.location_id) {
    return NextResponse.json({ success: false, error: SAME_STUDIO }, { status: 400 })
  }
  // Access at the target BEFORE the organisation check: answering 400 first
  // would tell a caller whether a studio they cannot see is in this
  // organisation. An inaccessible target is the unknown-id 404.
  const guard = assertLocationAccessOr404(user, target) || requireWhatsAppInboxAt(user, target)
  if (guard) return guard
  const { data: dest, error: destErr } = await db.from('locations').select('id, name, organization_id').eq('id', target).maybeSingle()
  if (destErr) {
    logError('wa-move', 'target studio read failed', { conversationId: conversation.id, target, err: destErr.message })
    return NextResponse.json({ success: false, error: 'Could not move the conversation.' }, { status: 500 })
  }
  if (!dest || !orgId || dest.organization_id !== orgId) {
    return NextResponse.json({ success: false, error: WRONG_ORG }, { status: 400 })
  }
  // WAMOVENUMBER.1 — never file a thread where nobody can answer it.
  let targetHasNumber
  try {
    targetHasNumber = (await locationsWithWhatsApp(db, [target])).has(target)
  } catch (e) {
    logError('wa-move', 'target studio WhatsApp number read failed', { conversationId: conversation.id, target, err: e?.message || String(e) })
    return NextResponse.json({ success: false, error: 'Could not move the conversation.' }, { status: 500 })
  }
  if (!targetHasNumber) {
    return NextResponse.json({ success: false, error: NO_NUMBER(dest.name) }, { status: 409 })
  }

  const { data, error } = await db.rpc('move_whatsapp_conversation', { p_conversation_id: conversation.id, p_target_location_id: target })
  if (error) {
    // The SQL function's own refusals (mig 723) map to the route's pre-check answers.
    if (error.code === '23505') {
      return NextResponse.json({ success: false, error: 'This customer already has a conversation at that studio that could not be merged automatically.' }, { status: 409 })
    }
    if (error.code === 'P0002') return NOT_FOUND()
    if (error.code === '22023') {
      const sameStudio = String(error.message || '').includes('same_studio')
      return NextResponse.json({ success: false, error: sameStudio ? SAME_STUDIO : WRONG_ORG }, { status: 400 })
    }
    logError('wa-move', 'move_whatsapp_conversation failed', { conversationId: conversation.id, target, err: error.message })
    return NextResponse.json({ success: false, error: 'Could not move the conversation.' }, { status: 500 })
  }
  // WASTUDIOPICK.1 — a staff move settles the studio for good (spec R6).
  // Recorded on the RETURNED id: a merge keeps the target row, not this one.
  // The move already happened, so a failed bookkeeping write is logged and
  // never turns the answer into an error (a retry would only fail SAME_STUDIO).
  const movedId = data?.conversation_id || conversation.id
  try {
    const { error: recErr } = await db.from('whatsapp_conversations')
      .update({ studio_resolution: { status: 'decided', by: 'staff', location_id: target, at: new Date().toISOString() } })
      .eq('id', movedId)
    if (recErr) logError('wa-move', 'studio_resolution write failed', { conversationId: movedId, err: recErr.message })
  } catch (e) {
    logError('wa-move', 'studio_resolution write failed', { conversationId: movedId, err: e?.message })
  }
  return NextResponse.json({ success: true, data: { conversation_id: movedId, merged: !!data?.merged } })
}
