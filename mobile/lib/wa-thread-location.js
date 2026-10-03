// INBOXLOC.1 (C37) — which studio the WhatsApp thread screen acts at.
//
// A thread belongs to ONE studio (whatsapp_conversations.location_id), and the
// phone opens threads from a contact at any studio the staff member belongs
// to, not only the active one. Every call the screen makes after the thread
// has loaded (sends, template list, card sets, Flow, resolve, block, react,
// Mia feedback) is sent for the conversation's studio: the x-active-location
// header then names the studio the routes act at, and the RLS reads (the
// template picker) list that studio's rows. Before the thread has loaded the
// active studio is the only one known; the thread GET judges the
// conversation's studio on the server either way.
//
// Pure, tested in wa-thread-location.test.js (there is no RN component test
// runner); tests/mobile-wa-thread-location.test.js pins the screen's use.

/**
 * @param {{ location_id?: unknown } | null | undefined} conversation
 * @param {{ id?: string } | null | undefined} activeLocation
 * @returns {string | undefined}
 */
export function threadLocationId(conversation, activeLocation) {
  const own = conversation?.location_id
  if (typeof own === 'string' && own) return own
  return activeLocation?.id || undefined
}
