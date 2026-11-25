import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { assertLocationAccessOr404, requireWhatsAppInboxAnywhere, requireWhatsAppInboxAt } from '@/lib/auth'
import { mediaRenderKind } from '@shared/whatsapp-media'
import { ensureInstagramMediaRehosted } from '@/lib/instagram-media-server'
import { signedMediaUrl } from '@/lib/whatsapp-media-server'

// IG-MEDIA.1 — serve inbound Instagram DM media to the inbox.
//
// GET /api/instagram/media/[messageId] — returns a short-lived signed URL
// for the message's media (re-hosting it from the IG CDN into the private
// whatsapp-media bucket if the webhook's eager re-host missed). The inbox
// fetches this, then renders the URL as an <img>/<video>/file link. Mirrors
// the WhatsApp media route; shares its signing helper + private bucket.
//
// Auth (INBOXPERM.1): the inbox key (the `whatsapp` key serves both channels;
// web or phone, the phone calls this route) held at ANY studio before the read,
// membership of the message's studio (404, not 403, so ids aren't enumerable),
// then the key AT that studio. Nothing is re-hosted or signed before the decision.

export const runtime = 'nodejs'

// withAuth only signs the caller in; the channel permission and the
// message's studio (404) run here, as before.
export const GET = withAuth({ permission: null, location: false }, async ({ user, db, params }) => {
  // Service-role client, so these gates ARE the access control (INBOXPERM.1).
  const perm = requireWhatsAppInboxAnywhere(user)
  if (perm) return perm

  const { data: message, error } = await db.from('instagram_messages')
    .select('id, location_id, message_type, media_mime_type, media_url, media_storage_path')
    .eq('id', params?.messageId)
    .maybeSingle()
  if (error || !message) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }

  const guard = assertLocationAccessOr404(user, message.location_id)
  if (guard) return guard
  const permHere = requireWhatsAppInboxAt(user, message.location_id)
  if (permHere) return permHere

  // Only serve things that are actually media (never text/story-mention/etc).
  const kind = mediaRenderKind(message.message_type, message.media_mime_type)
  if (!kind) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }

  // Lazy re-host fallback: if the eager webhook re-host missed, we may need
  // the location's IG token to fetch the CDN URL. Only looked up when the
  // bytes aren't already in the bucket.
  let token = null
  if (!message.media_storage_path) {
    const { data: conn } = await db.from('channel_connections')
      .select('access_token')
      .eq('location_id', message.location_id)
      .eq('platform', 'instagram')
      .eq('is_active', true)
      .maybeSingle()
    token = conn?.access_token || null
  }

  const path = await ensureInstagramMediaRehosted(db, message, { token })
  if (!path) {
    // The IG CDN URL has likely expired and we never re-hosted, or the
    // fetch failed. The inbox renders a graceful "unavailable" note.
    return NextResponse.json({ success: false, error: 'Media unavailable' }, { status: 404 })
  }

  const url = await signedMediaUrl(db, path)
  if (!url) {
    return NextResponse.json({ success: false, error: 'Media unavailable' }, { status: 404 })
  }

  return NextResponse.json({ success: true, url, kind, mime_type: message.media_mime_type || null })
})
