// WA-MEDIA.1 — pure helpers for inbound WhatsApp/Instagram media.
//
// Lives in shared/ (the web↔mobile seam) so the inbox UIs on both
// platforms classify and address media the same way. The IO — resolving
// a Meta media ID to bytes and re-hosting them into Supabase Storage —
// is server-only and lives in src/lib/whatsapp-media-server.js + the
// /api/whatsapp/media/[id] route; nothing here touches the network.
//
// Why re-host at all: Meta returns inbound media as an opaque media ID,
// not a URL. The download URL must be fetched with the business token
// and expires in minutes, and Meta drops the media entirely after ~30
// days. So we copy it once into a private bucket and serve a signed URL
// from there — durable, and the token never reaches a browser.

// Map a MIME type to a file extension for the stored object name.
const MIME_EXT = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
  'audio/aac': 'aac',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'audio/amr': 'amr',
  'application/pdf': 'pdf',
}

export function extFromMime(mime) {
  const m = String(mime || '').split(';')[0].trim().toLowerCase()
  if (MIME_EXT[m]) return MIME_EXT[m]
  const slash = m.indexOf('/')
  if (slash > -1) {
    const sub = m.slice(slash + 1).replace(/[^a-z0-9]/g, '')
    if (sub) return sub.slice(0, 8)
  }
  return 'bin'
}

// A Meta media ID is an all-digit string (typically 15-17 chars). We
// keep the range generous but reject obvious non-IDs (URLs, paths,
// empties) so a legacy media_url that already holds a Storage path is
// never mistaken for an ID to re-fetch.
export function looksLikeMetaMediaId(s) {
  const v = String(s ?? '').trim()
  return /^[0-9]{8,24}$/.test(v)
}

// How should a message render in the thread? Returns one of
// 'image' | 'video' | 'audio' | 'file', or null for non-media
// (text, location, contacts, interactive, reaction…). Documents are
// classified by their MIME so an image/PDF sent as a "document" still
// shows inline where it can.
export function mediaRenderKind(messageType, mime) {
  const t = String(messageType || '').toLowerCase()
  const m = String(mime || '').toLowerCase()
  switch (t) {
    case 'image':
    case 'sticker':
      return 'image'
    case 'video':
      return 'video'
    case 'audio':
    case 'voice':
      return 'audio'
    case 'document':
      if (m.startsWith('image/')) return 'image'
      if (m.startsWith('video/')) return 'video'
      if (m.startsWith('audio/')) return 'audio'
      return 'file'
    // IG-MEDIA.2 — an Instagram story mention carries the story frame itself,
    // which can be a photo OR a video, and the webhook doesn't say which. So
    // it resolves by MIME like 'document' does, once re-hosting has recorded
    // one. Before that it returns null and the bubble shows its placeholder —
    // which is why the re-host is allowed through explicitly for this type
    // rather than gated on this function. Unreachable for WhatsApp (no such
    // message_type there).
    case 'story_mention':
      if (m.startsWith('image/')) return 'image'
      if (m.startsWith('video/')) return 'video'
      // A story frame is always a picture or a clip, but the webhook doesn't
      // say which and the MIME only exists once re-hosting has fetched it.
      // Never return null: every gate on the media path — the eager re-host,
      // the lazy /api/instagram/media fallback, and the client's render test —
      // asks this function, so a null here would keep the bytes out of our
      // bucket entirely and the IG CDN drops them within about a day. 'file'
      // keeps it fetchable and renderable now, and it upgrades to image/video
      // the moment the MIME lands.
      return 'file'
    default:
      return null
  }
}

// The Meta media ID to (re)fetch for this message: the dedicated
// column if present, else a legacy media_url that still holds the raw
// ID. Returns null once it's been re-hosted (caller should prefer
// media_storage_path) or when there's nothing to fetch.
export function resolveMediaExternalId(message) {
  if (!message) return null
  const ext = message.media_external_id
  if (ext && looksLikeMetaMediaId(ext)) return String(ext).trim()
  if (looksLikeMetaMediaId(message.media_url)) return String(message.media_url).trim()
  return null
}

// Does this message carry media we can actually serve — i.e. it renders
// as media AND we either already have it in Storage or can still fetch
// it from Meta by ID?
export function isServableMedia(message) {
  if (!message) return false
  if (mediaRenderKind(message.message_type, message.media_mime_type) == null) return false
  return !!message.media_storage_path || resolveMediaExternalId(message) != null
}

// Object path inside the whatsapp-media bucket. Namespaced by location
// so a single bucket holds every studio's media without collision, and
// keyed by the message id (one media per message) so re-hosting is
// idempotent.
export function buildMediaObjectPath({ locationId, messageId, mime } = {}) {
  if (!locationId || !messageId) throw new Error('buildMediaObjectPath requires locationId and messageId')
  return `${locationId}/${messageId}.${extFromMime(mime)}`
}

// Relative API path the inbox clients hit to get a signed media URL.
export function mediaProxyPath(messageId) {
  return `/api/whatsapp/media/${messageId}`
}

export const WHATSAPP_MEDIA_BUCKET = 'whatsapp-media'
