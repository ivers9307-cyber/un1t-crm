// WAATTACH.1 — the Storage half of an inbox attachment (see
// src/lib/wa-outbound-attachment.js for the flow and the rules).

import { WHATSAPP_MEDIA_BUCKET } from '@shared/whatsapp-media'
import {
  WA_ATTACHMENT_TEXT, WA_ATTACHMENT_URL_TTL_SECS, judgeWaAttachment, parseWaAttachmentPath,
} from './wa-outbound-attachment'

/**
 * Judge what Storage holds at an attachment slot and mint Meta's link to it.
 *
 * The slot must be this conversation's at this studio; the object must exist;
 * its stored size and type (read back from the bucket, because the upload
 * token pins neither) must pass the same rules the sign route applied, and
 * the type must be the one the slot was minted for. Only then is a
 * short-lived signed URL made, here on the server.
 *
 * Nothing is removed on a refusal: the object is the staff member's own
 * upload, and a later send of the right file mints a new slot anyway.
 *
 * @returns {Promise<{ ok: true, url: string, kind: 'image'|'document', contentType: string, size: number }
 *   | { ok: false, status: number, error: string }>}
 */
export async function resolveWaAttachmentForSend(db, { path, locationId, conversationId }) {
  const slot = parseWaAttachmentPath(path, { locationId, conversationId })
  if (!slot) return { ok: false, status: 400, error: WA_ATTACHMENT_TEXT.notThisThread }

  const bucket = db.storage.from(WHATSAPP_MEDIA_BUCKET)
  const slash = path.lastIndexOf('/')
  const folder = path.slice(0, slash)
  const name = path.slice(slash + 1)

  let listed
  try {
    const { data, error } = await bucket.list(folder, { search: name })
    if (error) return { ok: false, status: 500, error: WA_ATTACHMENT_TEXT.unreadable }
    listed = data
  } catch {
    return { ok: false, status: 500, error: WA_ATTACHMENT_TEXT.unreadable }
  }
  const hit = (listed || []).find((o) => o?.name === name)
  if (!hit) return { ok: false, status: 400, error: WA_ATTACHMENT_TEXT.notUploaded }

  const size = Number(hit.metadata?.size)
  const judged = judgeWaAttachment({ mime: hit.metadata?.mimetype, size })
  if (!judged.ok) return { ok: false, status: 400, error: judged.error }
  if (judged.contentType !== slot.contentType) return { ok: false, status: 400, error: WA_ATTACHMENT_TEXT.mismatch }

  let url = null
  try {
    const { data, error } = await bucket.createSignedUrl(path, WA_ATTACHMENT_URL_TTL_SECS)
    if (!error) url = data?.signedUrl || null
  } catch {
    url = null
  }
  if (!url) return { ok: false, status: 500, error: WA_ATTACHMENT_TEXT.link }

  return { ok: true, url, kind: judged.kind, contentType: judged.contentType, size }
}
