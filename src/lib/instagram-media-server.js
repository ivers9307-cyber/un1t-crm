// IG-MEDIA.1 — server-side IO for inbound Instagram DM media.
//
// Instagram delivers media inline as a direct CDN URL (lookaside.fbsbx.com)
// in the webhook attachment payload — NOT an opaque Meta media ID like
// WhatsApp. That URL is short-lived, so we copy the bytes once into the
// same private 'whatsapp-media' bucket WhatsApp uses and hand the inbox a
// short-lived signed URL from there. The signing helper (signedMediaUrl)
// and the bucket/addressing helpers are shared with the WA pipeline.
//
// Pure classification/addressing helpers live in @shared/whatsapp-media;
// this module is the IO that depends on the network, Storage and the DB.

import { WHATSAPP_MEDIA_BUCKET, buildMediaObjectPath } from '@shared/whatsapp-media'

// Download the bytes for an Instagram media URL. IG CDN links are usually
// fetchable anonymously but expire quickly; on a 401/403 retry once with
// the connection's IG token (some media requires it). Returns { bytes,
// mime } or null on any failure so the caller can fail soft.
async function fetchInstagramMediaBytes(url, token) {
  let res
  try {
    res = await fetch(url)
    if ((res.status === 401 || res.status === 403) && token) {
      res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    }
  } catch {
    return null
  }
  if (!res.ok) return null
  const mime = res.headers.get('content-type')?.split(';')[0]?.trim() || null
  const bytes = Buffer.from(await res.arrayBuffer())
  return { bytes, mime }
}

/**
 * Ensure an inbound IG message's media is re-hosted into the whatsapp-media
 * bucket. Idempotent: returns the existing path immediately if already
 * re-hosted, otherwise downloads from the IG CDN URL, uploads, and persists
 * the path + mime (so future views skip the round-trip and survive the CDN
 * URL expiring). Returns the object path, or null if there's nothing to
 * serve or the fetch failed (caller renders a graceful gap).
 *
 * @param {object} db       service-role client
 * @param {object} message  { id, location_id, media_url, media_mime_type?, media_storage_path? }
 * @param {object} [opts]   { token } — the location's IG access token, used
 *                          only if the CDN refuses an anonymous fetch
 */
export async function ensureInstagramMediaRehosted(db, message, { token } = {}) {
  if (!message?.id) return null
  if (message.media_storage_path) return message.media_storage_path
  if (!message.media_url || !message.location_id) return null

  const fetched = await fetchInstagramMediaBytes(message.media_url, token)
  if (!fetched) return null

  const mime = message.media_mime_type || fetched.mime
  const path = buildMediaObjectPath({ locationId: message.location_id, messageId: message.id, mime })

  const { error: upErr } = await db.storage.from(WHATSAPP_MEDIA_BUCKET).upload(path, fetched.bytes, {
    contentType: mime || 'application/octet-stream',
    upsert: true,
  })
  if (upErr) return null

  // Persist best-effort — even if this write fails the upload succeeded,
  // so a later view will re-resolve and upsert to the same path.
  await db.from('instagram_messages')
    .update({ media_storage_path: path, media_mime_type: mime || message.media_mime_type || null })
    .eq('id', message.id)

  return path
}
