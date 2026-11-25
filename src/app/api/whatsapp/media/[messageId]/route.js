import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { assertLocationAccessOr404, requireWhatsAppInboxAnywhere, requireWhatsAppInboxAt } from '@/lib/auth'
import { withAuth } from '@/lib/with-auth'
import { mediaRenderKind } from '@shared/whatsapp-media'
import { ensureMediaRehosted, signedMediaUrl } from '@/lib/whatsapp-media-server'

// WA-MEDIA.1 — serve inbound WhatsApp/Instagram media to the inbox.
//
// GET /api/whatsapp/media/[messageId] — returns a short-lived signed URL
// for the message's media (re-hosting it from Meta into the private
// whatsapp-media bucket on first view). The inbox (web + mobile) fetches
// this, then renders the URL as an <img>/<video>/file link. Mirrors the
// signed-URL pattern used for card receipts / expense receipts. The Meta
// token stays server-side; the browser only ever sees the signed URL.
//
// Auth (INBOXPERM.1): the inbox key (web or phone: both the web inbox and the
// phone call this route) held at ANY studio before the read, membership of the
// message's studio (404, not 403, so ids aren't enumerable), then the key AT
// that studio. Nothing is re-hosted or signed before the decision.

export const runtime = 'nodejs'

export const GET = withAuth({ permission: null, location: false }, async ({ user, params }) => {
  const perm = requireWhatsAppInboxAnywhere(user)
  if (perm) return perm

  const db = createServerClient()
  const { data: message, error } = await db.from('whatsapp_messages')
    .select('id, location_id, conversation_id, message_type, media_mime_type, media_url, media_external_id, media_storage_path')
    .eq('id', params.messageId)
    .maybeSingle()
  if (error || !message) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }

  const guard = assertLocationAccessOr404(user, message.location_id)
  if (guard) return guard
  const permHere = requireWhatsAppInboxAt(user, message.location_id)
  if (permHere) return permHere

  // Only serve things that are actually media (never text/location/etc).
  const kind = mediaRenderKind(message.message_type, message.media_mime_type)
  if (!kind) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }

  const path = await ensureMediaRehosted(db, message)
  if (!path) {
    // Meta has likely expired the media (>30 days) or the fetch failed.
    return NextResponse.json({ success: false, error: 'Media unavailable' }, { status: 404 })
  }

  const url = await signedMediaUrl(db, path)
  if (!url) {
    return NextResponse.json({ success: false, error: 'Media unavailable' }, { status: 404 })
  }

  return NextResponse.json({ success: true, url, kind, mime_type: message.media_mime_type || null })
})
