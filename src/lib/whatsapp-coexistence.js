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
