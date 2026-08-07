// EMAIL-CONV-STOP.1 (2026-08-07) — the shared 410 body for the three retired
// /api/email/conversations* routes.
//
// WHY 410 AND NOT A DELETED FILE. Deployed mobile builds sitting on frozen OTA
// lanes still call all four legacy endpoints (list, detail, PATCH, send). A 404
// from a missing Next route is indistinguishable, inside the app, from a
// network error — the screen would spin or say "couldn't connect", and the
// staffer would retry it forever. A 410 with a sentence in `error` is something
// the app surfaces and a human can act on.
//
// EVIDENCE THAT THIS IS PROPORTIONATE, not reckless: the device_tokens census
// shows 8 active iOS clients on app version 2.2.0 (the newest seen today), one
// on 2.1.0 belonging to an INACTIVE profile, and three on builds predating
// mobile email entirely. ZERO on the 2.0.0 lane these routes were kept for.
// That is strong but it is NOT proof — the census only records a version when
// an Expo push token was derived, so a staffer who declined notifications never
// appears in it at all. The 410 is exactly what makes that residual case
// LEGIBLE instead of silent.
//
// The auth guard stays IN FRONT of the 410, deliberately: an unauthenticated
// caller must not be able to enumerate which routes exist and which are
// retired, and `check:route-guards` requires every route under
// src/app/api/email/conversations to carry the channel-permission check
// (INBOX-PERM.2 re-gated these three to `email_inbox`; the 410 supersedes that
// gate in practice but does not remove it).
//
// What replaced them: /api/email/tickets* (mig 482). Web works email at
// /communications/tickets; mobile has been on the ticket API since
// EMAIL-TICKET-M.1.
//
// The underlying email_conversations table (mig 394) is NOT dropped by this
// change — code stops touching it first and deploys, then a later migration
// retires the table, email_inbox_messages.conversation_id, the
// increment_email_conversation_unread RPC, and the RLS/realtime entries.

import { NextResponse } from 'next/server'

export const GONE_MESSAGE =
  'This endpoint has been retired. The email inbox is a ticket queue now — ' +
  'update the UN1T app to the latest version to keep working email, or use ' +
  'Communications → Tickets on the web.'

/**
 * The standard `{ success, error }` shape at HTTP 410 Gone.
 * @returns {NextResponse}
 */
export function goneResponse() {
  return NextResponse.json({ success: false, error: GONE_MESSAGE }, { status: 410 })
}
