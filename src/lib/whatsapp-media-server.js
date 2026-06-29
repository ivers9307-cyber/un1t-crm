// WA-MEDIA.1 — server-side IO for inbound WhatsApp/Instagram media.
//
// Resolves Meta's opaque media ID to bytes (using the location's business
// token), re-hosts them once into the private whatsapp-media bucket, and
// hands back a short-lived signed URL. The token never leaves the server
// and the signed URL is what the inbox (web + mobile) actually renders.
//
// Pure classification/addressing helpers live in @shared/whatsapp-media;
// this module is the IO that depends on the network, Storage and the DB.

import { getWhatsAppConfig, META_API_URL } from './whatsapp-config'
import {
  WHATSAPP_MEDIA_BUCKET,
  resolveMediaExternalId,
  buildMediaObjectPath,
} from '@shared/whatsapp-media'

// Download the bytes for a Meta media ID. Two hops: the ID resolves to a
// short-lived download URL, which is then fetched with the same bearer.
// Returns null on any failure (expired media, bad token, network) so the
// caller can fail soft.
async function fetchMetaMediaBytes(externalId, token) {
  const lookup = await fetch(`${META_API_URL}/${externalId}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!lookup.ok) return null
  const meta = await lookup.json().catch(() => null)
  if (!meta?.url) return null
  const dl = await fetch(meta.url, { headers: { Authorization: `Bearer ${token}` } })
  if (!dl.ok) return null
  const bytes = Buffer.from(await dl.arrayBuffer())
  return { bytes, mime: meta.mime_type || null }
}

/**
 * Ensure a message's inbound media is re-hosted into the whatsapp-media
 * bucket. Idempotent: returns the existing path immediately if already
 * re-hosted, otherwise downloads from Meta, uploads, and persists the
 * path (so future views skip the Meta round-trip and survive Meta's
 * ~30-day media expiry). Returns the object path, or null if there's
 * nothing to serve or the fetch failed (caller renders a graceful gap).
 */
export async function ensureMediaRehosted(db, message) {
  if (!message?.id) return null
  if (message.media_storage_path) return message.media_storage_path

  const externalId = resolveMediaExternalId(message)
  if (!externalId || !message.location_id) return null

  let config
  try {
    config = await getWhatsAppConfig(message.location_id)
  } catch {
    return null
  }
  if (!config?.token) return null

  const fetched = await fetchMetaMediaBytes(externalId, config.token)
  if (!fetched) return null

  const mime = message.media_mime_type || fetched.mime
  const path = buildMediaObjectPath({ locationId: message.location_id, messageId: message.id, mime })

  const { error: upErr } = await db.storage.from(WHATSAPP_MEDIA_BUCKET).upload(path, fetched.bytes, {
    contentType: mime || 'application/octet-stream',
    upsert: true,
  })
  if (upErr) return null

  // Persist best-effort — even if this write fails the upload succeeded,
  // so a later view will just re-resolve and upsert to the same path.
  await db.from('whatsapp_messages')
    .update({ media_storage_path: path, media_mime_type: mime || message.media_mime_type || null })
    .eq('id', message.id)

  return path
}

/**
 * Create a short-lived signed URL for a re-hosted object. The private
 * bucket means the URL is the only way a browser/app sees the bytes, and
 * it expires — so it's safe to hand to the client. Returns null on error.
 */
export async function signedMediaUrl(db, storagePath, ttlSeconds = 600) {
  if (!storagePath) return null
  const { data, error } = await db.storage
    .from(WHATSAPP_MEDIA_BUCKET)
    .createSignedUrl(storagePath, ttlSeconds)
  if (error || !data?.signedUrl) return null
  return data.signedUrl
}
