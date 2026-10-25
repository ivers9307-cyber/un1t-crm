// TVUPLOAD.1 (C93) — the TV image signed-upload flow's rules.
//
// Why: the phone posted TV images to POST /api/admin/tv-displays/upload as
// multipart with a `{uri}` file part, and since Expo SDK 57 such a part never
// leaves the phone (no request, no status, nothing in the logs). The phone
// now uploads the bytes straight to Storage against a slot the server mints:
//   1. POST /api/admin/tv-displays/upload/sign    — gate, checkTvImage on the
//      declared file, buildTvUploadPath, createSignedUploadUrl → { path, token }
//   2. the device: storage.from('tv-content').uploadToSignedUrl(path, token, bytes)
//   3. POST /api/admin/tv-displays/upload/finalise — gate, isTvUploadPath for
//      that studio and kind, checkTvImage on what Storage actually holds
// The multipart route stays for the web (which compresses under Vercel's
// cap) and for phones still on the old bundle. Paths are the multipart
// route's: <location>/<uuid>.<ext> (a push image) and
// <location>/templates/<uuid>.<ext> (a template base image).
//
// The limits are src/lib/tv-media.js, the bucket's own (mig 671), so a file
// this accepts Storage accepts too.

import { TV_IMAGE_MIME_TYPES, TV_IMAGE_MAX_BYTES } from './tv-media'

export const TV_UPLOAD_KINDS = Object.freeze(['content', 'template'])

// Staff-facing words, the multipart route's.
export const TV_IMAGE_TYPE_ERROR = 'File must be a PNG, JPEG, WebP, GIF or AVIF image.'
export const TV_IMAGE_SIZE_ERROR = 'Image must be under 15MB.'
export const TV_IMAGE_EMPTY_ERROR = 'The image is empty. Pick it again.'

/** The folder a kind of TV image lives in. */
export function tvUploadPrefix(locationId, kind) {
  return kind === 'template' ? `${locationId}/templates` : `${locationId}`
}

function extensionOf(fileName) {
  const raw = String(fileName || '').split('.').pop() || ''
  const ext = raw.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16)
  return ext || 'jpg'
}

/** A fresh storage path for a TV image (the server mints it, never the client). */
export function buildTvUploadPath({ locationId, kind, fileName, id }) {
  return `${tvUploadPrefix(locationId, kind)}/${id}.${extensionOf(fileName)}`
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const NAME_RE = new RegExp(`^${UUID}\\.[a-z0-9]{1,16}$`)

/**
 * Is `path` a slot the sign route minted for this studio and kind? Exactly
 * `<prefix>/<uuid>.<ext>`: no other studio, no other kind, no traversal.
 */
export function isTvUploadPath(path, locationId, kind) {
  if (typeof path !== 'string' || !locationId || !TV_UPLOAD_KINDS.includes(kind)) return false
  const prefix = `${tvUploadPrefix(locationId, kind)}/`
  if (!path.startsWith(prefix)) return false
  return NAME_RE.test(path.slice(prefix.length))
}

/**
 * The multipart route's file rules, for a declared file (sign) or the stored
 * object (finalise). @returns {{ ok: true } | { ok: false, error: string }}
 */
export function checkTvImage({ mime, size } = {}) {
  const type = String(mime || '').toLowerCase()
  if (!TV_IMAGE_MIME_TYPES.includes(type)) return { ok: false, error: TV_IMAGE_TYPE_ERROR }
  const bytes = Number(size)
  if (!Number.isFinite(bytes) || bytes <= 0) return { ok: false, error: TV_IMAGE_EMPTY_ERROR }
  if (bytes > TV_IMAGE_MAX_BYTES) return { ok: false, error: TV_IMAGE_SIZE_ERROR }
  return { ok: true }
}
