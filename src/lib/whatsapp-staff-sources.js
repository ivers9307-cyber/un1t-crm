// src/lib/whatsapp-staff-sources.js
//
// C106 CHECKINRISKS.1 (d) — who counts as STAFF in a WhatsApp thread. ONE
// definition, read by the check-in runner (followups.js isStaffOutbound), Mia's
// take-over and re-arm checks (auto-reply.js whatsappAdapter.isHumanOutbound)
// and the handoff SLA / auto-resolve sweep (handoff-sla.js humanFilter).
//
// A whatsapp_messages outbound row was written by a person when:
//   - sent_by is set: the inbox / contact / Flow / card-set send routes stamp
//     the session user (reactions deliberately do not, see react/route.js); or
//   - source is a person source: 'app_echo' is a reply typed in the studio's
//     linked WhatsApp Business phone app (coexistence smb_message_echoes,
//     whatsapp-coexistence-ingest.js); 'history_sync' and 'operator' are
//     allowed by the CHECK (mig 259) and nothing writes them today.
// Mia's own rows (source 'agent') are never staff. Automations (booking
// confirmations, sequence steps, broadcasts, consent prompts) insert the
// column default source 'api' with no sent_by, so they are not staff.
// Pure; no imports, so any server module can use it.

export const WA_APP_ECHO_SOURCE = 'app_echo'
export const WA_HISTORY_SYNC_SOURCE = 'history_sync'

/** Sources that mean "a person wrote this", with or without a sent_by. */
export const WA_PERSON_SOURCES = Object.freeze(['operator', WA_APP_ECHO_SOURCE, WA_HISTORY_SYNC_SOURCE])

/**
 * Rows that came from the studio's phone app, not through the Cloud API: not
 * a send we paid for and not one that counts against the messaging tier.
 */
export const WA_PHONE_APP_SOURCES = Object.freeze([WA_APP_ECHO_SOURCE, WA_HISTORY_SYNC_SOURCE])

/** A person on the studio's side wrote this row (direction not checked). */
export function isWhatsAppStaffAuthored(m) {
  if (!m || m.source === 'agent') return false
  return m.sent_by != null || WA_PERSON_SOURCES.includes(m.source)
}

/** An outbound row a person on the studio's side wrote. */
export function isWhatsAppStaffOutbound(m) {
  return !!m && m.direction === 'outbound' && isWhatsAppStaffAuthored(m)
}

/**
 * The same rule as a PostgREST `.or()` filter, for reads that must not pull
 * every outbound row. Agent rows never carry a sent_by, so the 'agent'
 * exclusion needs no clause here.
 */
export const WA_STAFF_OUTBOUND_OR_FILTER = `sent_by.not.is.null,source.in.(${WA_PERSON_SOURCES.join(',')})`

/** The PostgREST list literal for `.not('source', 'in', …)`. */
export const WA_PHONE_APP_SOURCES_IN_LIST = `(${WA_PHONE_APP_SOURCES.join(',')})`
