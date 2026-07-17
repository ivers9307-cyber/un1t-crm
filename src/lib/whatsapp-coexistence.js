// src/lib/whatsapp-coexistence.js
//
// WA-COEX.2 — pure parsers for the three coexistence webhook fields.
// Each turns a Meta `change.value` payload into normalised descriptors the
// ingest layer (whatsapp-coexistence-ingest.js) persists. No DB, no fetch —
// unit-tested against fixtures.

/** Both phone forms Meta/our DB use. `without` is what we store in wa_phone. */
export function normalizeWaPhone(raw) {
  if (!raw) return null
  const digits = String(raw).replace(/\D/g, '')
  if (!digits) return null
  return { withPlus: `+${digits}`, without: digits }
}

function textBody(msg) {
  if (msg.type === 'text') return msg.text?.body || ''
  if (msg.type === 'image') return msg.image?.caption || ''
  if (msg.type === 'video') return msg.video?.caption || ''
  if (msg.type === 'document') return msg.document?.caption || msg.document?.filename || ''
  return `[${msg.type || 'text'} message]`
}

/** smb_message_echoes → outbound descriptors (owner sent these FROM the phone). */
export function parseEchoMessages(value) {
  const echoes = value?.message_echoes || []
  return echoes.filter(m => m?.id).map(m => ({
    waMessageId: m.id,
    peerPhone: normalizeWaPhone(m.to)?.without || null,
    direction: 'outbound',
    messageType: m.type || 'text',
    body: textBody(m),
    tsSeconds: m.timestamp ? parseInt(m.timestamp, 10) : null,
  }))
}

/** smb_app_state_sync → contacts to MATCH (add/upsert only; removals ignored). */
export function parseSyncContacts(value) {
  const items = value?.state_sync || []
  return items
    .filter(s => s?.type === 'contact' && s?.action !== 'remove' && s?.contact?.phone_number)
    .map(s => ({ phone: s.contact.phone_number, name: s.contact.full_name || null }))
}

/**
 * history → flat message descriptors. `ownPhone` (the coexistence number's
 * own msisdn, digits only) decides direction: from==own → outbound, else inbound.
 */
export function parseHistoryMessages(value, ownPhone) {
  const own = normalizeWaPhone(ownPhone)?.without || null
  const out = []
  for (const h of value?.history || []) {
    for (const thread of h?.threads || []) {
      for (const m of thread?.messages || []) {
        if (!m?.id) continue
        const from = normalizeWaPhone(m.from)?.without || null
        const to = normalizeWaPhone(m.to)?.without || null
        // Fail-safe: when `own` is null (ownPhone unknown/unparseable) every
        // message defaults to inbound rather than being mislabelled outbound.
        const direction = from && own && from === own ? 'outbound' : 'inbound'
        const peerPhone = direction === 'outbound' ? to : from
        out.push({
          waMessageId: m.id, peerPhone, direction,
          messageType: m.type || 'text', body: textBody(m),
          tsSeconds: m.timestamp ? parseInt(m.timestamp, 10) : null,
        })
      }
    }
  }
  return out
}

/**
 * Advance the history-sync state from a `history` webhook payload.
 * Pure — pass the current now as ISO. Completion is progress >= 100 (Meta's
 * exact terminal value is loosely documented; this is the single place to
 * tune once seen live). A non-empty errors array = the business declined.
 */
export function nextHistorySyncState(current, historyValue, nowIso) {
  const startedAt = current?.started_at || nowIso
  const items = historyValue?.history || []
  const declined = items.some((h) => Array.isArray(h?.errors) && h.errors.length > 0)
  if (declined) {
    return { status: 'declined', progress: current?.progress ?? null, started_at: startedAt, updated_at: nowIso }
  }
  let progress = current?.progress ?? null
  for (const h of items) {
    const raw = h?.metadata?.progress
    const n = raw == null ? null : Number(raw)
    if (n != null && !Number.isNaN(n) && (progress == null || n > progress)) progress = n
  }
  const status = progress != null && progress >= 100 ? 'imported' : 'importing'
  return { status, progress, started_at: startedAt, updated_at: nowIso }
}

/**
 * The status to DISPLAY: a pending/importing sync older than 24h is shown as
 * 'expired' (the one-shot window is gone) — a read-time backstop so the badge
 * can never stay stuck even if the completion signal was missed. `nowMs` is
 * Date.now() from the caller.
 */
export function effectiveHistorySyncStatus(status, startedAtIso, nowMs) {
  if (status !== 'pending' && status !== 'importing') return status || null
  if (!startedAtIso) return status
  const startedMs = Date.parse(startedAtIso)
  if (Number.isNaN(startedMs)) return status
  return nowMs - startedMs > 24 * 60 * 60 * 1000 ? 'expired' : status
}
